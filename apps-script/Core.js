/**
 * WelcomeCore — pure decision logic for the therapist welcome-email automation.
 *
 * This file has no Google Apps Script dependencies. The same file runs in:
 *   - Apps Script (global `WelcomeCore`)
 *   - Node tests   (module.exports)
 *   - the browser demo (window.WelcomeCore)
 *
 * Keeping every decision here means the behaviour that is tested is the
 * behaviour that runs in production.
 */
var WelcomeCore = (function () {
  'use strict';

  // Canonical field -> accepted header spellings (compared after normalising).
  var FIELDS = {
    candidateId: ['candidate id', 'candidate', 'id'],
    fullName: ['full name', 'name', 'therapist name'],
    email: ['personal email', 'email', 'email address'],
    role: ['role', 'position', 'job title'],
    startDate: ['start date', 'start'],
    supervisor: ['supervisor', 'clinical supervisor', 'manager'],
    status: ['hiring status', 'status', 'stage'],
  };

  var REQUIRED_FIELDS = Object.keys(FIELDS);

  var DEFAULTS = {
    readyStatus: 'hired',
    confirmationWindowMinutes: 30, // undo window after a row first becomes ready
    maxAttempts: 3,
    staleStartDays: 30, // never welcome someone who started more than N days ago
    heartbeatStaleMinutes: 60, // no successful run in this long = alert
    atRiskLookaheadDays: 14, // digest flags hires starting within N days with no email sent
  };

  var STATES = {
    PENDING: 'PENDING', // ready, waiting out the confirmation window
    SENDING: 'SENDING', // send started; if a run dies here we must NOT auto-resend
    SENT: 'SENT',
    FAILED: 'FAILED', // send threw; will retry up to maxAttempts
    DEAD: 'DEAD', // retries exhausted; human needed
    BLOCKED: 'BLOCKED', // row is marked hired but data is invalid
    CANCELLED: 'CANCELLED', // status moved away from hired during the window
  };

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9-_]{1,31}$/;
  var MINUTE = 60 * 1000;
  var DAY = 24 * 60 * MINUTE;

  function withDefaults(config) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = config && config[k] !== undefined ? config[k] : DEFAULTS[k];
    });
    return out;
  }

  function normalizeHeader(value) {
    return String(value == null ? '' : value)
      .replace(/[ \s]+/g, ' ')
      .replace(/[*:]/g, '')
      .trim()
      .toLowerCase();
  }

  function clean(value) {
    return String(value == null ? '' : value).replace(/ /g, ' ').trim();
  }

  /**
   * Map a header row to column indexes by name, so re-ordering or inserting
   * columns in a shared sheet never breaks the automation.
   * @return {{index: Object<string, number>, missing: string[], ambiguous: string[]}}
   */
  function mapHeaders(headerRow) {
    var normalized = headerRow.map(normalizeHeader);
    var index = {};
    var missing = [];
    var ambiguous = [];
    REQUIRED_FIELDS.forEach(function (field) {
      var hits = [];
      FIELDS[field].forEach(function (alias) {
        normalized.forEach(function (h, i) {
          if (h === alias && hits.indexOf(i) === -1) hits.push(i);
        });
      });
      if (hits.length === 0) missing.push(field);
      else if (hits.length > 1) ambiguous.push(field);
      else index[field] = hits[0];
    });
    return { index: index, missing: missing, ambiguous: ambiguous };
  }

  /** Convert sheet values (header row first) into plain records. */
  function parseRows(values, index) {
    var records = [];
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var rec = { rowNumber: r + 1 };
      REQUIRED_FIELDS.forEach(function (field) {
        var v = row[index[field]];
        rec[field] = field === 'startDate' ? v : clean(v);
      });
      var blank = REQUIRED_FIELDS.every(function (f) { return clean(rec[f]) === ''; });
      if (!blank) records.push(rec);
    }
    return records;
  }

  /** Accepts a Date, an ISO yyyy-mm-dd string, or m/d/yyyy. Returns Date or null. */
  function parseDate(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    var s = clean(value);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    return null;
  }

  function isoDate(d) {
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function firstName(fullName) {
    return clean(fullName).split(/\s+/)[0] || '';
  }

  /** @return {string[]} human-readable problems; empty means valid. */
  function validateRecord(rec, now, config) {
    var cfg = withDefaults(config);
    var errors = [];
    if (!ID_RE.test(rec.candidateId)) errors.push('Candidate ID is missing or malformed');
    if (!firstName(rec.fullName)) errors.push('Full Name is empty');
    if (!EMAIL_RE.test(rec.email)) errors.push('Personal Email "' + rec.email + '" is not a valid address');
    if (!rec.supervisor) errors.push('Supervisor is empty');
    if (!rec.role) errors.push('Role is empty');
    var start = parseDate(rec.startDate);
    if (!start) errors.push('Start Date is missing or not a date');
    else if (now - start.getTime() > cfg.staleStartDays * DAY) {
      errors.push('Start Date ' + isoDate(start) + ' is more than ' + cfg.staleStartDays + ' days ago (backfilled row?)');
    }
    return errors;
  }

  /**
   * A fingerprint of the fields that change what we would send. If someone
   * corrects the email or start date during the confirmation window, the
   * window restarts so the corrected version is what goes out.
   */
  function fingerprint(rec) {
    var d = parseDate(rec.startDate);
    return [rec.email.toLowerCase(), d ? isoDate(d) : '', rec.fullName, rec.supervisor, rec.role].join('|');
  }

  function duplicateIds(records) {
    var seen = {};
    var dupes = {};
    records.forEach(function (r) {
      var id = r.candidateId.toLowerCase();
      if (!id) return;
      if (seen[id]) dupes[id] = true;
      seen[id] = true;
    });
    return dupes;
  }

  /**
   * Decide what to do for every row. Pure: takes the sheet records, the
   * current log (keyed by lower-cased Candidate ID), and "now".
   *
   * @return {Array<{type: string, candidateId: string, record?: Object, reason?: string, entry?: Object}>}
   *   type is one of MARK_PENDING, SEND, CANCEL, BLOCK, NEEDS_REVIEW, GIVE_UP
   */
  function decide(records, logById, now, config) {
    var cfg = withDefaults(config);
    var dupes = duplicateIds(records);
    var actions = [];

    records.forEach(function (rec) {
      var key = rec.candidateId.toLowerCase();
      var entry = key ? logById[key] : null;
      var ready = clean(rec.status).toLowerCase() === cfg.readyStatus;
      var state = entry ? entry.state : null;

      // A welcome email is sent at most once per Candidate ID, ever.
      if (state === STATES.SENT || state === STATES.DEAD) return;

      // A run died between "sending" and "sent". Gmail may or may not have
      // delivered it. Never guess: flag for a human instead of risking a duplicate.
      if (state === STATES.SENDING) {
        if (!entry.reviewFlagged) {
          actions.push({ type: 'NEEDS_REVIEW', candidateId: rec.candidateId, record: rec,
            reason: 'A previous run stopped mid-send. Check the Sent folder, then set the log state to SENT or FAILED.' });
        }
        return;
      }

      if (!ready) {
        if (state === STATES.PENDING || state === STATES.BLOCKED) {
          actions.push({ type: 'CANCEL', candidateId: rec.candidateId, record: rec,
            reason: 'Status changed to "' + rec.status + '" before the email was sent' });
        }
        return;
      }

      var problems = validateRecord(rec, now, cfg);
      if (key && dupes[key]) problems.unshift('Candidate ID appears on more than one row');
      if (problems.length) {
        var reason = problems.join('; ');
        if (!entry || state !== STATES.BLOCKED || entry.detail !== reason) {
          actions.push({ type: 'BLOCK', candidateId: rec.candidateId || '(row ' + rec.rowNumber + ')', record: rec, reason: reason });
        }
        return;
      }

      var fp = fingerprint(rec);
      if (!entry || state === STATES.BLOCKED || state === STATES.CANCELLED) {
        actions.push({ type: 'MARK_PENDING', candidateId: rec.candidateId, record: rec, fingerprint: fp });
        return;
      }

      if (state === STATES.PENDING) {
        if (entry.fingerprint !== fp) {
          actions.push({ type: 'MARK_PENDING', candidateId: rec.candidateId, record: rec, fingerprint: fp,
            reason: 'Details changed during confirmation window; window restarted' });
        } else if (now - entry.firstReadyAt >= cfg.confirmationWindowMinutes * MINUTE) {
          actions.push({ type: 'SEND', candidateId: rec.candidateId, record: rec, fingerprint: fp });
        }
        return;
      }

      if (state === STATES.FAILED) {
        if ((entry.attempts || 0) >= cfg.maxAttempts) {
          actions.push({ type: 'GIVE_UP', candidateId: rec.candidateId, record: rec,
            reason: 'Send failed ' + entry.attempts + ' times: ' + (entry.detail || 'unknown error') });
        } else {
          actions.push({ type: 'SEND', candidateId: rec.candidateId, record: rec, fingerprint: fp, retry: true });
        }
      }
    });

    return actions;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Fill {{placeholders}}. Throws if any placeholder has no value, so a broken
   * template fails loudly instead of emailing "Hi {{firstName}}" to a new hire.
   */
  function renderTemplate(template, data, options) {
    var html = options && options.html;
    var missing = [];
    var source = html ? String(template).replace(/<!--[\s\S]*?-->/g, '').trim() : String(template);
    var out = source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (_, key) {
      var v = data[key];
      if (v === undefined || v === null || clean(v) === '') { missing.push(key); return ''; }
      return html ? escapeHtml(v) : String(v);
    });
    if (missing.length) throw new Error('Template placeholders have no value: ' + missing.join(', '));
    if (!clean(out)) throw new Error('Rendered template is empty');
    return out;
  }

  function templateData(rec, settings, formatDate) {
    var d = parseDate(rec.startDate);
    return {
      firstName: firstName(rec.fullName),
      fullName: rec.fullName,
      role: rec.role,
      supervisor: rec.supervisor,
      startDate: d ? (formatDate ? formatDate(d) : isoDate(d)) : '',
      companyName: settings.companyName,
      senderName: settings.senderName,
      onboardingLink: settings.onboardingLink,
    };
  }

  /**
   * Answer "has this silently stopped?" from the heartbeat alone.
   * @param {{lastRunAt?: number, lastSuccessAt?: number, lastStatus?: string}} hb
   */
  function evaluateHeartbeat(hb, now, config) {
    var cfg = withDefaults(config);
    var alerts = [];
    if (!hb || !hb.lastSuccessAt) {
      alerts.push('The automation has never completed a successful run.');
      return alerts;
    }
    var ageMin = Math.floor((now - hb.lastSuccessAt) / MINUTE);
    if (ageMin > cfg.heartbeatStaleMinutes) {
      alerts.push('No successful run for ' + ageMin + ' minutes (expected every 15). Trigger may be disabled or the owner account may have lost access.');
    }
    if (hb.lastStatus && hb.lastStatus !== 'OK') {
      alerts.push('Last run finished with status ' + hb.lastStatus + '.');
    }
    return alerts;
  }

  /**
   * Reconciliation: independent of whether runs are "succeeding", find hires
   * who should have been welcomed but were not. Catches the quiet failures —
   * someone typed "Offer Accepted" instead of "Hired", an email is blank, etc.
   */
  function findAtRisk(records, logById, now, config) {
    var cfg = withDefaults(config);
    var out = [];
    records.forEach(function (rec) {
      var start = parseDate(rec.startDate);
      if (!start) return;
      var daysUntil = Math.ceil((start.getTime() - now) / DAY);
      if (daysUntil > cfg.atRiskLookaheadDays || daysUntil < -cfg.staleStartDays) return;
      var status = clean(rec.status).toLowerCase();
      if (status === 'withdrawn' || status === 'rejected' || status === 'declined') return;
      var entry = logById[rec.candidateId.toLowerCase()];
      if (entry && entry.state === STATES.SENT) return;
      // Only rows that look like accepted hires (or are already marked hired).
      var looksHired = status === cfg.readyStatus || /accept|hire|onboard|signed/.test(status);
      if (!looksHired) return;
      out.push({
        candidateId: rec.candidateId,
        fullName: rec.fullName,
        startDate: isoDate(start),
        daysUntil: daysUntil,
        status: rec.status,
        state: entry ? entry.state : 'NOT PICKED UP',
        detail: entry && entry.detail ? entry.detail
          : status !== cfg.readyStatus ? 'Status is "' + rec.status + '", not "Hired" — automation will not act' : '',
      });
    });
    return out.sort(function (a, b) { return a.daysUntil - b.daysUntil; });
  }

  return {
    FIELDS: FIELDS,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    DEFAULTS: DEFAULTS,
    STATES: STATES,
    normalizeHeader: normalizeHeader,
    mapHeaders: mapHeaders,
    parseRows: parseRows,
    parseDate: parseDate,
    isoDate: isoDate,
    firstName: firstName,
    validateRecord: validateRecord,
    fingerprint: fingerprint,
    decide: decide,
    renderTemplate: renderTemplate,
    templateData: templateData,
    evaluateHeartbeat: evaluateHeartbeat,
    findAtRisk: findAtRisk,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WelcomeCore;
if (typeof window !== 'undefined') window.WelcomeCore = WelcomeCore;
