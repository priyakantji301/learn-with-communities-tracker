import express from 'express';
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import { randomUUID as uid } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const DIR = path.dirname(fileURLToPath(import.meta.url)), PUB = path.join(DIR, 'public');

const PORT = +process.env.PORT || 3000, HOST = process.env.HOST || '127.0.0.1';
const ORIGIN = process.env.FETCH_ORIGIN || ''; // dev/test only: fetch profiles from a local stub instead of Google
const DB = path.join(DIR, 'data.json');
const URL_RE = /^https:\/\/(www\.)?(skills\.google|cloudskillsboost\.google)\/public_profiles\/[0-9a-f-]{36}\/?$/i;
const UA = 'GDG-LWC-Tracker/2.0 (campus campaign tracker)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const E = (code, message, x) => Object.assign(new Error(message), { code }, x);
const LIM = { target: [1, 100], delayMs: [500, 30000], concurrency: [1, 4], timeoutMs: [5000, 60000], retries: [0, 5], pageSize: [10, 100], refreshSec: [2, 60] };
const DEF = { target: 10, delayMs: 1500, concurrency: 2, timeoutMs: 15000, retries: 2, pageSize: 25, refreshSec: 6, utc: false, confirm: true, chapter: '', demo: false, map: {} };

let db = { students: [], settings: { ...DEF }, log: [] };
try { const d = JSON.parse(await fs.readFile(DB, 'utf8')); db = { students: d.students || [], settings: { ...DEF, ...d.settings }, log: d.log || [] }; } catch {}
let t_;
const save = () => { clearTimeout(t_); t_ = setTimeout(async () => { await fs.writeFile(DB + '.tmp', JSON.stringify(db)); await fs.rename(DB + '.tmp', DB); }, 300); };
const lg = (type, message, s, x) => { db.log.push({ id: uid(), at: new Date().toISOString(), type, message, student: s?.name || s?.email || '', studentId: s?.id, ...x }); if (db.log.length > 4000) db.log.splice(0, 500); save(); };
const clamp = (v, [a, b], d) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, Math.round(+v))) : d);
const status = (s) => s.error ? 'errors' : s.badgeCount == null ? 'unchecked' : s.badgeCount >= db.settings.target ? 'completed' : s.badgeCount > 0 ? 'in_progress' : 'not_started';

// ---------- CSV ----------
function parseCSV(text) {
  const rows = []; let row = [], c = '', q = false; text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { c += '"'; i++; } else if (ch === '"') q = false; else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(c); c = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(c); c = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else c += ch;
  }
  row.push(c); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
