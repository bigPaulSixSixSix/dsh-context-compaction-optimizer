import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_STATE,
  bulkSet,
  clear,
  exportState,
  importState,
  isExcluded,
  pruneToLive,
  removeAnnotation,
  resolveStatus,
  setAnnotation,
  stats,
  toRecords,
} from '../../src/core/annotations.ts';

const T0 = 1_700_000_000_000;

test('setAnnotation stores a record with source and timestamp', () => {
  const state = setAnnotation(EMPTY_STATE, 'm-1', 'invalid', { now: T0, source: 'user' });
  const record = state.byMessageId.get('m-1');
  assert.deepEqual(record, { messageId: 'm-1', status: 'invalid', updatedAt: T0, source: 'user' });
});

test('setAnnotation does not mutate the previous state', () => {
  const before = setAnnotation(EMPTY_STATE, 'm-1', 'valid', { now: T0 });
  const after = setAnnotation(before, 'm-2', 'invalid', { now: T0 });
  assert.equal(before.byMessageId.size, 1);
  assert.equal(after.byMessageId.size, 2);
});

test('setting unmarked removes the record instead of storing a third state', () => {
  const marked = setAnnotation(EMPTY_STATE, 'm-1', 'invalid', { now: T0 });
  const cleared = setAnnotation(marked, 'm-1', 'unmarked', { now: T0 });
  assert.equal(cleared.byMessageId.size, 0);
});

test('setAnnotation rejects a blank message id', () => {
  assert.throws(() => setAnnotation(EMPTY_STATE, '   ', 'valid'), /non-empty string/);
});

test('setAnnotation trims the message id', () => {
  const state = setAnnotation(EMPTY_STATE, '  m-9  ', 'valid', { now: T0 });
  assert.ok(state.byMessageId.has('m-9'));
});

test('bulkSet applies every item and lets later items win', () => {
  const state = bulkSet(
    EMPTY_STATE,
    [
      { messageId: 'a', status: 'invalid' },
      { messageId: 'b', status: 'valid' },
      { messageId: 'a', status: 'valid' },
    ],
    { now: T0 },
  );
  assert.equal(state.byMessageId.get('a')?.status, 'valid');
  assert.equal(state.byMessageId.get('b')?.status, 'valid');
  assert.equal(state.byMessageId.size, 2);
});

test('removeAnnotation returns the identical state when nothing was stored', () => {
  const state = setAnnotation(EMPTY_STATE, 'a', 'valid', { now: T0 });
  const same = removeAnnotation(state, 'missing');
  assert.equal(same, state);
  const changed = removeAnnotation(state, 'a');
  assert.notEqual(changed, state);
  assert.equal(changed.byMessageId.size, 0);
});

test('clear returns the shared empty state by identity', () => {
  assert.equal(clear(), EMPTY_STATE);
});

test('pruneToLive keeps only annotated messages that still exist', () => {
  const state = bulkSet(
    EMPTY_STATE,
    [
      { messageId: 'live-1', status: 'invalid' },
      { messageId: 'gone', status: 'invalid' },
    ],
    { now: T0 },
  );
  const pruned = pruneToLive(state, ['live-1']);
  assert.deepEqual([...pruned.byMessageId.keys()], ['live-1']);
  assert.equal(pruneToLive(state, ['live-1', 'gone']), state);
});

test('resolveStatus reports unmarked for stored-absent messages under the valid policy', () => {
  const state = setAnnotation(EMPTY_STATE, 'a', 'invalid', { now: T0 });
  assert.equal(resolveStatus(state, 'a', 'valid'), 'invalid');
  assert.equal(resolveStatus(state, 'b', 'valid'), 'unmarked');
  assert.equal(resolveStatus(state, 'b', 'invalid'), 'invalid');
});

test('isExcluded keeps unmarked messages by default, and an explicit valid beats an aggressive policy', () => {
  const state = bulkSet(
    EMPTY_STATE,
    [
      { messageId: 'bad', status: 'invalid' },
      { messageId: 'explicitly-valid', status: 'valid' },
    ],
    { now: T0 },
  );
  assert.equal(isExcluded(state, 'bad', 'valid'), true);
  // Unmarked follows the policy...
  assert.equal(isExcluded(state, 'unmarked-one', 'valid'), false);
  assert.equal(isExcluded(state, 'unmarked-one', 'invalid'), true);
  // ...but an explicit annotation always overrides it, in both directions.
  assert.equal(isExcluded(state, 'explicitly-valid', 'invalid'), false);
  assert.equal(isExcluded(state, 'bad', 'valid'), true);
});

test('stats counts each status across a known id set', () => {
  const state = bulkSet(
    EMPTY_STATE,
    [
      { messageId: 'a', status: 'invalid' },
      { messageId: 'b', status: 'valid' },
    ],
    { now: T0 },
  );
  assert.deepEqual(stats(state, ['a', 'b', 'c'], 'valid'), {
    total: 3,
    valid: 1,
    invalid: 1,
    unmarked: 1,
  });
});

test('toRecords is ordered by message id so exports are stable', () => {
  const state = bulkSet(
    EMPTY_STATE,
    [
      { messageId: 'zeta', status: 'valid' },
      { messageId: 'alpha', status: 'invalid' },
    ],
    { now: T0 },
  );
  assert.deepEqual(
    toRecords(state).map((r) => r.messageId),
    ['alpha', 'zeta'],
  );
});

test('export then import round-trips records', () => {
  const state = setAnnotation(EMPTY_STATE, 'm-1', 'invalid', { now: T0, source: 'user' });
  const json = exportState(state, 'session-1');
  const parsed = JSON.parse(json) as { version: number; sessionId: string };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sessionId, 'session-1');
  const result = importState(EMPTY_STATE, json);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.state.byMessageId.get('m-1')?.status, 'invalid');
  assert.equal(result.state.byMessageId.get('m-1')?.updatedAt, T0);
});

test('import merges over existing state rather than replacing it', () => {
  const existing = setAnnotation(EMPTY_STATE, 'keep', 'valid', { now: T0 });
  const json = exportState(setAnnotation(EMPTY_STATE, 'new', 'invalid', { now: T0 }), 'session-1');
  const result = importState(existing, json);
  assert.deepEqual([...result.state.byMessageId.keys()].sort(), ['keep', 'new']);
});

test('import skips malformed records and reports the count', () => {
  const payload = JSON.stringify({
    version: 1,
    sessionId: 's',
    records: [
      { messageId: 'ok', status: 'invalid', updatedAt: T0 },
      { messageId: '', status: 'invalid' },
      { messageId: 'bad-status', status: 'sideways' },
      null,
    ],
  });
  const result = importState(EMPTY_STATE, payload);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 3);
});

test('import rejects a payload that is not an envelope', () => {
  assert.throws(() => importState(EMPTY_STATE, '[]'), /must be a JSON object/);
  assert.throws(() => importState(EMPTY_STATE, '{"records":{}}'), /must be an array/);
});
