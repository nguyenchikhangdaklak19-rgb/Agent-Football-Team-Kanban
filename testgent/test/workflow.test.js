'use strict';

/*
 * Adversarial state-machine coverage for testgent/lib/workflow.js
 * Node built-in test runner: node --test test/workflow.test.js
 * Zero external deps.
 */

const test = require('node:test');
const assert = require('node:assert');

const { DEFAULT_WORKFLOW, validateMove, applyMove } = require('../lib/workflow');

const WF = DEFAULT_WORKFLOW;
const NOW = '2026-06-18T00:00:00.000Z';

// Helpers -------------------------------------------------------------------

function task(status, extra) {
  return Object.assign({ id: 't1', status: status, history: [] }, extra || {});
}

// ---------------------------------------------------------------------------
// 1. Workflow shape sanity
// ---------------------------------------------------------------------------

test('DEFAULT_WORKFLOW exposes the 5 expected states in order', () => {
  assert.deepStrictEqual(WF.states, ['backlog', 'progress', 'test', 'uat', 'done']);
});

test('done is terminal: no outgoing transitions exist', () => {
  const outgoing = WF.transitions.filter((t) => t.from === 'done');
  assert.strictEqual(outgoing.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Every VALID transition succeeds with the correct role
// ---------------------------------------------------------------------------

test('VALID backlog -> progress by engineer', () => {
  const r = validateMove(WF, 'backlog', 'progress', 'engineer', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transition.to, 'progress');
});

test('VALID progress -> test by engineer', () => {
  const r = validateMove(WF, 'progress', 'test', 'engineer', {});
  assert.strictEqual(r.ok, true);
});

test('VALID test -> uat by qa WITH testsPass:true', () => {
  const r = validateMove(WF, 'test', 'uat', 'qa', { testsPass: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transition.requires, 'tests_pass');
});

test('VALID test -> backlog (reject) by qa', () => {
  const r = validateMove(WF, 'test', 'backlog', 'qa', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transition.flag, 'reject');
});

test('VALID uat -> done by po', () => {
  const r = validateMove(WF, 'uat', 'done', 'po', {});
  assert.strictEqual(r.ok, true);
});

test('VALID uat -> backlog (reject) by po', () => {
  const r = validateMove(WF, 'uat', 'backlog', 'po', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transition.flag, 'reject');
});

// ---------------------------------------------------------------------------
// 3. Illegal SKIPS are blocked
// ---------------------------------------------------------------------------

test('SKIP backlog -> done blocked (with any role)', () => {
  for (const role of ['engineer', 'qa', 'po']) {
    const r = validateMove(WF, 'backlog', 'done', role, {});
    assert.strictEqual(r.ok, false, 'role ' + role + ' must not skip to done');
    assert.match(r.error, /KHÔNG hợp lệ/);
  }
});

test('SKIP backlog -> uat blocked', () => {
  const r = validateMove(WF, 'backlog', 'uat', 'engineer', {});
  assert.strictEqual(r.ok, false);
});

test('SKIP progress -> uat blocked', () => {
  const r = validateMove(WF, 'progress', 'uat', 'qa', { testsPass: true });
  assert.strictEqual(r.ok, false);
});

test('SKIP progress -> done blocked', () => {
  const r = validateMove(WF, 'progress', 'done', 'po', {});
  assert.strictEqual(r.ok, false);
});

test('SKIP test -> done blocked', () => {
  const r = validateMove(WF, 'test', 'done', 'po', { testsPass: true });
  assert.strictEqual(r.ok, false);
});

test('SKIP backlog -> test blocked', () => {
  const r = validateMove(WF, 'backlog', 'test', 'engineer', {});
  assert.strictEqual(r.ok, false);
});

// invalid-step error carries the list of legitimately-allowed transitions
test('blocked invalid step reports allowed transitions from source', () => {
  const r = validateMove(WF, 'backlog', 'done', 'engineer', {});
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.allowed));
  assert.deepStrictEqual(r.allowed.map((t) => t.to), ['progress']);
});

// ---------------------------------------------------------------------------
// 4. WRONG ROLE blocked
// ---------------------------------------------------------------------------

test('WRONG ROLE: engineer cannot do test -> uat (qa only)', () => {
  const r = validateMove(WF, 'test', 'uat', 'engineer', { testsPass: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sai vai/);
});

test('WRONG ROLE: po cannot do test -> uat (qa only)', () => {
  const r = validateMove(WF, 'test', 'uat', 'po', { testsPass: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sai vai/);
});

test('WRONG ROLE: qa cannot do uat -> done (po only)', () => {
  const r = validateMove(WF, 'uat', 'done', 'qa', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sai vai/);
});

test('WRONG ROLE: engineer cannot do uat -> done', () => {
  const r = validateMove(WF, 'uat', 'done', 'engineer', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sai vai/);
});

test('WRONG ROLE: engineer cannot do uat -> backlog (reject is po-only)', () => {
  const r = validateMove(WF, 'uat', 'backlog', 'engineer', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sai vai/);
});

test('WRONG ROLE: qa cannot do uat -> backlog (reject is po-only)', () => {
  const r = validateMove(WF, 'uat', 'backlog', 'qa', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sai vai/);
});

test('WRONG ROLE: qa cannot do backlog -> progress (engineer only)', () => {
  const r = validateMove(WF, 'backlog', 'progress', 'qa', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sai vai/);
});

test('Only po may push to done', () => {
  for (const role of ['engineer', 'qa', 'po']) {
    const r = validateMove(WF, 'uat', 'done', role, {});
    assert.strictEqual(r.ok, role === 'po', 'role ' + role + ' -> done expectation');
  }
});

// ---------------------------------------------------------------------------
// 5. test -> uat requires testsPass
// ---------------------------------------------------------------------------

test('test -> uat WITHOUT testsPass blocked', () => {
  const r = validateMove(WF, 'test', 'uat', 'qa', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /tests_pass/);
});

test('test -> uat with testsPass:false blocked', () => {
  const r = validateMove(WF, 'test', 'uat', 'qa', { testsPass: false });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /tests_pass/);
});

test('test -> uat with truthy-but-not-true testsPass blocked (strict ===)', () => {
  const r = validateMove(WF, 'test', 'uat', 'qa', { testsPass: 'yes' });
  assert.strictEqual(r.ok, false, 'only strict true should unlock the gate');
});

test('test -> uat with testsPass:true allowed', () => {
  const r = validateMove(WF, 'test', 'uat', 'qa', { testsPass: true });
  assert.strictEqual(r.ok, true);
});

// role check precedes the tests_pass gate: wrong role fails as "Sai vai" not "tests_pass"
test('test -> uat wrong role fails on role even without testsPass', () => {
  const r = validateMove(WF, 'test', 'uat', 'engineer', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sai vai/);
});

// ---------------------------------------------------------------------------
// 6. applyMove behavior
// ---------------------------------------------------------------------------

test('applyMove writes correct history entry {to, by, at}', () => {
  const t = task('backlog');
  const r = applyMove(WF, t, 'progress', 'engineer', { now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.status, 'progress');
  assert.strictEqual(t.history.length, 1);
  assert.deepStrictEqual(t.history[0], { to: 'progress', by: 'engineer', at: NOW });
});

test('applyMove appends (does not overwrite) history across multiple moves', () => {
  const t = task('backlog');
  applyMove(WF, t, 'progress', 'engineer', { now: NOW });
  applyMove(WF, t, 'test', 'engineer', { now: NOW });
  applyMove(WF, t, 'uat', 'qa', { now: NOW, testsPass: true });
  assert.deepStrictEqual(t.history.map((e) => e.to), ['progress', 'test', 'uat']);
  assert.strictEqual(t.status, 'uat');
});

test('applyMove creates history array if missing', () => {
  const t = { id: 'x', status: 'backlog' }; // no history field
  const r = applyMove(WF, t, 'progress', 'engineer', { now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.history.length, 1);
});

test('applyMove sets flag:"reject" on test -> backlog reject', () => {
  const t = task('test');
  const r = applyMove(WF, t, 'backlog', 'qa', { now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.status, 'backlog');
  assert.strictEqual(t.reject, true);
  assert.strictEqual(t.history[0].flag, 'reject');
  assert.deepStrictEqual(t.history[0], { to: 'backlog', by: 'qa', at: NOW, flag: 'reject' });
});

test('applyMove sets flag:"reject" + task.reject on uat -> backlog reject', () => {
  const t = task('uat');
  const r = applyMove(WF, t, 'backlog', 'po', { now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.reject, true);
  assert.strictEqual(t.history[0].flag, 'reject');
});

test('applyMove does NOT set reject flag on non-reject moves', () => {
  const t = task('progress');
  const r = applyMove(WF, t, 'test', 'engineer', { now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.reject, false);
  assert.strictEqual('flag' in t.history[0], false);
});

test('applyMove clears a previously-set reject on a forward non-backlog move', () => {
  // task was rejected (reject:true), re-flows backlog->progress->test->uat
  const t = task('test', { reject: true });
  const r = applyMove(WF, t, 'uat', 'qa', { now: NOW, testsPass: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.reject, false, 'forward move to non-backlog must clear reject');
});

test('applyMove sets reject:false on uat -> done', () => {
  const t = task('uat', { reject: true });
  const r = applyMove(WF, t, 'done', 'po', { now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(t.reject, false);
});

test('applyMove does NOT mutate task on an invalid move', () => {
  const t = task('backlog', { reject: true });
  const snapshot = JSON.parse(JSON.stringify(t));
  const r = applyMove(WF, t, 'done', 'engineer', { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
  assert.deepStrictEqual(t, snapshot, 'task must be untouched after invalid move');
});

test('applyMove does NOT mutate task on wrong-role move', () => {
  const t = task('uat');
  const snapshot = JSON.parse(JSON.stringify(t));
  const r = applyMove(WF, t, 'done', 'qa', { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(t, snapshot);
});

test('applyMove blocks test -> uat without testsPass and leaves task untouched', () => {
  const t = task('test');
  const snapshot = JSON.parse(JSON.stringify(t));
  const r = applyMove(WF, t, 'uat', 'qa', { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(t, snapshot);
});

// ---------------------------------------------------------------------------
// 7. Edge cases: unknown role/status, terminal done, missing opts
// ---------------------------------------------------------------------------

test('EDGE unknown role blocked', () => {
  const r = validateMove(WF, 'backlog', 'progress', 'intern', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sai vai/);
});

test('EDGE unknown source status blocked (no transitions)', () => {
  const r = validateMove(WF, 'frozen', 'progress', 'engineer', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /KHÔNG hợp lệ/);
  assert.deepStrictEqual(r.allowed, []);
});

test('EDGE unknown target status blocked', () => {
  const r = validateMove(WF, 'backlog', 'archived', 'engineer', {});
  assert.strictEqual(r.ok, false);
});

test('EDGE terminal done has no outgoing move (done -> anything blocked)', () => {
  for (const to of ['backlog', 'progress', 'test', 'uat']) {
    const r = validateMove(WF, 'done', to, 'po', {});
    assert.strictEqual(r.ok, false, 'done -> ' + to + ' must be blocked');
  }
});

test('EDGE validateMove with missing opts (undefined) still works for non-gated step', () => {
  const r = validateMove(WF, 'backlog', 'progress', 'engineer');
  assert.strictEqual(r.ok, true);
});

test('EDGE validateMove with missing opts blocks the testsPass-gated step', () => {
  const r = validateMove(WF, 'test', 'uat', 'qa');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /tests_pass/);
});

test('EDGE applyMove with missing opts: entry.at is undefined, move still applied', () => {
  const t = task('backlog');
  const r = applyMove(WF, t, 'progress', 'engineer');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.status, 'progress');
  assert.strictEqual(t.history[0].at, undefined);
});

test('EDGE same-state move (backlog -> backlog) blocked', () => {
  const r = validateMove(WF, 'backlog', 'backlog', 'engineer', {});
  assert.strictEqual(r.ok, false);
});