const cell = (v) => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
const toCSV = (head, rows) => [head.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
const RX = { url: /url|link/i, id: /student.?id|^id$|roll|enrol/i, name: /name/i, email: /mail/i, mock: /mock|sample_badge/i, notes: /note/i };

function preview(text, userMap = {}) {
  const rows = parseCSV(String(text || '')); if (rows.length < 2) throw new Error('CSV needs a header row and at least one student row.');
  if (rows.length > 5001) throw new Error('CSV has more than 5,000 rows.');
  const headers = rows[0].map((h) => h.trim()), map = {};
  for (const k of ['url', 'id', 'mock', 'email', 'notes', 'name']) {
    const want = userMap[k]; map[k] = headers.includes(want) ? want : headers.find((h) => RX[k].test(h) && !Object.values(map).includes(h)) || (k === 'url' ? headers.find((h) => /profile/i.test(h)) : '') || '';
  }
  if (!map.url) throw new Error('No profile URL column found. Pick one in the column mapping.');
  const idx = Object.fromEntries(Object.entries(map).map(([k, h]) => [k, headers.indexOf(h)]));
  const seen = new Set(), out = rows.slice(1).map((r, i) => {
    const g = (k) => (idx[k] >= 0 ? (r[idx[k]] || '').trim() : '');
    const s = { line: i + 2, studentId: g('id'), name: g('name'), email: g('email'), url: g('url'), notes: g('notes'), mock: g('mock') === '' ? null : parseInt(g('mock'), 10), issues: [] };
    if (!s.url) s.issues.push('Missing profile URL'); else if (!URL_RE.test(s.url)) s.issues.push('Invalid profile URL');
    if (!s.name && !s.email && !s.studentId) s.issues.push('No name, email or ID');
    const key = s.url.toLowerCase().replace(/\/$/, ''); if (key && seen.has(key)) s.issues.push('Duplicate URL in file'); seen.add(key);
    s.dup = s.issues.includes('Duplicate URL in file'); s.valid = !s.issues.length; return s;
  });
  return { headers, map, rows: out, counts: { total: out.length, valid: out.filter((r) => r.valid).length, invalid: out.filter((r) => !r.valid && !r.dup).length, dup: out.filter((r) => r.dup).length } };
}
const mk = (r) => ({ id: uid(), studentId: r.studentId || '', name: r.name || '', email: r.email || '', url: r.url, notes: r.notes || '', mock: r.mock ?? null, badgeCount: null, badges: [], error: null, lastCheckedAt: null, attempts: 0, history: [], createdAt: new Date().toISOString() });

// ---------- Fetch with global rate limit, bounded retries ----------
let nextSlot = 0, slow = 1, coolUntil = 0;
async function slot() { const now = Date.now(), t = Math.max(now, nextSlot, coolUntil); nextSlot = t + db.settings.delayMs * slow; if (t > now) await sleep(t - now); }
async function fetchProfile(s) {
  const cfg = db.settings; let tries = 0;
  for (;;) {
    tries++; await slot();
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), cfg.timeoutMs);
    try {
      const r = await fetch(ORIGIN ? s.url.replace(/^https:\/\/[^/]+/, ORIGIN) : s.url, { signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'text/html' } });
      if ([404, 410].includes(r.status)) throw E('PROFILE_NOT_FOUND', `Profile not found (HTTP ${r.status}). Check the URL.`, { fatal: 1 });
      if ([401, 403].includes(r.status)) throw E('PROFILE_NOT_PUBLIC', `Profile is private or blocked (HTTP ${r.status}). Ask the student to make it public.`, { fatal: 1 });
      if (r.status === 429) { const ra = (+r.headers.get('retry-after') || 0) * 1000; slow = Math.min(slow * 2, 8); coolUntil = Date.now() + Math.max(ra, 30000); throw E('RATE_LIMITED', 'Rate limited by Google Skills (HTTP 429). Queue slowed down automatically.'); }
      if (r.status >= 500) throw E('HTTP_ERROR', `Google Skills server error (HTTP ${r.status}).`);
      if (!r.ok) throw E('HTTP_ERROR', `Unexpected HTTP ${r.status}.`, { fatal: 1 });
      if (!ORIGIN && !/\/public_profiles\//.test(new URL(r.url).pathname)) throw E('PROFILE_NOT_PUBLIC', 'Redirected away from the public profile (private, removed, or sign-in required).', { fatal: 1 });
      const html = (await r.text()).slice(0, 3e6); slow = Math.max(1, slow * 0.9); return { html, tries };
    } catch (e) {
      const err = e.code ? e : E(e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', e.name === 'AbortError' ? `No response within ${cfg.timeoutMs / 1000}s.` : 'Network error: ' + (e.cause?.code || e.message));
      err.tries = tries; if (err.fatal || tries > cfg.retries) throw err;
      await sleep(Math.min(2000 * 2 ** (tries - 1), 30000) * (0.75 + Math.random() / 2));
    } finally { clearTimeout(t); }
  }
}
function parseProfile(html, url) {
  const $ = cheerio.load(html), seen = new Map();
  $('a[href*="/badges/"]').each((_, el) => {
    const h = $(el).attr('href') || ''; if (!/\/public_profiles\/[^/]+\/badges\/\d+/.test(h) || seen.has(h)) return;
    const tx = $(el).parent().text().replace(/\s+/g, ' ').trim(), m = tx.match(/^(.*?)\s*Earned\s+(.*)$/i);
    seen.set(h, { title: (m ? m[1] : tx).trim(), earned: m ? m[2].trim() : '' });
  });
  const all = [...seen.values()], id = url.match(/[0-9a-f-]{36}/i)[0].toLowerCase();
  if (!all.length && !html.toLowerCase().includes(id)) throw E('PARSE_FAILED', 'Page loaded but does not look like a public profile (no profile ID or badges found).');
  const done = all.filter((b) => b.earned);
  if (all.length && !done.length) throw E('PARSE_FAILED', `Found ${all.length} badge entries but no completion dates; the page layout may have changed.`);
  return { name: $('h1').first().text().trim(), badges: done };
}
async function check(s) {
  const t0 = Date.now(); let tries = 0, sim = false;
  try {
    if (!URL_RE.test(s.url)) throw E('INVALID_URL', 'Not a valid public profile URL (expected https://www.skills.google/public_profiles/<id>).', { tries: 0 });
    let r;
    if (db.settings.demo) {
      if (s.mock == null) throw E('PARSE_FAILED', 'Demo mode needs the mock badge-count column.', { tries: 0 });
      await sleep(100 + Math.random() * 200); sim = true; tries = 1;
      r = { name: '', badges: Array.from({ length: s.mock }, (_, i) => ({ title: 'Simulated badge ' + (i + 1), earned: 'demo' })) };
    } else { const f = await fetchProfile(s); tries = f.tries; r = parseProfile(f.html, s.url); }
    Object.assign(s, { badgeCount: r.badges.length, badges: r.badges, error: null, simulated: sim }); if (!s.name && r.name) s.name = r.name;
  } catch (e) { tries = e.tries ?? 1; s.error = { code: e.code || 'PARSE_FAILED', message: e.message }; s.simulated = sim; }
  s.lastCheckedAt = new Date().toISOString(); s.attempts = (s.attempts || 0) + tries;
  const h = { at: s.lastCheckedAt, ok: !s.error, count: s.badgeCount, code: s.error?.code, message: s.error?.message, tries, ms: Date.now() - t0, sim };
  s.history = [...(s.history || []), h].slice(-20);
  lg('check', s.error ? `${s.error.code}: ${s.error.message}` : `${s.badgeCount}/${db.settings.target} badges${sim ? ' (simulated)' : ''}`, s, { ok: !s.error, count: s.badgeCount, tries });
}

