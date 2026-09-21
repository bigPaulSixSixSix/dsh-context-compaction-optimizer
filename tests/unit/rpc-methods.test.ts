import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchRpc, type AnnotationPort, type RpcDeps } from '../../src/host/rpc/methods.ts';
import type { AnnotationRecord, PluginSettings } from '../../src/shared/types.ts';

const SESSION = 'session-1';
const RECORD: AnnotationRecord = { messageId: 'm-1', status: 'invalid', updatedAt: 1, source: 'user' };

interface Harness {
  deps: RpcDeps;
  calls: string[];
  settings: PluginSettings;
}

function harness(overrides: { surfaceKnown?: boolean } = {}): Harness {
  const calls: string[] = [];
  let settings: PluginSettings = {
    unmarkedPolicy: 'valid',
    injectDigest: true,
    observeCache: false,
  };
  const annotations: AnnotationPort = {
    list: (sessionId) => {
      calls.push(`list:${sessionId}`);
      return [RECORD];
    },
    set: async (sessionId, messageId, status) => {
      calls.push(`set:${sessionId}:${messageId}:${status}`);
      return { applied: 1 };
    },
    bulkSet: async (sessionId, items) => {
      calls.push(`bulk:${sessionId}:${items.length}`);
      return { applied: items.length };
    },
    remove: async (sessionId, messageId) => {
      calls.push(`remove:${sessionId}:${messageId}`);
      return true;
    },
    clear: async (sessionId) => {
      calls.push(`clear:${sessionId}`);
      return 3;
    },
    stats: () => ({ total: 1, valid: 0, invalid: 1, unmarked: 0 }),
    importRecords: async (sessionId, records) => {
      calls.push(`import:${sessionId}:${records.length}`);
      return { applied: records.length };
    },
  };
  const deps: RpcDeps = {
    annotations,
    settings: {
      get: () => settings,
      update: async (patch) => {
        calls.push(`settings.update:${Object.keys(patch).join(',')}`);
        settings = { ...settings, ...patch };
      },
    },
    observer: { snapshot: () => ({ injections: [], summaries: [] }) },
    turns: () =>
      overrides.surfaceKnown === false
        ? null
        : [
            {
              id: 'turn:1',
              startSeq: 1,
              endSeq: null,
              messages: [{ seq: 1, eventType: 'user/message', role: 'user', messageId: 'm-1', head: 'hello' }],
            },
          ],
    sessions: () => [{ id: SESSION }],
  };
  return {
    deps,
    calls,
    get settings() {
      return settings;
    },
  };
}

test('a non-string method is rejected as bad-request', async () => {
  const { deps } = harness();
  const result = await dispatchRpc(undefined, {}, deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'bad-request');
});

