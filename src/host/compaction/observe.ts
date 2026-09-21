/**
 * Compaction telemetry.
 *
 * Two questions this answers, both of which were open during M0 and are now
 * regression-checked in production:
 *
 * 1. **Did the digest actually reach a call, and how big was it?** Recorded per
 *    injection, with the same field names the M0 probes used so a live session
 *    can be compared against the `01开发日志.md` numbers directly.
 * 2. **Did compacting get more expensive?** `cacheReadTokens` and
 *    `cacheWriteTokens` are reported by the provider and subtracted out of
 *    `inputTokens`, so the cache behaviour is measurable rather than inferred
 *    (`dsh-llm/lib/types/types.d.ts`).
 *
 * Records are bounded: telemetry that grows without limit inside a long-lived
 * host process is a leak with a nice name.
 *
 * @module dsh-context-compaction-optimizer/host/compaction/observe
 */

import type { InjectionOutcome } from './interceptor.ts';

/** Maximum retained records per list. */
const MAX_RECORDS = 200;

/** One digest injection. */
export interface InjectionRecord {
  readonly at: number;
  readonly sessionId: string;
  /** Which rendering produced the digest. */
  readonly format: string;
  readonly messageCount: number;
  readonly entryCount: number;
  readonly digestChars: number;
}

/** One completed compaction summary, priced by the provider. */
export interface SummaryRecord {
  readonly at: number;
  readonly seq: number;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly shadowedCount: number;
  readonly shadowedTokenCount: number | undefined;
  readonly summaryChars: number;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
}

/** Bounded telemetry store. */
export class CompactionObserver {
  readonly #injections: InjectionRecord[] = [];
  readonly #summaries: SummaryRecord[] = [];
  readonly #skips: Record<string, number> = {};
  readonly #failures: string[] = [];

  /** Record one interceptor outcome, whatever it was. */
  recordOutcome(outcome: InjectionOutcome): void {
    if (outcome.kind === 'injected') {
      push(this.#injections, {
        at: Date.now(),
        sessionId: outcome.sessionId,
        format: outcome.format,
        messageCount: outcome.messageCount,
        entryCount: outcome.entryCount,
        digestChars: outcome.digestChars,
      });
      return;
    }
    if (outcome.kind === 'skipped') {
      this.#skips[outcome.reason] = (this.#skips[outcome.reason] ?? 0) + 1;
      return;
    }
    push(this.#failures, outcome.error);
  }

  /** Record one completed compaction summary. */
  recordSummary(record: SummaryRecord): void {
    push(this.#summaries, record);
  }

  /** Detached snapshot for the debug panel and the RPC layer. */
  snapshot(): {
    injections: readonly InjectionRecord[];
    summaries: readonly SummaryRecord[];
    skips: Readonly<Record<string, number>>;
    failures: readonly string[];
  } {
    return {
      injections: [...this.#injections],
      summaries: [...this.#summaries],
      skips: { ...this.#skips },
      failures: [...this.#failures],
    };
  }

  /** Drop every record. */
  reset(): void {
    this.#injections.length = 0;
    this.#summaries.length = 0;
    this.#failures.length = 0;
    for (const key of Object.keys(this.#skips)) delete this.#skips[key];
  }
}

function push<T>(list: T[], value: T): void {
  list.push(value);
  if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
}

function numberAt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringAt(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** Length of the text blocks in a content-block array. */
function textChars(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const block of value) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string') total += record['text'].length;
  }
  return total;
}

/**
 * Read one `compaction/summary` session event into a leaf-value record.
 *
 * Only scalars are copied out: the event carries live session data, which must
 * never be retained or serialized as a whole.
 */
export function readCompactionSummary(event: unknown): SummaryRecord | null {
  if (typeof event !== 'object' || event === null) return null;
  const envelope = event as Record<string, unknown>;
  if (envelope['type'] !== 'compaction/summary') return null;
  const data = envelope['data'];
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const usage = record['usage'];
  const usageRecord =
    typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : undefined;
  const seq = numberAt(envelope, 'seq') ?? -1;
  const shadowedSeqs = record['shadowedSeqs'];

  return {
    at: Date.now(),
    seq,
    provider: stringAt(record, 'provider'),
    model: stringAt(record, 'model'),
    shadowedCount: Array.isArray(shadowedSeqs) ? shadowedSeqs.length : -1,
    shadowedTokenCount: numberAt(record, 'shadowedTokenCount'),
    summaryChars: textChars(record['summary']),
    inputTokens: usageRecord === undefined ? undefined : numberAt(usageRecord, 'inputTokens'),
    outputTokens: usageRecord === undefined ? undefined : numberAt(usageRecord, 'outputTokens'),
    cacheReadTokens: usageRecord === undefined ? undefined : numberAt(usageRecord, 'cacheReadTokens'),
    cacheWriteTokens: usageRecord === undefined ? undefined : numberAt(usageRecord, 'cacheWriteTokens'),
  };
}