// ---------- Queue: bounded workers, pause/resume ----------
let J = { state: 'idle', queue: [], total: 0, done: 0, failed: 0, startedAt: null }, W = 0; const running = new Set();
const get = (id) => db.students.find((s) => s.id === id);
function enqueue(ids, front) {
  ids = ids.filter((i) => !J.queue.includes(i) && !running.has(i)); if (!ids.length) return 0;
  if (J.state === 'idle') J = { state: 'running', queue: [], total: 0, done: 0, failed: 0, startedAt: Date.now() };
  J.queue = front ? [...ids, ...J.queue] : [...J.queue, ...ids]; J.total += ids.length; if (J.state === 'running') pump(); return ids.length;
}
function pump() { while (J.state === 'running' && W < db.settings.concurrency && J.queue.length) { W++; worker(); } }
async function worker() {
  while (J.state === 'running' && J.queue.length) {
    const s = get(J.queue.shift()); if (!s) { J.total--; continue; }
    running.add(s.id); try { await check(s); } finally { running.delete(s.id); J.done++; if (s.error) J.failed++; save(); }
  }
  W--; if (!W && !J.queue.length && J.state === 'running') { J.state = 'idle'; lg('batch', `Batch finished: ${J.done - J.failed} ok, ${J.failed} failed`); }
}

