import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnotationController, DEFAULT_RETRY_DELAYS_MS, turnStatus } from '../../src/client/store.ts';
import { RpcError, type RpcClient } from '../../src/client/rpc.ts';
import type { AnnotationRecord, SurfaceMessage, SurfaceTurn } from '../../src/shared/types.ts';

const SESSION = 'session-1';

function message(seq: number, id: string | null): SurfaceMessage {
  return { seq, eventType: id === null ? 'system/message' : 'user/message', role: 'user', messageId: id, head: `m${seq}` };
}

/** Two ordinary turns and one loose message that no turn encloses. */
function fixture(): readonly SurfaceTurn[] {
  return [
    { id: 'turn:1', startSeq: 1, endSeq: 20, messages: [message(1, 'm-1'), message(2, 'm-2')] },
    { id: 'turn:3', startSeq: 3, endSeq: 40, messages: [message(3, 'm-3')] },
    { id: 'loose:4', startSeq: 4, endSeq: null, messages: [message(4, null)] },
  ];
}

interface Harness {
  rpc: RpcClient;
  calls: { method: string; params: Record<string, unknown> }[];
  setRecords(records: readonly AnnotationRecord[]): void;
  /** Replace the live surface, as a new exchange or a compaction would. */
  setTurns(turns: readonly SurfaceTurn[]): void;
  /** Fail the next call of one method, with the host code it would carry. */
  failNext(method: string, message: string, code?: string): void;
}

function harness(initial: readonly AnnotationRecord[] = []): Harness {
  let records = [...initial];
  let turns: readonly SurfaceTurn[] = fixture();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const failures = new Map<string, { message: string; code: string }>();

  const rpc: RpcClient = {
    async tryCall() {
      throw new Error('not used');
    },
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      const failure = failures.get(method);
      if (failure !== undefined) {
        failures.delete(method);
        // A real `RpcError`, not a bare `Error`: the retry decision reads the
        // host's code, so a test double without one would exercise the wrong
        // branch of it.
        throw new RpcError(failure.code, failure.message);
      }
      switch (method) {
        case 'annotations.list':
          return { records } as unknown as T;
        case 'session.surface':
          return { turns } as unknown as T;
        case 'annotations.bulkSet': {
          const { items } = params as { items: { messageId: string; status: string }[] };
          for (const item of items) {
            records = records.filter((record) => record.messageId !== item.messageId);
            if (item.status !== 'unmarked') {
              records = [
                ...records,
                { messageId: item.messageId, status: item.status, updatedAt: 1, source: 'user' } as AnnotationRecord,
              ];
            }
          }
          return { applied: items.length } as unknown as T;
        }
        case 'annotations.clear':
          records = [];
          return { cleared: 3 } as unknown as T;
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  };

  return {
    rpc,
    calls,
    setRecords(next) {
      records = [...next];
    },
    setTurns(next) {
      turns = [...next];
    },
    failNext(method, failure, code = 'internal') {
      failures.set(method, { message: failure, code });
    },
  };
}

/**
 * The contract that makes `useSyncExternalStore` safe. Returning a fresh object
 * from `view()` on every read re-renders forever, so identity must be stable
 * between real changes.
 */
test('view returns a stable snapshot until the session state actually changes', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);

  const first = controller.view(SESSION);
  assert.equal(controller.view(SESSION), first, 'reads without change must not allocate');

  await controller.load(SESSION);
  const afterLoad = controller.view(SESSION);
  assert.notEqual(afterLoad, first, 'a load must produce a new snapshot');
  assert.equal(controller.view(SESSION), afterLoad);
});

test('load populates turns, records and per-turn stats', async () => {
  // Both messages of turn 1: a turn is all-or-nothing, and a mixed one is
  // cleared on load by #clearMixedTurns.
  const h = harness([
    { messageId: 'm-1', status: 'invalid', updatedAt: 1, source: 'user' },
    { messageId: 'm-2', status: 'invalid', updatedAt: 1, source: 'user' },
  ]);
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.phase, 'ready');
  assert.equal(view.error, null);
  assert.equal(view.turns.length, 3, 'the unit is the turn, not the message');
  assert.equal(view.messages.length, 4, 'messages stay available for membership checks');
  assert.equal(view.byMessageId.get('m-2'), 'invalid');
  // Turn 1 carries the marked messages; turns 3 and the loose one do not.
  assert.deepEqual(view.stats, { total: 3, valid: 0, invalid: 1, unmarked: 2 });
});

