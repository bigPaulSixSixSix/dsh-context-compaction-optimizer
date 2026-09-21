/**
 * Host-side annotation service.
 *
 * Two responsibilities, deliberately kept in one place so they cannot disagree:
 *
 * 1. **Durability.** Every mutation is written to the `cco_annotations` storage
 *    domain before the in-memory view changes, so a crash can lose an in-flight
 *    write but never a write that was already acknowledged.
 *
 * 2. **A synchronous read path.** The digest is injected from the `llm/stream`
 *    waterfall, which is synchronous. The service therefore keeps a cached
 *    `AnnotationState` per session and serves `snapshot()` without awaiting
 *    anything. Awaiting storage inside that waterfall would either stall the
 *    model call or force the caller to inject stale data.
 *
 * Annotations are written when the operator toggles them and read only when a
 * compaction actually fires. Between those moments the plugin costs nothing:
 * no model call, no surface rewrite, and therefore no KV-cache invalidation
 * (`01开发日志.md` N003, N006, N012).
 *
 * @module dsh-context-compaction-optimizer/host/annotations/service
 */

import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';

import {
  EMPTY_STATE,
  bulkSet,
  isExcluded,
  removeAnnotation,
  setAnnotation,
  stats,
  toRecords,
  type AnnotationState,
} from '../../core/annotations.ts';
import { keyBelongsToSession, splitStorageKey, storageKey } from '../../core/keys.ts';
import type {
  AnnotationRecord,
  AnnotationSource,
  AnnotationStats,
  AnnotationStatus,
  UnmarkedPolicy,
} from '../../shared/types.ts';
import { annotationDomainSpec, type StoredAnnotationRecord } from './domain.ts';

