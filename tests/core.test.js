const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../apps-script/Core.js');

const MIN = 60 * 1000;
const NOW = new Date(2026, 8, 24, 10, 0).getTime(); // 2026-09-24 10:00 local

const HEADER = ['Candidate ID', 'Full Name', 'Personal Email', 'Role', 'Start Date', 'Supervisor', 'Hiring Status', 'Notes'];

function row(overrides = {}) {
  const r = {
    candidateId: 'C-101', fullName: 'Maya Chen', email: 'maya.chen@example.com',
    role: 'Speech-Language Pathologist', startDate: '2026-10-05', supervisor: 'Dr. Patel',
    status: 'Hired', rowNumber: 2, ...overrides,
  };
  return r;
}

function logOf(entries) {
  const out = {};
  entries.forEach((e) => { out[e.candidateId.toLowerCase()] = e; });
  return out;
}

test('mapHeaders tolerates reordered, re-cased and padded columns', () => {
  const shuffled = ['  hiring status ', 'Notes', 'START DATE', 'Candidate ID', 'Supervisor', 'Role', 'Personal Email', 'Full Name'];
  const { index, missing, ambiguous } = Core.mapHeaders(shuffled);
  assert.deepEqual(missing, []);
  assert.deepEqual(ambiguous, []);
  assert.equal(index.status, 0);
  assert.equal(index.email, 6);
});

test('mapHeaders reports a renamed column instead of guessing', () => {
  const renamed = HEADER.map((h) => (h === 'Personal Email' ? 'Contact' : h));
  assert.deepEqual(Core.mapHeaders(renamed).missing, ['email']);
});

test('mapHeaders flags two columns that both look like email', () => {
  const dup = [...HEADER, 'Email'];
  assert.deepEqual(Core.mapHeaders(dup).ambiguous, ['email']);
});

test('parseRows skips fully blank rows and keeps real row numbers', () => {
  const values = [HEADER, ['', '', '', '', '', '', '', ''], ['C-1', 'A B', 'a@b.co', 'OT', '2026-10-01', 'S', 'Hired', '']];
  const recs = Core.parseRows(values, Core.mapHeaders(HEADER).index);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].rowNumber, 3);
});

test('a newly hired row is held for the confirmation window, not sent immediately', () => {
  const actions = Core.decide([row()], {}, NOW);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'MARK_PENDING');
});

test('a pending row is sent once the window has passed with no changes', () => {
  const r = row();
  const log = logOf([{ candidateId: 'C-101', state: 'PENDING', firstReadyAt: NOW - 31 * MIN, fingerprint: Core.fingerprint(r) }]);
  assert.equal(Core.decide([r], log, NOW)[0].type, 'SEND');
});

test('a pending row is not sent before the window passes', () => {
  const r = row();
  const log = logOf([{ candidateId: 'C-101', state: 'PENDING', firstReadyAt: NOW - 10 * MIN, fingerprint: Core.fingerprint(r) }]);
  assert.deepEqual(Core.decide([r], log, NOW), []);
});

test('editing the email during the window restarts the window', () => {
  const original = row();
  const log = logOf([{ candidateId: 'C-101', state: 'PENDING', firstReadyAt: NOW - 45 * MIN, fingerprint: Core.fingerprint(original) }]);
  const corrected = row({ email: 'maya.c@example.com' });
  const [action] = Core.decide([corrected], log, NOW);
  assert.equal(action.type, 'MARK_PENDING');
  assert.match(action.reason, /restarted/);
});

test('status changed back from Hired during the window cancels the send', () => {
  const log = logOf([{ candidateId: 'C-101', state: 'PENDING', firstReadyAt: NOW - 5 * MIN, fingerprint: 'x' }]);
  assert.equal(Core.decide([row({ status: 'Offer Sent' })], log, NOW)[0].type, 'CANCEL');
});

