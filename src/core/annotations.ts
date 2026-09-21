/**
 * Annotation store: pure, immutable state transitions over per-message records.
 *
 * No I/O and no DSH imports. Durability is the adapter's job; this module only
 * decides what the state *means*, which is what makes it testable and what keeps
 * the persistence choice swappable.
 *
 * @module dsh-context-compaction-optimizer/core/annotations
 */

import type {
  AnnotationRecord,
  AnnotationSource,
  AnnotationStats,
  AnnotationStatus,
  StoredStatus,
  UnmarkedPolicy,
} from '../shared/types.ts';

/** Immutable annotation state for one session. */
export interface AnnotationState {
  readonly byMessageId: ReadonlyMap<string, AnnotationRecord>;
}

/** The empty state. Reused so callers can compare by identity. */
export const EMPTY_STATE: AnnotationState = Object.freeze({
  byMessageId: new Map<string, AnnotationRecord>(),
});

/** Options accepted by the mutators. */
export interface MutationOptions {
  readonly source?: AnnotationSource;
  readonly now?: number;
}

function clone(state: AnnotationState): Map<string, AnnotationRecord> {
  return new Map(state.byMessageId);
}

function normalize(messageId: string): string {
  const trimmed = messageId.trim();
  if (trimmed.length === 0) throw new Error('annotation: messageId must be a non-empty string');
  return trimmed;
}

/**
 * Set one annotation.
 *
 * Setting `unmarked` is defined as removal, so the stored union never contains
 * a third state. A repeated set of the same status still refreshes
 * `updatedAt` — the caller asked for a write, and idempotent no-ops are the
 * adapter's concern, not the state's.
 */
export function setAnnotation(
  state: AnnotationState,
  messageId: string,
  status: AnnotationStatus,
  options: MutationOptions = {},
): AnnotationState {
  const id = normalize(messageId);
  if (status === 'unmarked') return removeAnnotation(state, id);
  const next = clone(state);
  next.set(id, {
    messageId: id,
    status,
    updatedAt: options.now ?? Date.now(),
    source: options.source ?? 'user',
  });
  return { byMessageId: next };
}

/** Apply many annotations in one transition. Later items win on conflict. */
export function bulkSet(
  state: AnnotationState,
  items: readonly { readonly messageId: string; readonly status: AnnotationStatus }[],
  options: MutationOptions = {},
): AnnotationState {
  let next = state;
  for (const item of items) {
    next = setAnnotation(next, item.messageId, item.status, options);
  }
  return next;
}

/** Remove one annotation, returning the same state when nothing was stored. */
export function removeAnnotation(state: AnnotationState, messageId: string): AnnotationState {
  const id = normalize(messageId);
  if (!state.byMessageId.has(id)) return state;
  const next = clone(state);
  next.delete(id);
  return { byMessageId: next };
}

/** Drop every annotation. Returns `EMPTY_STATE` by identity. */
export function clear(): AnnotationState {
  return EMPTY_STATE;
}

/** Remove every annotation whose id is absent from `liveMessageIds`. */
export function pruneToLive(state: AnnotationState, liveMessageIds: Iterable<string>): AnnotationState {
  const live = new Set(liveMessageIds);
  let changed = false;
  const next = clone(state);
  for (const id of state.byMessageId.keys()) {
    if (!live.has(id)) {
      next.delete(id);
      changed = true;
    }
  }
  return changed ? { byMessageId: next } : state;
}

/** Resolve the effective status of a message, applying the unmarked policy. */
export function resolveStatus(
  state: AnnotationState,
  messageId: string,
  policy: UnmarkedPolicy,
): AnnotationStatus {
  const record = state.byMessageId.get(messageId);
  if (record === undefined) return policy === 'invalid' ? 'invalid' : 'unmarked';
  return record.status;
}

/** Whether a message should be excluded from the checkpoint. */
export function isExcluded(
  state: AnnotationState,
  messageId: string,
  policy: UnmarkedPolicy,
): boolean {
  const stored: StoredStatus | undefined = state.byMessageId.get(messageId)?.status;
  if (stored !== undefined) return stored === 'invalid';
  return policy === 'invalid';
}

/** Counts over a known set of message ids. */
export function stats(
  state: AnnotationState,
  messageIds: Iterable<string>,
  policy: UnmarkedPolicy,
): AnnotationStats {
  let total = 0;
  let valid = 0;
  let invalid = 0;
  let unmarked = 0;
  for (const id of messageIds) {
    total += 1;
    const status = resolveStatus(state, id, policy);
    if (status === 'invalid') invalid += 1;
    else if (status === 'valid') valid += 1;
    else unmarked += 1;
  }
  return { total, valid, invalid, unmarked };
}

/** Detached, stably ordered records — the export/import payload shape. */
export function toRecords(state: AnnotationState): readonly AnnotationRecord[] {
  return [...state.byMessageId.values()].sort((a, b) =>
    a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0,
  );
}

/** Durable export envelope. */
export interface ExportEnvelope {
  readonly version: 1;
  readonly sessionId: string;
  readonly records: readonly AnnotationRecord[];
}

/** Serialize annotations for export. */
export function exportState(state: AnnotationState, sessionId: string): string {
  const envelope: ExportEnvelope = { version: 1, sessionId, records: toRecords(state) };
  return JSON.stringify(envelope, null, 2);
}

/** Outcome of an import. */
export interface ImportResult {
  readonly state: AnnotationState;
  readonly applied: number;
  readonly skipped: number;
}

function isStoredStatus(value: unknown): value is StoredStatus {
  return value === 'valid' || value === 'invalid';
}

function isSource(value: unknown): value is AnnotationSource {
  return value === 'user' || value === 'system' || value === 'import';
}

/**
 * Validate an untrusted record array into detached records.
 *
 * Shared by import and by the RPC layer's import path so the two cannot
 * disagree about what counts as a usable record. Skipping is preferred to
 * throwing: a payload carrying a few records from a newer schema should still
 * deliver the records it *can* express, and the skip count is reported so the
 * caller can surface it.
 */
export function sanitizeRecords(
  raw: unknown,
  now: number = Date.now(),
): { records: AnnotationRecord[]; skipped: number } {
  const records: AnnotationRecord[] = [];
  let skipped = 0;
  if (!Array.isArray(raw)) return { records, skipped: 0 };
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      skipped += 1;
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const messageId = candidate['messageId'];
    const status = candidate['status'];
    if (typeof messageId !== 'string' || messageId.trim().length === 0 || !isStoredStatus(status)) {
      skipped += 1;
      continue;
    }
    const updatedAt = candidate['updatedAt'];
    const source = candidate['source'];
    records.push({
      messageId: messageId.trim(),
      status,
      updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : now,
      source: isSource(source) ? source : 'import',
    });
  }
  return { records, skipped };
}

/**
 * Merge an exported envelope into the current state.
 */
export function importState(state: AnnotationState, json: string, now = Date.now()): ImportResult {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('annotation import: payload must be a JSON object');
  }
  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) {
    throw new Error('annotation import: payload.records must be an array');
  }
  const sanitized = sanitizeRecords(records, now);
  let next = state;
  for (const record of sanitized.records) {
    next = setAnnotation(next, record.messageId, record.status, {
      source: record.source,
      now: record.updatedAt,
    });
  }
  return { state: next, applied: sanitized.records.length, skipped: sanitized.skipped };
}
