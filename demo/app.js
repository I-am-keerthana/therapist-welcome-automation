/*
 * Browser simulator. Every decision comes from WelcomeCore (core.js), which
 * is generated from apps-script/Core.js — the same file deployed to Apps Script.
 * This file only plays the role of Sheets, Gmail, the trigger and the
 * external heartbeat monitor, mirroring apps-script/Main.js and Monitor.js.
 */
(function () {
  'use strict';

  var Core = window.WelcomeCore;
  var MIN = 60 * 1000;
  var RULES = {
    readyStatus: 'hired', confirmationWindowMinutes: 30, maxAttempts: 3,
    staleStartDays: 30, heartbeatStaleMinutes: 60, atRiskLookaheadDays: 14,
  };
  var SETTINGS = { companyName: 'Our Practice', senderName: 'People Operations', onboardingLink: 'https://example.com/new-therapist-guide' };
  var SUBJECT = 'Welcome to {{companyName}}, {{firstName}}!';
  var HC_PERIOD_MIN = 15;
  var HC_GRACE_MIN = 30;
  var ALERT_REPEAT_MS = 6 * 60 * MIN;
  var DAILY_QUOTA = 1500;
  var STATUSES = ['Applied', 'Interviewing', 'Offer Sent', 'Offer Accepted', 'Hired', 'Withdrawn'];
  var COLUMNS = [
    { key: 'candidateId', header: 'Candidate ID' },
    { key: 'fullName', header: 'Full Name', mid: true },
    { key: 'email', header: 'Personal Email', wide: true },
    { key: 'role', header: 'Role', wide: true },
    { key: 'startDate', header: 'Start Date', type: 'date' },
    { key: 'supervisor', header: 'Supervisor', mid: true },
    { key: 'status', header: 'Hiring Status', type: 'status' },
  ];

  var fault = { rename: false, trigger: false, gmail: false, crash: false };
  var S;

  function Killed(message) { this.message = message; }

  function initialState() {
    var start = new Date();
    start.setHours(9, 0, 0, 0);
    var d = function (days) { var x = new Date(start); x.setDate(x.getDate() + days); return Core.isoDate(x); };
    return {
      now: start.getTime(),
      rows: [
        { candidateId: 'C-201', fullName: 'Maya Chen', email: 'maya.chen@example.com', role: 'Speech-Language Pathologist', startDate: d(11), supervisor: 'Dr. Anita Patel', status: 'Hired' },
        { candidateId: 'C-202', fullName: 'Jordan Reyes', email: 'jordan.reyes@example.com', role: 'Occupational Therapist', startDate: d(18), supervisor: 'Dr. Marcus Lee', status: 'Offer Sent' },
        { candidateId: 'C-203', fullName: 'Priya Nair', email: 'priya.nair@gmail', role: 'Physical Therapist', startDate: d(6), supervisor: 'Dr. Anita Patel', status: 'Hired' },
        { candidateId: 'C-204', fullName: 'Sam Okafor', email: 'sam.okafor@example.com', role: 'BCBA', startDate: d(9), supervisor: 'Dr. Marcus Lee', status: 'Offer Accepted' },
        { candidateId: 'C-205', fullName: 'Lucas Kim', email: 'lucas.kim@example.com', role: 'Mental Health Therapist', startDate: d(25), supervisor: 'Dr. Rosa Alvarez', status: 'Interviewing' },
      ],
      log: {},
      outbox: [],
      alerts: [],
      runs: [],
      hb: { lastRunAt: null, lastSuccessAt: null, lastStatus: null },
      monitor: { lastPingAt: null, failed: false, state: 'NEW' },
      dedupe: {},
      nextId: 206,
      sentToday: 0,
    };
  }

  // ---------- helpers ----------
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }
  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function pill(text, cls) { return el('span', { class: 'pill ' + (cls || text), text: text }); }
  function fmt(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function ago(ms) {
    if (!ms) return 'never';
    var m = Math.round((S.now - ms) / MIN);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    return h + ' h ' + (m % 60) + ' min ago';
  }
  function fmtLong(d) { return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }

  // ---------- fake Google services ----------
  function sheetValues() {
    var header = COLUMNS.map(function (c) { return fault.rename && c.key === 'email' ? 'Contact' : c.header; });
    return [header].concat(S.rows.map(function (r) { return COLUMNS.map(function (c) { return r[c.key]; }); }));
  }

  function upsert(candidateId, patch) {
    var key = String(candidateId).toLowerCase();
    var current = S.log[key] || { candidateId: candidateId, attempts: 0 };
    var next = Object.assign({}, current, patch, { updatedAt: S.now });
    if (patch.state && patch.state !== Core.STATES.SENDING && patch.reviewFlagged === undefined) next.reviewFlagged = false;
    S.log[key] = next;
  }

  function alertOps(level, subject, body, dedupeKey) {
    var key = dedupeKey || subject;
    if (S.dedupe[key] && S.now - S.dedupe[key] < ALERT_REPEAT_MS) return;
    S.dedupe[key] = S.now;
    S.alerts.unshift({ level: level, subject: subject, body: body, at: S.now });
  }

  function recordRun(status, details) {
    S.hb.lastRunAt = S.now;
    S.hb.lastStatus = status;
    if (status === 'OK') S.hb.lastSuccessAt = S.now;
    S.runs.unshift({ at: S.now, status: status, details: details });
  }

  function ping(ok) {
    S.monitor.lastPingAt = S.now;
    S.monitor.failed = !ok;
  }

  /** Healthchecks.io-style evaluation: runs outside the script, so it notices when the script doesn't run at all. */
  function evaluateMonitor() {
    var m = S.monitor;
    var prev = m.state;
    if (!m.lastPingAt) m.state = 'NEW';
    else if (m.failed) m.state = 'DOWN';
    else {
      var age = (S.now - m.lastPingAt) / MIN;
      m.state = age > HC_PERIOD_MIN + HC_GRACE_MIN ? 'DOWN' : age > HC_PERIOD_MIN ? 'LATE' : 'UP';
    }
    if (m.state === 'DOWN' && prev !== 'DOWN') {
      S.alerts.unshift({ level: 'bad', source: 'Healthchecks.io (external)', at: S.now,
        subject: 'Check "Welcome automation" is DOWN',
        body: m.failed ? 'The last run reported a failure.' : 'No ping received for ' + Math.round((S.now - m.lastPingAt) / MIN) + ' minutes (expected every 15). The trigger may be gone or the owner account may have lost access.' });
    }
    if (m.state === 'UP' && prev === 'DOWN') {
      S.alerts.unshift({ level: 'info', source: 'Healthchecks.io (external)', at: S.now, subject: 'Check "Welcome automation" is UP again', body: 'Pings resumed.' });
    }
  }

  // ---------- the run cycle (mirrors apps-script/Main.js) ----------
  function runCycle() {
    var summary = { sent: 0, pending: 0, blocked: 0, cancelled: 0, failed: 0, review: 0 };
    try {
      var values = sheetValues();
      var headers = Core.mapHeaders(values[0]);
      if (headers.missing.length || headers.ambiguous.length) {
        throw new Error('Hiring sheet columns changed. Missing: [' + headers.missing.join(', ') +
          '] Ambiguous: [' + headers.ambiguous.join(', ') + ']. No emails were sent.');
      }
      var records = Core.parseRows(values, headers.index);
      var actions = Core.decide(records, S.log, S.now, RULES);

      var sendsNeeded = actions.filter(function (a) { return a.type === 'SEND'; }).length;
      if (sendsNeeded > 0 && DAILY_QUOTA - S.sentToday < sendsNeeded + 5) throw new Error('Gmail daily quota nearly exhausted.');

      actions.forEach(function (a) {
        if (a.type === 'MARK_PENDING') {
          upsert(a.candidateId, { state: 'PENDING', email: a.record.email, fingerprint: a.fingerprint, firstReadyAt: S.now,
            detail: a.reason || 'Ready; waiting out ' + RULES.confirmationWindowMinutes + '-minute confirmation window' });
          summary.pending++;
        } else if (a.type === 'SEND') {
          if (send(a)) summary.sent++; else summary.failed++;
        } else if (a.type === 'CANCEL') {
          upsert(a.candidateId, { state: 'CANCELLED', detail: a.reason });
          summary.cancelled++;
        } else if (a.type === 'BLOCK') {
          upsert(a.candidateId, { state: 'BLOCKED', email: a.record.email, detail: a.reason });
          alertOps('warn', 'Welcome email blocked: ' + a.candidateId,
            'Row ' + a.record.rowNumber + ' is marked Hired but cannot be emailed: ' + a.reason + '. Fix the row and the next run picks it up.',
            'block:' + a.candidateId + ':' + a.reason);
          summary.blocked++;
        } else if (a.type === 'NEEDS_REVIEW') {
          upsert(a.candidateId, { reviewFlagged: true, detail: a.reason });
          alertOps('bad', 'Welcome email needs review: ' + a.candidateId, a.reason, 'review:' + a.candidateId);
          summary.review++;
        } else if (a.type === 'GIVE_UP') {
          upsert(a.candidateId, { state: 'DEAD', detail: a.reason });
          alertOps('bad', 'Welcome email FAILED permanently: ' + a.candidateId, a.reason + ' Send manually, then mark SENT.', 'dead:' + a.candidateId);
          summary.failed++;
        }
      });
      recordRun('OK', summary);
      ping(true);
    } catch (err) {
      if (err instanceof Killed) {
        // A killed execution never reaches its catch/finally: no run record, no heartbeat.
        S.runs.unshift({ at: S.now, status: 'KILLED', details: { note: err.message } });
        return;
      }
      recordRun('ERROR', { error: err.message });
      alertOps('bad', 'Welcome automation run failed', err.message, 'run-error:' + err.message);
      ping(false);
    }
  }

  function send(a) {
    var rec = a.record;
    var entry = S.log[rec.candidateId.toLowerCase()] || {};
    var attempts = (entry.attempts || 0) + 1;
    upsert(rec.candidateId, { state: 'SENDING', attempts: attempts, lastAttemptAt: S.now, detail: 'Send started' });
    try {
      var data = Core.templateData(rec, SETTINGS, fmtLong);
      var subject = Core.renderTemplate(SUBJECT, data);
      var body = Core.renderTemplate(window.WELCOME_TEMPLATE, data, { html: true });
      if (fault.gmail) throw new Error('Gmail: Service unavailable. Try again later.');
      var id = 'msg-' + (S.outbox.length + 1);
      S.outbox.unshift({ id: id, to: rec.email, subject: subject, body: body, at: S.now });
      S.sentToday++;
      if (fault.crash) {
        fault.crash = false;
        $('f-crash').checked = false;
        throw new Killed('Execution killed right after Gmail accepted the message (simulated time limit). Log left at SENDING.');
      }
      upsert(rec.candidateId, { state: 'SENT', sentAt: S.now, messageId: id, detail: 'Sent to ' + rec.email });
      return true;
    } catch (err) {
      if (err instanceof Killed) throw err;
      upsert(rec.candidateId, { state: 'FAILED', detail: err.message });
      return false;
    }
  }

  function dailyDigest() {
    var problems = Core.evaluateHeartbeat(S.hb, S.now, RULES);
    if (fault.trigger) problems.push('The 15-minute trigger for runWelcomeCycle is missing. Run setup().');
    var values = sheetValues();
    var headers = Core.mapHeaders(values[0]);
    var atRisk = [];
    if (headers.missing.length) problems.push('Hiring sheet is missing columns: ' + headers.missing.join(', '));
    else atRisk = Core.findAtRisk(Core.parseRows(values, headers.index), S.log, S.now, RULES);

    var lines = [problems.length ? 'System checks: ATTENTION NEEDED' : 'System checks: passed (runs healthy, triggers installed).'];
    problems.forEach(function (p) { lines.push(' - ' + p); });
    lines.push('');
    lines.push('Starting soon, NOT yet welcomed: ' + atRisk.length);
    atRisk.forEach(function (r) {
      lines.push(' - ' + r.fullName + ' (' + r.candidateId + '), starts ' + r.startDate + ' (' + r.daysUntil + ' days): ' + r.state + (r.detail ? ' — ' + r.detail : ''));
    });
    lines.push('');
    lines.push('Gmail quota remaining: ' + (DAILY_QUOTA - S.sentToday));
    var n = problems.length + atRisk.length;
    S.alerts.unshift({ level: n ? 'warn' : 'info', digest: true, at: S.now,
      subject: 'Daily check: ' + (n ? n + ' item(s) need attention' : 'all clear'), body: lines.join('\n') });
  }

  // ---------- rendering ----------
  function renderClock() { $('clock').textContent = fmt(S.now); }

  function renderSheet() {
    var table = clear($('sheet'));
    var thead = el('thead', null, el('tr', null,
      el('th', { text: '#' }),
      COLUMNS.map(function (c) {
        var renamed = fault.rename && c.key === 'email';
        return el('th', { class: renamed ? 'renamed' : null, text: renamed ? 'Contact' : c.header, title: renamed ? 'Someone renamed this column' : null });
      }).reduce(function (f, n) { f.appendChild(n); return f; }, document.createDocumentFragment()),
      el('th', { 'aria-label': 'Delete row' })));
    var tbody = el('tbody');
    S.rows.forEach(function (row, i) {
      var tr = el('tr', null, el('td', { class: 'muted', text: String(i + 2) }));
      COLUMNS.forEach(function (c) {
        var input;
        var label = c.header + ' for row ' + (i + 2);
        if (c.type === 'status') {
          input = el('select', { 'aria-label': label });
          STATUSES.forEach(function (s) { input.appendChild(el('option', { value: s, text: s, selected: s === row.status })); });
        } else {
          input = el('input', { type: c.type === 'date' ? 'date' : 'text', value: row[c.key], 'aria-label': label, spellcheck: 'false' });
        }
        input.addEventListener('change', function () { row[c.key] = input.value; renderPanels(); });
        tr.appendChild(el('td', { class: c.wide ? 'wide' : c.mid ? 'mid' : null }, input));
      });
      tr.appendChild(el('td', null, el('button', { class: 'rowdel', title: 'Delete row', 'aria-label': 'Delete row ' + (i + 2), text: '×',
        onclick: function () { S.rows.splice(i, 1); renderAll(); } })));
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
  }

  function renderLog() {
    var table = clear($('log'));
    table.appendChild(el('thead', null, el('tr', null,
      el('th', { text: 'Candidate' }), el('th', { text: 'State' }), el('th', { text: 'Tries' }), el('th', { text: 'Detail' }))));
    var tbody = el('tbody');
    var keys = Object.keys(S.log);
    if (!keys.length) tbody.appendChild(el('tr', null, el('td', { colspan: '4', class: 'muted', text: 'Empty. Run the trigger to see the automation act.' })));
    keys.sort().forEach(function (k) {
      var e = S.log[k];
      var stateCell = el('td', null, pill(e.state || '—', e.reviewFlagged ? 'REVIEW' : e.state));
      if (e.state === 'SENDING' && e.reviewFlagged) {
        stateCell.appendChild(el('div', { class: 'small', style: 'margin-top:4px' },
          el('button', { class: 'btn', style: 'min-height:26px;padding:2px 8px;font-size:12px;margin-right:4px', text: 'Found in Sent → SENT',
            onclick: function () { upsert(e.candidateId, { state: 'SENT', detail: 'Confirmed in Sent folder by ops (runbook step)' }); renderPanels(); } }),
          el('button', { class: 'btn', style: 'min-height:26px;padding:2px 8px;font-size:12px', text: 'Not sent → retry',
            onclick: function () { upsert(e.candidateId, { state: 'FAILED', detail: 'Not found in Sent folder; released for retry by ops' }); renderPanels(); } })));
      }
      var detail = e.detail || '';
      if (e.state === 'PENDING' && e.firstReadyAt) {
        var left = RULES.confirmationWindowMinutes - Math.round((S.now - e.firstReadyAt) / MIN);
        detail += left > 0 ? ' (' + left + ' min left)' : ' (sends on next run)';
      }
      if (e.state === 'SENDING' && !e.reviewFlagged) detail = 'Send started; outcome unknown';
      tbody.appendChild(el('tr', null, el('td', { text: e.candidateId }), stateCell, el('td', { text: String(e.attempts || 0) }), el('td', { class: 'detail', text: detail })));
    });
    table.appendChild(tbody);
  }

  function renderOutbox() {
    var ul = clear($('outbox'));
    $('outbox-count').textContent = String(S.outbox.length);
    if (!S.outbox.length) ul.appendChild(el('li', { class: 'empty', text: 'No emails sent yet.' }));
    S.outbox.forEach(function (m) {
      ul.appendChild(el('li', null,
        el('div', { class: 'meta' }, el('span', { text: 'To ' + m.to }), el('span', { text: fmt(m.at) })),
        el('button', { class: 'linklike', text: m.subject, onclick: function () { openPreview(m); } })));
    });
  }

  function renderAlerts() {
    var ul = clear($('alerts'));
    $('alert-count').textContent = String(S.alerts.length);
    if (!S.alerts.length) ul.appendChild(el('li', { class: 'empty', text: 'No alerts. Quiet is good, and the daily digest confirms it really is quiet.' }));
    S.alerts.forEach(function (a) {
      ul.appendChild(el('li', { class: 'alert-' + a.level + (a.digest ? ' digest' : '') },
        el('div', { class: 'meta' }, el('span', { text: a.source || (a.digest ? 'Daily digest → ops inbox' : 'Apps Script → ops inbox') }), el('span', { text: fmt(a.at) })),
        el('strong', { text: a.subject }), el('div', { text: a.body })));
    });
  }

  function renderRuns() {
    var ul = clear($('runs'));
    if (!S.runs.length) ul.appendChild(el('li', { class: 'empty', text: fault.trigger ? 'The trigger is not firing, so no runs are recorded.' : 'No runs yet.' }));
    S.runs.forEach(function (r) {
      var d = r.details || {};
      var text = d.error || d.note || Object.keys(d).filter(function (k) { return d[k]; }).map(function (k) { return d[k] + ' ' + k; }).join(', ') || 'nothing to do';
      ul.appendChild(el('li', null, el('div', { class: 'meta' }, el('span', { text: fmt(r.at) }), pill(r.status)), el('div', { text: text })));
    });
  }

  function renderHealth() {
    var box = clear($('health'));
    var m = S.monitor;
    var hbProblems = S.hb.lastSuccessAt ? Core.evaluateHeartbeat(S.hb, S.now, RULES) : [];
    function row(label, value) { box.appendChild(el('div', { class: 'row' }, el('span', { text: label }), value)); }
    row('External heartbeat', pill(m.state === 'NEW' ? 'WAITING' : m.state, m.state === 'NEW' ? '' : m.state));
    row('Last ping', el('span', { text: ago(m.lastPingAt) }));
    row('Last successful run', el('span', { text: ago(S.hb.lastSuccessAt) }));
    row('Last run status', S.hb.lastStatus ? pill(S.hb.lastStatus) : el('span', { class: 'muted', text: '—' }));
    row('Internal watchdog', hbProblems.length ? pill('WARN') : pill(S.hb.lastSuccessAt ? 'OK' : '—', S.hb.lastSuccessAt ? 'OK' : ''));
    row('Triggers installed', fault.trigger ? pill('MISSING', 'DOWN') : pill('OK'));
    row('Gmail quota left today', el('span', { text: String(DAILY_QUOTA - S.sentToday) }));
  }

  function renderPanels() { renderClock(); renderLog(); renderOutbox(); renderAlerts(); renderRuns(); renderHealth(); }
  function renderAll() { renderSheet(); renderPanels(); }

  function openPreview(m) {
    $('preview-subject').textContent = m.subject;
    $('preview-meta').textContent = 'To ' + m.to + ' · ' + fmt(m.at) + ' · ' + m.id;
    // Body is rendered by Core.renderTemplate with html:true, which escapes every sheet value.
    $('preview-body').innerHTML = m.body;
    $('preview').showModal();
  }

  // ---------- controls ----------
  function tick(minutes) {
    var steps = minutes / 15;
    for (var i = 0; i < steps; i++) {
      S.now += 15 * MIN;
      if (!fault.trigger) runCycle();
      evaluateMonitor();
    }
    renderPanels();
  }

  $('run').addEventListener('click', function () { tick(15); });
  $('hour').addEventListener('click', function () { tick(60); });
  $('digest').addEventListener('click', function () { dailyDigest(); renderPanels(); });
  $('add').addEventListener('click', function () {
    S.rows.push({ candidateId: 'C-' + S.nextId++, fullName: '', email: '', role: '', startDate: '', supervisor: '', status: 'Applied' });
    renderAll();
    var inputs = $('sheet').querySelectorAll('tbody tr:last-child input');
    if (inputs[1]) inputs[1].focus();
  });
  $('reset').addEventListener('click', function () {
    Object.keys(fault).forEach(function (k) { fault[k] = false; $('f-' + k).checked = false; });
    S = initialState();
    renderAll();
  });
  Object.keys(fault).forEach(function (k) {
    $('f-' + k).addEventListener('change', function (e) { fault[k] = e.target.checked; renderAll(); });
  });

  S = initialState();
  renderAll();
})();
