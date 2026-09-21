/**
 * RPC method dispatch.
 *
 * Deliberately transport-free: this module knows nothing about HTTP, `req`, or
 * `res`. The route layer validates the origin and parses the body, then hands a
 * `(method, params)` pair here. That split is what makes the whole host API
 * testable without standing up a server.
 *
 * Wire shape is a small envelope rather than HTTP status codes carrying
 * meaning, because the client has to distinguish "your request was malformed"
 * from "the write failed" from "the plugin is broken":
 *
 *   { ok: true,  value: ... }
 *   { ok: false, error: { code, message } }
 *
 * @module dsh-context-compaction-optimizer/host/rpc/methods
 */

import { sanitizeRecords, type ExportEnvelope } from '../../core/annotations.ts';
import type {
  AnnotationRecord,
  AnnotationStats,
  AnnotationStatus,
  PluginSettings,
} from '../../shared/types.ts';
import type { SurfaceTurn } from '../session/surface.ts';

/** Failure classes a caller can act on. */
export type RpcErrorCode = 'bad-request' | 'not-found' | 'unsupported-method' | 'internal';

/** One failure. */
export interface RpcFailure {
  readonly code: RpcErrorCode;
  readonly message: string;
}

/** Dispatch result. */
export type RpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcFailure };

/** The annotation surface the RPC layer needs. */
export interface AnnotationPort {
  list(sessionId: string): readonly AnnotationRecord[];
  set(
    sessionId: string,
    messageId: string,
    status: AnnotationStatus,
    source?: 'user' | 'system' | 'import',
  ): Promise<{ readonly applied: number }>;
  bulkSet(
    sessionId: string,
    items: readonly { readonly messageId: string; readonly status: AnnotationStatus }[],
    source?: 'user' | 'system' | 'import',
  ): Promise<{ readonly applied: number }>;
  remove(sessionId: string, messageId: string): Promise<boolean>;
  clear(sessionId: string): Promise<number>;
  stats(sessionId: string, messageIds: Iterable<string>): AnnotationStats;
  importRecords(
    sessionId: string,
    records: readonly AnnotationRecord[],
  ): Promise<{ readonly applied: number }>;
}

/** Everything dispatch needs; supplied by the plugin entry. */
export interface RpcDeps {
  readonly annotations: AnnotationPort;
  readonly settings: {
    get(): PluginSettings;
    update(patch: Partial<PluginSettings>): Promise<void>;
  };
  readonly observer: { snapshot(): unknown };
  /**
   * Current surface grouped into turns, or `null` when the session is unknown.
   *
   * Turns rather than a flat message list because the turn is the unit the
   * operator annotates: one exchange routinely spans dozens of surface messages,
   * so a per-message list asks for a dozen clicks to express one judgement.
   * Annotations themselves stay per message, since that is what the digest
   * addresses.
   */
  readonly turns: (sessionId: string) => readonly SurfaceTurn[] | null;
  /** Known session ids, for the UI's session picker. */
  readonly sessions?: () => readonly unknown[];
  /**
   * Manual compaction, when this deployment can reach the service.
   *
   * Optional because the capability is genuinely absent in some compositions: a
   * deployment with no command registry, or with no agent preset mounted, still
   * gets automatic interception. The route reports the absence rather than
   * failing to register.
   */
  readonly compaction?: {
    trigger(sessionId: string): Promise<{ readonly kind: 'success' | 'error'; readonly text: string }>;
  };
}

const OK = <T>(value: T): RpcResult<T> => ({ ok: true, value });
const FAIL = (code: RpcErrorCode, message: string): RpcResult<never> => ({
  ok: false,
  error: { code, message },
});

function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequest(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequest(`${key} must be a string when present`);
  return value;
}

function requireStatus(params: Record<string, unknown>, key = 'status'): AnnotationStatus {
  const value = params[key];
  if (value !== 'valid' && value !== 'invalid' && value !== 'unmarked') {
    throw new BadRequest(`${key} must be one of valid | invalid | unmarked`);
  }
  return value;
}

function requireItems(
  params: Record<string, unknown>,
): readonly { readonly messageId: string; readonly status: AnnotationStatus }[] {
  const value = params['items'];
  if (!Array.isArray(value)) throw new BadRequest('items must be an array');
  const out: { messageId: string; status: AnnotationStatus }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) throw new BadRequest('items entries must be objects');
    const record = entry as Record<string, unknown>;
    const messageId = record['messageId'];
    const status = record['status'];
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new BadRequest('items[].messageId must be a non-empty string');
    }
    if (status !== 'valid' && status !== 'invalid' && status !== 'unmarked') {
      throw new BadRequest('items[].status must be one of valid | invalid | unmarked');
    }
    out.push({ messageId, status });
  }
  return out;
}

/** Thrown internally to carry a failure class to the dispatcher. */
class BadRequest extends Error {}

/** Session id with no live session behind it is a distinct, actionable failure. */
class NotFound extends Error {}

/** A method name this build does not implement. */
class UnsupportedMethod extends Error {}

function turnsOrThrow(deps: RpcDeps, sessionId: string): readonly SurfaceTurn[] {
  const turns = deps.turns(sessionId);
  if (turns === null) throw new NotFound(`unknown session ${sessionId}`);
  return turns;
}

/**
 * Dispatch one RPC call.
 *
 * Never throws: every failure is folded into the envelope, because the caller is
 * a browser that can only act on `{ ok: false, error }`.
 */
