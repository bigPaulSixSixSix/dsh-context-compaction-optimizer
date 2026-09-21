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

/** Immutable view of one session's annotation state. */
export interface AnnotationView {
  readonly sessionId: string;
  readonly byMessageId: ReadonlyMap<string, StoredStatus>;
  /** Counts of *turns*, the unit the header reports. */
  readonly stats: AnnotationStats;
  readonly turns: readonly SurfaceTurn[];
  /** The same messages flattened, for membership checks and comparisons. */
  readonly messages: readonly SurfaceMessage[];
  readonly loaded: boolean;
  readonly error: string | null;
}

type Listener = () => void;

const EMPTY_STATS: AnnotationStats = { total: 0, valid: 0, invalid: 0, unmarked: 0 };

function emptyView(sessionId: string): AnnotationView {
  return {
    sessionId,
    byMessageId: new Map(),
    stats: EMPTY_STATS,
    turns: [],
    messages: [],
    loaded: false,
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

/** Per-session annotation state with optimistic writes. */
export class AnnotationController {
  readonly #rpc: RpcClient;
  readonly #views = new Map<string, AnnotationView>();
  readonly #listeners = new Set<Listener>();
  #policy: UnmarkedPolicy = 'valid';

  constructor(rpc: RpcClient) {
    this.#rpc = rpc;
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
    });
  }

  /** Fetch annotations and the surface for one session. */
  async load(sessionId: string): Promise<void> {
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
      this.#commit(sessionId, {
        sessionId,
        byMessageId,
        turns: surface.turns,
        messages: flatten(surface.turns),
        stats: computeStats(surface.turns, byMessageId, this.#policy),
        loaded: true,
        error: null,
      });
    } catch (error) {
      this.#commit(sessionId, {
        ...this.view(sessionId),
        loaded: true,
        error: error instanceof Error ? error.message : String(error),
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
