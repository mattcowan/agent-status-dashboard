'use strict';

// Server-side settings, persisted to their own data/settings.json (kept out of
// board.json on purpose: board saves are debounced and reset-on-corrupt, and a
// settings blob shouldn't ride along with card churn).

const path = require('path');

const { DATA_DIR, atomicWrite, readJsonSafe } = require('./store');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  usagePoll: {
    enabled: false,       // background polling of the usage endpoint is opt-in
    intervalMs: 600000,   // 10 min
  },
  // Whether a session may mark its own card ended (`status.js end`, issue
  // #33). Off by default: ending is otherwise a fact reported by the
  // SessionEnd hook, and letting Claude assert it is a change in what the
  // "ended" badge means, which is the user's call to make, not an install's.
  selfEnd: {
    enabled: false,
  },
  // The column keys whose fresh cards keep the Hibearnate busy lease (issue
  // #42, lib/hibearnate.js). Working only by default, which is the rule the
  // lease had before the setting existed. An empty list is a real choice: the
  // server then never takes the lease. Edited from ⚙ Settings and from
  // Hibearnate's tray menu (mattcowan/hibearnate#12), which POSTs the whole
  // list rather than a toggle.
  //
  // freshMinutes: how recent a card's last activity must be for it to count,
  // per column key. A column with no entry uses the default, 6 hours
  // (hibearnate.FRESH_MS). The user's answer to #42's open question: a
  // forgotten card in a watched custom column held the lease for six hours,
  // since no hook moves a card out of a custom column, and the right window
  // for a "Merging" column is not the right one for Working. Edited from
  // ⚙ Settings only; Hibearnate's tray POSTs `columns` alone, and the
  // one-level merge in flatten() keeps this map when it does.
  //
  // Only the SHAPE is checked here (CLEANERS). Whether each key is a
  // current, non-Done column depends on the board, which this module does not
  // own: server.js filters on write and prunes on column delete, and
  // hibearnate.busyRules() filters again at every use.
  hibearnate: {
    columns: ['working'],
    freshMinutes: {},
  },
};

// The windows the dialog offers, in minutes. A stored value outside this set
// (hand-edited file) is dropped and the column falls back to the default,
// rather than kept: the dialog's <select> could not show it, and Save would
// silently replace it with whatever option the browser picked. MIRRORED in
// public/app.js (FRESH_CHOICES there); change both together.
const FRESH_CHOICES = [30, 60, 120, 180, 360, 720, 1440];

// Column keys are slugify() output: [a-z0-9_], at most 40 characters, plus a
// "_<n>" suffix that addColumn() adds on a clash. 64 leaves room for that
// suffix. The count cap only bounds what a hand-edited file can make us
// carry; a board with more columns than this is not a real board.
const COLUMN_KEY_RE = /^[a-z0-9_]{1,64}$/;
const MAX_WATCHED = 50;

// An array of distinct column-key strings, or null when the value is not an
// array at all (so a caller can tell "wrong type" from "empty list").
function cleanColumnKeys(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const key of value) {
    if (typeof key === 'string' && COLUMN_KEY_RE.test(key) && !(key in Object.prototype) && !out.includes(key)) out.push(key);
    if (out.length >= MAX_WATCHED) break;
  }
  return out;
}

// A { columnKey: minutes } map holding only well-formed keys and minutes from
// FRESH_CHOICES, or null when the value is not a plain object. "__proto__"
// and "constructor" pass COLUMN_KEY_RE (underscores are legal), and JSON.parse
// makes "__proto__" an own key, so prototype member names are refused the
// same way isReservedId() refuses them as card ids in lib/store.js: assigning
// out.__proto__ would be a prototype write, not a map entry.
function cleanFreshMinutes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  let n = 0;
  for (const key of Object.keys(value)) {
    const min = value[key];
    if (!COLUMN_KEY_RE.test(key) || key in Object.prototype || !FRESH_CHOICES.includes(min)) continue;
    out[key] = min;
    if (++n >= MAX_WATCHED) break;
  }
  return out;
}

// Values whose default is not a plain scalar or a nested group of scalars get
// their own cleaner, keyed by path. Each returns null for a value of the
// wrong type, and merge() then uses the default.
const CLEANERS = {
  'hibearnate.columns': cleanColumnKeys,
  'hibearnate.freshMinutes': cleanFreshMinutes,
};

// Background poll can't go below the usage module's own fetch throttle.
const MIN_POLL_MS = 5 * 60 * 1000;

let settings = load();

function load() {
  const raw = readJsonSafe(SETTINGS_FILE, {});
  return merge(DEFAULTS, raw);
}

// Whitelist-merge: only keys present in DEFAULTS are honored, so a hand-edited
// or stale file can't inject arbitrary state. The Hibearnate values need the
// CLEANERS branch: typeof [] and typeof null are both 'object', so the typeof
// test below would let null or a plain object through where a list belongs,
// and recursing into the freshMinutes default ({}) would whitelist every
// column key away.
function merge(defaults, incoming, prefix) {
  const out = {};
  for (const key of Object.keys(defaults)) {
    const def = defaults[key];
    const val = incoming ? incoming[key] : undefined;
    const cleaner = CLEANERS[(prefix ? prefix + '.' : '') + key];
    if (cleaner) {
      const clean = cleaner(val);
      out[key] = clean === null ? JSON.parse(JSON.stringify(def)) : clean;
    } else if (def && typeof def === 'object' && !Array.isArray(def)) {
      out[key] = merge(def, val, key);
    } else if (typeof val === typeof def && val !== undefined) {
      out[key] = val;
    } else {
      out[key] = def;
    }
  }
  return out;
}

function getSettings() {
  return settings;
}

function updateSettings(patch) {
  settings = merge(DEFAULTS, Object.assign({}, flatten(settings, patch)));
  if (settings.usagePoll.intervalMs < MIN_POLL_MS) settings.usagePoll.intervalMs = MIN_POLL_MS;
  try { atomicWrite(SETTINGS_FILE, settings); } catch (_) { /* best effort */ }
  return settings;
}

// Shallow-merge a patch over current settings one level deep, so a POST like
// {usagePoll: {enabled: true}} doesn't wipe intervalMs.
function flatten(current, patch) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const def = DEFAULTS[key];
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      out[key] = Object.assign({}, current[key], patch && patch[key]);
    } else {
      out[key] = patch && key in patch ? patch[key] : current[key];
    }
  }
  return out;
}

module.exports = {
  getSettings, updateSettings, cleanColumnKeys, cleanFreshMinutes, merge,
  DEFAULTS, FRESH_CHOICES, MIN_POLL_MS,
};