/**
 * A failure that another identical attempt cannot fix is terminal and reported
 * immediately — no retry, and no throwing at the caller.
 */
test('a load failure is surfaced on the view rather than thrown', async () => {
  const h = harness();
  h.failNext('annotations.list', 'storage exploded');
  const controller = new AnnotationController(h.rpc);

  await controller.load(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.phase, 'failed');
  assert.match(view.error ?? '', /storage exploded/);
  assert.equal(view.turns.length, 0);
  assert.equal(
    h.calls.filter((call) => call.method === 'annotations.list').length,
    1,
    'an internal failure must not be retried',
  );
});

/**
 * A turn is excluded when *any* of its messages is: the operator's question is
 * "does this exchange contribute content that will be dropped", and one excluded
 * step already answers yes.
 */
test('one invalid message makes the whole turn read as invalid', () => {
  const turns = fixture();
  const byMessageId = new Map([['m-2', 'invalid'] as const]);

  assert.equal(turnStatus(turns[0]!, byMessageId, 'valid'), 'invalid');
  assert.equal(turnStatus(turns[1]!, byMessageId, 'valid'), 'unmarked');
});

test('marking a turn writes every addressable message in it', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);

  await controller.setTurn(SESSION, controller.view(SESSION).turns[0]!, 'invalid');

  const view = controller.view(SESSION);
  assert.equal(view.byMessageId.get('m-1'), 'invalid');
  assert.equal(view.byMessageId.get('m-2'), 'invalid');
  assert.equal(view.stats.invalid, 1);
});

test('clearing a turn removes its annotations', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);
  const turn = controller.view(SESSION).turns[0]!;

  await controller.setTurn(SESSION, turn, 'invalid');
  assert.equal(controller.view(SESSION).stats.invalid, 1);

  await controller.setTurn(SESSION, turn, 'unmarked');
  assert.equal(controller.view(SESSION).stats.invalid, 0);
  assert.equal(controller.view(SESSION).byMessageId.size, 0);
});

/**
 * Records written before turns existed can mark one message of an exchange and
 * not its siblings. Completing them would let a single stray mark exclude an
 * entire exchange, so they are cleared instead — the operator restarts from a
 * state that means something.
 */
test('a mixed turn is cleared rather than completed on load', async () => {
  const h = harness([{ messageId: 'm-1', status: 'invalid', updatedAt: 1, source: 'user' }]);
  const controller = new AnnotationController(h.rpc);

  await controller.load(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.byMessageId.has('m-1'), false, 'the stray mark is dropped');
  assert.equal(view.byMessageId.has('m-2'), false, 'and its sibling is not swept in');
  assert.equal(view.stats.invalid, 0, 'the turn is no longer excluded');
  const writes = h.calls.filter((call) => call.method === 'annotations.bulkSet');
  assert.equal(writes.length, 1, 'one cleanup write');
  assert.deepEqual(
    (writes[0]?.params as { items: unknown }).items,
    [{ messageId: 'm-1', status: 'unmarked' }],
    'only the stray record is cleared',
  );
});

test('a uniformly marked turn survives the cleanup untouched', async () => {
  const h = harness([
    { messageId: 'm-1', status: 'invalid', updatedAt: 1, source: 'user' },
    { messageId: 'm-2', status: 'invalid', updatedAt: 1, source: 'user' },
  ]);
  const controller = new AnnotationController(h.rpc);

  await controller.load(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.stats.invalid, 1);
  assert.equal(h.calls.filter((call) => call.method === 'annotations.bulkSet').length, 0);
});

test('a uniformly marked turn is not rewritten on every load', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);
  await controller.setTurn(SESSION, controller.view(SESSION).turns[1]!, 'invalid');
  const before = h.calls.filter((call) => call.method === 'annotations.bulkSet').length;

  await controller.load(SESSION);

  const after = h.calls.filter((call) => call.method === 'annotations.bulkSet').length;
  assert.equal(after, before, 'a complete turn needs no cleanup write');
});

