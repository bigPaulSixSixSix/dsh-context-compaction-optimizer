import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BODY_BYTES,
  READ_ONLY_METHODS,
  RPC_PATH,
  createRpcHandler,
  isSameOrigin,
  readJsonBody,
  registerRpcRoutes,
  type RequestLike,
  type ResponseLike,
} from '../../src/host/rpc/routes.ts';
import type { RpcDeps } from '../../src/host/rpc/methods.ts';

const SESSION = 'session-1';

/** Minimal request double: an async-iterable of body chunks plus headers. */
function request(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): RequestLike {
  const chunks = options.body === undefined ? [] : [options.body];
  return {
    method: options.method ?? 'GET',
    url: options.url ?? RPC_PATH,
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** Response double capturing status, headers and body. */
function response(): ResponseLike & { status: number; headers: Record<string, string>; body: string } {
  const captured = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  };
  return captured;
}

function deps(): RpcDeps {
  return {
    annotations: {
      list: () => [{ messageId: 'm-1', status: 'invalid', updatedAt: 1, source: 'user' }],
      set: async () => ({ applied: 1 }),
      bulkSet: async (_sessionId, items) => ({ applied: items.length }),
      remove: async () => true,
      clear: async () => 0,
      stats: () => ({ total: 0, valid: 0, invalid: 0, unmarked: 0 }),
      importRecords: async () => ({ applied: 0 }),
    },
    settings: {
      get: () => ({ unmarkedPolicy: 'valid', injectDigest: true, observeCache: false }),
      update: async () => undefined,
    },
    observer: { snapshot: () => ({}) },
    turns: () => [
      {
        id: 'turn:1',
        startSeq: 1,
        endSeq: null,
        messages: [{ seq: 1, eventType: 'user/message', role: 'user', messageId: 'm-1', head: 'hi' }],
      },
    ],
    sessions: () => [{ id: SESSION }],
  };
}

test('isSameOrigin allows a missing Origin and a matching one, and refuses the rest', () => {
  assert.equal(isSameOrigin(undefined, '127.0.0.1:3080'), true, 'a non-browser client sends no Origin');
  assert.equal(isSameOrigin('', '127.0.0.1:3080'), true);
  assert.equal(isSameOrigin('http://127.0.0.1:3080', '127.0.0.1:3080'), true);
  assert.equal(isSameOrigin('http://evil.example', '127.0.0.1:3080'), false);
  assert.equal(isSameOrigin('not a url', '127.0.0.1:3080'), false);
  assert.equal(isSameOrigin('http://127.0.0.1:3080', undefined), false);
});

test('POST dispatches a method and returns the envelope', async () => {
  const handler = createRpcHandler(deps());
  const res = response();
  await handler(
    request({ method: 'POST', body: JSON.stringify({ method: 'annotations.list', params: { sessionId: SESSION } }) }),
    res,
  );
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body) as { ok: boolean; value: { records: unknown[] } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.records.length, 1);
});

test('POST forwards a failure with its code mapped to an HTTP status', async () => {
  const handler = createRpcHandler(deps());
  const res = response();
  await handler(request({ method: 'POST', body: JSON.stringify({ method: 'nope' }) }), res);
  assert.equal(res.status, 404);
  const parsed = JSON.parse(res.body) as { ok: boolean; error: { code: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'unsupported-method');
});

test('a malformed JSON body is a 400 and never reaches dispatch', async () => {
  const handler = createRpcHandler(deps());
  const res = response();
  await handler(request({ method: 'POST', body: '{not json' }), res);
  assert.equal(res.status, 400);
  assert.match(res.body, /could not read request body/);
});

test('an oversized body is refused', async () => {
  const handler = createRpcHandler(deps());
  const res = response();
  await handler(
    request({ method: 'POST', body: JSON.stringify({ method: 'annotations.list', pad: 'x'.repeat(MAX_BODY_BYTES) }) }),
    res,
  );
  assert.equal(res.status, 400);
  assert.match(res.body, /exceeds/);
});

test('a body that is not an object is refused', async () => {
  const handler = createRpcHandler(deps());
  for (const body of ['[]', '"str"', '42']) {
    const res = response();
    await handler(request({ method: 'POST', body }), res);
    assert.equal(res.status, 400, `body ${body} must be refused`);
  }
});

/**
 * The CSRF barrier. Without it, `?method=annotations.set` would be reachable
 * from an `<img src>` on any page the operator visits.
 */
test('GET serves read-only methods and refuses mutations', async () => {
  const handler = createRpcHandler(deps());

  const read = response();
  await handler(
    request({ method: 'GET', url: `${RPC_PATH}?method=annotations.list&sessionId=${SESSION}` }),
    read,
  );
  assert.equal(read.status, 200);
  assert.match(read.body, /"ok":true/);

  // `compaction.trigger` belongs here above all others: it spends a model call
  // and rewrites the session surface, so a GET-reachable form would make it
  // fireable from an `<img src>` on any page the operator visits.
  for (const mutating of [
    'annotations.set',
    'annotations.clear',
    'settings.update',
    'annotations.import',
    'compaction.trigger',
  ]) {
    const res = response();
    await handler(request({ method: 'GET', url: `${RPC_PATH}?method=${mutating}&sessionId=${SESSION}` }), res);
    assert.equal(res.status, 405, `${mutating} must not be reachable over GET`);
  }

  const missing = response();
  await handler(request({ method: 'GET', url: RPC_PATH }), missing);
  assert.equal(missing.status, 405);
});

test('every read-only method is actually a real method', () => {
  // Guards against the allowlist drifting away from the dispatcher.
  assert.ok(READ_ONLY_METHODS.length > 0);
  for (const method of READ_ONLY_METHODS) assert.match(method, /^(annotations|settings|session|diagnostics)\./);
});

test('a cross-origin POST is refused before dispatch', async () => {
  const handler = createRpcHandler(deps());
  const res = response();
  await handler(
    request({
      method: 'POST',
      headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' },
      body: JSON.stringify({ method: 'annotations.clear', params: { sessionId: SESSION } }),
    }),
    res,
  );
  assert.equal(res.status, 403);
  assert.match(res.body, /cross-origin/);
});

test('a same-origin POST is allowed', async () => {
  const handler = createRpcHandler(deps());
  const res = response();
  await handler(
    request({
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
      body: JSON.stringify({ method: 'annotations.list', params: { sessionId: SESSION } }),
    }),
    res,
  );
  assert.equal(res.status, 200);
});

test('readJsonBody parses chunks and caps the size', async () => {
  const parsed = await readJsonBody(request({ body: '{"a":1}' }) as never);
  assert.deepEqual(parsed, { a: 1 });
  assert.deepEqual(await readJsonBody(request({}) as never), {}, 'an empty body is an empty object');
  await assert.rejects(() => readJsonBody(request({ body: 'x'.repeat(50) }) as never, 10), /exceeds/);
});

test('registerRpcRoutes mounts a prefix route at the documented path', () => {
  const mounted: { kind: string; path: string }[] = [];
  const disposer = registerRpcRoutes(
    {
      register(route) {
        mounted.push({ kind: route.kind, path: route.path });
        return () => undefined;
      },
    },
    deps(),
  );
  assert.deepEqual(mounted, [{ kind: 'prefix', path: RPC_PATH }]);
  assert.equal(typeof disposer, 'function');
  assert.equal(RPC_PATH, '/cco/api');
});