// ---------- API ----------
const app = express(); app.use(express.json({ limit: '5mb' })); app.use(express.static(PUB));
app.get('/', (_, res) => res.sendFile(path.join(PUB, 'index.html')));
const view = ({ history, ...s }) => ({ ...s, status: status(s), checking: running.has(s.id), queued: J.queue.includes(s.id) });
const wrap = (f) => async (req, res) => { try { await f(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
const find = (req) => get(req.params.id) || Promise.reject(Object.assign(new Error('Student not found'), { status: 404 }));
const clean = (b) => ({ studentId: String(b.studentId || '').trim(), name: String(b.name || '').trim(), email: String(b.email || '').trim(), url: String(b.url || '').trim(), notes: String(b.notes || '').trim() });

app.get('/api/state', (_, res) => res.json({ students: db.students.map(view), settings: db.settings, job: { ...J, queue: undefined, queued: J.queue.length, active: running.size, slow }, counts: { log: db.log.length } }));
app.put('/api/settings', wrap((req, res) => {
  const b = req.body, s = db.settings;
  for (const k in LIM) if (k in b) s[k] = clamp(b[k], LIM[k], s[k]);
  for (const k of ['utc', 'confirm', 'demo']) if (k in b) s[k] = !!b[k];
  if ('chapter' in b) s.chapter = String(b.chapter).slice(0, 80);
  if (b.map && typeof b.map === 'object') s.map = Object.fromEntries(Object.keys(RX).map((k) => [k, String(b.map[k] || '').slice(0, 80)]));
  lg('settings', 'Settings updated'); save(); res.json(s);
}));
app.post('/api/import/preview', wrap((req, res) => res.json(preview(req.body.csv, req.body.map || db.settings.map))));
app.post('/api/import/commit', wrap((req, res) => {
  const p = preview(req.body.csv, req.body.map || db.settings.map); let add = 0, upd = 0, skip = 0;
  if (req.body.mode === 'replace') db.students = [];
  for (const r of p.rows) {
    if (r.dup || (!r.valid && req.body.skipInvalid)) { skip++; continue; }
    const ex = db.students.find((s) => s.url.toLowerCase().replace(/\/$/, '') === r.url.toLowerCase().replace(/\/$/, '') || (r.studentId && s.studentId === r.studentId));
    if (ex) { Object.assign(ex, { studentId: r.studentId || ex.studentId, name: r.name || ex.name, email: r.email || ex.email, notes: r.notes || ex.notes, mock: r.mock ?? ex.mock }); if (ex.url !== r.url) { ex.url = r.url; Object.assign(ex, { badgeCount: null, badges: [], error: null }); } upd++; }
    else { const s = mk(r); if (!r.valid) s.error = { code: 'INVALID_URL', message: r.issues.join('; ') }; db.students.push(s); add++; }
  }
  if (req.body.saveMap) db.settings.map = p.map;
  lg('import', `Imported CSV: ${add} added, ${upd} updated, ${skip} skipped (${req.body.mode || 'merge'})`); save(); res.json({ add, upd, skip, mock: p.rows.some((r) => /mock/i.test(r.notes)) });
}));
app.post('/api/students', wrap((req, res) => { const r = clean(req.body); if (!r.url) throw new Error('Profile URL is required.'); const s = mk(r); if (!URL_RE.test(r.url)) s.error = { code: 'INVALID_URL', message: 'Invalid profile URL' }; db.students.push(s); lg('add', 'Student added', s); save(); res.json(view(s)); }));
app.put('/api/students/:id', wrap(async (req, res) => { const s = await find(req), r = clean(req.body); if (r.url !== s.url) Object.assign(s, { badgeCount: null, badges: [], error: URL_RE.test(r.url) ? null : { code: 'INVALID_URL', message: 'Invalid profile URL' }, lastCheckedAt: null }); Object.assign(s, r); lg('edit', 'Student edited', s); save(); res.json(view(s)); }));
app.delete('/api/students/:id', wrap(async (req, res) => { const s = await find(req); db.students = db.students.filter((x) => x !== s); J.queue = J.queue.filter((i) => i !== s.id); lg('remove', 'Student removed', s); save(); res.json({ ok: 1 }); }));
app.delete('/api/students', wrap((_, res) => { db.students = []; J.queue = []; lg('remove', 'All students removed'); save(); res.json({ ok: 1 }); }));
app.get('/api/students/:id/history', wrap(async (req, res) => res.json((await find(req)).history || [])));
app.post('/api/students/:id/verify', wrap(async (req, res) => { const s = await find(req); res.json({ queued: enqueue([s.id], true) }); }));
app.post('/api/verify', wrap((req, res) => {
  const scope = req.body.scope || 'all', all = db.students, pick = scope === 'unchecked' ? all.filter((s) => status(s) === 'unchecked') : scope === 'failed' ? all.filter((s) => s.error && s.error.code !== 'INVALID_URL') : all;
  const n = enqueue(pick.map((s) => s.id)); lg('batch', `Batch started (${scope}): ${n} students`); res.json({ queued: n, skippedInvalid: scope === 'failed' ? all.filter((s) => s.error?.code === 'INVALID_URL').length : 0 });
}));
app.post('/api/job/:a', wrap((req, res) => {
  const a = req.params.a;
  if (a === 'pause' && J.state === 'running') J.state = 'paused';
  else if (a === 'resume' && J.state === 'paused') { J.state = 'running'; pump(); }
  else if (a === 'cancel') { J.queue = []; if (J.state === 'paused' && !W) J.state = 'idle'; }
  lg('batch', 'Batch ' + a); res.json({ state: J.state });
}));
const rows = (list) => list.map((s) => [s.studentId, s.name, s.email, s.url, s.badgeCount ?? '', db.settings.target, status(s), s.lastCheckedAt ?? '', s.attempts ?? 0, s.error?.code ?? '', s.error?.message ?? '', s.simulated ? 'simulated' : s.badgeCount == null ? '' : 'live', s.notes]);
app.get('/api/export.csv', (req, res) => {
  const { status: st = 'all', q = '' } = req.query, n = String(q).toLowerCase();
  const list = db.students.filter((s) => (st === 'all' || status(s) === st) && (!n || [s.name, s.email, s.studentId, s.url, s.notes].join(' ').toLowerCase().includes(n)));
  lg('export', `Exported ${list.length} students`);
  res.type('text/csv').attachment('lwc-results.csv').send(toCSV(['student_id', 'name', 'email', 'profile_url', 'badge_count', 'target', 'status', 'last_checked_at', 'attempts', 'error_code', 'error_message', 'source', 'notes'], rows(list)));
});
app.get('/api/template.csv', (_, res) => res.type('text/csv').attachment('lwc-template.csv').send('student_id,student_name,email,google_skills_profile_url,notes\r\n'));
const flog = (q = '', type = '') => db.log.filter((l) => (!type || l.type === type) && (!q || Object.values(l).join(' ').toLowerCase().includes(String(q).toLowerCase()))).reverse();
app.get('/api/activity', (req, res) => res.json(flog(req.query.q, req.query.type).slice(0, 300)));
app.get('/api/activity.csv', (req, res) => res.type('text/csv').attachment('lwc-activity.csv').send(toCSV(['time', 'type', 'student', 'result', 'message'], flog(req.query.q, req.query.type).map((l) => [l.at, l.type, l.student, l.ok === undefined ? '' : l.ok ? 'ok' : 'error', l.message]))));

await fs.access(path.join(PUB, 'index.html')).catch(() => { console.error(`\nMissing ${path.join(PUB, 'index.html')}. Copy the whole tracker folder from the zip, including public/.\n`); process.exit(1); });
app.listen(PORT, HOST, () => console.log(`Learn With Communities tracker: http://${HOST}:${PORT}`));