test('status appears optimistically before the round trip resolves', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);

  const pending = controller.setStatus(SESSION, ['m-1'], 'invalid');
  assert.equal(controller.view(SESSION).stats.invalid, 1);
  await pending;
  assert.equal(controller.view(SESSION).stats.invalid, 1);
});

test('a rejected write re-reads the server state instead of guessing a rollback', async () => {
  // Turn 3 holds a single message, so this mark is uniform and survives the load
  // cleanup — it is the pre-existing state the re-read must preserve.
  const h = harness([{ messageId: 'm-3', status: 'invalid', updatedAt: 1, source: 'user' }]);
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);
  h.failNext('annotations.bulkSet', 'write refused');

  await controller.setStatus(SESSION, ['m-1'], 'invalid');

  const view = controller.view(SESSION);
  assert.equal(view.byMessageId.has('m-1'), false);
  assert.equal(view.byMessageId.get('m-3'), 'invalid');
  assert.match(view.error ?? '', /write refused/);
});

test('turnFor finds the exchange a message belongs to', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);

  assert.equal(controller.turnFor(SESSION, 'm-2')?.id, 'turn:1');
  assert.equal(controller.turnFor(SESSION, 'm-3')?.id, 'turn:3');
  assert.equal(controller.turnFor(SESSION, null), undefined);
  assert.equal(controller.turnFor(SESSION, 'm-999'), undefined);
});

test('the unmarked policy applies per turn and never sweeps up a turn with no id', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);
  assert.equal(controller.view(SESSION).stats.unmarked, 3);

  controller.setPolicy('invalid');

  const view = controller.view(SESSION);
  // Two turns can be addressed, so they follow the policy; the loose message
  // carries no durable id, the host can never exclude it, and counting it as
  // excluded would over-report what a compaction actually drops.
  assert.equal(view.stats.invalid, 2);
  assert.equal(view.stats.unmarked, 1);
});

test('subscribers are notified on change and stop after unsubscribing', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => {
    notifications += 1;
  });

  await controller.load(SESSION);
  const afterLoad = notifications;
  assert.ok(afterLoad > 0);

  unsubscribe();
  await controller.setStatus(SESSION, ['m-1'], 'invalid');
  assert.equal(notifications, afterLoad, 'no notification after unsubscribe');
});

test('clear empties the session and reloads', async () => {
  const h = harness([{ messageId: 'm-1', status: 'invalid', updatedAt: 1, source: 'user' }]);
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);

  await controller.clear(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.byMessageId.size, 0);
  assert.equal(view.stats.invalid, 0);
});

test('two sessions keep independent views', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);

  const other = controller.view('session-2');
  assert.equal(other.phase, 'idle');
  assert.notEqual(other, controller.view(SESSION));
});

/**
 * The N026 bug, restated for turns: a write whose count is computed over a list
 * that predates it moves nothing. A turn that arrived after the last read must
 * still be counted when it is marked.
 */
test('marking a turn that arrived after the last load still moves the count', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);
  h.setTurns([
    ...fixture(),
    { id: 'turn:5', startSeq: 5, endSeq: null, messages: [message(5, 'm-5')] },
  ]);

  await controller.setStatus(SESSION, ['m-5'], 'invalid');

  const view = controller.view(SESSION);
  assert.equal(view.stats.invalid, 1, 'the count must include a turn the load predates');
  assert.equal(view.stats.total, 4, 'the list must pick the new turn up');
});

test('knows reports what the cached surface holds', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);

  assert.equal(controller.knows(SESSION, 'm-1'), false, 'nothing is known before a load');
  await controller.load(SESSION);
  assert.equal(controller.knows(SESSION, 'm-1'), true);
  assert.equal(controller.knows(SESSION, 'm-999'), false);
  assert.equal(controller.knows(SESSION, null), false, 'an id-less message can never be known');
});

