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
//   A flip, though, is acted on at once, so a card that enters a watched
//   column reaches Hibearnate within one of its polls rather than one
//   RENEW_MS tick. A settings save that changes the watched columns is
//   synced the same way (server.js), for the same reason.
// - Releasing does not put the laptop to sleep. Hibearnate still waits its own
//   quiet period after the last busy signal, and no client can force it to
//   Away, so a release here is never a way to cut someone else's work short.

const fs = require('fs');
const path = require('path');

// One lease per server, named after the port it owns. server.js builds the
// lease only after listen() succeeds, so each name has one writer: a second
// server on another port (the scratch copy under PORT=4799 that server changes
// are tested with, or any other PORT override) reports under its own name and
// can neither renew nor delete the live server's lease. With one fixed name it
// did both: an idle copy released the live lease at every RENEW_MS tick, and
// the live server, still holding it as far as it knew, did not write it again
// until its own next tick.
//
// "agent-dashboard-" is 16 characters and a port at most 5 digits, inside
// Hibearnate's 1 to 24 from [A-Za-z0-9._-] starting with a letter or digit; the
// name also shows in Hibearnate's tray tooltip, capped at 63. Agent-neutral
// rather than "claude-...", because the cards are not only Claude Code's and
// the name is something another repo displays: renaming it after release would
// need both sides to agree.
const LEASE_PREFIX = 'agent-dashboard-';
const RENEW_MS = 60 * 1000;
const LEASE_MS = 3 * 60 * 1000;
// A card in a watched column with no activity for this long is a session that
// went away without an end signal (a crash, a reboot), not work in flight.
// The value came from Hibearnate's old DashboardFreshHours, so the #36
// cut-over changed nothing. Since issue #42 it is only the DEFAULT window:
// settings.hibearnate.freshMinutes sets one per column. That matters most for
// a custom column, because no hook moves a card out of one (the Stop backstop
// only leaves Working), so a forgotten card in a watched "Merging" column
// holds the lease until its window runs out. MIRRORED in public/app.js as
// FRESH_DEFAULT (minutes); test/settings.test.js fails if they drift.
const FRESH_MS = 6 * 60 * 60 * 1000;
// What the setting holds when nothing was saved (lib/settings.js DEFAULTS).
const DEFAULT_WATCHED = ['working'];

// The lease name for the port this server bound, or null when there is no
// usable port (server.address() can return null), which turns the lease off
// rather than inventing a name another instance might share.
function leaseName(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? LEASE_PREFIX + n : null;
}

// The leases folder, or null when the feature is off: not Windows (Hibearnate
// is Windows only), no LOCALAPPDATA, or turned off with
// AGENT_STATUS_HIBEARNATE=0 (also "off" or "false"). Whether Hibearnate is
// installed is checked at each write instead, because it can be installed or
// removed while this server runs.
function leaseDir(env, platform) {
  if (platform !== 'win32') return null;
  if (!env || !env.LOCALAPPDATA) return null;
  const flag = String(env.AGENT_STATUS_HIBEARNATE || '').trim().toLowerCase();
  if (flag === '0' || flag === 'off' || flag === 'false') return null;
  return path.join(env.LOCALAPPDATA, 'Hibearnate', 'leases');
}

// The stored setting (hibearnate.columns) reduced to the keys that may count:
// each must be a column on the board right now, and not the Done column,
// whatever the file says. This runs at every use, not only when the setting
// is saved, because the setting and the board change separately: a column
// deleted after the save must stop counting at once, and must not come back
// when a later column reuses its key (addColumn() slugifies the label, so a
// new "Merging" gets the key "merging" again). server.js also prunes the
// stored list on delete; this is the check that holds when that did not run.
// Returns the keys in board order.
function watchedColumns(keys, columns) {
  const want = new Set(Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : []);
  return (columns || [])
    .filter((c) => c && c.kind !== 'done' && want.has(c.key))
    .map((c) => c.key);
}

