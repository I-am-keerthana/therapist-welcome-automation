# Runbook: Therapist Welcome Automation

Every alert subject starts with `[Welcome automation]`. Find it below.

## Log states

| State | Meaning | Automation will… |
|---|---|---|
| PENDING | Row is ready; waiting out the 30-minute undo window | send on the first run after the window |
| SENDING | A send started. If this persists, the run died mid-send | ask a human (never auto-resend) |
| SENT | Delivered to Gmail; Message ID recorded | never touch this hire again |
| FAILED | Gmail threw an error | retry, up to 3 attempts |
| DEAD | 3 attempts failed | nothing; a human sends it manually |
| BLOCKED | Row is Hired but data is invalid | re-check every run; proceeds once fixed |
| CANCELLED | Status changed away from Hired during the window | start over if set to Hired again |

## Alerts

### "Welcome email blocked: C-123"
The row is marked Hired, but something is wrong. The alert says what (invalid email, empty supervisor, duplicate Candidate ID, start date in the distant past).
**Fix:** correct the row in Hiring Tracker. The next run moves it to PENDING automatically. Nothing else is needed.

### "Welcome email needs review: C-123"
A run stopped between starting and finishing a send. Gmail may or may not have sent it.
**Fix:** search the sending mailbox's **Sent** folder for the hire's email address.
- Found: set the log row's State to `SENT`.
- Not found: set State to `FAILED`. The next run retries.

### "Welcome email FAILED permanently: C-123"
Gmail rejected the send three times (the detail column has the error).
**Fix:** send the welcome email manually (use `previewWelcomeEmail("C-123")` for the exact content), then set State to `SENT`.

### "Welcome automation run failed"
The whole run stopped before sending anything. Common causes:
- *Hiring sheet columns changed:* someone renamed or deleted a required column, or added a second "Email" column. Restore the header. Required: Candidate ID, Full Name, Personal Email, Role, Start Date, Supervisor, Hiring Status.
- *Sheet "Hiring Tracker" not found:* the tab was renamed. Rename it back or update `CONFIG.HIRING_SHEET`.
- *Log sheet header was modified:* restore the Welcome Log header row (see `LOG_COLUMNS` in `Log.js`).
- *Gmail quota nearly exhausted:* the run resumes automatically when the quota resets. Check whether something else is sending mail from this account.

### Healthchecks.io: check is DOWN
No successful run for 45+ minutes.
1. Open the Apps Script project, then **Executions**. Are runs failing, or absent?
2. Absent: check **Triggers**. If `runWelcomeCycle` is missing, run `setup()` (safe to re-run).
3. Does the owner account still exist and have access to the sheet? If not, reinstall from the shared ops account.
4. Failing: read the error and use the sections above.

### "Daily check: N item(s) need attention"
Lists hires starting within 14 days who haven't been welcomed, each with the reason. The most common is a status that isn't exactly "Hired" (e.g. "Offer Accepted"). Set it to Hired via the dropdown.

### The daily digest didn't arrive
Treat this as the heartbeat being down. Follow the Healthchecks.io steps above.

## Routine tasks

- **Change the email wording:** edit `WelcomeEmail.html`, then run `previewWelcomeEmail("<any Candidate ID>")` and check your inbox before the next hire.
- **Re-send to a hire on purpose:** delete their row from Welcome Log. They are treated as new (with the 30-minute window).
- **Pause everything:** delete the `runWelcomeCycle` trigger. The heartbeat will alert, which is expected. Pause the Healthchecks check too.
- **Hand over ownership:** in the new owner's account, open the project and run `setup()`. Remove the old owner's triggers.
