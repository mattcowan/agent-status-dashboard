'use strict';

// Busy lease for Hibearnate (issue #36), the Windows tray app that keeps a
// laptop awake while work runs (github.com/mattcowan/hibearnate).
//
// Hibearnate's Auto mode used to poll GET /api/board and count fresh Working
// cards itself, which meant it had to know this board's data format: column
// keys, archivedAt, sessionEndedAt, lastActiveAt and the six-hour staleness
// rule. Hibearnate issue #6 replaced that with a generic busy-lease API, so the
// dashboard now makes the decision and reports it, as one client among others.
//
// The API is a file: %LOCALAPPDATA%\Hibearnate\leases\<Name>.json holding
// { "Name": "<Name>", "Until": "<ISO 8601 with Z>" }. Hibearnate reads the
// folder every 10 s and counts a lease until Until, but never for more than
// three hours after the file's last write. A crashed server therefore needs no
// cleanup: it stops renewing and the lease runs out by itself. Hibearnate's
// readme ("Tell Auto that a tool is busy") is the spec.
//
// Consequences of that design that shape this module:
//
// - Renewal is a timer, not only the store's 'change' event. A busy board can
//   sit unchanged for an hour while a long tool run works, and the lease must
//   not lapse under it. RENEW_MS against LEASE_MS leaves room for one missed
//   renewal (see the EPERM note in write()).
// - The 'change' event only acts when busy flips. It fires once per debounced
//   save, which during active sessions is many times a minute, and rewriting
//   the lease on each one would buy nothing: the timer already keeps it fresh.
//   A flip, though, is acted on at once, so a card that enters Working reaches
//   Hibearnate within one of its polls rather than one RENEW_MS tick.
// - Releasing does not put the laptop to sleep. Hibearnate still waits its own
//   quiet period after the last busy signal, and no client can force it to
//   Away, so a release here is never a way to cut someone else's work short.

const fs = require('fs');
const path = require('path');

// 23 characters; Hibearnate allows 1 to 24 from [A-Za-z0-9._-], starting with
// a letter or digit, and shows the name in a tray tooltip capped at 63.
const LEASE_NAME = 'claude-status-dashboard';
const RENEW_MS = 60 * 1000;
const LEASE_MS = 3 * 60 * 1000;
// Hibearnate's old DashboardFreshHours: a Working card with no activity for
// this long is a session that went away without an end signal (a crash, a
// reboot), not work in flight. Kept identical so the cut-over changes nothing.
const FRESH_MS = 6 * 60 * 60 * 1000;

// The leases folder, or null when the feature is off: not Windows (Hibearnate
// is Windows only), no LOCALAPPDATA, or turned off with
// CLAUDE_STATUS_HIBEARNATE=0 (also "off" or "false"). Whether Hibearnate is
// installed is checked at each write instead, because it can be installed or
// removed while this server runs.
function leaseDir(env, platform) {
  if (platform !== 'win32') return null;
  if (!env || !env.LOCALAPPDATA) return null;
  const flag = String(env.CLAUDE_STATUS_HIBEARNATE || '').trim().toLowerCase();
  if (flag === '0' || flag === 'off' || flag === 'false') return null;
  return path.join(env.LOCALAPPDATA, 'Hibearnate', 'leases');
}

// The same test Hibearnate's Get-DashboardWorking applied to /api/board:
// in the Working column, not archived, not ended, and active within FRESH_MS.
// updatedAt is the fallback Hibearnate used for a card without lastActiveAt.
// An unparseable stamp counts as not busy: with no trustworthy clock, keeping
// a laptop awake is not a claim this card can make (the same rule the board
// applies to the live badge).
function isBusyCard(card, nowMs) {
  if (!card || card.column !== 'working' || card.archivedAt || card.sessionEndedAt) return false;
  const stamp = Date.parse(card.lastActiveAt || card.updatedAt || '');
  return Number.isFinite(stamp) && stamp > nowMs - FRESH_MS;
}

function anyBusy(cards, nowMs) {
  return (cards || []).some((c) => isBusyCard(c, nowMs));
}

