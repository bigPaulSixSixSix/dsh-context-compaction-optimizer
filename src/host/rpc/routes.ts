/**
 * HTTP binding for the RPC dispatch.
 *
 * This is the host half of the client channel. M0 established that a packaged
 * plugin cannot use the first-party Typert remote path — the generator that
 * produces the required strict artifacts is not published — so the supported
 * route is a plugin-owned web route, which is exactly what the two real
 * third-party plugins in this deployment do (`dsh-better-sidebar` at
 * `/sidebar/api`, `dshmarket` at `/dsh-market/*`).
 *
 * Two deliberate constraints:
 *
 * 1. **Same-origin only.** `Origin`, when present, must match `Host`. A request
 *    with no `Origin` is a non-browser client (a test harness, a CLI) and is
 *    allowed; a browser always attaches `Origin` to a cross-origin POST, so a
 *    hostile page cannot reach a local write endpoint.
 * 2. **GET is read-only.** Mutations are POST-only. Allowing `?method=annotations.set`
 *    over GET would make every write reachable from an `<img src>` tag, which no
 *    origin check can prevent.
 *
 * @module dsh-context-compaction-optimizer/host/rpc/routes
 */

import { dispatchRpc, type RpcDeps, type RpcErrorCode, type RpcResult } from './methods.ts';

/** Mount path. Absolute, no trailing slash, per the web server's route contract. */
export const RPC_PATH = '/cco/api';

/** Body cap. Annotations are small; anything larger is a mistake or an attack. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Methods reachable over GET, for debugging and for cheap reads. */
export const READ_ONLY_METHODS: readonly string[] = Object.freeze([
  'settings.get',
  'session.list',
  'session.surface',
  'annotations.list',
  'annotations.stats',
  'diagnostics.snapshot',
]);

/** Node `IncomingMessage` shape this module relies on. */
export interface RequestLike extends AsyncIterable<unknown> {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
}

/** Node `ServerResponse` shape this module relies on. */
export interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** The web server slice this module needs. */
export interface WebServerLike {
  register(route: {
    kind: 'prefix';
    path: string;
    handler: (req: RequestLike, res: ResponseLike) => void | Promise<void>;
  }): () => void;
}

function headerOf(req: RequestLike, name: string): string | undefined {
  const value = req.headers?.[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/**
 * Whether a request may reach a write endpoint.
 *
 * An absent `Origin` is allowed on purpose: the plugin's own tests and any
 * local CLI client send none, and refusing them would make the API untestable
 * without a browser. The check is not a security boundary against a local
 * process — nothing here is — it is a barrier against a *web page* reaching the
 * endpoint, and a browser cannot suppress `Origin` on a cross-origin write.
 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin.length === 0) return true;
  if (host === undefined || host.length === 0) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host;
  } catch {
    return false;
  }
}

/** Read and parse a JSON request body under a byte cap. */
export async function readJsonBody(req: AsyncIterable<unknown>, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes =
      typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(0);
    total += bytes.byteLength;
    if (total > limit) throw new Error(`request body exceeds ${limit} bytes`);
    chunks.push(bytes);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  if (text.trim().length === 0) return {};
  return JSON.parse(text) as unknown;
}

function statusFor(code: RpcErrorCode): number {
  switch (code) {
    case 'bad-request':
      return 400;
    case 'not-found':
      return 404;
    case 'unsupported-method':
      return 404;
    default:
      return 500;
  }
}

function send(res: ResponseLike, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function respond(res: ResponseLike, result: RpcResult): void {
  send(res, result.ok ? 200 : statusFor(result.error.code), result);
}

/** Build the request handler. Exported so it can be exercised without a server. */
export function createRpcHandler(deps: RpcDeps): (req: RequestLike, res: ResponseLike) => Promise<void> {
  return async (req, res) => {
    const httpMethod = (req.method ?? 'GET').toUpperCase();

    if (!isSameOrigin(headerOf(req, 'origin'), headerOf(req, 'host'))) {
      send(res, 403, {
        ok: false,
        error: { code: 'bad-request', message: 'cross-origin request refused' },
      });
      return;
    }

    let envelope: { method?: unknown; params?: unknown };
    if (httpMethod === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, {
          ok: false,
          error: {
            code: 'bad-request',
            message: `could not read request body: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
        return;
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: 'body must be an object' } });
        return;
      }
      envelope = body as { method?: unknown; params?: unknown };
    } else {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = url.searchParams.get('method');
      if (method === null || !READ_ONLY_METHODS.includes(method)) {
        send(res, 405, {
          ok: false,
          error: {
            code: 'bad-request',
            message: `GET is read-only; use POST. Read methods: ${READ_ONLY_METHODS.join(', ')}`,
          },
        });
        return;
      }
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) if (key !== 'method') params[key] = value;
      envelope = { method, params };
    }

    respond(res, await dispatchRpc(envelope.method, envelope.params, deps));
  };
}

/** Register the route. The returned disposer is the web server's. */
export function registerRpcRoutes(webServer: WebServerLike, deps: RpcDeps): () => void {
  return webServer.register({ kind: 'prefix', path: RPC_PATH, handler: createRpcHandler(deps) });
}
