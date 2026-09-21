import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RPC_PATH, RpcError, createRpcClient, type FetchLike } from '../../src/client/rpc.ts';

/** Recording fetch double. */
function fakeFetch(
  responder: (url: string, init: { method?: string; body?: string }) => {
    ok?: boolean;
    status?: number;
    body?: unknown;
    throwOnJson?: boolean;
    throwOnFetch?: string;
  },
): { impl: FetchLike; calls: { url: string; init: { method?: string; body?: string } }[] } {
  const calls: { url: string; init: { method?: string; body?: string } }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const outcome = responder(url, init ?? {});
    if (outcome.throwOnFetch !== undefined) throw new Error(outcome.throwOnFetch);
    return {
      ok: outcome.ok ?? true,
      status: outcome.status ?? 200,
      async json() {
        if (outcome.throwOnJson === true) throw new Error('not json');
        return outcome.body;
      },
    };
  };
  return { impl, calls };
}

test('a successful call returns the value and posts the documented envelope', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { ok: true, value: { answer: 42 } } }));
  const client = createRpcClient({ fetchImpl: impl });

  const value = await client.call<{ answer: number }>('settings.get', { a: 1 });

  assert.deepEqual(value, { answer: 42 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, RPC_PATH);
  assert.equal(calls[0]?.init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0]?.init.body ?? '{}'), {
    method: 'settings.get',
    params: { a: 1 },
  });
});

test('params default to an empty object', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { ok: true, value: null } }));
  const client = createRpcClient({ fetchImpl: impl });
  await client.call('session.list');
  assert.deepEqual(JSON.parse(calls[0]?.init.body ?? '{}'), { method: 'session.list', params: {} });
});

test('a host failure becomes an RpcError carrying the host code', async () => {
  const { impl } = fakeFetch(() => ({
    ok: false,
    status: 400,
    body: { ok: false, error: { code: 'bad-request', message: 'sessionId must be a non-empty string' } },
  }));
  const client = createRpcClient({ fetchImpl: impl });

  await assert.rejects(
    () => client.call('annotations.list', { sessionId: '' }),
    (error: unknown) => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.code, 'bad-request');
      assert.match(error.message, /sessionId/);
      return true;
    },
  );
});

test('tryCall returns the failure envelope instead of throwing', async () => {
  const { impl } = fakeFetch(() => ({
    ok: false,
    status: 404,
    body: { ok: false, error: { code: 'not-found', message: 'unknown session' } },
  }));
  const client = createRpcClient({ fetchImpl: impl });

  const envelope = await client.tryCall('annotations.list', { sessionId: 'x' });
  assert.equal(envelope.ok, false);
  if (!envelope.ok) assert.equal(envelope.error.code, 'not-found');
});

test('a transport failure is reported as a transport error, not swallowed', async () => {
  const { impl } = fakeFetch(() => ({ throwOnFetch: 'connection refused' }));
  const client = createRpcClient({ fetchImpl: impl });

  const envelope = await client.tryCall('settings.get');
  assert.equal(envelope.ok, false);
  if (!envelope.ok) {
    assert.equal(envelope.error.code, 'transport');
    assert.match(envelope.error.message, /connection refused/);
  }
});

test('a non-JSON body is reported as malformed-response with the HTTP status', async () => {
  const { impl } = fakeFetch(() => ({ status: 502, throwOnJson: true }));
  const client = createRpcClient({ fetchImpl: impl });

  const envelope = await client.tryCall('settings.get');
  assert.equal(envelope.ok, false);
  if (!envelope.ok) {
    assert.equal(envelope.error.code, 'malformed-response');
    assert.match(envelope.error.message, /502/);
  }
});

test('a JSON body that is not an envelope is rejected rather than treated as a value', async () => {
  for (const body of [{ hello: 'world' }, { ok: 'yes', value: 1 }, { ok: false }, 'plain', 7]) {
    const { impl } = fakeFetch(() => ({ body }));
    const client = createRpcClient({ fetchImpl: impl });
    const envelope = await client.tryCall('settings.get');
    assert.equal(envelope.ok, false, `body ${JSON.stringify(body)} must be refused`);
    if (!envelope.ok) assert.equal(envelope.error.code, 'malformed-response');
  }
});

test('a missing fetch implementation fails predictably instead of throwing a TypeError', async () => {
  const client = createRpcClient({ fetchImpl: undefined as unknown as FetchLike });
  const envelope = await client.tryCall('settings.get');
  assert.equal(envelope.ok, false);
  if (!envelope.ok) assert.equal(envelope.error.code, 'transport');
});

test('a custom base path is honoured', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { ok: true, value: null } }));
  const client = createRpcClient({ basePath: '/custom/api', fetchImpl: impl });
  await client.call('settings.get');
  assert.equal(calls[0]?.url, '/custom/api');
});
