# Dominion Playwright

Browser automation for The Dominion Group's utility portals. Handles BGE (Baltimore Gas & Electric) and Baltimore City Water — logging in, enrolling accounts in paperless billing, and pulling current bill data — all without any manual portal work.

---

## What It Does

Each run can do one or more of the following:

| Mode | What happens |
|------|-------------|
| `audit` | Logs in and takes screenshots of key pages. No changes are made. Good for a first-time check. |
| `paperless` | Enrolls every account in paperless billing (skips any already enrolled). |
| `bills` | Reads the current balance and due date for every account and saves it to the database. |
| `full` | Does all three above in one pass (default). |

For **water accounts**, bill retrieval also checks water consumption against each unit's baseline and flags anomalies:

- Normal usage → auto-pay
- Elevated usage (25–35 units/quarter) → alert the property manager
- High usage (35+ units/quarter) → likely a leak, trigger a work order

Every action — success or failure — is written to audit log tables in the database so there is always a record of what ran and when.

---

## How It Works

The tool uses [Playwright](https://playwright.dev/) to control a Chrome browser, the same way a person would — clicking buttons, filling in fields, reading page content. It runs accounts one at a time (no parallel tabs) to stay under the radar of portal bot-detection.

Account data comes from a PostgreSQL database. BGE accounts are pulled from a property map table; water accounts are pulled based on which units the landlord is responsible for paying.

---

## Requirements

- Node.js 18+
- A PostgreSQL database with the schema from `db/migrations.sql` applied
- A `.env` file with credentials (see setup below)

---

## Setup

**1. Install dependencies**

```bash
npm install
npx playwright install chromium
```

**2. Apply the database schema**

Run the SQL in `db/migrations.sql` against your PostgreSQL database once. This creates the account mapping and audit log tables.

**3. Create a `.env` file**

Copy `.env.example` to `.env` and fill in your values:

```
# Database
DB_HOST=
DB_PORT=5432
DB_NAME=
DB_USER=
DB_PASSWORD=

# BGE Portal
BGE_EMAIL=
BGE_PASSWORD=
BGE_LOGIN_URL=https://myaccount.bge.com/sign-in

# BGE OTP (email inbox to check for one-time codes)
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_EMAIL=
IMAP_PASSWORD=

# Water Portal
WATER_EMAIL=
WATER_PASSWORD=
WATER_LOGIN_URL=https://cityservices.baltimorecity.gov/water/Login
```

---

## Running

### BGE Portal

```bash
# Full run (paperless + bill retrieval)
npm run bge:full

# Individual modes
npm run bge:audit       # Screenshots only, browser visible
npm run bge:paperless   # Enroll accounts in paperless billing
npm run bge:bills       # Retrieve balances and due dates
```

### Water Portal

```bash
# Full run
npm run water:full

# Individual modes
npm run water:audit
npm run water:paperless
npm run water:bills
```

### Data Import Scripts

```bash
npm run import:bge-mapping    # Import BGE account-to-property mapping
npm run import:quickbooks     # Import data from QuickBooks export
```

---

## First Time on a New Portal

Run in `audit` mode with the browser visible first:

```bash
npm run bge:audit
# or
npm run water:audit
```

This lets you see the portal, verify the selectors match, and take screenshots before any changes are made. The code includes notes throughout marking spots that may need selector adjustments after an audit.

---

## Project Structure

```
tests/
  bge.spec.ts          # BGE portal automation
  water.spec.ts        # Water portal automation
  helpers/
    db.ts              # Database queries and audit logging
    emailOTP.ts        # Reads OTP codes from email (for BGE login)
    utils.ts           # Shared utilities (delays, parsing, screenshots)

scripts/
  import-bge-mapping.ts    # Imports BGE account map from spreadsheet
  import-quickbooks.ts     # Imports QuickBooks data

db/
  migrations.sql       # Run once to create required tables

playwright.config.ts   # Playwright settings (timeouts, browser, reporter)
```

---

## Notes

- Runs use Chromium only — no need for cross-browser coverage on portal scraping.
- Tests run sequentially (one at a time) to avoid triggering bot-detection on the portals.
- Screenshots on failure are saved to `test-results/` automatically.
- The `.env` file is intentionally excluded from version control — never commit credentials.
