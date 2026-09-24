/**
 * One-time setup and operator utilities. Run from the Apps Script editor.
 * setup() is idempotent — safe to re-run any time (e.g. after a trigger was deleted).
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var hiring = ss.getSheetByName(CONFIG.HIRING_SHEET);
  if (!hiring) throw new Error('Create or rename the hiring tab to "' + CONFIG.HIRING_SHEET + '" first.');
  var headers = WelcomeCore.mapHeaders(hiring.getRange(1, 1, 1, hiring.getLastColumn()).getValues()[0]);
  if (headers.missing.length) throw new Error('Hiring tab is missing columns: ' + headers.missing.join(', '));

  ensureSheet_(CONFIG.LOG_SHEET, LOG_COLUMNS);
  ensureSheet_(CONFIG.RUNS_SHEET, ['Run At', 'Status', 'Details', 'Mode']);
  addStatusValidation_(hiring, headers.index.status);

  // Replace only our own triggers; leave any others in the project alone.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['runWelcomeCycle', 'dailyDigest'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runWelcomeCycle').timeBased().everyMinutes(CONFIG.RUN_EVERY_MINUTES).create();
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(CONFIG.DIGEST_HOUR).everyDays(1).create();

  MailApp.sendEmail(alertEmails_().join(','), '[Welcome automation] Setup complete',
    'Triggers installed. Mode: ' + (isDryRun_() ? 'DRY RUN' : 'LIVE') +
    '.\nIf you received this, alert delivery works.');
  console.log('Setup complete. Dry run = ' + isDryRun_());
}

function ensureSheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
  }
  // Only the script owner can edit the automation's own tabs. Others can read them.
  var protection = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET)[0] || sheet.protect();
  protection.setDescription('Managed by the welcome automation. Edit only via the runbook.');
  protection.removeEditors(protection.getEditors().filter(function (u) {
    return u.getEmail() !== Session.getEffectiveUser().getEmail();
  }));
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
  return sheet;
}

/** A dropdown stops "hired", "Hired ", "HIRED!" and "Offer accepted" drift at the source. */
function addStatusValidation_(sheet, statusColumnIndex) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Applied', 'Interviewing', 'Offer Sent', 'Hired', 'Withdrawn', 'Rejected'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, statusColumnIndex + 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

/** Preview the welcome email for a candidate, sent only to you. Nothing is logged. */
function previewWelcomeEmail(candidateId) {
  candidateId = candidateId || Browser.inputBox('Candidate ID to preview');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.HIRING_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = WelcomeCore.mapHeaders(values[0]);
  var rec = WelcomeCore.parseRows(values, headers.index).filter(function (r) {
    return r.candidateId.toLowerCase() === String(candidateId).toLowerCase();
  })[0];
  if (!rec) throw new Error('No row with Candidate ID ' + candidateId);

  var settings = { companyName: CONFIG.COMPANY_NAME, senderName: CONFIG.SENDER_NAME, onboardingLink: CONFIG.ONBOARDING_LINK };
  var tz = Session.getScriptTimeZone();
  var data = WelcomeCore.templateData(rec, settings, function (d) { return Utilities.formatDate(d, tz, 'EEEE, MMMM d, yyyy'); });
  var template = HtmlService.createHtmlOutputFromFile('WelcomeEmail').getContent();
  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: '[PREVIEW] ' + WelcomeCore.renderTemplate(CONFIG.SUBJECT_TEMPLATE, data),
    htmlBody: WelcomeCore.renderTemplate(template, data, { html: true }),
  });
}

/**
 * Going live: dry-run sends were logged as SENT so they would not repeat.
 * Before switching DRY_RUN to "false", remove those entries so real hires
 * are welcomed. Rows whose start date has already passed stay blocked by
 * the staleStartDays rule.
 */
function clearDryRunEntries() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.LOG_SHEET);
  var values = sheet.getDataRange().getValues();
  var detailCol = LOG_COLUMNS.indexOf('Detail');
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][detailCol]).indexOf('DRY RUN') === 0) sheet.deleteRow(r + 1);
  }
}