test('refreshSurface picks up new turns and preserves annotations', async () => {
  // Turn 1 marked uniformly so the load cleanup leaves it alone.
  const h = harness([
    { messageId: 'm-1', status: 'invalid', updatedAt: 1, source: 'user' },
    { messageId: 'm-2', status: 'invalid', updatedAt: 1, source: 'user' },
  ]);
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);
  assert.equal(controller.view(SESSION).stats.total, 3);

  h.setTurns([...fixture(), { id: 'turn:5', startSeq: 5, endSeq: null, messages: [message(5, 'm-5')] }]);
  await controller.refreshSurface(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.stats.total, 4);
  assert.equal(view.stats.invalid, 1, 'annotations must survive a surface-only refresh');
  assert.equal(view.byMessageId.get('m-2'), 'invalid');
  assert.equal(view.phase, 'ready');
});

test('refreshSurface keeps the snapshot identity when the surface is unchanged', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);
  const before = controller.view(SESSION);

  await controller.refreshSurface(SESSION);

  assert.equal(controller.view(SESSION), before);
});

test('a failed refresh keeps the last good list instead of blanking the panel', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);
  h.failNext('session.surface', 'surface exploded');

  await controller.refreshSurface(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.turns.length, 3);
  assert.equal(view.stats.total, 3);
  assert.equal(view.error, null, 'a failed refresh is not a load error');
});

/** A scheduler that captures retries so a test can run them by hand. */
function retryRecorder(): { schedule: (run: () => void, delayMs: number) => () => void; pending: (() => void)[]; delays: number[] } {
  const pending: (() => void)[] = [];
  const delays: number[] = [];
  return {
    pending,
    delays,
    schedule(run, delayMs) {
      pending.push(run);
      delays.push(delayMs);
      return () => undefined;
    },
  };
}

/**
 * N048. The host projects only sessions that are live in its process, so a read
 * issued before the host has loaded the session fails with `not-found`. That is
 * a timing fact, and treating it as terminal is what left every annotation
 * control grey and unclickable for good.
 */
test('a not-found read is retried until the host has the session', async () => {
  const h = harness();
  const recorder = retryRecorder();
  const controller = new AnnotationController(h.rpc, { schedule: recorder.schedule });

  // The first read loses the race; the retry finds the session loaded.
  h.failNext('session.surface', 'unknown session session-1', 'not-found');
  await controller.load(SESSION);

  const waiting = controller.view(SESSION);
  assert.equal(waiting.phase, 'loading', 'a retryable failure is a load in progress, not a verdict');
  assert.equal(waiting.error, null, 'nothing to report while it is still trying');
  assert.equal(recorder.pending.length, 1, 'exactly one retry was scheduled');

  (recorder.pending.shift() as () => void)();
  await controller.load(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.phase, 'ready', 'the retry must be what makes the surface available');
  assert.equal(view.turns.length, 3);
  assert.equal(recorder.pending.length, 0, 'a success stops the schedule');
});

/**
 * The other half of the contract: retrying is bounded, and running out is a
 * state the operator can read rather than a spinner that never resolves.
 *
 * Only *consecutive* retries exhaust the schedule: each explicit `load` — a
 * mount, the reload button, a panel open — restarts it, which is what an
 * operator asking again should get. So this drives the retries by hand instead
 * of calling `load` between them; the extra `load` calls made while a retry is
 * in flight resolve against it rather than starting a rival attempt.
 */
test('a session the host never loads ends in an explicit, reported state', async () => {
  const h = harness();
  const recorder = retryRecorder();
  const controller = new AnnotationController(h.rpc, {
    schedule: recorder.schedule,
    retryDelaysMs: [10, 10],
  });
  const unreachable = (): void => h.failNext('session.surface', 'unknown session session-1', 'not-found');

  unreachable();
  await controller.load(SESSION);
  assert.equal(controller.view(SESSION).phase, 'loading', 'the first failure schedules a retry');
  assert.equal(recorder.pending.length, 1);

  // `[10, 10]` buys exactly two retries: the first is scheduled by the initial
  // failure, the second by that retry, and the second retry is the terminal one.
  unreachable();
  (recorder.pending.shift() as () => void)();
  await controller.load(SESSION);
  assert.equal(controller.view(SESSION).phase, 'loading', 'one retry remains');
  assert.equal(recorder.pending.length, 1);

  unreachable();
  (recorder.pending.shift() as () => void)();
  await controller.load(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.phase, 'session-not-loaded');
  assert.match(view.error ?? '', /unknown session/, 'the host message is kept for the operator');
  assert.equal(recorder.pending.length, 0, 'the schedule must be finite');
});

