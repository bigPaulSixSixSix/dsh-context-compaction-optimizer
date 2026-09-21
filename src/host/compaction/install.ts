/**
 * Wiring for the compaction pipeline.
 *
 * Kept separate from the interceptor and the observer so both stay testable
 * without a Cordis context: this module is the only part that knows about
 * `ctx.on`, and it contains no logic worth unit-testing beyond delegation.
 *
 * Placement note (N015): the listener is registered on a **profile-level** fiber,
 * which was verified to receive `llm/stream` for live agent sessions. The
 * `compaction` service itself is NOT reachable from here — it lives in the
 * agent preset's isolate realm — which is why injection happens on the
 * `llm/stream` waterfall rather than by subclassing the engine.
 *
 * @module dsh-context-compaction-optimizer/host/compaction/install
 */

import { applyDigest, type AnnotationLookup, type StreamOptionsLike } from './interceptor.ts';
import { CompactionObserver, readCompactionSummary } from './observe.ts';
import type { DigestFormat } from '../../shared/types.ts';

/** The slice of a Cordis context this module needs. */
export interface ListenerContext {
  on(name: string, listener: (...args: never[]) => unknown): unknown;
}

/** Everything the pipeline needs from its owner. */
export interface CompactionPipelineDeps {
  readonly annotations: AnnotationLookup;
  /** Whether digest injection is enabled right now. */
  readonly enabled: () => boolean;
  /** How the digest identifies excluded messages. */
  readonly format: () => DigestFormat;
  readonly observer: CompactionObserver;
}

/**
 * Register the interceptor and the telemetry listeners.
 *
 * Both registrations are fiber-owned: Cordis disposes them when the plugin
 * unloads, so there is nothing to clean up here.
 */
export function installCompactionPipeline(ctx: ListenerContext, deps: CompactionPipelineDeps): void {
  ctx.on('llm/stream', ((options: StreamOptionsLike, next: () => unknown) => {
    // `applyDigest` never throws: a defect degrades to stock compaction rather
    // than breaking the model call.
    applyDigest(options, {
      annotations: deps.annotations,
      enabled: deps.enabled,
      format: deps.format,
      onOutcome: (outcome) => deps.observer.recordOutcome(outcome),
    });
    return next();
  }) as never);

  ctx.on('session/event', ((_session: unknown, event: unknown) => {
    const record = readCompactionSummary(event);
    if (record !== null) deps.observer.recordSummary(record);
  }) as never);
}
