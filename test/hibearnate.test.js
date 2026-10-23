'use strict';

// Tests for the Hibearnate busy lease (issue #36, lib/hibearnate.js).
//
// What is pinned here, and why each one matters:
//
//   leaseDir()    the feature is Windows only and can be turned off; a wrong
//                 answer either writes into a home folder on macOS or ignores
//                 the user's opt-out.
//   leaseName()   one name per port, inside Hibearnate's name rule, so a second
//                 server (a scratch copy on another port) can never renew or
//                 delete the live server's lease.
//   isBusyCard()  with the default setting, must give the same answer
//                 Hibearnate's own board read gave, or the cut-over silently
//                 changes when the laptop sleeps.
//   watched       the columns setting (issue #42): a custom column can count,
//                 Working can stop counting, Done never counts, and a deleted
//                 column's key stops counting at once, whatever is stored.
//   Lease         the file contract Hibearnate parses (name, Until, temp file
//                 that does not end in .json), never creating Hibearnate's
//                 folder, and the EPERM rule: skip a renewal, never fall back
//                 to an in-place write.
//
// Every Lease test runs against a fresh temp directory standing in for
// %LOCALAPPDATA%, so nothing here touches a real Hibearnate install.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hb = require('../lib/hibearnate');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const NAME = hb.leaseName(4787);

function tempAppData(withHibearnate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csd-hibearnate-'));
  if (withHibearnate) fs.mkdirSync(path.join(root, 'Hibearnate'));
  return root;
}

function leaseFor(root, over) {
  return new hb.Lease(Object.assign({
    dir: path.join(root, 'Hibearnate', 'leases'),
    name: NAME,
    now: () => NOW,
    log: () => { throw new Error('unexpected log'); },
  }, over || {}));
}

function readLease(lease) {
  return JSON.parse(fs.readFileSync(lease.file, 'utf8'));
}

// Wraps the real fs and makes chosen calls fail with a given code.
function failingFs(failures) {
  return Object.assign({}, fs, Object.fromEntries(Object.entries(failures).map(([name, code]) => [
    name,
    function () {
      const err = new Error(name + ' failed (' + code + ')');
      err.code = code;
      throw err;
    },
  ])));
}

// ---------- leaseDir ----------

test('leaseDir is off outside Windows and without LOCALAPPDATA', () => {
  assert.strictEqual(hb.leaseDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'linux'), null);
  assert.strictEqual(hb.leaseDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'darwin'), null);
  assert.strictEqual(hb.leaseDir({}, 'win32'), null);
  assert.strictEqual(hb.leaseDir({ LOCALAPPDATA: '' }, 'win32'), null);
});

test('leaseDir honors AGENT_STATUS_HIBEARNATE=0/off/false and nothing else', () => {
  const base = { LOCALAPPDATA: 'X' };
  for (const flag of ['0', 'off', 'OFF', ' false ']) {
    assert.strictEqual(hb.leaseDir(Object.assign({ AGENT_STATUS_HIBEARNATE: flag }, base), 'win32'), null, flag);
  }
  const on = path.join('X', 'Hibearnate', 'leases');
  for (const flag of [undefined, '', '1', 'on', 'yes']) {
    assert.strictEqual(hb.leaseDir(Object.assign({ AGENT_STATUS_HIBEARNATE: flag }, base), 'win32'), on, String(flag));
  }
});

// ---------- leaseName ----------

test('leaseName is one name per port, inside Hibearnate\'s name rule', () => {
  assert.strictEqual(hb.leaseName(4787), 'agent-dashboard-4787');
  assert.notStrictEqual(hb.leaseName(4787), hb.leaseName(4799));
  // Hibearnate's rule: 1 to 24 of [A-Za-z0-9._-], letter or digit first. The
  // longest name is the one for the largest port.
  for (const port of [1, 4787, 65535]) {
    assert.match(hb.leaseName(port), /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/, String(port));
  }
});