// The whole setting reduced to what the busy test needs: a Map from each
// watched column's key (watchedColumns() output, so current and not Done) to
// its freshness window in ms. A column without a stored window, or with one
// that is not a positive number, gets FRESH_MS. The window map is read from
// the setting as stored; lib/settings.js has already limited its values to
// the dialog's choices.
function busyRules(hb, columns) {
  const h = hb || {};
  const fresh = h.freshMinutes && typeof h.freshMinutes === 'object' ? h.freshMinutes : {};
  const rules = new Map();
  for (const key of watchedColumns(h.columns, columns)) {
    const min = Object.prototype.hasOwnProperty.call(fresh, key) ? fresh[key] : null;
    rules.set(key, Number.isFinite(min) && min > 0 ? min * 60 * 1000 : FRESH_MS);
  }
  return rules;
}

// Hibearnate's old Get-DashboardWorking test, with the column and its window
// made choices (issue #42): in a watched column, not archived, not ended, and
// active within that column's window. watched is normally busyRules() output,
// a Map of key -> window in ms; a Set of keys is also accepted and gives each
// FRESH_MS. Left out, it is the default setting (Working only, six hours), and
// an empty one means no card is ever busy. updatedAt is the fallback
// Hibearnate used for a card without lastActiveAt. An unparseable stamp counts
// as not busy: with no trustworthy clock, keeping a laptop awake is not a
// claim this card can make (the same rule the board applies to the live
// badge).
//
// 'done' is refused here as well as in watchedColumns(): an archived card is
// moved to Done, and a caller that builds its own Map must still never make
// one busy.
function isBusyCard(card, nowMs, watched) {
  const cols = watched || new Set(DEFAULT_WATCHED);
  if (!card || card.column === 'done' || !cols.has(card.column)) return false;
  if (card.archivedAt || card.sessionEndedAt) return false;
  const windowMs = cols instanceof Map ? cols.get(card.column) : FRESH_MS;
  const stamp = Date.parse(card.lastActiveAt || card.updatedAt || '');
  return Number.isFinite(stamp) && Number.isFinite(windowMs) && stamp > nowMs - windowMs;
}

function anyBusy(cards, nowMs, watched) {
  const cols = watched || new Set(DEFAULT_WATCHED);
  return (cards || []).some((c) => isBusyCard(c, nowMs, cols));
}

class Lease {
  // opts.dir   the leases folder (leaseDir()); null makes every call a no-op
  // opts.name  the lease name (leaseName()); null does the same
  // opts.now   clock, injectable for tests
  // opts.fs    fs, injectable so tests can simulate a Windows EPERM
  // opts.log   where a write failure is reported (once per distinct message)
  constructor(opts) {
    const o = opts || {};
    this.dir = o.dir || null;
    this.name = o.name || null;
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
    return this.dir && this.name ? path.join(this.dir, this.name + '.json') : null;
  }

  // Whether a busy card would really reach Hibearnate: this lease has a file
  // name and Hibearnate's own folder exists (write() refuses to create it).
  // The board uses this to decide whether a watched column's header shows the
  // keep-awake mark (issue #42); without it, a Mac or an opted-out install
  // would show a promise nothing keeps. Checked on each call, not cached,
  // because Hibearnate can be installed or removed while the server runs.
  available() {
    if (!this.file) return false;
    try { return this.fs.existsSync(path.dirname(this.dir)); } catch (_) { return false; }
  }

  // Bring the lease in line with the board. renew = true (the timer) rewrites
  // a held lease to push Until out; renew = false (a store change) only acts
  // when busy differs from what is on disk.
  sync(busy, renew) {
    if (!this.file) return;
    if (busy) {
      if (renew || this.held !== true) this.write();
    } else if (renew || this.held !== false) {
      this.release();
    }
  }

  write() {
    if (!this.file) return;
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
    const json = JSON.stringify({ Name: this.name, Until: new Date(this.now() + LEASE_MS).toISOString() });
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
    if (!this.file) return;
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
  LEASE_PREFIX: LEASE_PREFIX,
  RENEW_MS: RENEW_MS,
  LEASE_MS: LEASE_MS,
  FRESH_MS: FRESH_MS,
  DEFAULT_WATCHED: DEFAULT_WATCHED,
  leaseName: leaseName,
  leaseDir: leaseDir,
  watchedColumns: watchedColumns,
  busyRules: busyRules,
  isBusyCard: isBusyCard,
  anyBusy: anyBusy,
  Lease: Lease,
};