/** Asking again must restart the schedule rather than resume an exhausted one. */
test('an explicit reload restarts an exhausted retry schedule', async () => {
  const h = harness();
  const recorder = retryRecorder();
  const controller = new AnnotationController(h.rpc, {
    schedule: recorder.schedule,
    retryDelaysMs: [10],
  });

  h.failNext('session.surface', 'unknown session session-1', 'not-found');
  await controller.load(SESSION);
  h.failNext('session.surface', 'unknown session session-1', 'not-found');
  (recorder.pending.shift() as () => void)();
  await controller.load(SESSION);
  assert.equal(controller.view(SESSION).phase, 'session-not-loaded', 'the schedule is spent');

  h.failNext('session.surface', 'unknown session session-1', 'not-found');
  await controller.load(SESSION);

  assert.equal(controller.view(SESSION).phase, 'loading', 'the reload button gets a fresh schedule');
  assert.equal(recorder.pending.length, 1);
});

/** Two controls mounting together must not produce two round trips. */
test('concurrent loads share one round trip', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);

  await Promise.all([controller.load(SESSION), controller.load(SESSION)]);

  assert.equal(h.calls.filter((call) => call.method === 'session.surface').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'annotations.list').length, 1);
});

/**
 * A refresh that succeeds proves the host can serve the session, so it must also
 * lift a terminal phase — otherwise a session whose first read lost the race
 * would stay disabled even after its surface arrived.
 */
test('a successful refresh clears a terminal phase', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc, { retryDelaysMs: [] });
  h.failNext('session.surface', 'unknown session session-1', 'not-found');

  await controller.load(SESSION);
  assert.equal(controller.view(SESSION).phase, 'session-not-loaded');

  await controller.refreshSurface(SESSION);

  assert.equal(controller.view(SESSION).phase, 'ready');
  assert.equal(controller.view(SESSION).turns.length, 3);
});

/** The default schedule must be finite for the terminal state to be reachable. */
test('the default retry schedule is finite and front-loaded', () => {
  assert.ok(DEFAULT_RETRY_DELAYS_MS.length > 0, 'a transient failure must be retried at all');
  assert.ok(
    DEFAULT_RETRY_DELAYS_MS.every((delay) => Number.isFinite(delay) && delay > 0),
    'every delay must be a real wait',
  );
  const total = DEFAULT_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  assert.ok(total <= 60_000, `the schedule must give up within a minute, saw ${total}ms`);
});

/**
 * N049. After a compaction most of a conversation leaves the surface, so the
 * rows the operator still sees carry ids the surface does not hold. Asking for a
 * re-read on every render would put one request behind every row and never
 * succeed; asking once per id both bounds the traffic and turns "no turns for
 * this message" into a fact the UI can state.
 */
test('a message the surface does not hold is asked about once, then reported', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);

  assert.equal(controller.isOffSurface(SESSION, 'm-gone'), false, 'nothing is known before the ask');
  assert.equal(controller.needsRefreshFor(SESSION, 'm-gone'), true, 'the first ask goes out');
  assert.equal(controller.needsRefreshFor(SESSION, 'm-gone'), false, 'and never again');
  assert.equal(controller.isOffSurface(SESSION, 'm-gone'), true, 'so the UI can say it is gone');

  // The store itself must not fire refreshes: `needsRefreshFor` is a decision the
  // caller asks for, so the traffic stays where the render is.
  const refreshes = h.calls.filter((call) => call.method === 'session.surface').length;
  assert.equal(refreshes, 1, 'only the load read the surface');
});

test('an id that is on the surface is never reported as off it', async () => {
  const h = harness();
  const controller = new AnnotationController(h.rpc);
  await controller.load(SESSION);

  assert.equal(controller.knows(SESSION, 'm-1'), true);
  assert.equal(controller.isOffSurface(SESSION, 'm-1'), false);
  assert.equal(controller.needsRefreshFor(SESSION, null), false, 'an id-less message cannot be asked about');
  assert.equal(controller.isOffSurface(SESSION, null), false);
});
