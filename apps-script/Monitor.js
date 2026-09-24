/**
 * Monitoring — answering "how would you know if it silently stopped working?"
 *
 * Four independent layers, because each one catches a failure the others miss:
 *
 *  1. Loud failures      Every exception emails ops (deduplicated) and marks the run ERROR.
 *  2. External heartbeat Each successful run pings Healthchecks.io. If pings stop — trigger
 *                        deleted, script owner left the company, authorization revoked,
 *                        Apps Script outage — the EXTERNAL service alerts. A script cannot
 *                        report that it isn't running; something outside it has to notice.
 *  3. Internal watchdog  The daily digest checks the last-success timestamp and that both
 *                        triggers still exist.
 *  4. Reconciliation     The daily digest compares outcomes, not runs: "hires starting in
 *                        the next 14 days who have not been welcomed." This catches the
 *                        quietest failure — the script runs perfectly but a recruiter typed
 *                        "Offer Accepted" instead of "Hired", so no row ever qualifies.
 */

function recordRun_(status, details) {
  var now = Date.now();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('LAST_RUN_AT', String(now));
  props.setProperty('LAST_RUN_STATUS', status);
  if (status === 'OK') props.setProperty('LAST_SUCCESS_AT', String(now));

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.RUNS_SHEET);
  if (!sheet) return;
  sheet.appendRow([new Date(now), status, JSON.stringify(details || {}), isDryRun_() ? 'DRY RUN' : 'LIVE']);
  var extra = sheet.getLastRow() - 1 - CONFIG.RUN_HISTORY_KEEP;
  if (extra > 0) sheet.deleteRows(2, extra);
}

function heartbeat_() {
  var props = PropertiesService.getScriptProperties();
  return {
    lastRunAt: Number(props.getProperty('LAST_RUN_AT')) || null,
    lastSuccessAt: Number(props.getProperty('LAST_SUCCESS_AT')) || null,
    lastStatus: props.getProperty('LAST_RUN_STATUS'),
  };
}

function pingHealthcheck_(ok, message) {
  var url = prop_('HEALTHCHECK_URL', '');
  if (!url) return;
  try {
    UrlFetchApp.fetch(ok ? url : url + '/fail', {
      method: 'post', payload: message || 'ok', muteHttpExceptions: true,
    });
  } catch (e) {
    // Never let monitoring break the job it monitors; a missed ping becomes an alert anyway.
    console.warn('Healthcheck ping failed: ' + e);
  }
}

/**
 * Send an alert, suppressing identical alerts for ALERT_REPEAT_HOURS so ops
 * aren't trained to ignore a flood of repeats every 15 minutes.
 */
function alert_(subject, body, dedupeKey) {
  var props = PropertiesService.getScriptProperties();
  var key = 'ALERT_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, dedupeKey || subject));
  var last = Number(props.getProperty(key)) || 0;
  if (Date.now() - last < CONFIG.ALERT_REPEAT_HOURS * 3600 * 1000) return;
  props.setProperty(key, String(Date.now()));

  MailApp.sendEmail({
    to: alertEmails_().join(','),
    subject: '[Welcome automation] ' + subject,
    body: body + '\n\nSpreadsheet: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl() +
      '\nRunbook: see docs/RUNBOOK.md in the repository.',
  });
}

/** Daily 8am digest: watchdog + reconciliation + summary. */
function dailyDigest() {
  var now = Date.now();
  var problems = WelcomeCore.evaluateHeartbeat(heartbeat_(), now, CONFIG.RULES);

  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (handlers.indexOf('runWelcomeCycle') === -1) problems.push('The 15-minute trigger for runWelcomeCycle is missing. Run setup().');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.HIRING_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = WelcomeCore.mapHeaders(values[0] || []);
  var atRisk = [];
  var log = openLog_();
  if (headers.missing.length) {
    problems.push('Hiring sheet is missing columns: ' + headers.missing.join(', '));
  } else {
    atRisk = WelcomeCore.findAtRisk(WelcomeCore.parseRows(values, headers.index), log.byId, now, CONFIG.RULES);
  }

  var counts = {};
  Object.keys(log.byId).forEach(function (k) {
    var s = log.byId[k].state;
    counts[s] = (counts[s] || 0) + 1;
  });

  var lines = [];
  lines.push(problems.length ? 'System checks: ATTENTION NEEDED' : 'System checks: passed (runs healthy, triggers installed).');
  problems.forEach(function (p) { lines.push(' - ' + p); });
  lines.push('');
  lines.push('Hires starting soon who have NOT received a welcome email: ' + atRisk.length);
  atRisk.forEach(function (r) {
    lines.push(' - ' + r.fullName + ' (' + r.candidateId + '), starts ' + r.startDate +
      ' (' + r.daysUntil + ' days): ' + r.state + (r.detail ? ' — ' + r.detail : ''));
  });
  lines.push('');
  lines.push('Log totals: ' + JSON.stringify(counts));
  lines.push('Gmail quota remaining today: ' + MailApp.getRemainingDailyQuota());
  lines.push('Mode: ' + (isDryRun_() ? 'DRY RUN (emails go to ops, not hires)' : 'LIVE'));

  var subject = problems.length || atRisk.length
    ? 'Daily check: ' + (problems.length + atRisk.length) + ' item(s) need attention'
    : 'Daily check: all clear';

  // The digest is sent every day, even when all clear. Silence is itself a signal:
  // if ops stop receiving it, the watchdog is down too.
  MailApp.sendEmail({ to: alertEmails_().join(','), subject: '[Welcome automation] ' + subject, body: lines.join('\n') });
}