test('leaseName gives no name without a usable port', () => {
  for (const port of [undefined, null, 0, -1, 65536, 4787.5, 'abc', '']) {
    assert.strictEqual(hb.leaseName(port), null, String(port));
  }
});

// ---------- isBusyCard ----------

function card(over) {
  return Object.assign({
    column: 'working',
    archivedAt: null,
    sessionEndedAt: null,
    lastActiveAt: new Date(NOW - 60 * 1000).toISOString(),
    updatedAt: null,
  }, over || {});
}

test('isBusyCard: a fresh Working card is busy', () => {
  assert.strictEqual(hb.isBusyCard(card(), NOW), true);
});

test('isBusyCard: other columns, archived and ended cards are not busy', () => {
  assert.strictEqual(hb.isBusyCard(card({ column: 'review' }), NOW), false);
  assert.strictEqual(hb.isBusyCard(card({ column: 'done' }), NOW), false);
  assert.strictEqual(hb.isBusyCard(card({ archivedAt: '2026-10-20T11:00:00Z' }), NOW), false);
  assert.strictEqual(hb.isBusyCard(card({ sessionEndedAt: '2026-10-20T11:00:00Z' }), NOW), false);
  assert.strictEqual(hb.isBusyCard(null, NOW), false);
});

test('isBusyCard: stale after FRESH_MS, with updatedAt as the fallback stamp', () => {
  const stale = new Date(NOW - hb.FRESH_MS - 1000).toISOString();
  const fresh = new Date(NOW - hb.FRESH_MS + 1000).toISOString();
  assert.strictEqual(hb.isBusyCard(card({ lastActiveAt: stale }), NOW), false);
  assert.strictEqual(hb.isBusyCard(card({ lastActiveAt: fresh }), NOW), true);
  assert.strictEqual(hb.isBusyCard(card({ lastActiveAt: null, updatedAt: fresh }), NOW), true);
  assert.strictEqual(hb.isBusyCard(card({ lastActiveAt: null, updatedAt: null }), NOW), false);
  assert.strictEqual(hb.isBusyCard(card({ lastActiveAt: 'not a date' }), NOW), false);
});

test('anyBusy needs only one busy card', () => {
  assert.strictEqual(hb.anyBusy([card({ column: 'review' }), card()], NOW), true);
  assert.strictEqual(hb.anyBusy([card({ column: 'review' })], NOW), false);
  assert.strictEqual(hb.anyBusy([], NOW), false);
});

// ---------- watched columns (issue #42) ----------

// The default board plus one custom column, in board order.
const COLUMNS = [
  { key: 'working', label: 'Working', kind: 'root' },
  { key: 'needs_input', label: 'Needs Input', kind: 'root' },
  { key: 'merging', label: 'Merging', kind: 'custom' },
  { key: 'task_completed', label: 'Ready for Review', kind: 'root' },
  { key: 'done', label: 'Done', kind: 'done' },
];

function watched(keys, columns) {
  return new Set(hb.watchedColumns(keys, columns || COLUMNS));
}

test('watched: a fresh card in a watched custom column is busy', () => {
  const set = watched(['working', 'merging']);
  assert.strictEqual(hb.isBusyCard(card({ column: 'merging' }), NOW, set), true);
  assert.strictEqual(hb.anyBusy([card({ column: 'needs_input' }), card({ column: 'merging' })], NOW, set), true);
  // The other rules still apply in a custom column.
  assert.strictEqual(hb.isBusyCard(card({ column: 'merging', sessionEndedAt: '2026-10-20T11:00:00Z' }), NOW, set), false);
  assert.strictEqual(hb.isBusyCard(card({ column: 'merging', archivedAt: '2026-10-20T11:00:00Z' }), NOW, set), false);
  const stale = new Date(NOW - hb.FRESH_MS - 1000).toISOString();
  assert.strictEqual(hb.isBusyCard(card({ column: 'merging', lastActiveAt: stale }), NOW, set), false);
});