test('SENT is final: re-sorting, re-editing or re-marking Hired never sends again', () => {
  const log = logOf([{ candidateId: 'C-101', state: 'SENT' }]);
  assert.deepEqual(Core.decide([row({ rowNumber: 40, supervisor: 'Someone else' })], log, NOW), []);
});

test('Candidate ID is matched case-insensitively for idempotency', () => {
  const log = logOf([{ candidateId: 'C-101', state: 'SENT' }]);
  assert.deepEqual(Core.decide([row({ candidateId: 'c-101' })], log, NOW), []);
});

test('a run that died mid-send is flagged for review, never auto-resent', () => {
  const log = logOf([{ candidateId: 'C-101', state: 'SENDING', attempts: 1 }]);
  const [action] = Core.decide([row()], log, NOW);
  assert.equal(action.type, 'NEEDS_REVIEW');
  // ...and only flagged once
  const flagged = logOf([{ candidateId: 'C-101', state: 'SENDING', attempts: 1, reviewFlagged: true }]);
  assert.deepEqual(Core.decide([row()], flagged, NOW), []);
});

test('invalid data on a Hired row is blocked with a readable reason', () => {
  const [action] = Core.decide([row({ email: 'maya.chen@example', supervisor: '' })], {}, NOW);
  assert.equal(action.type, 'BLOCK');
  assert.match(action.reason, /not a valid address/);
  assert.match(action.reason, /Supervisor is empty/);
});

test('the same block reason is not re-raised every run', () => {
  const r = row({ email: 'bad' });
  const [first] = Core.decide([r], {}, NOW);
  const log = logOf([{ candidateId: 'C-101', state: 'BLOCKED', detail: first.reason }]);
  assert.deepEqual(Core.decide([r], log, NOW), []);
});

test('fixing a blocked row moves it to pending', () => {
  const log = logOf([{ candidateId: 'C-101', state: 'BLOCKED', detail: 'old' }]);
  assert.equal(Core.decide([row()], log, NOW)[0].type, 'MARK_PENDING');
});

test('duplicate Candidate IDs block both rows rather than guessing', () => {
  const actions = Core.decide([row(), row({ rowNumber: 3, fullName: 'Other Person' })], {}, NOW);
  assert.equal(actions.length, 2);
  actions.forEach((a) => {
    assert.equal(a.type, 'BLOCK');
    assert.match(a.reason, /more than one row/);
  });
});

test('backfilled historic hires are not welcomed', () => {
  const [action] = Core.decide([row({ startDate: '2026-06-01' })], {}, NOW);
  assert.equal(action.type, 'BLOCK');
  assert.match(action.reason, /more than 30 days ago/);
});

test('failed sends retry up to maxAttempts, then give up and alert', () => {
  const r = row();
  const retry = logOf([{ candidateId: 'C-101', state: 'FAILED', attempts: 2, detail: 'Service invoked too many times' }]);
  const [a] = Core.decide([r], retry, NOW);
  assert.equal(a.type, 'SEND');
  assert.equal(a.retry, true);
  const exhausted = logOf([{ candidateId: 'C-101', state: 'FAILED', attempts: 3, detail: 'boom' }]);
  assert.equal(Core.decide([r], exhausted, NOW)[0].type, 'GIVE_UP');
});

test('status matching ignores case and surrounding whitespace', () => {
  assert.equal(Core.decide([row({ status: '  HIRED ' })], {}, NOW)[0].type, 'MARK_PENDING');
});

test('parseDate accepts Date objects, ISO and US formats and rejects junk', () => {
  assert.equal(Core.isoDate(Core.parseDate(new Date(2026, 9, 5))), '2026-10-05');
  assert.equal(Core.isoDate(Core.parseDate('2026-10-05')), '2026-10-05');
  assert.equal(Core.isoDate(Core.parseDate('10/5/2026')), '2026-10-05');
  assert.equal(Core.parseDate('next Monday'), null);
  assert.equal(Core.parseDate(''), null);
});

