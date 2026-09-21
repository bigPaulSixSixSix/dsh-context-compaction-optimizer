/**
 * Client-side RPC.
 *
 * Speaks the envelope the host route defines:
 *
 *   POST /cco/api  { method, params }  →  { ok: true, value } | { ok: false, error }
 *
 * `fetch` is injectable so the whole client data layer is testable in Node,
 * where there is no browser and no server. Mutations go over POST; the host
 * refuses them over GET, so there is deliberately no GET path here.
 *
 * @module dsh-context-compaction-optimizer/client/rpc
 */

/** Mount path, matching the host route. */
export const RPC_PATH = '/cco/api';

/** One failure reported by the host. */
export interface RpcFailure {
  readonly code: string;
  readonly message: string;
}

/** Host envelope. */
export type RpcEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcFailure };

/** Thrown when the host reports a failure or the transport breaks. */
export class RpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** Minimal `fetch` shape this module needs. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Client options. */
export interface RpcClientOptions {
  readonly basePath?: string;
  readonly fetchImpl?: FetchLike;
}

/** The client surface the UI uses. */
export interface RpcClient {
  /** Call a method, throwing {@link RpcError} on any failure. */
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Call a method, returning the envelope without throwing for host failures. */
  tryCall<T>(method: string, params?: Record<string, unknown>): Promise<RpcEnvelope<T>>;
}

function isEnvelope(value: unknown): value is RpcEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['ok'] === true) return 'value' in record;
  if (record['ok'] === false) return typeof record['error'] === 'object' && record['error'] !== null;
  return false;
}

/** Build a client bound to one host route. */
export function createRpcClient(options: RpcClientOptions = {}): RpcClient {
  const basePath = options.basePath ?? RPC_PATH;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);

  async function tryCall<T>(method: string, params: Record<string, unknown> = {}): Promise<RpcEnvelope<T>> {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, error: { code: 'transport', message: 'no fetch implementation available' } };
    }
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(basePath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
      });
    } catch (error) {
      return {
        ok: false,
        error: { code: 'transport', message: error instanceof Error ? error.message : String(error) },
      };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'malformed-response',
          message: `host returned a non-JSON body (HTTP ${response.status}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
    if (!isEnvelope(parsed)) {
      return {
        ok: false,
        error: { code: 'malformed-response', message: `unexpected envelope (HTTP ${response.status})` },
      };
    }
    return parsed as RpcEnvelope<T>;
  }

  return {
    tryCall,
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const envelope = await tryCall<T>(method, params);
      if (envelope.ok) return envelope.value;
      throw new RpcError(envelope.error.code, envelope.error.message);
    },
  };
}
