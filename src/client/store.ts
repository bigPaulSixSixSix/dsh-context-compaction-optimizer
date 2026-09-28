/**
 * Client-side annotation state.
 *
 * One controller per browser session, holding a `MessageId`-keyed view and
 * notifying React through a `useSyncExternalStore`-compatible subscription.
 *
 * **The turn is the unit.** Annotations themselves remain per message, because
 * that is what the digest addresses, but everything the operator sees and does
 * is grouped by turn: one exchange routinely spans dozens of surface messages
 * (one measured session had 741 messages against 18 prompts, with a single turn
 * holding 12), so a per-message list asks for a dozen clicks to express one
 * judgement — "this exchange is junk". The agent's intermediate steps are also
 * exactly the noise worth excluding.
 *
 * Three further behaviours are deliberate:
 *
 * 1. **Writes are optimistic.** A click updates the view immediately and the
 *    RPC reconciles afterwards. A toggle that waited on a round trip would feel
 *    broken, and the host is the authority anyway — a rejected write re-reads
 *    the server state rather than guessing what to roll back to.
 * 2. **Snapshots are cached per session.** `useSyncExternalStore` compares
 *    snapshot identity, so returning a fresh object on every read would loop
 *    forever. A view object is replaced only when its contents change.
 * 3. **The surface list is re-readable.** Every count is derived from `turns`,
 *    so the list has to track the live surface rather than being read once: a
 *    turn that arrives afterwards would otherwise be invisible to the counter
 *    and missing from the panel.
 * 4. **The surface read waits for the host to load the session** (N048). The
 *    host projects only sessions that are live in its process, so a read issued
 *    before the session is loaded fails with `not-found` — a *timing* fact, not
 *    a verdict. Every annotation control is dead until a read succeeds, so an
 *    early read that is never retried leaves them dead permanently, which is
 *    exactly what happened. {@link AnnotationView.phase} is the single home of
 *    that state, and the schedule below retries a transient failure until the
 *    session appears.
 *
 * @module dsh-context-compaction-optimizer/client/store
 */

import type {
  AnnotationRecord,
  AnnotationStats,
  AnnotationStatus,
  StoredStatus,
  SurfaceMessage,
  SurfaceTurn,
  UnmarkedPolicy,
} from '../shared/types.ts';
import type { RpcClient } from './rpc.ts';

/**
 * Where the surface read stands.
 *
 * One field rather than several booleans, because "we have no turns" has three
 * different meanings an operator must be able to tell apart: the host has not
 * loaded the session yet, the read failed, or the session genuinely has none.
 */
export type SurfacePhase =
  /** No read has been attempted yet. */
  | 'idle'
  /** A read is in flight, or a transient failure is waiting to be retried. */
  | 'loading'
  /** The turns are here. Every control is live. */
  | 'ready'
  /** The host has no live session for this id; retries are exhausted. */
  | 'session-not-loaded'
  /** The read failed for any other reason; retries are exhausted. */
  | 'failed';

/** Immutable view of one session's annotation state. */
export interface AnnotationView {
  readonly sessionId: string;
  readonly byMessageId: ReadonlyMap<string, StoredStatus>;
  /** Counts of *turns*, the unit the header reports. */
  readonly stats: AnnotationStats;
  readonly turns: readonly SurfaceTurn[];
  /** The same messages flattened, for membership checks and comparisons. */
  readonly messages: readonly SurfaceMessage[];
  readonly phase: SurfacePhase;
  /** The host's own message for the last terminal failure, else `null`. */
  readonly error: string | null;
}

type Listener = () => void;

function emptyView(sessionId: string): AnnotationView {
  return {
    sessionId,
    byMessageId: new Map(),
    stats: { total: 0, valid: 0, invalid: 0, unmarked: 0 },
    turns: [],
    messages: [],
    phase: 'idle',
    error: null,
  };
}

function flatten(turns: readonly SurfaceTurn[]): readonly SurfaceMessage[] {
  const out: SurfaceMessage[] = [];
  for (const turn of turns) for (const message of turn.messages) out.push(message);
  return out;
}

/**
 * Effective status of one turn.
 *
 * `invalid` on *any* excluded message rather than *all*: the operator's question
 * is "does this exchange contribute content that will be dropped", and one
 * excluded step already answers yes. Marking is all-or-nothing through the UI,
 * so a mixed turn can only come from records written before turns existed — and
 * showing it as unmarked would understate what a compaction will actually drop.
 */
