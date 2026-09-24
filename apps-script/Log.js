/**
 * Welcome Log — the automation's own record of what it has done, keyed by
 * Candidate ID. It lives on a protected tab so recruiters editing the hiring
 * tracker cannot accidentally delete the history that prevents duplicate sends.
 *
 * Deliberately NOT stored as a "Welcome sent?" column on the hiring tracker:
 * shared sheets get sorted, filtered, copy-pasted and rows get deleted, and a
 * status column that moves with the row is too easy to overwrite.
 */
var LOG_COLUMNS = [
  'Candidate ID', 'State', 'Email', 'Start Date', 'Fingerprint', 'First Ready At',
  'Attempts', 'Last Attempt At', 'Sent At', 'Message ID', 'Review Flagged', 'Detail', 'Updated At',
];

var LOG_KEYS = [
  'candidateId', 'state', 'email', 'startDate', 'fingerprint', 'firstReadyAt',
  'attempts', 'lastAttemptAt', 'sentAt', 'messageId', 'reviewFlagged', 'detail', 'updatedAt',
];

var TIME_KEYS = ['firstReadyAt', 'lastAttemptAt', 'sentAt', 'updatedAt'];

function openLog_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.LOG_SHEET);
  if (!sheet) throw new Error('Log sheet "' + CONFIG.LOG_SHEET + '" is missing. Run setup().');

  var values = sheet.getDataRange().getValues();
  if (values[0].join('|') !== LOG_COLUMNS.join('|')) {
    throw new Error('Log sheet header was modified. Restore it before the automation can run safely.');
  }

  var byId = {};
  var rowById = {};
  for (var r = 1; r < values.length; r++) {
    var entry = {};
    LOG_KEYS.forEach(function (k, i) {
      var v = values[r][i];
      entry[k] = TIME_KEYS.indexOf(k) !== -1 && v instanceof Date ? v.getTime() : v;
    });
    entry.attempts = Number(entry.attempts) || 0;
    entry.reviewFlagged = entry.reviewFlagged === true || entry.reviewFlagged === 'TRUE';
    var key = String(entry.candidateId).toLowerCase();
    if (!key) continue;
    byId[key] = entry;
    rowById[key] = r + 1;
  }

  function upsert(candidateId, patch) {
    var key = String(candidateId).toLowerCase();
    var current = byId[key] || { candidateId: candidateId, attempts: 0 };
    var next = Object.assign({}, current, patch, { updatedAt: Date.now() });
    // Clear a stale review flag once a human resolves the row.
    if (patch.state && patch.state !== WelcomeCore.STATES.SENDING && patch.reviewFlagged === undefined) next.reviewFlagged = false;
    byId[key] = next;

    var row = LOG_KEYS.map(function (k) {
      var v = next[k];
      if (TIME_KEYS.indexOf(k) !== -1 && typeof v === 'number') return new Date(v);
      return v === undefined || v === null ? '' : v;
    });
    if (rowById[key]) {
      sheet.getRange(rowById[key], 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
      rowById[key] = sheet.getLastRow();
    }
  }

  return { byId: byId, upsert: upsert, sheet: sheet };
}