test('an unknown method reports unsupported-method rather than internal', async () => {
  const { deps } = harness();
  const result = await dispatchRpc('annotations.nope', {}, deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unsupported-method');
});

test('a missing sessionId is a bad-request, not a crash', async () => {
  const { deps } = harness();
  for (const method of ['annotations.list', 'annotations.set', 'annotations.stats', 'session.surface']) {
    const result = await dispatchRpc(method, {}, deps);
    assert.equal(result.ok, false, `${method} must fail`);
    if (!result.ok) assert.equal(result.error.code, 'bad-request');
  }
});

test('an unknown session is a distinct not-found failure', async () => {
  const { deps } = harness({ surfaceKnown: false });
  const result = await dispatchRpc('annotations.list', { sessionId: 'ghost' }, deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'not-found');
});

test('annotations.set forwards a valid status', async () => {
  const h = harness();
  const result = await dispatchRpc(
    'annotations.set',
    { sessionId: SESSION, messageId: 'm-9', status: 'invalid' },
    h.deps,
  );
  assert.deepEqual(result, { ok: true, value: { applied: 1 } });
  assert.deepEqual(h.calls, [`set:${SESSION}:m-9:invalid`]);
});

test('annotations.set refuses a status outside the stored union', async () => {
  const h = harness();
  const result = await dispatchRpc(
    'annotations.set',
    { sessionId: SESSION, messageId: 'm-9', status: 'maybe' },
    h.deps,
  );
  assert.equal(result.ok, false);
  assert.equal(h.calls.length, 0, 'nothing must reach the service');
});

test('annotations.bulkSet validates every entry before writing anything', async () => {
  const h = harness();
  const bad = await dispatchRpc(
    'annotations.bulkSet',
    { sessionId: SESSION, items: [{ messageId: 'a', status: 'invalid' }, { messageId: '', status: 'valid' }] },
    h.deps,
  );
  assert.equal(bad.ok, false);
  assert.equal(h.calls.length, 0, 'a partially invalid batch must not write at all');

  const good = await dispatchRpc(
    'annotations.bulkSet',
    { sessionId: SESSION, items: [{ messageId: 'a', status: 'invalid' }, { messageId: 'b', status: 'valid' }] },
    h.deps,
  );
  assert.deepEqual(good, { ok: true, value: { applied: 2 } });
  assert.deepEqual(h.calls, [`bulk:${SESSION}:2`]);
});

test('annotations.export returns a versioned envelope', async () => {
  const { deps } = harness();
  const result = await dispatchRpc('annotations.export', { sessionId: SESSION }, deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { json: string };
  const parsed = JSON.parse(value.json) as { version: number; sessionId: string; records: unknown[] };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sessionId, SESSION);
  assert.equal(parsed.records.length, 1);
});

test('annotations.import rejects non-JSON and non-envelope payloads', async () => {
  const h = harness();
  for (const json of ['not json', '[]', '{"records":{}}']) {
    const result = await dispatchRpc('annotations.import', { sessionId: SESSION, json }, h.deps);
    assert.equal(result.ok, false, `payload ${json} must be refused`);
  }
  assert.equal(h.calls.length, 0);
});

test('annotations.import reports applied and skipped counts', async () => {
  const h = harness();
  const json = JSON.stringify({
    version: 1,
    sessionId: SESSION,
    records: [
      { messageId: 'ok', status: 'invalid', updatedAt: 1 },
      { messageId: '', status: 'invalid' },
      { messageId: 'x', status: 'nonsense' },
    ],
  });
  const result = await dispatchRpc('annotations.import', { sessionId: SESSION, json }, h.deps);
  assert.deepEqual(result, { ok: true, value: { applied: 1, skipped: 2 } });
});

test('settings.get returns the resolved value', async () => {
  const { deps } = harness();
  const result = await dispatchRpc('settings.get', {}, deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual((result.value as { settings: PluginSettings }).settings, {
    unmarkedPolicy: 'valid',
    injectDigest: true,
    observeCache: false,
  });
});

test('settings.update refuses unknown keys instead of silently dropping them', async () => {
  const h = harness();
  const result = await dispatchRpc('settings.update', { patch: { nonsense: 1 } }, h.deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'bad-request');
  assert.equal(h.calls.length, 0);
});

test('settings.update refuses a bad enum value', async () => {
  const h = harness();
  const result = await dispatchRpc('settings.update', { patch: { unmarkedPolicy: 'whatever' } }, h.deps);
  assert.equal(result.ok, false);
  assert.equal(h.calls.length, 0);
});

test('settings.update applies a valid patch and returns the new value', async () => {
  const h = harness();
  const result = await dispatchRpc('settings.update', { patch: { injectDigest: false } }, h.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal((result.value as { settings: PluginSettings }).settings.injectDigest, false);
  assert.deepEqual(h.calls, ['settings.update:injectDigest']);
});

test('diagnostics.snapshot includes the observer and optional annotations', async () => {
  const h = harness();
  const withoutSession = await dispatchRpc('diagnostics.snapshot', {}, h.deps);
  assert.equal(withoutSession.ok, true);
  if (withoutSession.ok) {
    assert.deepEqual((withoutSession.value as { annotations: unknown }).annotations, null);
  }
  const withSession = await dispatchRpc('diagnostics.snapshot', { sessionId: SESSION }, h.deps);
  assert.equal(withSession.ok, true);
  if (withSession.ok) {
    assert.equal((withSession.value as { annotations: unknown[] }).annotations.length, 1);
  }
});

test('a defect inside a dependency is reported as internal, never thrown', async () => {
  const h = harness();
  const exploding: RpcDeps = {
    ...h.deps,
    annotations: {
      ...h.deps.annotations,
      list: () => {
        throw new Error('storage exploded');
      },
    },
  };
  const result = await dispatchRpc('annotations.list', { sessionId: SESSION }, exploding);
  assert.deepEqual(result, { ok: false, error: { code: 'internal', message: 'storage exploded' } });
});

test('session.list returns the session ids', async () => {
  const { deps } = harness();
  const result = await dispatchRpc('session.list', {}, deps);
  assert.deepEqual(result, { ok: true, value: { sessions: [{ id: SESSION }] } });
});

test('compaction.trigger delegates to the port and returns its outcome', async () => {
  const h = harness();
  const asked: string[] = [];
  const deps: RpcDeps = {
    ...h.deps,
    compaction: {
      async trigger(sessionId) {
        asked.push(sessionId);
        return { kind: 'success', text: 'compaction complete' };
      },
    },
  };

  const result = await dispatchRpc('compaction.trigger', { sessionId: SESSION }, deps);

  assert.deepEqual(asked, [SESSION]);
  assert.deepEqual(result, { ok: true, value: { kind: 'success', text: 'compaction complete' } });
});

/**
 * The capability is genuinely absent in some compositions, so the route reports
 * that instead of failing to register — the panel then explains itself rather
 * than offering a button that cannot work.
 */
test('compaction.trigger reports an unavailable port rather than throwing', async () => {
  const { deps } = harness();

  const result = await dispatchRpc('compaction.trigger', { sessionId: SESSION }, deps);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal((result.value as { kind: string }).kind, 'error');
    assert.match((result.value as { text: string }).text, /unavailable/i);
  }
});

test('compaction.trigger refuses an unknown session before reaching the port', async () => {
  const h = harness({ surfaceKnown: false });
  let reached = false;
  const deps: RpcDeps = {
    ...h.deps,
    compaction: {
      async trigger() {
        reached = true;
        return { kind: 'success', text: 'should not run' };
      },
    },
  };

  const result = await dispatchRpc('compaction.trigger', { sessionId: SESSION }, deps);

  assert.deepEqual(result, { ok: false, error: { code: 'not-found', message: `unknown session ${SESSION}` } });
  assert.equal(reached, false);
});

test('compaction.trigger requires a sessionId', async () => {
  const { deps } = harness();
  const result = await dispatchRpc('compaction.trigger', {}, deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'bad-request');
});

test('a failing compaction surfaces as an error result, not a transport failure', async () => {
  const h = harness();
  const deps: RpcDeps = {
    ...h.deps,
    compaction: {
      async trigger() {
        return { kind: 'error', text: 'provider refused' };
      },
    },
  };

  const result = await dispatchRpc('compaction.trigger', { sessionId: SESSION }, deps);

  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { kind: 'error', text: 'provider refused' });
});