test('watched: Working is not busy when it is not watched', () => {
  const set = watched(['merging']);
  assert.strictEqual(hb.isBusyCard(card({ column: 'working' }), NOW, set), false);
  assert.strictEqual(hb.anyBusy([card({ column: 'working' })], NOW, set), false);
});

test('watched: an empty list means no card is ever busy', () => {
  const set = watched([]);
  assert.strictEqual(set.size, 0);
  assert.strictEqual(hb.anyBusy([card(), card({ column: 'merging' })], NOW, set), false);
});

test('watched: left out, the default is Working only (the rule before #42)', () => {
  assert.deepStrictEqual(hb.DEFAULT_WATCHED, ['working']);
  assert.strictEqual(hb.isBusyCard(card(), NOW), true);
  assert.strictEqual(hb.isBusyCard(card({ column: 'merging' }), NOW), false);
});

test('watched: Done never counts, also when the stored setting names it', () => {
  assert.deepStrictEqual(hb.watchedColumns(['done', 'working'], COLUMNS), ['working']);
  // A caller that builds its own Set is refused too.
  assert.strictEqual(hb.isBusyCard(card({ column: 'done' }), NOW, new Set(['done'])), false);
});

test('watched: a deleted column key stops counting, and a reused key needs a new tick', () => {
  const withoutMerging = COLUMNS.filter((c) => c.key !== 'merging');
  // Stored setting still names it; the board no longer has it.
  const set = watched(['working', 'merging'], withoutMerging);
  assert.deepStrictEqual(Array.from(set), ['working']);
  // A card left with the old key (hand-edited board) is not busy.
  assert.strictEqual(hb.isBusyCard(card({ column: 'merging' }), NOW, set), false);
});

test('watched: keys come back in board order, renamed columns stay, junk is dropped', () => {
  const renamed = COLUMNS.map((c) => (c.key === 'merging' ? Object.assign({}, c, { label: 'Waiting on CI' }) : c));
  assert.deepStrictEqual(hb.watchedColumns(['merging', 'working'], renamed), ['working', 'merging']);
  assert.deepStrictEqual(hb.watchedColumns(['nope', 42, null, 'working'], COLUMNS), ['working']);
  assert.deepStrictEqual(hb.watchedColumns('working', COLUMNS), []);
  assert.deepStrictEqual(hb.watchedColumns(null, COLUMNS), []);
});

// ---------- per-column windows (issue #42) ----------

const MIN = 60 * 1000;

test('busyRules: each watched column gets its window, the rest the default', () => {
  const rules = hb.busyRules({ columns: ['working', 'merging'], freshMinutes: { merging: 60 } }, COLUMNS);
  assert.deepStrictEqual(Array.from(rules), [['working', hb.FRESH_MS], ['merging', 60 * MIN]]);
});

test('busyRules: a window for an unwatched, deleted or Done column adds nothing', () => {
  const rules = hb.busyRules({ columns: ['working'], freshMinutes: { merging: 60, gone: 30, done: 30 } }, COLUMNS);
  assert.deepStrictEqual(Array.from(rules.keys()), ['working']);
});

test('busyRules: a junk window falls back to the default, never to "always busy"', () => {
  for (const bad of [0, -5, 'soon', null, NaN, Infinity]) {
    const rules = hb.busyRules({ columns: ['merging'], freshMinutes: { merging: bad } }, COLUMNS);
    assert.strictEqual(rules.get('merging'), hb.FRESH_MS, String(bad));
  }
  assert.strictEqual(hb.busyRules({ columns: ['merging'], freshMinutes: null }, COLUMNS).get('merging'), hb.FRESH_MS);
  assert.strictEqual(hb.busyRules(null, COLUMNS).size, 0);
});

