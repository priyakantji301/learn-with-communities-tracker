# Learn With Communities Tracker

A web-based campaign monitoring and student progress tracking platform developed for **Google Developer Groups on Campus (GDG on Campus)** organizers to manage participation in the **Learn With Communities (LWC) Campaign**.

The platform simplifies campaign monitoring by verifying students' public Google Skills profiles, tracking earned skill badges, and comparing individual progress against a configurable campaign target (default: **10 badges**).

## Features

### Dashboard
- Overview of total registered students and campaign progress.
- Completion rate and student status breakdown.
- Verification errors and progress statistics.
- Quick actions to verify all profiles and refresh data.

### Student Management
- Bulk student registration through CSV uploads.
- CSV preview, validation, and customizable column mapping.
- Add, edit, search, filter, and remove student records.
- View individual Google Skills profiles.
- Reverify profiles and access verification history.
- Export student records.

### Profile Verification
- Automated fetching and parsing of public Google Skills profiles.
- Extraction and counting of earned skill badges.
- Comparison against the campaign badge target.
- Configurable request delays and concurrent verification.
- Timeout handling, retries, and exponential backoff.
- Start, pause, resume, cancel, and recheck failed verifications.

### Reports & Settings
- Campaign completion breakdown and exportable results.
- Searchable activity logs for imports and verification checks.
- Configurable badge targets, request limits, timeouts, and retry settings.
- Demo mode for testing without external network requests.

## Student Verification Status

| Status | Description |
|---|---|
| Completed | Target badge count achieved |
| In Progress | At least one badge earned, target not reached |
| Not Started | Successfully checked, zero badges found |
| Errors | Profile verification failed |
| Unchecked | Profile not yet verified |

## Technology Stack

| Component | Technology |
|---|---|
| Backend | Node.js, Express.js |
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| HTML Parsing | Cheerio |
| Data Storage | Local JSON file |
| Data Import/Export | CSV |

## Getting Started

### Prerequisites
- Node.js 18 or later
- npm

### Installation

Clone the repository:

```bash
git clone <repository-url>
cd learn-with-communities-tracker
```

Install dependencies:

```bash
npm install
```

Start the application:

```bash
npm start
```

Open your browser and visit:

`http://127.0.0.1:3000`

## Demo Mode

The application includes a Demo Mode that simulates student verification using the supplied `mock-students-55.csv` dataset.

- Contains 55 sample student records.
- Simulates badge counts and verification results.
- Makes no external network requests.
- Allows organizers to explore the dashboard and verification workflow.

## Data & Security

- Student records, settings, and verification results are stored locally in `data.json`.
- Real student CSV files and `data.json` must not be committed to the repository.
- Public profile accessibility and changes to Google's page structure may affect verification.
- The application currently has no authentication and is intended for local organizer use.

## Project Objective

The Learn With Communities Tracker aims to reduce manual verification efforts, centralize student progress information, and provide GDG on Campus organizers with a structured overview of campaign participation and badge completion.

---

**Built for the Learn With Communities Campaign by Priyanshi Parmar | GDG on Campus**