class Lease {
  // opts.dir   the leases folder (leaseDir()); null makes every call a no-op
  // opts.now   clock, injectable for tests
  // opts.fs    fs, injectable so tests can simulate a Windows EPERM
  // opts.log   where a write failure is reported (once per distinct message)
  constructor(opts) {
    const o = opts || {};
    this.dir = o.dir || null;
    this.now = o.now || Date.now;
    this.fs = o.fs || fs;
    this.log = o.log || ((msg) => console.error(msg)); // eslint-disable-line no-console
    // true: our lease file is in place. false: it is not. null: unknown, which
    // is the state at startup, because a previous run that crashed may have
    // left a lease behind; the first idle sync() deletes it rather than leave
    // it to run out.
    this.held = null;
    this._lastError = null;
    this._transient = 0;
  }

  get file() {
    return this.dir ? path.join(this.dir, LEASE_NAME + '.json') : null;
  }

  // Bring the lease in line with the board. renew = true (the timer) rewrites
  // a held lease to push Until out; renew = false (a store change) only acts
  // when busy differs from what is on disk.
  sync(busy, renew) {
    if (!this.dir) return;
    if (busy) {
      if (renew || this.held !== true) this.write();
    } else if (renew || this.held !== false) {
      this.release();
    }
  }

  write() {
    if (!this.dir) return;
    // Never create Hibearnate's own folder. It appears on Hibearnate's first
    // start; without it Hibearnate is not installed, and a lease would only
    // litter %LOCALAPPDATA% for nobody. The leases subfolder is fine to make:
    // Hibearnate reads it but only Busy.ps1 creates it, and this server may be
    // the first client.
    try {
      if (!this.fs.existsSync(path.dirname(this.dir))) {
        this.held = false;
        return;
      }
      if (!this.fs.existsSync(this.dir)) this.fs.mkdirSync(this.dir);
    } catch (err) {
      this._fail(err);
      return;
    }
    const json = JSON.stringify({ Name: LEASE_NAME, Until: new Date(this.now() + LEASE_MS).toISOString() });
    // Temp file plus rename, so Hibearnate never reads half a lease. The temp
    // name must not end in .json: Hibearnate skips everything else in the
    // folder, which is what makes the temp file invisible to it.
    const tmp = this.file + '.' + process.pid + '.tmp';
    try {
      this.fs.writeFileSync(tmp, json, 'utf8');
      this.fs.renameSync(tmp, this.file);
      this.held = true;
      this._ok();
    } catch (err) {
      try { this.fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      // Hibearnate opens the lease for a moment on every poll, and on Windows a
      // rename over an open file fails with EPERM. Unlike store.js's
      // atomicWrite, do NOT fall back to an in-place write: the reader holds
      // the file with FileShare.Read, so that write would fail too, and if it
      // got through it could leave exactly the half-written lease the rename
      // exists to prevent. Skip this renewal instead. held stays as it was, so
      // the next change or timer tick retries, and LEASE_MS outlasts the gap.
      this._fail(err);
    }
  }

  // Also called synchronously on exit, so it must stay synchronous.
  release() {
    if (!this.dir) return;
    try {
      this.fs.unlinkSync(this.file);
    } catch (err) {
      // ENOENT: already gone (never written, or Hibearnate deleted it after it
      // ran out). A transient EPERM (Hibearnate reading it) leaves held as it
      // was, so the next sync() retries.
      if (err.code !== 'ENOENT') {
        this._fail(err);
        return;
      }
    }
    this.held = false;
    this._ok();
  }

  _ok() {
    this._lastError = null;
    this._transient = 0;
  }

  // A failure repeats every RENEW_MS for as long as its cause lasts, so report
  // each distinct message once rather than once a minute. A transient one
  // (EPERM while Hibearnate has the file open) is expected now and then and
  // stays quiet, unless it happens three times in a row: then it is not
  // Hibearnate's read but something lasting, such as a folder ACL.
  _fail(err) {
    if (isTransient(err) && ++this._transient < 3) return;
    const msg = '[hibearnate] lease update failed: ' + ((err && err.message) || err);
    if (msg !== this._lastError) this.log(msg);
    this._lastError = msg;
  }
}

function isTransient(err) {
  return !!err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY');
}

module.exports = {
  LEASE_NAME: LEASE_NAME,
  RENEW_MS: RENEW_MS,
  LEASE_MS: LEASE_MS,
  FRESH_MS: FRESH_MS,
  leaseDir: leaseDir,
  isBusyCard: isBusyCard,
  anyBusy: anyBusy,
  Lease: Lease,
};
