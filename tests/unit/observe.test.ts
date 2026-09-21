import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CompactionObserver, readCompactionSummary } from '../../src/host/compaction/observe.ts';
import type { InjectionOutcome } from '../../src/host/compaction/interceptor.ts';

const INJECTED: InjectionOutcome = {
  kind: 'injected',
  sessionId: 'session-1',
  messageCount: 61,
  entryCount: 3,
  digestChars: 1491,
  insertIndex: 60,
};

function summaryEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'compaction/summary',
    seq: 163,
    data: {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      shadowedSeqs: [1, 2, 3, 4, 5],
      shadowedTokenCount: 15015,
      summary: [
        { type: 'text', text: 'x'.repeat(100) },
        { type: 'text', text: 'y'.repeat(50) },
      ],
      usage: {
        inputTokens: 968,
        outputTokens: 1830,
        totalTokens: 35438,
        cacheReadTokens: 32640,
      },
      ...overrides,
    },
  };
}

test('readCompactionSummary ignores events of other types', () => {
  assert.equal(readCompactionSummary({ type: 'compaction/start', seq: 1, data: {} }), null);
  assert.equal(readCompactionSummary({ type: 'user/message', seq: 1, data: {} }), null);
  assert.equal(readCompactionSummary(null), null);
  assert.equal(readCompactionSummary('nope'), null);
});

test('readCompactionSummary copies only leaf scalars', () => {
  const record = readCompactionSummary(summaryEvent());
  assert.ok(record !== null);
  assert.equal(record.seq, 163);
  assert.equal(record.provider, 'deepseek-official');
  assert.equal(record.model, 'deepseek-flash');
  assert.equal(record.shadowedCount, 5);
  assert.equal(record.shadowedTokenCount, 15015);
  assert.equal(record.inputTokens, 968);
  assert.equal(record.outputTokens, 1830);
  assert.equal(record.cacheReadTokens, 32640);
  assert.equal(record.cacheWriteTokens, undefined);
});

test('summaryChars counts text blocks only, matching how the seam reads a summary', () => {
  const record = readCompactionSummary(summaryEvent());
  assert.equal(record?.summaryChars, 150);
});

test('a summary without usage still yields a record', () => {
  const record = readCompactionSummary(summaryEvent({ usage: undefined }));
  assert.ok(record !== null);
  assert.equal(record.cacheReadTokens, undefined);
  assert.equal(record.summaryChars, 150);
});

test('recordOutcome tallies injections, skips and failures separately', () => {
  const observer = new CompactionObserver();
  observer.recordOutcome(INJECTED);
  observer.recordOutcome({ kind: 'skipped', reason: 'nothing-excluded' });
  observer.recordOutcome({ kind: 'skipped', reason: 'nothing-excluded' });
  observer.recordOutcome({ kind: 'skipped', reason: 'not-compaction' });
  observer.recordOutcome({ kind: 'failed', error: 'boom' });

  const snapshot = observer.snapshot();
  assert.equal(snapshot.injections.length, 1);
  assert.equal(snapshot.injections[0]?.digestChars, 1491);
  assert.deepEqual(snapshot.skips, { 'nothing-excluded': 2, 'not-compaction': 1 });
  assert.deepEqual(snapshot.failures, ['boom']);
});

test('the snapshot is a detached copy', () => {
  const observer = new CompactionObserver();
  observer.recordOutcome(INJECTED);
  const snapshot = observer.snapshot();
  observer.reset();
  assert.equal(snapshot.injections.length, 1, 'the earlier snapshot must not change');
  assert.equal(observer.snapshot().injections.length, 0);
});

test('retained records are bounded so a long-lived host cannot leak', () => {
  const observer = new CompactionObserver();
  for (let i = 0; i < 500; i += 1) observer.recordOutcome(INJECTED);
  observer.recordSummary({
    at: 0,
    seq: 1,
    provider: undefined,
    model: undefined,
    shadowedCount: 0,
    shadowedTokenCount: undefined,
    summaryChars: 0,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  });
  for (let i = 0; i < 500; i += 1) observer.recordSummary({
    at: i,
    seq: i,
    provider: undefined,
    model: undefined,
    shadowedCount: 0,
    shadowedTokenCount: undefined,
    summaryChars: 0,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  });
  const snapshot = observer.snapshot();
  assert.equal(snapshot.injections.length, 200);
  assert.equal(snapshot.summaries.length, 200);
  // The newest records survive, not the oldest.
  assert.equal(snapshot.summaries[199]?.seq, 499);
});

test('reset clears every list including the skip tally', () => {
  const observer = new CompactionObserver();
  observer.recordOutcome(INJECTED);
  observer.recordOutcome({ kind: 'skipped', reason: 'disabled' });
  observer.recordOutcome({ kind: 'failed', error: 'x' });
  observer.reset();
  const snapshot = observer.snapshot();
  assert.equal(snapshot.injections.length, 0);
  assert.equal(snapshot.failures.length, 0);
  assert.deepEqual(snapshot.skips, {});
});
