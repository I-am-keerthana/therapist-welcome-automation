# Automating the new-therapist welcome email

*Practical exercise: Automation & Systems Builder application. Keerthana B. E. Balamurugan.*

> We manually send a welcome email to every new therapist and track hiring in a spreadsheet that several people edit. Sketch how you would automate the welcome email. What would you use? What could go wrong? How would you know if the automation silently stopped working?

## 1. What I would use

**Google Apps Script bound to the existing hiring sheet, sending from a shared Gmail alias** (e.g. `onboarding@`). The team already works in Google Workspace, so this adds no vendor, login or subscription, and hiring data stays inside the Workspace tenant.

How it works:

- **Every 15 minutes, a time-driven trigger scans the sheet.** I chose this over an on-edit trigger, because on-edit fires while someone is still typing and doesn't fire reliably for pasted or imported rows. A scan also heals itself: whatever one run misses, the next run catches.
- **Rows are identified by a Candidate ID**, never by row number or name, so sorting, filtering and inserting rows are safe.
- **A row qualifies** when Hiring Status is "Hired" and the email, start date, role and supervisor all pass validation.
- **30-minute undo window.** A row that qualifies is first recorded as *pending*. If the status changes back within 30 minutes, the send is cancelled. If the email or start date is edited, the window restarts so the corrected version is what goes out.
- **Two-phase send.** The script writes `SENDING` to the log and flushes it, calls Gmail, then writes `SENT` with the Gmail message ID. If a run dies between those steps, the next run asks a human to check the Sent folder instead of guessing and emailing twice.
- **Protected Welcome Log tab** keyed by Candidate ID. Only the script's owner can edit it. `SENT` is final, which is what makes the automation idempotent.
- The template is an HTML file kept in Git. Placeholders like `{{firstName}}` and `{{supervisor}}` must all resolve, or the send stops.

*Alternatives:* Zapier or Make with a "new or updated row" trigger is quicker to set up. But deduplication, the undo window and reconciliation would need workarounds, and every run would add a per-task cost. If hiring later moves to a proper database or ATS (applicant tracking system), the same `Core.js` decision logic carries over. Only the read and send layer changes.

## 2. What could go wrong

| Failure | Mitigation |
|---|---|
| Same hire emailed twice (re-sort, re-edit, run killed mid-send) | Log keyed by Candidate ID; `SENT` final; two-phase `SENDING` → human review |
| "Hired" selected by mistake or on the wrong row | 30-min confirmation window; reverting status cancels |
| Typo in the email address | Format validation blocks the row and alerts, with the reason in plain English |
| Someone renames, moves or duplicates a column | Columns resolved by header name and aliases; missing or ambiguous column stops the run |
| Status spelled differently ("Offer Accepted", "hired ") | Dropdown validation; case- and whitespace-insensitive matching; digest flags near-miss statuses |
| Trigger owner leaves the company or authorization is revoked | Install from a shared ops account; external heartbeat catches it within ~45 min |
| Gmail daily quota or outage | Quota checked first; 3 retries; permanent failure alerts |
| Template edited and broken | Unfilled placeholder stops the send; preview function |
| Old hires backfilled into the sheet | Start dates more than 30 days in the past are blocked |
| Two runs overlap | Script lock |
| PHI in email | Email uses only name, role, start date, supervisor. The hiring sheet should not hold client data. |

## 3. How I would know if it silently stopped

A script can't report that it isn't running, and "no errors" isn't the same as "working". So there are four independent signals:

1. **External heartbeat.** Every successful run pings a monitor outside Google (Healthchecks.io has a free tier). If no ping arrives for 30 minutes past the expected 15, ops gets an email or text. This catches the trigger being deleted, the owner's account being disabled, revoked authorization and Apps Script outages, which are exactly the failures the script itself can't see. Failed runs ping `/fail` for an immediate alert.
2. **Loud failures.** Any exception stops the run before anything is sent, emails ops, and appears in the Run History tab and the Apps Script executions log. Identical alerts are suppressed for 6 hours so people don't learn to ignore them.
3. **Reconciliation of outcomes, not runs.** A daily 8am digest lists every hire starting in the next 14 days who has not been welcomed, with the reason (blocked, failed, or status not "Hired"). This catches the quietest failure: the automation runs perfectly, but a recruiter's row never qualifies.
4. **The digest is sent every day, even when all is clear.** If it stops arriving, that silence is the alert.

## Rollout

1. Add a Candidate ID column, run `setup()` (creates the protected tabs, status dropdown and triggers, and sends a test alert).
2. One week with `DRY_RUN=true`: every welcome email goes to the ops inbox. Compare against the emails still sent by hand.
3. `clearDryRunEntries()`, set `DRY_RUN=false`, keep the digest.
4. Hand over the runbook: each alert, what it means, and the fix.

## Questions I'd ask before building

- Who owns the sheet today, and which statuses are actually used?
- Should the email wait for signed paperwork or a background check?
- One template for everyone, or per location or discipline? Should the supervisor be CC'd?
- Where should replies go, and who should receive alerts?
- Does the sheet contain anything beyond HR data?

## Evidence

- `apps-script/`: complete, deployable implementation
- `tests/`: 37 automated tests, including the real Apps Script files running against fakes of Sheets and Gmail
- `demo/`: interactive simulator using the same `Core.js`, with buttons to inject each failure above