/** Minimal structural view of the two storage calls this service uses. */
interface AnnotationTable {
  entries(): IterableIterator<[string, StoredAnnotationRecord]>;
  get(key: string): StoredAnnotationRecord | undefined;
  put(key: string, value: StoredAnnotationRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Minimal structural view of an opened domain. */
interface OpenedDomain {
  table(name: string): AnnotationTable;
  close(): Promise<void>;
}

/** Minimal structural view of the storage-domain facility. */
interface StorageDomainFacility {
  open(spec: typeof annotationDomainSpec): Promise<OpenedDomain>;
}

/** Outcome of a mutating call, for logging and the RPC layer. */
export interface MutationResult {
  readonly applied: number;
  readonly records: readonly AnnotationRecord[];
}

/**
 * Per-session annotation store with a durable backing domain.
 *
 * The in-memory map is a *cache of the domain*, never an independent store:
 * every mutation path writes through, and `hydrate()` can rebuild the whole map
 * from the domain at any time. That is what makes a restart cheap and what keeps
 * the two representations from diverging.
 */
export class AnnotationService extends Service {
  static inject = ['storageDomain'];

  /** Cached state per session id. */
  readonly #bySession = new Map<string, AnnotationState>();
  /** Last known unmarked policy, refreshed by the settings owner. */
  #unmarkedPolicy: UnmarkedPolicy = 'valid';
  #domain: OpenedDomain | undefined;
  #opening: Promise<OpenedDomain> | undefined;

  constructor(ctx: Context) {
    super(ctx, 'ccoAnnotations');
  }

  /** Open the domain if needed, then load every stored record into the cache. */
  async hydrate(): Promise<void> {
    const domain = await this.#open();
    const table = domain.table('annotations');
    this.#bySession.clear();
    for (const [key, value] of table.entries()) {
      let parsed;
      try {
        parsed = splitStorageKey(key);
      } catch {
        // A key we cannot parse predates or postdates this build's key rule.
        // Skip it rather than guessing: the record stays on disk untouched.
        this.ctx.logger?.warn?.(`annotations: skipping unparseable key ${key}`);
        continue;
      }
      const current = this.#bySession.get(parsed.sessionId) ?? EMPTY_STATE;
      this.#bySession.set(
        parsed.sessionId,
        setAnnotation(current, parsed.messageId, value.status, {
          now: value.updatedAt,
          source: value.source,
        }),
      );
    }
  }

  /** Update the cached unmarked policy. Called by the settings owner. */
  setUnmarkedPolicy(policy: UnmarkedPolicy): void {
    this.#unmarkedPolicy = policy;
  }

  /** Effective unmarked policy. */
  get unmarkedPolicy(): UnmarkedPolicy {
    return this.#unmarkedPolicy;
  }

  /**
   * Synchronous view for the hot path.
   *
   * Never throws and never touches storage: an unknown session simply has no
   * annotations, which yields an empty digest and therefore an untouched
   * request.
   */
  snapshot(sessionId: string): AnnotationState {
    return this.#bySession.get(sessionId) ?? EMPTY_STATE;
  }

  /** Whether one message is excluded under the current policy. */
  excludes(sessionId: string, messageId: string): boolean {
    return isExcluded(this.snapshot(sessionId), messageId, this.#unmarkedPolicy);
  }

  /** Stored annotations for a session, ordered by message id. */
  list(sessionId: string): readonly AnnotationRecord[] {
    return toRecords(this.snapshot(sessionId));
  }

  /** Counts for a session over a known message set. */
  stats(sessionId: string, messageIds: Iterable<string>): AnnotationStats {
    return stats(this.snapshot(sessionId), messageIds, this.#unmarkedPolicy);
  }

  /** Set or clear one annotation. `unmarked` clears. */
  async set(
    sessionId: string,
    messageId: string,
    status: AnnotationStatus,
    source: AnnotationSource = 'user',
    now: number = Date.now(),
  ): Promise<MutationResult> {
    if (status === 'unmarked') {
      await this.remove(sessionId, messageId);
      return { applied: 1, records: this.list(sessionId) };
    }
    const domain = await this.#open();
    const key = storageKey(sessionId, messageId);
    // Persist first: an acknowledged mutation is always durable.
    await domain.table('annotations').put(key, {
      sessionId,
      status,
      updatedAt: now,
      source,
    });
    this.#bySession.set(
      sessionId,
      setAnnotation(this.snapshot(sessionId), messageId, status, { now, source }),
    );
    return { applied: 1, records: this.list(sessionId) };
  }

  /** Apply many annotations, writing each one through. */
  async bulkSet(
    sessionId: string,
    items: readonly { readonly messageId: string; readonly status: AnnotationStatus }[],
    source: AnnotationSource = 'user',
    now: number = Date.now(),
  ): Promise<MutationResult> {
    const domain = await this.#open();
    const table = domain.table('annotations');
    let next = this.snapshot(sessionId);
    for (const item of items) {
      if (item.status === 'unmarked') {
        await table.delete(storageKey(sessionId, item.messageId));
        next = removeAnnotation(next, item.messageId);
        continue;
      }
      await table.put(storageKey(sessionId, item.messageId), {
        sessionId,
        status: item.status,
        updatedAt: now,
        source,
      });
      next = setAnnotation(next, item.messageId, item.status, { now, source });
    }
    this.#bySession.set(sessionId, next);
    return { applied: items.length, records: this.list(sessionId) };
  }

  /** Remove one annotation. Returns whether anything was stored. */
  async remove(sessionId: string, messageId: string): Promise<boolean> {
    const domain = await this.#open();
    const removed = await domain.table('annotations').delete(storageKey(sessionId, messageId));
    this.#bySession.set(sessionId, removeAnnotation(this.snapshot(sessionId), messageId));
    return removed;
  }

  /** Drop every annotation for one session. */
  async clear(sessionId: string): Promise<number> {
    const domain = await this.#open();
    const table = domain.table('annotations');
    const doomed: string[] = [];
    for (const [key] of table.entries()) {
      if (keyBelongsToSession(key, sessionId)) doomed.push(key);
    }
    for (const key of doomed) await table.delete(key);
    this.#bySession.delete(sessionId);
    return doomed.length;
  }

  /** Merge an exported envelope into one session. */
  async importRecords(
    sessionId: string,
    records: readonly AnnotationRecord[],
    now: number = Date.now(),
  ): Promise<MutationResult> {
    return this.bulkSet(
      sessionId,
      records.map((record) => ({ messageId: record.messageId, status: record.status })),
      'import',
      now,
    );
  }

  /** Release the domain. Called from the plugin's dispose path. */
  async dispose(): Promise<void> {
    const domain = this.#domain;
    this.#domain = undefined;
    this.#opening = undefined;
    this.#bySession.clear();
    if (domain !== undefined) await domain.close();
  }

  async #open(): Promise<OpenedDomain> {
    if (this.#domain !== undefined) return this.#domain;
    this.#opening ??= (async () => {
      const facility = this.ctx.get('storageDomain') as StorageDomainFacility | undefined;
      if (facility === undefined) {
        throw new Error('ccoAnnotations: the storageDomain service is not mounted');
      }
      const domain = await facility.open(annotationDomainSpec);
      this.#domain = domain;
      return domain;
    })();
    return this.#opening;
  }
}