test('isBusyCard: a short window ends a forgotten card in a custom column', () => {
  const rules = hb.busyRules({ columns: ['working', 'merging'], freshMinutes: { merging: 60 } }, COLUMNS);
  const ninetyAgo = new Date(NOW - 90 * MIN).toISOString();
  const thirtyAgo = new Date(NOW - 30 * MIN).toISOString();
  assert.strictEqual(hb.isBusyCard(card({ column: 'merging', lastActiveAt: thirtyAgo }), NOW, rules), true);
  assert.strictEqual(hb.isBusyCard(card({ column: 'merging', lastActiveAt: ninetyAgo }), NOW, rules), false);
  // Working keeps the six-hour default in the same setting.
  assert.strictEqual(hb.isBusyCard(card({ column: 'working', lastActiveAt: ninetyAgo }), NOW, rules), true);
});

test('isBusyCard: a Map without a window for the column is not busy', () => {
  assert.strictEqual(hb.isBusyCard(card(), NOW, new Map([['working', undefined]])), false);
  assert.strictEqual(hb.anyBusy(null, NOW), false);
});

// ---------- Lease ----------

test('a busy sync writes the lease Hibearnate expects, with no temp file left', () => {
  const root = tempAppData(true);
  const lease = leaseFor(root);
  lease.sync(true, false);
  assert.strictEqual(lease.held, true);
  assert.strictEqual(path.basename(lease.file), NAME + '.json');
  assert.deepStrictEqual(readLease(lease), {
    Name: NAME,
    Until: new Date(NOW + hb.LEASE_MS).toISOString(),
  });
  // Hibearnate rejects a lease whose Name differs from the file name.
  assert.deepStrictEqual(fs.readdirSync(lease.dir), [NAME + '.json']);
});

test('a second server on another port never touches the first one\'s lease', () => {
  const root = tempAppData(true);
  const live = leaseFor(root);
  const scratch = leaseFor(root, { name: hb.leaseName(4799) });
  live.sync(true, true);
  // An idle scratch copy: its startup sync and its timer ticks both release.
  scratch.sync(false, true);
  scratch.sync(false, true);
  assert.strictEqual(fs.existsSync(live.file), true, 'the live lease survives');
  // A busy one writes its own file beside the live one, and its release on
  // exit removes only that file.
  scratch.sync(true, true);
  assert.deepStrictEqual(fs.readdirSync(live.dir).sort(), [NAME + '.json', hb.leaseName(4799) + '.json'].sort());
  scratch.release();
  assert.deepStrictEqual(fs.readdirSync(live.dir), [NAME + '.json']);
});

test('without Hibearnate installed, nothing is created', () => {
  const root = tempAppData(false);
  const lease = leaseFor(root);
  lease.sync(true, true);
  assert.strictEqual(lease.held, false);
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('a change only rewrites when busy flips; the timer renews', () => {
  const root = tempAppData(true);
  let now = NOW;
  const lease = leaseFor(root, { now: () => now });
  lease.sync(true, false);
  now += 30 * 1000;
  lease.sync(true, false); // a store change while still busy: no rewrite
  assert.strictEqual(readLease(lease).Until, new Date(NOW + hb.LEASE_MS).toISOString());
  lease.sync(true, true); // the timer: Until moves out
  assert.strictEqual(readLease(lease).Until, new Date(now + hb.LEASE_MS).toISOString());
});

test('going idle deletes the lease; staying idle is harmless', () => {
  const root = tempAppData(true);
  const lease = leaseFor(root);
  lease.sync(true, false);
  lease.sync(false, false);
  assert.strictEqual(lease.held, false);
  assert.strictEqual(fs.existsSync(lease.file), false);
  lease.sync(false, false);
  lease.sync(false, true);
  assert.strictEqual(fs.existsSync(lease.file), false);
});

test('a lease left by a crashed run is removed on the first idle sync', () => {
  const root = tempAppData(true);
  const dir = path.join(root, 'Hibearnate', 'leases');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, NAME + '.json'), '{"Name":"' + NAME + '","Until":"2999-01-01T00:00:00Z"}');
  const lease = leaseFor(root);
  assert.strictEqual(lease.held, null);
  lease.sync(false, false);
  assert.strictEqual(fs.existsSync(lease.file), false);
});

