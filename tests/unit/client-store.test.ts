import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnotationController, turnStatus } from '../../src/client/store.ts';
import type { RpcClient } from '../../src/client/rpc.ts';
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
  failNext(method: string, message: string): void;
}

function harness(initial: readonly AnnotationRecord[] = []): Harness {
  let records = [...initial];
  let turns: readonly SurfaceTurn[] = fixture();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const failures = new Map<string, string>();

  const rpc: RpcClient = {
    async tryCall() {
      throw new Error('not used');
    },
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      const failure = failures.get(method);
      if (failure !== undefined) {
        failures.delete(method);
        throw new Error(failure);
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
    failNext(method, failure) {
      failures.set(method, failure);
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
  assert.equal(view.loaded, true);
  assert.equal(view.error, null);
  assert.equal(view.turns.length, 3, 'the unit is the turn, not the message');
  assert.equal(view.messages.length, 4, 'messages stay available for membership checks');
  assert.equal(view.byMessageId.get('m-2'), 'invalid');
  // Turn 1 carries the marked messages; turns 3 and the loose one do not.
  assert.deepEqual(view.stats, { total: 3, valid: 0, invalid: 1, unmarked: 2 });
});

test('a load failure is surfaced on the view rather than thrown', async () => {
  const h = harness();
  h.failNext('annotations.list', 'storage exploded');
  const controller = new AnnotationController(h.rpc);

  await controller.load(SESSION);

  const view = controller.view(SESSION);
  assert.equal(view.loaded, true);
  assert.match(view.error ?? '', /storage exploded/);
  assert.equal(view.turns.length, 0);
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
  assert.equal(other.loaded, false);
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
  assert.equal(view.loaded, true);
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