export function turnStatus(
  turn: SurfaceTurn,
  byMessageId: ReadonlyMap<string, StoredStatus>,
  policy: UnmarkedPolicy,
): AnnotationStatus {
  let anyInvalid = false;
  let anyValid = false;
  let annotatable = false;
  for (const message of turn.messages) {
    if (message.messageId === null) continue;
    annotatable = true;
    const stored = byMessageId.get(message.messageId);
    if (stored === 'invalid') anyInvalid = true;
    else if (stored === 'valid') anyValid = true;
  }
  // A turn whose messages all lack a durable id can never be annotated, and the
  // host's exclusion predicate requires an id — so it stays unmarked rather than
  // being swept up by an aggressive policy and over-reporting what will drop.
  if (!annotatable) return 'unmarked';
  if (anyInvalid) return 'invalid';
  if (anyValid) return 'valid';
  return policy === 'invalid' ? 'invalid' : 'unmarked';
}

function computeStats(
  turns: readonly SurfaceTurn[],
  byMessageId: ReadonlyMap<string, StoredStatus>,
  policy: UnmarkedPolicy,
): AnnotationStats {
  let valid = 0;
  let invalid = 0;
  let unmarked = 0;
  for (const turn of turns) {
    const status = turnStatus(turn, byMessageId, policy);
    if (status === 'invalid') invalid += 1;
    else if (status === 'valid') valid += 1;
    else unmarked += 1;
  }
  return { total: turns.length, valid, invalid, unmarked };
}

