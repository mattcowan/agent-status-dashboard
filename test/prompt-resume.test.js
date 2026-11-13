'use strict';

// A reply from the user (UserPromptSubmit -> POST /api/cards with source
// 'prompt') takes a card out of Needs Input. Before, upsertSession() only
// refreshed lastActiveAt, so a card stayed in Needs Input until the session
// declared an outcome or the user dragged it.
//
// Follows session-end.test.js: a real Store, saves stubbed, board replaced by a
// fixture, never data/. History `at` values come from _log's own clock, so they
// are never compared with the upsert's `now`. Expected texts are built with
// columnLabel(), so the suite does not depend on the UI language.

const test = require('node:test');
const assert = require('node:assert');

const { Store } = require('../lib/store');

function fixture(cards) {
  const s = new Store();
  s.saves = 0;
  s._scheduleSave = () => { s.saves++; };
  s.board = { version: 1, columns: s.board.columns, cards: {} };
  s.archive = { version: 1, cards: {} };
  (cards || []).forEach((c) => { s.board.cards[c.id] = c; });
  return s;
}

function card(over) {
  return Object.assign({
    id: 's1',
    project: 'C:\\Sites\\alpha',
    column: 'needs_input',
    headline: 'Title',
    body: 'Pending body',
    leftOff: { text: 'left off here', auto: true, at: '2026-10-01T10:00:00.000Z' },
    userNote: 'user note',
    externalEdits: [],
    autoMoved: false,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    lastActiveAt: '2026-10-01T10:00:00.000Z',
    sessionEndedAt: null,
    endedBy: null,
    history: [{ at: '2026-10-01T10:00:00.000Z', kind: 'status', text: 'Working → Needs Input', auto: true }],
  }, over);
}

function statusEntries(c) { return c.history.filter((e) => e.kind === 'status'); }

function moved(s, from, to) { return s.columnLabel(from) + ' → ' + s.columnLabel(to); }

test('a prompt takes a Needs Input card to Working and logs it', () => {
  const s = fixture([card({ autoMoved: true })]);
  const before = JSON.parse(JSON.stringify(s.board.cards.s1));
  const r = s.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
  assert.strictEqual(r.column, 'working');
  assert.strictEqual(r.autoMoved, false);
  assert.strictEqual(r.updatedAt, r.lastActiveAt);
  assert.notStrictEqual(r.updatedAt, before.updatedAt);
  const last = r.history[r.history.length - 1];
  assert.strictEqual(last.kind, 'status');
  assert.strictEqual(last.text, moved(s, 'needs_input', 'working'));
  assert.strictEqual(last.auto, false);
  assert.strictEqual(r.history.length, before.history.length + 1);
  for (const k of ['headline', 'body', 'leftOff', 'userNote', 'externalEdits']) {
    assert.deepStrictEqual(r[k], before[k], k);
  }
});

test('same result when the card was not auto-moved', () => {
  const s = fixture([card({ autoMoved: false })]);
  const r = s.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
  assert.strictEqual(r.column, 'working');
  assert.strictEqual(r.autoMoved, false);
});

test('only source "prompt" moves the card', () => {
  for (const source of [undefined, 'startup', 'resume']) {
    const s = fixture([card()]);
    const r = s.upsertSession('s1', 'C:\\Sites\\alpha', source);
    assert.strictEqual(r.column, 'needs_input', String(source));
    assert.strictEqual(statusEntries(r).length, 1, String(source));
  }
});

test('a prompt on a Ready for Review card leaves it alone', () => {
  const s = fixture([card({ column: 'task_completed' })]);
  const r = s.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
  assert.strictEqual(r.column, 'task_completed');
  assert.strictEqual(statusEntries(r).length, 1);
});

test('done and custom columns are the user\'s and stay put', () => {
  for (const column of ['done', 'my_column']) {
    const s = fixture([card({ column })]);
    const r = s.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
    assert.strictEqual(r.column, column);
    assert.strictEqual(statusEntries(r).length, 1);
  }
});

test('an archived record is left byte for byte as it was', () => {
  const archived = card({ column: 'needs_input', archivedAt: '2026-10-02T00:00:00.000Z', archivedFrom: 'needs_input' });
  const s = fixture([]);
  s.archive.cards.s1 = archived;
  const snap = JSON.stringify(archived);
  s.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
  assert.strictEqual(JSON.stringify(s.archive.cards.s1), snap);
});

test('an ended session resumed from Needs Input goes to Working', () => {
  const s = fixture([card({ sessionEndedAt: '2026-10-01T11:00:00.000Z', endedBy: 'hook' })]);
  const r = s.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
  assert.strictEqual(r.sessionEndedAt, null);
  assert.strictEqual(r.endedBy, null);
  assert.strictEqual(r.column, 'working');
  assert.strictEqual(r.history[r.history.length - 1].text, moved(s, 'needs_input', 'working'));
});

test('new card, Working card and single save are unchanged', () => {
  const s = fixture([card({ column: 'working', id: 'w1' })]);
  const w = s.upsertSession('w1', 'C:\\Sites\\alpha', 'prompt');
  assert.strictEqual(w.column, 'working');
  assert.strictEqual(w.history.length, 1);
  assert.strictEqual(s.saves, 1);

  const n = s.upsertSession('new1', 'C:\\Sites\\beta', 'prompt');
  assert.strictEqual(n.column, 'working');
  assert.strictEqual(n.history.length, 1);
  assert.strictEqual(n.history[0].kind, 'created');

  const s2 = fixture([card()]);
  s2.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
  assert.strictEqual(s2.saves, 1);
});

test('a note on a Needs Input card does not move it', () => {
  const s = fixture([card()]);
  s.updateCard('s1', { note: 'detail' });
  assert.strictEqual(s.board.cards.s1.column, 'needs_input');
});

test('prompt then Stop without outcome returns to Needs Input, with two status entries', () => {
  const s = fixture([card()]);
  s.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
  s.applyStopBackstop('s1', 'agent reply');
  const c = s.board.cards.s1;
  assert.strictEqual(c.column, 'needs_input');
  assert.strictEqual(c.autoMoved, true);
  assert.strictEqual(c.leftOff.text, 'agent reply');
  const st = statusEntries(c);
  assert.strictEqual(st.length, 3);
  assert.strictEqual(st[1].text, moved(s, 'needs_input', 'working'));
  assert.strictEqual(st[1].auto, false);
  assert.strictEqual(st[2].text, moved(s, 'working', 'needs_input'));
  assert.strictEqual(st[2].auto, true);
});

test('prompt then done-for-review before Stop stays in Ready for Review', () => {
  const s = fixture([card()]);
  s.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
  s.updateCard('s1', { column: 'task_completed', auto: false });
  s.applyStopBackstop('s1', 'x');
  assert.strictEqual(s.board.cards.s1.column, 'task_completed');
});
