# Therapist Welcome Email Automation

Sends a welcome email to every newly hired therapist, driven by a shared Google Sheet hiring tracker that several people edit. The goals are that every hire gets exactly one email, a mistake in the sheet can be undone, and nobody has to notice by luck that the automation stopped.

**Live walkthrough and simulator:** https://regal-chebakia-271b75.netlify.app/ (source in [`demo/`](demo/))
**Design write-up (the exercise answer):** [`docs/DESIGN.md`](docs/DESIGN.md)
**Operating it:** [`docs/RUNBOOK.md`](docs/RUNBOOK.md)

```
Hiring Tracker (Google Sheet, many editors)
        │  every 15 min (time-driven trigger)
        ▼
Apps Script ── read columns by header name ── validate ── 30-min undo window
        │                                                   │
        │                                     two-phase send via Gmail alias
        ▼                                                   ▼
Welcome Log (protected tab, one row per Candidate ID)   new hire's inbox
        │
        ├── ping ──► external heartbeat monitor (alerts if pings stop)
        └── daily 8am digest ──► ops: watchdog + "starting soon, not welcomed"
```

## Why Apps Script

The team already uses Google Workspace. Apps Script runs inside the hiring sheet and sends through the team's own Gmail, so there is no new vendor, login or subscription, and the data stays inside the Workspace tenant. Zapier or Make handle the happy path well. The hard parts of this job are idempotency, validation and silent-failure detection, which need real logic and somewhere to keep state.

## What it guards against

| Risk | Guard |
|---|---|
| Duplicate emails | Log keyed by Candidate ID. `SENT` is final. The log is set to `SENDING` before Gmail is called, so a run that dies mid-send is flagged for a human instead of resent. |
| "Hired" chosen by mistake | 30-minute confirmation window. Changing the status back cancels the send, and editing the email restarts the window. |
| Columns renamed or moved | Columns are found by header name, with aliases. A missing or ambiguous column stops the run before anything is sent. |
| Status typos | The dropdown is enforced by `setup()`. The daily digest flags "Offer Accepted"-style rows that never qualify. |
| Trigger silently dies | External heartbeat (Healthchecks.io or similar) plus a daily digest that is sent even when all is clear. |
| Gmail quota or outage | Quota checked before sending. Up to 3 retries, then a permanent-failure alert. |
| Broken template | Any unfilled `{{placeholder}}` stops the send. `previewWelcomeEmail()` for review. |
| Old rows backfilled | Start dates more than 30 days in the past are blocked. |
| PHI exposure | The email uses only name, role, start date and supervisor. No client or clinical data. |

## Repository layout

```
apps-script/
  Core.js           pure decision engine: no Google APIs, fully unit-tested
  Main.js           15-minute run cycle: lock, read sheet, decide, two-phase send
  Log.js            protected Welcome Log read/write
  Monitor.js        run history, heartbeat ping, deduplicated alerts, daily digest
  Setup.js          idempotent setup(), status dropdown, preview, go-live helper
  Config.js         settings; secrets come from Script Properties
  WelcomeEmail.html email template
  appsscript.json   manifest with explicit OAuth scopes
tests/
  core.test.js        28 unit tests for the decision engine
  appsscript.test.js  9 integration tests: the real Apps Script files run against in-memory fakes of Sheets/Gmail
demo/               static site (Netlify). Runs the same Core.js in the browser.
docs/               DESIGN.md, RUNBOOK.md, sample-hiring-sheet.csv
```

`Core.js` holds every decision. Apps Script, the Node tests and the browser demo all load that same file. `npm run build:demo` copies it into `demo/`, and CI fails if the copy drifts.

## Run the tests

```bash
npm test          # 37 tests, no dependencies to install (Node 18+)
npm run check:demo
```

## Install in a Google Sheet

1. Import [`docs/sample-hiring-sheet.csv`](docs/sample-hiring-sheet.csv), or rename your existing tab to **Hiring Tracker**. Required columns (any order): Candidate ID, Full Name, Personal Email, Role, Start Date, Supervisor, Hiring Status.
2. **Extensions → Apps Script.** Add each file from `apps-script/` (or use `clasp push` with `.clasp.json.example`).
3. **Project Settings → Script Properties:**
   - `ALERT_EMAILS`: ops inbox(es), comma-separated
   - `HEALTHCHECK_URL`: a free check from healthchecks.io with a 15-minute period and 30-minute grace
   - `DRY_RUN`: `true` for the first week (emails go to ops, not hires)
4. Set `COMPANY_NAME`, `FROM_ALIAS`, `REPLY_TO` and `ONBOARDING_LINK` in `Config.js`.
5. Run `setup()` once and approve the permissions. It creates the protected **Welcome Log** and **Run History** tabs, adds the status dropdown, installs both triggers and sends a test alert.
6. After a clean dry-run week: run `clearDryRunEntries()`, then set `DRY_RUN` to `false`.

Install from a shared operations account rather than a personal one, so the triggers survive staff changes.

## License

MIT