test('renderTemplate fills placeholders and escapes HTML', () => {
  const out = Core.renderTemplate('<p>Hi {{firstName}}</p>', { firstName: '<b>Maya</b>' }, { html: true });
  assert.equal(out, '<p>Hi &lt;b&gt;Maya&lt;/b&gt;</p>');
});

test('renderTemplate refuses to send with an unfilled placeholder', () => {
  assert.throws(() => Core.renderTemplate('Hi {{firstName}}, meet {{supervisor}}', { firstName: 'Maya' }), /supervisor/);
});

test('renderTemplate refuses an empty template', () => {
  assert.throws(() => Core.renderTemplate('   ', {}), /empty/);
});

test('renderTemplate strips HTML comments before rendering', () => {
  const out = Core.renderTemplate('<!-- uses {{secret}} --><p>{{firstName}}</p>', { firstName: 'Maya' }, { html: true });
  assert.equal(out, '<p>Maya</p>');
});

test('heartbeat: healthy, stale, and never-run states', () => {
  assert.deepEqual(Core.evaluateHeartbeat({ lastSuccessAt: NOW - 14 * MIN, lastStatus: 'OK' }, NOW), []);
  assert.match(Core.evaluateHeartbeat({ lastSuccessAt: NOW - 3 * 60 * MIN, lastStatus: 'OK' }, NOW)[0], /No successful run for 180 minutes/);
  assert.match(Core.evaluateHeartbeat({}, NOW)[0], /never completed/);
  assert.match(Core.evaluateHeartbeat({ lastSuccessAt: NOW - MIN, lastStatus: 'ERROR' }, NOW)[0], /ERROR/);
});

test('reconciliation finds hires who will start without a welcome — including status typos', () => {
  const records = [
    row({ candidateId: 'C-1', startDate: '2026-09-28' }), // hired, not sent
    row({ candidateId: 'C-2', startDate: '2026-09-29', status: 'Offer Accepted' }), // wrong status word
    row({ candidateId: 'C-3', startDate: '2026-09-30' }), // already sent
    row({ candidateId: 'C-4', startDate: '2026-12-30' }), // too far out
    row({ candidateId: 'C-5', startDate: '2026-09-27', status: 'Withdrawn' }), // withdrew
    row({ candidateId: 'C-6', startDate: '2026-09-27', status: 'Interviewing' }), // not a hire yet
  ];
  const log = logOf([{ candidateId: 'C-3', state: 'SENT' }]);
  const risk = Core.findAtRisk(records, log, NOW);
  assert.deepEqual(risk.map((r) => r.candidateId), ['C-1', 'C-2']);
  assert.match(risk[1].detail, /not "Hired"/);
});

test('end-to-end: hire -> pending -> sent -> never again', () => {
  const log = {};
  const apply = (actions, now) => actions.forEach((a) => {
    const key = a.candidateId.toLowerCase();
    if (a.type === 'MARK_PENDING') log[key] = { candidateId: a.candidateId, state: 'PENDING', firstReadyAt: now, fingerprint: a.fingerprint };
    if (a.type === 'SEND') log[key] = { ...log[key], state: 'SENT' };
  });
  const r = row();
  let sends = 0;
  for (let t = 0; t <= 24 * 60; t += 15) {
    const now = NOW + t * MIN;
    const actions = Core.decide([r], log, now);
    sends += actions.filter((a) => a.type === 'SEND').length;
    apply(actions, now);
  }
  assert.equal(sends, 1);
  assert.equal(log['c-101'].state, 'SENT');
});

test('templateData uses the first name and a custom date formatter', () => {
  const d = Core.templateData(row(), { companyName: 'X', senderName: 'Y', onboardingLink: 'Z' }, () => 'Monday, October 5, 2026');
  assert.equal(d.firstName, 'Maya');
  assert.equal(d.startDate, 'Monday, October 5, 2026');
});

