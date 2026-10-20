'use strict';

// Tests for the Hibearnate busy lease (issue #36, lib/hibearnate.js).
//
// What is pinned here, and why each one matters:
//
//   leaseDir()    the feature is Windows only and can be turned off; a wrong
//                 answer either writes into a home folder on macOS or ignores
//                 the user's opt-out.
//   isBusyCard()  must give the same answer Hibearnate's own board read gave,
//                 or the cut-over silently changes when the laptop sleeps.
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

function tempAppData(withHibearnate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csd-hibearnate-'));
  if (withHibearnate) fs.mkdirSync(path.join(root, 'Hibearnate'));
  return root;
}

function leaseFor(root, over) {
  return new hb.Lease(Object.assign({
    dir: path.join(root, 'Hibearnate', 'leases'),
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

test('leaseDir honours CLAUDE_STATUS_HIBEARNATE=0/off/false and nothing else', () => {
  const base = { LOCALAPPDATA: 'X' };
  for (const flag of ['0', 'off', 'OFF', ' false ']) {
    assert.strictEqual(hb.leaseDir(Object.assign({ CLAUDE_STATUS_HIBEARNATE: flag }, base), 'win32'), null, flag);
  }
  const on = path.join('X', 'Hibearnate', 'leases');
  for (const flag of [undefined, '', '1', 'on', 'yes']) {
    assert.strictEqual(hb.leaseDir(Object.assign({ CLAUDE_STATUS_HIBEARNATE: flag }, base), 'win32'), on, String(flag));
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
  assert.strictEqual(hb.anyBusy(null, NOW), false);
});

// ---------- Lease ----------

test('a busy sync writes the lease Hibearnate expects, with no temp file left', () => {
  const root = tempAppData(true);
  const lease = leaseFor(root);
  lease.sync(true, false);
  assert.strictEqual(lease.held, true);
  assert.strictEqual(path.basename(lease.file), hb.LEASE_NAME + '.json');
  assert.deepStrictEqual(readLease(lease), {
    Name: hb.LEASE_NAME,
    Until: new Date(NOW + hb.LEASE_MS).toISOString(),
  });
  assert.deepStrictEqual(fs.readdirSync(lease.dir), [hb.LEASE_NAME + '.json']);
  // Hibearnate's rules for a name: 1 to 24 of [A-Za-z0-9._-], letter or digit first.
  assert.match(hb.LEASE_NAME, /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/);
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
  fs.writeFileSync(path.join(dir, hb.LEASE_NAME + '.json'), '{"Name":"' + hb.LEASE_NAME + '","Until":"2999-01-01T00:00:00Z"}');
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
  const lease = new hb.Lease({ dir: null });
  lease.sync(true, true);
  lease.sync(false, true);
  lease.release();
  assert.strictEqual(lease.held, null);
  assert.strictEqual(lease.file, null);
});
