/**
 * Storage keys for the annotation domain.
 *
 * M0 (Spike 3, `01开发日志.md` N008) established the real constraint for a
 * `per-record` storage domain: the key becomes a filesystem segment and must
 * match `/^[a-zA-Z0-9_-]+$/`. Real `MessageId` values are 36-character UUIDv4
 * strings whose charset is `0-9`, `a-z` and `-`, so they are directly usable —
 * no encoding needed.
 *
 * The key is `sessionId + '_' + messageId` rather than the bare message id, for
 * one behavioural reason: a forked session inherits its parent's messages **and
 * therefore the same `MessageId` values**, but must not inherit the parent's
 * annotations. Keying by the pair reproduces the first-party semantics that
 * `dsh-message-feedback` documents ("fork … starts with no feedback of its
 * own"), while a bare-id key would silently share annotations across a fork.
 *
 * The `_` separator is unambiguous because neither id may contain `_`: the
 * validator below rejects it. That is also why the separator cannot be `:`,
 * which the storage layer forbids.
 *
 * @module dsh-context-compaction-optimizer/core/keys
 */

/** Storage-layer key rule, mirrored from the per-record writer. */
export const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Separator between the two ids; never present inside either id. */
export const KEY_SEPARATOR = '_';

/** A component id (session or message) as accepted by the storage layer. */
const COMPONENT_PATTERN = /^[a-zA-Z0-9-]+$/;

function assertComponent(kind: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`storage key: ${kind} must be a non-empty string`);
  if (!COMPONENT_PATTERN.test(trimmed)) {
    throw new Error(
      `storage key: ${kind} ${JSON.stringify(trimmed)} is not path-safe (must match ${String(COMPONENT_PATTERN)})`,
    );
  }
  return trimmed;
}

/**
 * Build the storage key for one annotation.
 *
 * @throws when either id is empty or contains a character outside `[a-zA-Z0-9-]`.
 *   Throwing is deliberate: a silently mis-encoded key would address the wrong
 *   record rather than fail loudly, and the ids are machine-generated so a
 *   mismatch means a real defect.
 */
export function storageKey(sessionId: string, messageId: string): string {
  const session = assertComponent('sessionId', sessionId);
  const message = assertComponent('messageId', messageId);
  const key = `${session}${KEY_SEPARATOR}${message}`;
  /* istanbul ignore next -- the component rule makes this unreachable. */
  if (!STORAGE_KEY_PATTERN.test(key)) {
    throw new Error(`storage key: composed key ${JSON.stringify(key)} is not path-safe`);
  }
  return key;
}

/** Split a storage key back into its two ids. */
export function splitStorageKey(key: string): { readonly sessionId: string; readonly messageId: string } {
  const index = key.indexOf(KEY_SEPARATOR);
  if (index <= 0 || index === key.length - 1) {
    throw new Error(`storage key: ${JSON.stringify(key)} is not a composed annotation key`);
  }
  return { sessionId: key.slice(0, index), messageId: key.slice(index + 1) };
}

/** Whether a key belongs to one session, without fully parsing it. */
export function keyBelongsToSession(key: string, sessionId: string): boolean {
  return key.startsWith(`${sessionId}${KEY_SEPARATOR}`);
}
