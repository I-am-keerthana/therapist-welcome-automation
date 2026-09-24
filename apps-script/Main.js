/**
 * Main run cycle — executed every 15 minutes by a time-driven trigger.
 *
 * Why a timed scan instead of onEdit:
 *  - onEdit fires mid-typing (status set to Hired before the email is filled in)
 *  - onEdit does not fire for edits made by the Sheets API, imports, or pasted ranges reliably
 *  - a scan is naturally self-healing: anything missed is picked up on the next run
 */
function runWelcomeCycle() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20 * 1000)) {
    // Another run is still working. Not an error, but record it so a stuck lock is visible.
    recordRun_('SKIPPED_LOCKED', { note: 'Previous run still holds the lock' });
    return;
  }

  var summary = { sent: 0, pending: 0, blocked: 0, cancelled: 0, failed: 0, review: 0 };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CONFIG.HIRING_SHEET);
    if (!sheet) throw new Error('Sheet "' + CONFIG.HIRING_SHEET + '" not found. Was it renamed?');

    var values = sheet.getDataRange().getValues();
    var headers = WelcomeCore.mapHeaders(values[0] || []);
    if (headers.missing.length || headers.ambiguous.length) {
      throw new Error('Hiring sheet columns changed. Missing: [' + headers.missing.join(', ') +
        '] Ambiguous: [' + headers.ambiguous.join(', ') + ']. No emails were sent.');
    }

    var records = WelcomeCore.parseRows(values, headers.index);
    var log = openLog_();
    var now = Date.now();
    var actions = WelcomeCore.decide(records, log.byId, now, CONFIG.RULES);

    var sendsNeeded = actions.filter(function (a) { return a.type === 'SEND'; }).length;
    var quota = MailApp.getRemainingDailyQuota();
    if (sendsNeeded > 0 && quota < sendsNeeded + 5) { // keep a margin for alerts
      throw new Error('Gmail daily quota nearly exhausted (' + quota + ' left, ' + sendsNeeded + ' welcome emails queued). Will retry next run.');
    }

    var template = HtmlService.createHtmlOutputFromFile('WelcomeEmail').getContent();

    actions.forEach(function (action) {
      switch (action.type) {
        case 'MARK_PENDING':
          log.upsert(action.candidateId, {
            state: WelcomeCore.STATES.PENDING, email: action.record.email,
            startDate: action.record.startDate, fingerprint: action.fingerprint,
            firstReadyAt: now, detail: action.reason || 'Ready; waiting out confirmation window',
          });
          summary.pending++;
          break;

        case 'SEND':
          if (sendWelcome_(action, log, template, now)) summary.sent++;
          else summary.failed++;
          break;

        case 'CANCEL':
          log.upsert(action.candidateId, { state: WelcomeCore.STATES.CANCELLED, detail: action.reason });
          summary.cancelled++;
          break;

        case 'BLOCK':
          log.upsert(action.candidateId, { state: WelcomeCore.STATES.BLOCKED, email: action.record.email, detail: action.reason });
          alert_('Welcome email blocked: ' + action.candidateId,
            'Row ' + action.record.rowNumber + ' is marked Hired but cannot be emailed:\n\n' + action.reason +
            '\n\nFix the row in "' + CONFIG.HIRING_SHEET + '" and the next run will pick it up.',
            'block:' + action.candidateId + ':' + action.reason);
          summary.blocked++;
          break;

        case 'NEEDS_REVIEW':
          log.upsert(action.candidateId, { reviewFlagged: true, detail: action.reason });
          alert_('Welcome email needs review: ' + action.candidateId, action.reason, 'review:' + action.candidateId);
          summary.review++;
          break;

        case 'GIVE_UP':
          log.upsert(action.candidateId, { state: WelcomeCore.STATES.DEAD, detail: action.reason });
          alert_('Welcome email FAILED permanently: ' + action.candidateId,
            action.reason + '\n\nSend it manually, then set the log state to SENT.', 'dead:' + action.candidateId);
          summary.failed++;
          break;
      }
    });

    recordRun_('OK', summary);
    pingHealthcheck_(true);
  } catch (err) {
    recordRun_('ERROR', { error: String(err && err.message || err) });
    alert_('Welcome automation run failed', String(err && err.stack || err), 'run-error:' + String(err && err.message));
    pingHealthcheck_(false, String(err && err.message || err));
    throw err; // surface in the Apps Script executions log too
  } finally {
    lock.releaseLock();
  }
}

/**
 * Two-phase send. The log is flushed to SENDING before Gmail is called, so if
 * the run is killed mid-send (6-minute limit, outage) the next run sees
 * SENDING and asks a human instead of emailing the new hire twice.
 */
function sendWelcome_(action, log, template, now) {
  var rec = action.record;
  var entry = log.byId[rec.candidateId.toLowerCase()] || {};
  var attempts = (entry.attempts || 0) + 1;
  log.upsert(rec.candidateId, { state: WelcomeCore.STATES.SENDING, attempts: attempts, lastAttemptAt: now, detail: 'Send started' });
  SpreadsheetApp.flush();

  try {
    var settings = { companyName: CONFIG.COMPANY_NAME, senderName: CONFIG.SENDER_NAME, onboardingLink: CONFIG.ONBOARDING_LINK };
    var tz = Session.getScriptTimeZone();
    var data = WelcomeCore.templateData(rec, settings, function (d) { return Utilities.formatDate(d, tz, 'EEEE, MMMM d, yyyy'); });
    var subject = WelcomeCore.renderTemplate(CONFIG.SUBJECT_TEMPLATE, data);
    var body = WelcomeCore.renderTemplate(template, data, { html: true });

    var dryRun = isDryRun_();
    var to = dryRun ? alertEmails_().join(',') : rec.email;
    var options = { htmlBody: body, name: CONFIG.SENDER_NAME };
    if (CONFIG.FROM_ALIAS) options.from = CONFIG.FROM_ALIAS;
    if (CONFIG.REPLY_TO) options.replyTo = CONFIG.REPLY_TO;

    // createDraft().send() returns the message, so we can store its ID as proof of send.
    var message = GmailApp.createDraft(to, (dryRun ? '[DRY RUN for ' + rec.email + '] ' : '') + subject, '', options).send();

    log.upsert(rec.candidateId, {
      state: WelcomeCore.STATES.SENT, sentAt: Date.now(), messageId: message.getId(),
      detail: dryRun ? 'DRY RUN — delivered to ops inbox, not the hire' : 'Sent to ' + rec.email,
    });
    return true;
  } catch (err) {
    log.upsert(rec.candidateId, { state: WelcomeCore.STATES.FAILED, detail: String(err && err.message || err) });
    return false;
  }
}
