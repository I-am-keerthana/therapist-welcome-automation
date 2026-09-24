/**
 * Configuration. Non-secret settings live here and are reviewed in Git.
 * Anything environment-specific or secret (the heartbeat URL, alert inbox)
 * is read from Script Properties so it never lands in source control.
 *
 * Project Settings -> Script Properties:
 *   HEALTHCHECK_URL   e.g. https://hc-ping.com/<uuid>   (external dead-man's switch)
 *   ALERT_EMAILS      comma-separated ops inboxes
 *   DRY_RUN           "true" sends every welcome email to ALERT_EMAILS instead of the hire
 */
var CONFIG = {
  HIRING_SHEET: 'Hiring Tracker',
  LOG_SHEET: 'Welcome Log', // automation-owned, protected
  RUNS_SHEET: 'Run History', // automation-owned, protected
  RUN_HISTORY_KEEP: 500,

  COMPANY_NAME: 'Our Practice',
  SENDER_NAME: 'People Operations',
  // Send from a shared alias rather than a person, so replies survive staff changes.
  // The alias must be configured under Gmail -> Settings -> Accounts -> "Send mail as".
  FROM_ALIAS: '', // e.g. 'onboarding@yourpractice.com'
  REPLY_TO: '', // e.g. 'people@yourpractice.com'
  ONBOARDING_LINK: 'https://example.com/new-therapist-guide',
  SUBJECT_TEMPLATE: 'Welcome to {{companyName}}, {{firstName}}!',

  RULES: {
    readyStatus: 'hired',
    confirmationWindowMinutes: 30,
    maxAttempts: 3,
    staleStartDays: 30,
    heartbeatStaleMinutes: 60,
    atRiskLookaheadDays: 14,
  },

  RUN_EVERY_MINUTES: 15,
  DIGEST_HOUR: 8, // daily reconciliation digest, script time zone
  ALERT_REPEAT_HOURS: 6, // don't repeat an identical alert more often than this
};

function prop_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === '' ? fallback : v;
}

function alertEmails_() {
  var raw = prop_('ALERT_EMAILS', Session.getEffectiveUser().getEmail());
  return raw.split(',').map(function (s) { return s.trim(); }).filter(String);
}

function isDryRun_() {
  return String(prop_('DRY_RUN', 'true')).toLowerCase() === 'true';
}