export async function dispatchRpc(
  method: unknown,
  params: unknown,
  deps: RpcDeps,
): Promise<RpcResult> {
  if (typeof method !== 'string' || method.length === 0) {
    return FAIL('bad-request', 'method must be a non-empty string');
  }
  const p = asRecord(params);
  try {
    return OK(await route(method, p, deps));
  } catch (error) {
    if (error instanceof BadRequest) return FAIL('bad-request', error.message);
    if (error instanceof NotFound) return FAIL('not-found', error.message);
    if (error instanceof UnsupportedMethod) return FAIL('unsupported-method', error.message);
    const message = error instanceof Error ? error.message : String(error);
    return FAIL('internal', message);
  }
}

async function route(method: string, p: Record<string, unknown>, deps: RpcDeps): Promise<unknown> {
  switch (method) {
    case 'annotations.list': {
      const sessionId = requireString(p, 'sessionId');
      turnsOrThrow(deps, sessionId);
      return { records: deps.annotations.list(sessionId) };
    }

    case 'annotations.set': {
      const sessionId = requireString(p, 'sessionId');
      const messageId = requireString(p, 'messageId');
      const status = requireStatus(p);
      const result = await deps.annotations.set(sessionId, messageId, status);
      return { applied: result.applied };
    }

    case 'annotations.bulkSet': {
      const sessionId = requireString(p, 'sessionId');
      const items = requireItems(p);
      const result = await deps.annotations.bulkSet(sessionId, items);
      return { applied: result.applied };
    }

    case 'annotations.remove': {
      const sessionId = requireString(p, 'sessionId');
      const messageId = requireString(p, 'messageId');
      return { removed: await deps.annotations.remove(sessionId, messageId) };
    }

    case 'annotations.clear': {
      const sessionId = requireString(p, 'sessionId');
      return { cleared: await deps.annotations.clear(sessionId) };
    }

    case 'annotations.stats': {
      const sessionId = requireString(p, 'sessionId');
      const turns = turnsOrThrow(deps, sessionId);
      const ids: string[] = [];
      for (const turn of turns) {
        for (const message of turn.messages) if (message.messageId !== null) ids.push(message.messageId);
      }
      return { stats: deps.annotations.stats(sessionId, ids) };
    }

    case 'annotations.export': {
      const sessionId = requireString(p, 'sessionId');
      const envelope: ExportEnvelope = {
        version: 1,
        sessionId,
        records: deps.annotations.list(sessionId),
      };
      return { json: JSON.stringify(envelope, null, 2) };
    }

    case 'annotations.import': {
      const sessionId = requireString(p, 'sessionId');
      const json = requireString(p, 'json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (error) {
        throw new BadRequest(`json is not valid JSON: ${error instanceof Error ? error.message : ''}`);
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new BadRequest('json must be an object envelope');
      }
      const raw = (parsed as { records?: unknown }).records;
      if (!Array.isArray(raw)) throw new BadRequest('json.records must be an array');
      const sanitized = sanitizeRecords(raw);
      const result = await deps.annotations.importRecords(sessionId, sanitized.records);
      return { applied: result.applied, skipped: sanitized.skipped };
    }

    case 'settings.get':
      return { settings: deps.settings.get() };

    case 'settings.update': {
      const patch = p['patch'];
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new BadRequest('patch must be an object');
      }
      const record = patch as Record<string, unknown>;
      const unknownKeys = Object.keys(record).filter(
        (key) =>
          key !== 'unmarkedPolicy' && key !== 'injectDigest' && key !== 'digestFormat' && key !== 'observeCache',
      );
      if (unknownKeys.length > 0) {
        throw new BadRequest(`patch has unknown keys: ${unknownKeys.join(', ')}`);
      }
      if (
        record['unmarkedPolicy'] !== undefined &&
        record['unmarkedPolicy'] !== 'valid' &&
        record['unmarkedPolicy'] !== 'invalid'
      ) {
        throw new BadRequest('patch.unmarkedPolicy must be valid | invalid');
      }
      if (
        record['digestFormat'] !== undefined &&
        record['digestFormat'] !== 'anchors' &&
        record['digestFormat'] !== 'spans'
      ) {
        throw new BadRequest('patch.digestFormat must be anchors | spans');
      }
      await deps.settings.update(record as Partial<PluginSettings>);
      return { settings: deps.settings.get() };
    }

    case 'session.surface': {
      const sessionId = requireString(p, 'sessionId');
      return { turns: turnsOrThrow(deps, sessionId) };
    }

    case 'session.list':
      return { sessions: deps.sessions === undefined ? [] : deps.sessions() };

    /**
     * Trigger one manual compaction for a session.
     *
     * The client cannot compact by itself — there is no compaction RPC to call
     * — so it submits the same command line an operator would type, and this
     * route is the only seam that turns a confirmed preview into a real
     * compaction. Annotate first, then trigger: the annotations are what the
     * summarizer is told to honour, and they are read at compaction time.
     */
    case 'compaction.trigger': {
      const sessionId = requireString(p, 'sessionId');
      turnsOrThrow(deps, sessionId);
      if (deps.compaction === undefined) {
        return {
          kind: 'error',
          text: 'manual compaction is unavailable: this deployment registers no command registry',
        };
      }
      return await deps.compaction.trigger(sessionId);
    }

    case 'diagnostics.snapshot': {
      const sessionId = optionalString(p, 'sessionId');
      return {
        observer: deps.observer.snapshot(),
        settings: deps.settings.get(),
        annotations: sessionId === undefined ? null : deps.annotations.list(sessionId),
      };
    }

    default:
      throw new UnsupportedMethod(`unsupported method ${method}`);
  }
}
