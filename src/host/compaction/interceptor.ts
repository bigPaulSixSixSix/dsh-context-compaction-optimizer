/**
 * The compaction interceptor.
 *
 * Registers one `llm/stream` waterfall listener that appends an annotation
 * digest to the message list of a *summarization* call, immediately before the
 * compaction instruction. Everything else passes through untouched.
 *
 * Three properties are non-negotiable, and each is covered by a test:
 *
 * 1. **Only compaction calls are touched.** `GenerateOptions.purpose` is the
 *    discriminator; an ordinary conversation request is never modified. The
 *    plugin therefore cannot change what a normal turn costs or contains.
 *
 * 2. **The cached prefix is preserved.** The digest is spliced in *before the
 *    final message*, so every earlier message keeps its position and the
 *    provider's prefix cache still hits (N011/N012 measured 96.5% → 97.1%
 *    cache-read ratios with the digest present).
 *
 * 3. **Failure is contained.** Any defect here is caught and reported as an
 *    outcome; `next()` is still called. A plugin bug must degrade to stock
 *    compaction, never to a broken model call. Losing an annotation is
 *    acceptable; breaking the user's session is not.
 *
 * @module dsh-context-compaction-optimizer/host/compaction/interceptor
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { injectBeforeLast, planInjection, DIGEST_ROLE } from '../../core/digest.ts';
import type { DigestFormat, MessageLike } from '../../shared/types.ts';
import { messageId, messageRole, messageText } from './text.ts';

/** Plugin name carried as the digest message's source. */
export const PLUGIN_NAME = 'dsh-context-compaction-optimizer';

/** Why an interceptor pass did nothing. */
export type SkipReason = 'not-compaction' | 'disabled' | 'no-session' | 'nothing-excluded';

/** Result of one interceptor pass. */
export type InjectionOutcome =
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | {
      readonly kind: 'injected';
      readonly sessionId: string;
      /** Which rendering produced the digest, so measurements self-describe. */
      readonly format: DigestFormat;
      readonly messageCount: number;
      readonly entryCount: number;
      readonly digestChars: number;
      readonly insertIndex: number;
    }
  | { readonly kind: 'failed'; readonly error: string };

/** The exclusion lookup the interceptor needs; satisfied by `AnnotationService`. */
export interface AnnotationLookup {
  excludes(sessionId: string, messageId: string): boolean;
}

/** Interceptor configuration. */
export interface InterceptorDeps {
  readonly annotations: AnnotationLookup;
  /** Whether injection is currently enabled. */
  readonly enabled: () => boolean;
  /** How the digest identifies excluded messages. */
  readonly format: () => DigestFormat;
  /** Sink for every outcome, including skips, for the debug panel. */
  readonly onOutcome?: (outcome: InjectionOutcome) => void;
  /**
   * Builds the provider message that carries the digest.
   *
   * Injectable so the interceptor can be tested without a DSH runtime; the
   * default uses the real `createUserMessage`.
   */
  readonly createDigestMessage?: (text: string) => unknown;
}

/** Structural view of the waterfall's options object. */
export interface StreamOptionsLike {
  purpose?: unknown;
  sessionId?: unknown;
  messages?: unknown;
  [key: string]: unknown;
}

function errText(error: unknown): string {
  if (error === null || error === undefined) return 'nullish'
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Default digest message factory, using the real DSH constructor. */
export function defaultCreateDigestMessage(text: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME },
  });
}

/**
 * Project one raw message into the core layer's leaf-value view.
 *
 * The projection is deliberately total: a message whose shape we do not
 * recognize becomes an id-less placeholder rather than being dropped, because
 * dropping it would shift every later index and make the digest point at the
 * wrong messages.
 */
export function toMessageLike(message: unknown): MessageLike {
  const id = messageId(message);
  return id === undefined
    ? { role: messageRole(message), text: messageText(message) }
    : { id, role: messageRole(message), text: messageText(message) };
}

/**
 * Apply the digest to one `llm/stream` options object.
 *
 * Mutates `options.messages` in place on success — that is the only way to
 * influence a request inside a waterfall, since the waterfall's return value is
 * the response stream, not the options.
 */
export function applyDigest(options: StreamOptionsLike, deps: InterceptorDeps): InjectionOutcome {
  let outcome: InjectionOutcome;
  try {
    outcome = plan(options, deps);
  } catch (error) {
    outcome = { kind: 'failed', error: errText(error) };
  }
  deps.onOutcome?.(outcome);
  return outcome;
}

function plan(options: StreamOptionsLike, deps: InterceptorDeps): InjectionOutcome {
  if (options.purpose !== 'compaction') return { kind: 'skipped', reason: 'not-compaction' };
  if (!deps.enabled()) return { kind: 'skipped', reason: 'disabled' };

  const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0
    ? options.sessionId
    : undefined;
  if (sessionId === undefined) return { kind: 'skipped', reason: 'no-session' };

  const messages: unknown[] = Array.isArray(options.messages) ? options.messages : [];
  const likes = messages.map(toMessageLike);
  const injection = planInjection(
    likes,
    (message) => (message.id !== undefined ? deps.annotations.excludes(sessionId, message.id) : false),
    deps.format(),
  );
  if (injection === null) return { kind: 'skipped', reason: 'nothing-excluded' };

  const create = deps.createDigestMessage ?? defaultCreateDigestMessage;
  const digestMessage = create(injection.digest);
  options.messages = injectBeforeLast(messages, digestMessage);

  return {
    kind: 'injected',
    sessionId,
    format: deps.format(),
    messageCount: messages.length,
    entryCount: injection.entries.length,
    digestChars: injection.digest.length,
    insertIndex: injection.insertIndex,
  };
}