test('other tools\' leases in the folder are left alone', () => {
  const root = tempAppData(true);
  const dir = path.join(root, 'Hibearnate', 'leases');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'pytest.json'), '{}');
  const lease = leaseFor(root);
  lease.sync(true, false);
  lease.sync(false, false);
  assert.deepStrictEqual(fs.readdirSync(dir), ['pytest.json']);
});

test('EPERM on the rename skips the renewal: no in-place write, temp removed, retried later', () => {
  const root = tempAppData(true);
  const lease = leaseFor(root, { fs: failingFs({ renameSync: 'EPERM' }) });
  lease.sync(true, false);
  assert.strictEqual(lease.held, null, 'held unchanged, so the next sync retries');
  assert.deepStrictEqual(fs.readdirSync(lease.dir), [], 'neither a lease nor a temp file');
  // The next change retries the write (busy still differs from what is on disk).
  lease.fs = fs;
  lease.sync(true, false);
  assert.strictEqual(lease.held, true);
  assert.strictEqual(fs.existsSync(lease.file), true);
});

test('EPERM on release keeps held, so the next sync retries', () => {
  const root = tempAppData(true);
  const lease = leaseFor(root);
  lease.sync(true, false);
  lease.fs = failingFs({ unlinkSync: 'EPERM' });
  lease.sync(false, false);
  assert.strictEqual(lease.held, true);
  lease.fs = fs;
  lease.sync(false, false);
  assert.strictEqual(lease.held, false);
  assert.strictEqual(fs.existsSync(lease.file), false);
});

test('a transient error is logged only when it repeats three times in a row', () => {
  const root = tempAppData(true);
  const logged = [];
  const lease = leaseFor(root, { fs: failingFs({ renameSync: 'EPERM' }), log: (m) => logged.push(m) });
  lease.sync(true, true);
  lease.sync(true, true);
  assert.strictEqual(logged.length, 0);
  lease.sync(true, true);
  lease.sync(true, true);
  assert.strictEqual(logged.length, 1, 'then once, not once a minute');
});

test('a lasting error is logged once per distinct message', () => {
  const root = tempAppData(true);
  const logged = [];
  const lease = leaseFor(root, { fs: failingFs({ renameSync: 'EIO' }), log: (m) => logged.push(m) });
  lease.sync(true, true);
  lease.sync(true, true);
  lease.sync(true, true);
  assert.strictEqual(logged.length, 1);
  assert.match(logged[0], /lease update failed/);
});

test('a Lease without a folder does nothing', () => {
  const lease = new hb.Lease({ dir: null, name: NAME });
  lease.sync(true, true);
  lease.sync(false, true);
  lease.release();
  assert.strictEqual(lease.held, null);
  assert.strictEqual(lease.file, null);
});

test('a Lease without a name does nothing', () => {
  const root = tempAppData(true);
  const lease = leaseFor(root, { name: null });
  lease.sync(true, true);
  lease.sync(false, true);
  lease.release();
  assert.strictEqual(lease.held, null);
  assert.strictEqual(lease.file, null);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'Hibearnate')), []);
});

test('available() is true only with a name and Hibearnate\'s folder, and creates nothing', () => {
  const installed = tempAppData(true);
  assert.strictEqual(leaseFor(installed).available(), true);
  assert.strictEqual(leaseFor(installed, { name: null }).available(), false);
  const absent = tempAppData(false);
  assert.strictEqual(leaseFor(absent).available(), false);
  assert.deepStrictEqual(fs.readdirSync(absent), []);
});
