/**
 * Frozen shared contracts for the Context Compaction Optimizer.
 *
 * Everything here is plain data: no DSH/Cordis imports, no live objects, so the
 * core layer stays testable and replayable outside a running harness. The
 * adapter layer (`src/host/**`) is what touches the runtime.
 *
 * @module dsh-context-compaction-optimizer/shared/types
 */

/**
 * Operator annotation of one message.
 *
 * `unmarked` is a *view* status, never a stored one: clearing an annotation
 * removes the record. Keeping the stored union at two members means
 * "no record" and "explicitly valid" can never be confused.
 */
export type AnnotationStatus = 'valid' | 'invalid' | 'unmarked';

/** Stored status: the two states an operator can actually assert. */
export type StoredStatus = Exclude<AnnotationStatus, 'unmarked'>;

/** How an unmarked message is treated when a digest is built. */
export type UnmarkedPolicy = 'valid' | 'invalid';

/** Who authored the annotation. */
export type AnnotationSource = 'user' | 'system' | 'import';

/**
 * How excluded messages are identified to the summarizer.
 *
 * `spans` (default) collapses consecutive excluded messages into one range
 * carrying a verbatim fingerprint at each end.
 *
 * `anchors` lists one verbatim fingerprint per excluded message — the format
 * validated in N009/N011/N012/N013, and the fix for the position-only digest
 * that failed in N006 v1. Kept as a working fallback, not as dead code: the
 * setting still selects it and the renderer still implements it.
 *
 * **Why spans won.** An anchor IS the excluded message's own opening, so a
 * per-message digest restates the very content it is asking the model to
 * ignore — roughly 170 characters per message, which the turn unit (N035) made
 * routine: one measured turn produced 170 entries and a 24,108-character digest,
 * against ~400 characters for the same span. Repetition of excluded text drifts
 * attention, and two independent runs show it leaking rather than excluding:
 * the short anchors run in N032 recorded marked content back verbatim, and the
 * N039 anchors run summarized an entire excluded turn as if it were ordinary
 * content (book title, translator, four URLs) while the spans run of the same
 * fixture leaked only one URL domain. Both runs quote nothing verbatim, so the
 * failure is attention, not copying — which is exactly what shrinking the
 * restated text addresses.
 *
 * The cost spans accepts: a range's middle is specified by its bounds alone.
 * N038 measured 13 excluded messages collapsing to one span with no sign of
 * partial exclusion, but that is a single sample.
 */
export type DigestFormat = 'anchors' | 'spans';

/** One durable annotation. */
export interface AnnotationRecord {
  readonly messageId: string;
  readonly status: StoredStatus;
  readonly updatedAt: number;
  readonly source: AnnotationSource;
}

/** Operator-visible plugin settings. */
export interface PluginSettings {
  /**
   * Treatment of messages with no annotation.
   *
   * Defaults to `valid` deliberately: the safe posture is "never drop what the
   * operator did not explicitly mark", so an unconfigured install cannot lose
   * content it was never told to lose.
   */
  readonly unmarkedPolicy: UnmarkedPolicy;
  /** Master switch for digest injection. */
  readonly injectDigest: boolean;
  /** How the digest identifies excluded messages. */
  readonly digestFormat: DigestFormat;  /** Record cache accounting for every compaction summarization call. */
  readonly observeCache: boolean;
}

/** Default settings; also the shape the profile patch seeds. */
export const DEFAULT_SETTINGS: PluginSettings = Object.freeze({
  unmarkedPolicy: 'valid',
  injectDigest: true,
  digestFormat: 'spans',
  observeCache: false,
});

/**
 * One fingerprint in the annotation digest.
 *
 * The anchor is the excluded message's *verbatim opening* and is never wrapped
 * in quotes by the renderer — M0/N013 showed a quoted anchor reads to the
 * summarizer as quotable content, whereas an unquoted fingerprint line reads as
 * identification metadata.
 */
export interface DigestEntry {
  /** Zero-based index of the message within the summarization call's list. */
  readonly position: number;
  /** Message role, used only to help the summarizer locate the message. */
  readonly role: string;
  /** Verbatim opening of the excluded message. */
  readonly anchor: string;
}

/** Counts shown in the manual-compaction preview and the debug panel. */
export interface AnnotationStats {
  readonly total: number;
  readonly valid: number;
  readonly invalid: number;
  readonly unmarked: number;
}

/**
 * The projection of one LLM message the digest builder needs.
 *
 * Deliberately a leaf-value view: the adapter extracts these scalars from live
 * DSH messages rather than passing the live objects into the core layer.
 */
export interface MessageLike {
  /** Durable message id, when the message carries one. */
  readonly id?: string;
  readonly role: string;
  /** Concatenated text blocks; non-text blocks are ignored. */
  readonly text: string;
}

/** Result of planning one digest injection against a message list. */
export interface InjectionPlan {
  readonly entries: readonly DigestEntry[];
  readonly digest: string;
  /**
   * Index the digest must occupy in the resulting list. Equal to
   * `messages.length - 1`, i.e. immediately before the compaction instruction.
   */
  readonly insertIndex: number;
}

/**
 * One surface message as the host projects it for the UI.
 *
 * Lives in `shared` because both halves need the same shape: the host produces
 * it from a live session, and the client renders it and annotates by
 * `messageId`. Keeping one declaration is what stops the wire shape and the
 * render shape from drifting apart.
 */
export interface SurfaceMessage {
  readonly seq: number;
  /** Session event type, e.g. `user/message`. */
  readonly eventType: string;
  readonly role: string;
  /** Durable id, or `null` for events that carry no message identity. */
  readonly messageId: string | null;
  /** Text preview, truncated by the host. */
  readonly head: string;
}

/**
 * One exchange: the operator's prompt and everything the agent did about it.
 *
 * **This is the unit of annotation.** A turn routinely spans dozens of surface
 * messages — one real session measured 741 messages against 18 prompts, with the
 * final turn alone holding 12 — so marking per message asks the operator to
 * click a dozen times to express one judgement ("this exchange is junk"). The
 * agent's intermediate steps are also precisely the noise worth excluding: 355
 * of those 741 were tool results.
 *
 * Boundaries come from the session's own `turn/start` / `turn/end` events rather
 * than from "a `user/message` starts a turn": injected user messages (runtime
 * context, system reminders) sit *inside* a turn, and one session logged 56 user
 * messages against 45 turns.
 *
 * Annotations remain per message, because that is what the digest addresses.
 * A turn is the operator's handle onto a set of them.
 */
export interface SurfaceTurn {
  /**
   * Stable key: the turn's opening seq, or `loose:<seq>` for a surface message
   * that no turn encloses (a compaction checkpoint is appended outside one).
   */
  readonly id: string;
  /** Seq of the turn's first surface message. */
  readonly startSeq: number;
  /** Seq of the enclosing `turn/end`, or `null` while the turn is still open. */
  readonly endSeq: number | null;
  /** Surface messages in order. Empty turns are never emitted. */
  readonly messages: readonly SurfaceMessage[];
}
