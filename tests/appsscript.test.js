/**
 * Runs the real Apps Script files (Config, Core, Log, Monitor, Main) inside a
 * Node VM with in-memory fakes for SpreadsheetApp, GmailApp, MailApp, etc.
 * This exercises the I/O layer — two-phase send, log persistence, alerts,
 * heartbeat — without a Google account.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MIN = 60 * 1000;
const FILES = ['Config.js', 'Core.js', 'Log.js', 'Monitor.js', 'Main.js'];

function makeSheet(name, values) {
  const sheet = {
    name,
    values,
    getDataRange: () => ({ getValues: () => sheet.values.map((r) => r.slice()) }),
    getRange: (row, col, nr, nc) => ({
      setValues: (vals) => { for (let i = 0; i < nr; i++) sheet.values[row - 1 + i].splice(col - 1, nc, ...vals[i]); },
    }),
    appendRow: (r) => sheet.values.push(r.slice()),
    getLastRow: () => sheet.values.length,
    deleteRows: (start, n) => sheet.values.splice(start - 1, n),
    deleteRow: (r) => sheet.values.splice(r - 1, 1),
  };
  return sheet;
}

function makeEnv({ hiringRows, header, quota = 1500, gmailFails = 0, props = {} } = {}) {
  const clock = { now: new Date(2026, 8, 24, 9, 0).getTime() };
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }
  const HEADER = header || ['Candidate ID', 'Full Name', 'Personal Email', 'Role', 'Start Date', 'Supervisor', 'Hiring Status'];
  const sheets = {};
  const add = (s) => { sheets[s.name] = s; return s; };
  const hiring = add(makeSheet('Hiring Tracker', [HEADER, ...hiringRows]));
  const ctx = { Date: FakeDate, console: { log() {}, warn() {} }, JSON, Math, String, Number, Object, Array, Error, RegExp, isNaN };
  vm.createContext(ctx);
  // Load the real Apps Script files; LOG_COLUMNS then comes from Log.js itself.
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'), ctx, { filename: f });
  add(makeSheet('Welcome Log', [vm.runInContext('LOG_COLUMNS', ctx).slice()]));
  add(makeSheet('Run History', [['Run At', 'Status', 'Details', 'Mode']]));

  const sent = [];
  const alerts = [];
  const pings = [];
  const store = { DRY_RUN: 'false', ALERT_EMAILS: 'ops@example.com', HEALTHCHECK_URL: 'https://hc-ping.com/abc', ...props };
  let failuresLeft = gmailFails;

  Object.assign(ctx, {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, getUrl: () => 'https://sheet' }),
      flush() {},
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; } }) },
    MailApp: {
      getRemainingDailyQuota: () => quota,
      sendEmail: (a) => alerts.push(typeof a === 'string' ? { to: a } : a),
    },
    GmailApp: {
      createDraft: (to, subject, _b, opts) => ({
        send: () => {
          if (failuresLeft > 0) { failuresLeft--; throw new Error('Service invoked too many times for one day: email.'); }
          sent.push({ to, subject, html: opts.htmlBody });
          return { getId: () => 'msg-' + sent.length };
        },
      }),
    },
    HtmlService: { createHtmlOutputFromFile: () => ({ getContent: () => fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'WelcomeEmail.html'), 'utf8') }) },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: {
      formatDate: (d) => d.toDateString(),
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
      computeDigest: (_alg, s) => [...require('node:crypto').createHash('md5').update(s).digest()],
      DigestAlgorithm: { MD5: 'MD5' },
    },
    UrlFetchApp: { fetch: (url) => pings.push(url) },
    ScriptApp: { getProjectTriggers: () => [] },
  });

  const run = () => { try { vm.runInContext('runWelcomeCycle()', ctx); return null; } catch (e) { return e; } };
  const logRows = () => {
    const [h, ...rows] = sheets['Welcome Log'].values;
    return rows.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
  };
  const advance = (minutes) => { clock.now += minutes * MIN; };
  return { run, advance, sent, alerts, pings, store, sheets, hiring, logRows, ctx };
}

const maya = ['C-101', 'Maya Chen', 'maya.chen@example.com', 'Speech-Language Pathologist', '2026-10-05', 'Dr. Patel', 'Hired'];

test('full lifecycle: pending, sent after the window, then never again', () => {
  const env = makeEnv({ hiringRows: [maya.slice()] });
  assert.equal(env.run(), null);
  assert.equal(env.sent.length, 0);
  assert.equal(env.logRows()[0].State, 'PENDING');

  env.advance(15); env.run();
  assert.equal(env.sent.length, 0, 'still inside the 30-minute window');

  env.advance(20); env.run();
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].to, 'maya.chen@example.com');
  assert.match(env.sent[0].subject, /Welcome to Our Practice, Maya!/);
  assert.match(env.sent[0].html, /Your first day is/);
  assert.doesNotMatch(env.sent[0].html, /\{\{|<!--/);
  assert.equal(env.logRows()[0].State, 'SENT');
  assert.equal(env.logRows()[0]['Message ID'], 'msg-1');

  // Someone sorts the sheet and re-selects Hired: nothing happens.
  env.hiring.values.splice(1, 0, ['C-102', 'Sam Ortiz', 'sam@example.com', 'OT', '2026-10-12', 'Dr. Lee', 'Interviewing']);
  for (let i = 0; i < 10; i++) { env.advance(15); env.run(); }
  assert.equal(env.sent.length, 1);
});

test('every successful run pings the external heartbeat and records run history', () => {
  const env = makeEnv({ hiringRows: [maya.slice()] });
  env.run(); env.advance(15); env.run();
  assert.deepEqual(env.pings, ['https://hc-ping.com/abc', 'https://hc-ping.com/abc']);
  assert.equal(env.sheets['Run History'].values.length, 3);
  assert.equal(env.store.LAST_RUN_STATUS, 'OK');
});

test('a renamed column stops the run, sends nothing, alerts ops and pings /fail', () => {
  const header = ['Candidate ID', 'Full Name', 'Contact', 'Role', 'Start Date', 'Supervisor', 'Hiring Status'];
  const env = makeEnv({ hiringRows: [maya.slice()], header });
  const err = env.run();
  assert.match(String(err), /columns changed/);
  assert.equal(env.sent.length, 0);
  assert.equal(env.store.LAST_RUN_STATUS, 'ERROR');
  assert.ok(env.alerts.some((a) => /run failed/.test(a.subject)));
  assert.equal(env.pings.at(-1), 'https://hc-ping.com/abc/fail');
});

test('identical alerts are deduplicated for six hours', () => {
  const bad = maya.slice(); bad[2] = 'maya.chen@example';
  const env = makeEnv({ hiringRows: [bad] });
  env.run();
  for (let i = 0; i < 8; i++) { env.advance(15); env.run(); }
  const blockAlerts = env.alerts.filter((a) => /blocked/.test(a.subject));
  assert.equal(blockAlerts.length, 1);
  assert.equal(env.logRows()[0].State, 'BLOCKED');
});

test('a Gmail failure retries on later runs and succeeds without duplicates', () => {
  const env = makeEnv({ hiringRows: [maya.slice()], gmailFails: 1 });
  env.run(); env.advance(31); env.run();
  assert.equal(env.logRows()[0].State, 'FAILED');
  assert.equal(env.logRows()[0].Attempts, 1);
  env.advance(15); env.run();
  assert.equal(env.sent.length, 1);
  assert.equal(env.logRows()[0].State, 'SENT');
  assert.equal(env.logRows()[0].Attempts, 2);
});

test('retries are capped and a permanent failure alerts a human', () => {
  const env = makeEnv({ hiringRows: [maya.slice()], gmailFails: 99 });
  env.run();
  for (let i = 0; i < 6; i++) { env.advance(31); env.run(); }
  assert.equal(env.sent.length, 0);
  assert.equal(env.logRows()[0].State, 'DEAD');
  assert.ok(env.alerts.some((a) => /FAILED permanently/.test(a.subject)));
});

test('a run killed mid-send leaves SENDING, and the next run asks a human instead of resending', () => {
  const env = makeEnv({ hiringRows: [maya.slice()] });
  env.run(); env.advance(31);
  // Simulate the 6-minute execution limit killing the run right after Gmail accepted the message.
  const realCreate = env.ctx.GmailApp.createDraft;
  env.ctx.GmailApp.createDraft = (...a) => ({ send: () => { realCreate(...a).send(); throw new Error('Exceeded maximum execution time'); } });
  // The catch in sendWelcome_ would record FAILED; a real kill skips catch blocks entirely,
  // so emulate that by forcing the state the log would be left in.
  env.run();
  const log = env.sheets['Welcome Log'];
  log.values[1][1] = 'SENDING';
  env.ctx.GmailApp.createDraft = realCreate;

  env.advance(15); env.run();
  env.advance(15); env.run();
  assert.equal(env.sent.length, 1, 'only the original send; no automatic duplicate');
  assert.ok(env.alerts.some((a) => /needs review/.test(a.subject)));
});

test('dry run sends to ops, not the hire', () => {
  const env = makeEnv({ hiringRows: [maya.slice()], props: { DRY_RUN: 'true' } });
  env.run(); env.advance(31); env.run();
  assert.equal(env.sent[0].to, 'ops@example.com');
  assert.match(env.sent[0].subject, /^\[DRY RUN for maya.chen@example.com\]/);
});

test('low Gmail quota aborts before sending anything', () => {
  const env = makeEnv({ hiringRows: [maya.slice()], quota: 3 });
  env.run(); env.advance(31);
  const err = env.run();
  assert.match(String(err), /quota/);
  assert.equal(env.sent.length, 0);
  assert.equal(env.logRows()[0].State, 'PENDING', 'stays pending so it is sent once quota resets');
});