/** Whether two turn projections would render identically. */
function sameTurns(a: readonly SurfaceTurn[], b: readonly SurfaceTurn[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] as SurfaceTurn;
    const right = b[index] as SurfaceTurn;
    if (left.id !== right.id || left.messages.length !== right.messages.length) return false;
    for (let inner = 0; inner < left.messages.length; inner += 1) {
      const one = left.messages[inner] as SurfaceMessage;
      const two = right.messages[inner] as SurfaceMessage;
      if (
        one.seq !== two.seq ||
        one.eventType !== two.eventType ||
        one.role !== two.role ||
        one.messageId !== two.messageId ||
        one.head !== two.head
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Timer used to schedule a retry, returning its own cancel.
 *
 * Injected so the retry schedule is testable without real clocks: a test passes
 * a scheduler that captures the callback and runs it when it chooses.
 */
export type RetryScheduler = (run: () => void, delayMs: number) => () => void;

/** Controller options. Both default; tests inject both. */
export interface AnnotationControllerOptions {
  readonly schedule?: RetryScheduler;
  readonly retryDelaysMs?: readonly number[];
}

const defaultSchedule: RetryScheduler = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return () => clearTimeout(handle);
};

/**
 * Delays between surface-read attempts, in order.
 *
 * The wait is for the host to load the session, which normally happens within a
 * moment of the page asking for it, so the schedule is front-loaded and totals
 * about 20 seconds. It is deliberately finite: an operator who is still looking
 * at a session the host never loaded needs a stated reason, not a spinner that
 * never resolves. Nine entries means nine retries after the first attempt.
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000, 4000, 4000, 4000];

/**
 * Failure codes worth retrying.
 *
 * `not-found` is the documented "the host has no live session for this id" and
 * resolves itself as soon as the session is loaded. `transport` is a fetch that
 * never reached the host, which a restart explains. Everything else — a
 * malformed response, a rejected request, an internal error — is a real fault
 * that another identical attempt will not fix, so it fails immediately and says
 * so instead of looking like a slow load.
 */
const TRANSIENT_CODES = new Set(['not-found', 'transport']);

/** The failure code carried by an error, if it names one. */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'transport';
}

/** Per-session annotation state with optimistic writes. */
export class AnnotationController {
  readonly #rpc: RpcClient;
  readonly #views = new Map<string, AnnotationView>();
  readonly #listeners = new Set<Listener>();
  #policy: UnmarkedPolicy = 'valid';
  readonly #schedule: RetryScheduler;
  readonly #retryDelays: readonly number[];
  /** Attempts already spent per session, indexed into `#retryDelays`. */
  readonly #attempts = new Map<string, number>();
  /** Cancel handle for a scheduled retry, per session. */
  readonly #retries = new Map<string, () => void>();
  /** The in-flight read per session, so concurrent callers share one. */
  readonly #inflight = new Map<string, Promise<void>>();
  /** Message ids a control has already asked a surface re-read for, per session. */
  readonly #askedFor = new Map<string, Set<string>>();

  constructor(rpc: RpcClient, options: AnnotationControllerOptions = {}) {
    this.#rpc = rpc;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /**
   * Cancel every pending retry.
   *
   * Retries outlive the call that scheduled them, so a controller that is torn
   * down must not keep waking up to talk to a host that no longer has a client.
   */
  dispose(): void {
    this.#cancelRetry();
    this.#inflight.clear();
    this.#askedFor.clear();
  }

  /** Mirror the host's unmarked policy so local counts match the server's. */
  setPolicy(policy: UnmarkedPolicy): void {
    if (this.#policy === policy) return;
    this.#policy = policy;
    for (const [sessionId, view] of this.#views) {
      this.#commit(sessionId, {
        ...view,
        stats: computeStats(view.turns, view.byMessageId, policy),
      });
    }
  }

  /** Subscribe to any view change. */
  subscribe = (listener: Listener): () => void => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Cached snapshot for one session.
   *
   * Returns the same object until the session's state actually changes, which is
   * what makes this safe to hand to `useSyncExternalStore`.
   */
  view = (sessionId: string): AnnotationView => {
    let view = this.#views.get(sessionId);
    if (view === undefined) {
      view = emptyView(sessionId);
      this.#views.set(sessionId, view);
    }
    return view;
  };

  /** Effective status of one turn, applying the unmarked policy. */
  statusOfTurn(sessionId: string, turn: SurfaceTurn): AnnotationStatus {
    return turnStatus(turn, this.view(sessionId).byMessageId, this.#policy);
  }

  /**
   * The turn containing one message, or `undefined`.
   *
   * The inline per-message control is registered by `messageId` alone, so it
   * needs this to act on the same unit the panel does.
   */
  turnFor(sessionId: string, messageId: string | null): SurfaceTurn | undefined {
    if (messageId === null) return undefined;
    for (const turn of this.view(sessionId).turns) {
      for (const message of turn.messages) if (message.messageId === messageId) return turn;
    }
    return undefined;
  }

  /**
   * Whether the cached surface already lists one message.
   *
   * A caller that sees `false` for a message it knows exists is looking at a
   * list that predates that message, and should {@link refreshSurface}.
   */
  knows(sessionId: string, messageId: string | null): boolean {
    if (messageId === null) return false;
    return this.view(sessionId).messages.some((message) => message.messageId === messageId);
  }

  /**
   * Whether a control should ask for a surface re-read because of one message.
   *
   * True once per id. Past that first ask, the id is one the surface genuinely
   * does not hold — a message a compaction folded into a checkpoint, which can
   * never come back — so asking again would put one request behind every row of
   * a compacted conversation and still never succeed (N049).
   */
  needsRefreshFor(sessionId: string, messageId: string | null): boolean {
    if (messageId === null) return false;
    let asked = this.#askedFor.get(sessionId);
    if (asked === undefined) {
      asked = new Set<string>();
      this.#askedFor.set(sessionId, asked);
    }
    if (asked.has(messageId)) return false;
    asked.add(messageId);
    return true;
  }

  /**
   * Whether the surface has been checked for this message and does not hold it.
   *
   * This is the operator-facing half of {@link needsRefreshFor}: it distinguishes
   * "not looked yet" from "looked, and it is gone", which is the difference
   * between a control that is briefly busy and one that will never work.
   */
  isOffSurface(sessionId: string, messageId: string | null): boolean {
    if (messageId === null) return false;
    const asked = this.#askedFor.get(sessionId);
    return asked !== undefined && asked.has(messageId) && !this.knows(sessionId, messageId);
  }

  /**
   * Re-read the surface, leaving annotations untouched.
   *
   * `turns` is the source of every count and every panel row, so a turn that
   * arrives after the last read is invisible to both — which is how a reply
   * could be marked and still not be counted. Callers run this on a genuine
   * change signal (a message row mounting, the panel opening) rather than on a
   * timer.
   */
  async refreshSurface(sessionId: string): Promise<void> {
    let turns: readonly SurfaceTurn[];
    try {
      const surface = await this.#rpc.call<{ turns: readonly SurfaceTurn[] }>('session.surface', { sessionId });
      turns = surface.turns;
    } catch {
      // A refresh is an improvement, not a requirement: the last good list and
      // the current annotations both stay usable, and `load` owns error
      // reporting. Failing here must not blank the panel.
      return;
    }
    // Read the view *after* the await, so annotations from a reload that landed
    // meanwhile are carried forward instead of being overwritten by a snapshot
    // taken before it.
    const view = this.view(sessionId);
    if (sameTurns(view.turns, turns)) return;
    this.#commit(sessionId, {
      ...view,
      turns,
      messages: flatten(turns),
      stats: computeStats(turns, view.byMessageId, this.#policy),
      // A refresh that succeeded is proof the host can serve this session, so it
      // also clears a terminal `session-not-loaded`/`failed` phase. Without this
      // a session whose first read lost the race would stay disabled forever
      // even though its surface arrived here.
      phase: 'ready',
      error: null,
    });
  }

  /**
   * Read annotations and the surface for one session, retrying a transient
   * failure until the host has the session loaded.
   *
   * Resolves after the *first* attempt; a scheduled retry continues in the
   * background and reports through {@link view}. That keeps `await load()` a
   * single round trip for callers while still converging on its own — which is
   * what the annotation controls need, since they have no way to observe the
   * host loading a session.
   */
  load(sessionId: string): Promise<void> {
    return this.#attempt(sessionId, true);
  }

  /**
   * One attempt, preceded by cancelling whatever was pending.
   *
   * `reset` distinguishes an explicit request (a mount, the reload button, a
   * panel open) from the automatic retry that follows a transient failure: only
   * the former restarts the schedule, so a retry cannot extend itself forever.
   */
  #attempt(sessionId: string, reset: boolean): Promise<void> {
    const inflight = this.#inflight.get(sessionId);
    if (inflight !== undefined) return inflight;
    if (reset) this.#attempts.delete(sessionId);
    this.#cancelRetry(sessionId);

    const view = this.view(sessionId);
    if (view.phase !== 'loading') {
      this.#commit(sessionId, { ...view, phase: 'loading', error: null });
    }

    const run = this.#runOnce(sessionId).finally(() => {
      this.#inflight.delete(sessionId);
    });
    this.#inflight.set(sessionId, run);
    return run;
  }

  /** Cancel a scheduled retry for one session, or for every session. */
  #cancelRetry(sessionId?: string): void {
    if (sessionId === undefined) {
      for (const cancel of this.#retries.values()) cancel();
      this.#retries.clear();
      return;
    }
    const cancel = this.#retries.get(sessionId);
    if (cancel !== undefined) {
      cancel();
      this.#retries.delete(sessionId);
    }
  }

  /** Perform one read and decide what the failure, if any, means. */
  async #runOnce(sessionId: string): Promise<void> {
    try {
      const [annotation, surface] = await Promise.all([
        this.#rpc.call<{ records: readonly AnnotationRecord[] }>('annotations.list', { sessionId }),
        this.#rpc.call<{ turns: readonly SurfaceTurn[] }>('session.surface', { sessionId }),
      ]);
      const byMessageId = new Map<string, StoredStatus>();
      for (const record of annotation.records) byMessageId.set(record.messageId, record.status);
      // A turn is all-or-nothing (N035); records from the old per-message UI can
      // land in between. See #clearMixedTurns for why they are dropped rather
      // than completed.
      await this.#clearMixedTurns(sessionId, surface.turns, byMessageId);
      this.#attempts.delete(sessionId);
      this.#commit(sessionId, {
        sessionId,
        byMessageId,
        turns: surface.turns,
        messages: flatten(surface.turns),
        stats: computeStats(surface.turns, byMessageId, this.#policy),
        phase: 'ready',
        error: null,
      });
    } catch (error) {
      const code = codeOf(error);
      const message = error instanceof Error ? error.message : String(error);
      const spent = this.#attempts.get(sessionId) ?? 0;
      const delay = TRANSIENT_CODES.has(code) ? this.#retryDelays[spent] : undefined;

      if (delay !== undefined) {
        this.#attempts.set(sessionId, spent + 1);
        // Stay in `loading`: the operator sees a load in progress, which is what
        // this is, rather than a failure that then heals by itself.
        this.#commit(sessionId, { ...this.view(sessionId), phase: 'loading', error: null });
        this.#retries.set(
          sessionId,
          this.#schedule(() => {
            this.#retries.delete(sessionId);
            void this.#attempt(sessionId, false);
          }, delay),
        );
        return;
      }

      this.#attempts.delete(sessionId);
      this.#commit(sessionId, {
        ...this.view(sessionId),
        phase: code === 'not-found' ? 'session-not-loaded' : 'failed',
        error: message,
      });
    }
  }

  /**
   * Clear annotations on turns that are not uniformly marked.
   *
   * A turn is all-or-nothing (N035), but records written before turns existed —
   * the old per-message UI could only mark one message at a time — land in
   * between. Neither reading of such a turn is honest: completing it would let a
   * single stray mark exclude an entire exchange (one measured turn holds 97
   * messages), while leaving it would have the panel promise an exclusion the
   * digest would not deliver. So they are cleared, and the operator starts from
   * a state that means something.
   *
   * Idempotent: once no turn is mixed, this writes nothing. Failure is
   * contained — the display rule already reads a mixed turn as invalid.
   */
  async #clearMixedTurns(
    sessionId: string,
    turns: readonly SurfaceTurn[],
    byMessageId: Map<string, StoredStatus>,
  ): Promise<void> {
    const messageIds: string[] = [];
    for (const turn of turns) {
      const ids: string[] = [];
      for (const message of turn.messages) if (message.messageId !== null) ids.push(message.messageId);
      if (ids.length === 0) continue;
      const marked = ids.filter((id) => byMessageId.has(id));
      if (marked.length === 0 || marked.length === ids.length) continue;
      for (const id of marked) messageIds.push(id);
    }
    if (messageIds.length === 0) return;
    try {
      await this.#rpc.call<{ applied: number }>('annotations.bulkSet', {
        sessionId,
        items: messageIds.map((messageId) => ({ messageId, status: 'unmarked' })),
      });
      for (const messageId of messageIds) byMessageId.delete(messageId);
    } catch {
      /* the display rule already treats the turn as invalid */
    }
  }

  /**
   * Set one status across many messages at once. Optimistic; re-reads on failure.
   *
   * Counts are computed over the cached turns, so an annotation for a message the
   * list does not hold cannot move a single number — marking a reply that arrived
   * after the last read is exactly that case. When any id is unknown the write is
   * therefore followed by a full re-read; without it the newest exchange could be
   * marked and the header would keep showing the old figure.
   */
  async setStatus(
    sessionId: string,
    messageIds: readonly string[],
    status: AnnotationStatus,
  ): Promise<void> {
    if (messageIds.length === 0) return;
    const view = this.view(sessionId);
    const allKnown = messageIds.every((messageId) => this.knows(sessionId, messageId));
    const optimistic = new Map(view.byMessageId);
    for (const messageId of messageIds) {
      if (status === 'unmarked') optimistic.delete(messageId);
      else optimistic.set(messageId, status);
    }
    this.#commit(sessionId, {
      ...view,
      byMessageId: optimistic,
      stats: computeStats(view.turns, optimistic, this.#policy),
      error: null,
    });

    const items = messageIds.map((messageId) => ({ messageId, status }));
    try {
      const result = await this.#rpc.call<{ applied: number }>('annotations.bulkSet', { sessionId, items });
      if (result.applied === 0 || !allKnown) await this.load(sessionId);
    } catch (error) {
      // The host is the authority: re-read rather than guess a rollback.
      await this.load(sessionId);
      this.#commit(sessionId, {
        ...this.view(sessionId),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Mark or clear one whole turn. */
  async setTurn(sessionId: string, turn: SurfaceTurn, status: AnnotationStatus): Promise<void> {
    const ids: string[] = [];
    for (const message of turn.messages) if (message.messageId !== null) ids.push(message.messageId);
    await this.setStatus(sessionId, ids, status);
  }

  /** Drop every annotation for one session. */
  async clear(sessionId: string): Promise<void> {
    await this.#rpc.call<{ cleared: number }>('annotations.clear', { sessionId });
    await this.load(sessionId);
  }

  #commit(sessionId: string, next: AnnotationView): void {
    this.#views.set(sessionId, next);
    for (const listener of this.#listeners) listener();
  }
}
