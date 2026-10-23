'use strict';

// Tests for the settings whitelist-merge (lib/settings.js), pinned for the
// first array-valued setting: the Hibearnate watched columns (issue #42).
//
// merge() used to accept any value whose typeof matched the default, and
// typeof null, typeof [] and typeof {} are all 'object'. A hand-edited
// settings.json could then hand the lease code null or an object where a list
// of keys belongs. These tests only call the pure functions: requiring the
// module reads data/settings.json, but nothing here writes it.

const test = require('node:test');
const assert = require('node:assert');

const s = require('../lib/settings');

test('no saved value: only Working is watched', () => {
  assert.deepStrictEqual(s.merge(s.DEFAULTS, {}).hibearnate.columns, ['working']);
  assert.deepStrictEqual(s.merge(s.DEFAULTS, { hibearnate: {} }).hibearnate.columns, ['working']);
});

test('the default list is a copy, so a caller cannot change DEFAULTS', () => {
  const out = s.merge(s.DEFAULTS, {});
  out.hibearnate.columns.push('merging');
  assert.deepStrictEqual(s.DEFAULTS.hibearnate.columns, ['working']);
});

test('a value of the wrong type falls back to the default, not through', () => {
  for (const bad of [null, {}, 'working', 7, true]) {
    assert.deepStrictEqual(s.merge(s.DEFAULTS, { hibearnate: { columns: bad } }).hibearnate.columns, ['working'], JSON.stringify(bad));
  }
});

test('an empty list is kept: it means "watch nothing"', () => {
  assert.deepStrictEqual(s.merge(s.DEFAULTS, { hibearnate: { columns: [] } }).hibearnate.columns, []);
});

test('entries that are not column keys are dropped, and duplicates folded', () => {
  const out = s.merge(s.DEFAULTS, { hibearnate: { columns: ['merging', 'merging', 3, null, '', 'Has Space', '../x', 'working'] } });
  assert.deepStrictEqual(out.hibearnate.columns, ['merging', 'working']);
});

test('cleanColumnKeys tells a wrong type (null) from an empty list', () => {
  assert.strictEqual(s.cleanColumnKeys('working'), null);
  assert.strictEqual(s.cleanColumnKeys(undefined), null);
  assert.deepStrictEqual(s.cleanColumnKeys([]), []);
  assert.deepStrictEqual(s.cleanColumnKeys(['merging_2']), ['merging_2']);
});

test('no saved windows: the map is empty, and the default is a fresh copy', () => {
  const out = s.merge(s.DEFAULTS, {});
  assert.deepStrictEqual(out.hibearnate.freshMinutes, {});
  out.hibearnate.freshMinutes.merging = 60;
  assert.deepStrictEqual(s.DEFAULTS.hibearnate.freshMinutes, {});
});

test('windows keep only offered values for well-formed keys', () => {
  const out = s.merge(s.DEFAULTS, { hibearnate: { freshMinutes: {
    merging: 60, working: 1440, odd: 45, neg: -60, str: '60', 'Has Space': 60,
  } } });
  assert.deepStrictEqual(out.hibearnate.freshMinutes, { merging: 60, working: 1440 });
});

test('windows of the wrong type fall back to the empty map', () => {
  for (const bad of [null, [], 'x', 60]) {
    assert.deepStrictEqual(s.merge(s.DEFAULTS, { hibearnate: { freshMinutes: bad } }).hibearnate.freshMinutes, {}, JSON.stringify(bad));
  }
});

test('prototype member names are never keys, in either Hibearnate value', () => {
  // JSON.parse makes __proto__ an own key, as a hand-edited file would.
  const raw = JSON.parse('{"hibearnate":{"columns":["__proto__","constructor","working"],"freshMinutes":{"__proto__":60,"constructor":60,"merging":60}}}');
  const out = s.merge(s.DEFAULTS, raw);
  assert.deepStrictEqual(out.hibearnate.columns, ['working']);
  assert.deepStrictEqual(Object.keys(out.hibearnate.freshMinutes), ['merging']);
  assert.strictEqual(Object.getPrototypeOf(out.hibearnate.freshMinutes), Object.prototype);
});

test('the dialog choices are the ones the server keeps', () => {
  assert.deepStrictEqual(s.FRESH_CHOICES, [30, 60, 120, 180, 360, 720, 1440]);
  // public/app.js mirrors the list; a drift there is caught by reading it.
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /const FRESH_CHOICES = \[30, 60, 120, 180, 360, 720, 1440\];/);
  // The dialog's default must be the server's: watchedWindows() leaves a
  // column at FRESH_DEFAULT out of the saved map, so a drift here would turn
  // a picked window into the server's other default without a word.
  const fresh = require('../lib/hibearnate').FRESH_MS / 60000;
  assert.ok(s.FRESH_CHOICES.includes(fresh), 'the default must be one of the choices');
  assert.ok(app.includes('const FRESH_DEFAULT = ' + fresh + ';'), 'public/app.js FRESH_DEFAULT must equal FRESH_MS in minutes (' + fresh + ')');
});

test('the other settings still merge as before', () => {
  const out = s.merge(s.DEFAULTS, { selfEnd: { enabled: true }, usagePoll: { enabled: 'yes' }, extra: 1 });
  assert.strictEqual(out.selfEnd.enabled, true);
  assert.strictEqual(out.usagePoll.enabled, false);
  assert.strictEqual(out.usagePoll.intervalMs, 600000);
  assert.strictEqual('extra' in out, false);
});
