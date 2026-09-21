/**
 * Live session surface projection.
 *
 * The client UI needs a list of the current conversation's messages *with their
 * durable ids*, because an annotation is keyed by `MessageId` and nothing else.
 * This is the host half of that: it walks a session's current surface and
 * copies out leaf scalars only.
 *
 * The projection deliberately does not touch the transcript path. `surface.nodes`
 * is the model-visible view (replacements applied), which is exactly what a
 * digest acts on — a message the surface no longer holds cannot be annotated
 * meaningfully, because it is not in the next summarization call.
 *
 * @module dsh-context-compaction-optimizer/host/session/surface
 */

import { messageId, messageRole, messageText } from '../compaction/text.ts';
import type { SurfaceMessage, SurfaceTurn } from '../../shared/types.ts';

/** Default characters of preview retained per message. */
export const DEFAULT_HEAD_LIMIT = 160;

export type { SurfaceMessage, SurfaceTurn };

/** Structural view of a live session. */
interface SessionLike {
  surface?: { nodes?: unknown };
  eventAt?: (seq: unknown) => unknown;
  /** Total event count. Present on a real session; used to scan for turns. */
  seq?: unknown;
}

/** One turn's seq span, as read from the log. `end` is `null` while open. */
interface TurnRange {
  readonly start: number;
  readonly end: number | null;
}

function extractMessage(eventType: string, data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  // `user/message` carries the message directly; `assistant/message` nests it
  // beside the provider stream.
  return eventType === 'user/message' ? data : record['message'];
}

/**
 * Project the current surface of one session.
 *
 * Only message-producing events are returned: a UI that lists boundary markers
 * or log-only records would offer annotations for things that never reach a
 * summarization call.
 */
export function listSurface(session: unknown, headLimit: number = DEFAULT_HEAD_LIMIT): readonly SurfaceMessage[] {
  if (typeof session !== 'object' || session === null) return [];
  const model = session as SessionLike;
  const nodes = model.surface?.nodes;
  if (!Array.isArray(nodes) || typeof model.eventAt !== 'function') return [];

  const out: SurfaceMessage[] = [];
  for (const seq of nodes) {
    const event = model.eventAt(seq);
    if (typeof event !== 'object' || event === null) continue;
    const envelope = event as Record<string, unknown>;
    const eventType = typeof envelope['type'] === 'string' ? envelope['type'] : '';
    if (eventType !== 'user/message' && eventType !== 'assistant/message' && eventType !== 'tool/result') {
      continue;
    }
    const message = extractMessage(eventType, envelope['data']);
    const text = messageText(message);
    out.push({
      seq: typeof seq === 'number' ? seq : -1,
      eventType,
      role: messageRole(message),
      messageId: messageId(message) ?? null,
      head: text.length > headLimit ? text.slice(0, headLimit) : text,
    });
  }
  return out;
}

/** Message ids present on the surface, for pruning and stats. */
export function surfaceMessageIds(messages: readonly SurfaceMessage[]): readonly string[] {
  const ids: string[] = [];
  for (const message of messages) if (message.messageId !== null) ids.push(message.messageId);
  return ids;
}

/**
 * Read the session's own turn boundaries off the log.
 *
 * `turn/start` … `turn/end` is the only exact way to do this. Counting user
 * messages does not work: injected ones (runtime context, system reminders) sit
 * inside a turn, and one measured session logged 56 `user/message` events
 * against 45 turns. An unterminated turn — the running one — is left open.
 */
function listTurnRanges(session: SessionLike): readonly TurnRange[] {
  const total = typeof session.seq === 'number' && Number.isFinite(session.seq) ? session.seq : 0;
  if (total <= 0 || typeof session.eventAt !== 'function') return [];

  const ranges: TurnRange[] = [];
  let open: number | null = null;
  for (let seq = 0; seq < total; seq += 1) {
    const event = session.eventAt(seq);
    if (typeof event !== 'object' || event === null) continue;
    const type = (event as Record<string, unknown>)['type'];
    if (type === 'turn/start') {
      // A previous turn with no `turn/end` still happened; keep it rather than
      // silently merging two turns into one.
      if (open !== null) ranges.push({ start: open, end: null });
      open = seq;
    } else if (type === 'turn/end' && open !== null) {
      ranges.push({ start: open, end: seq });
      open = null;
    }
  }
  if (open !== null) ranges.push({ start: open, end: null });
  return ranges;
}

/**
 * Group the current surface into turns: the unit the operator annotates.
 *
 * Both lists are seq-ordered, so grouping is one merge pass. A surface message
 * no turn encloses becomes its own group — a compaction checkpoint is appended
 * outside any turn, and folding it into a neighbouring turn would misattribute
 * it.
 */
export function listTurns(session: unknown, headLimit: number = DEFAULT_HEAD_LIMIT): readonly SurfaceTurn[] {
  const messages = listSurface(session, headLimit);
  if (messages.length === 0) return [];
  const ranges =
    typeof session === 'object' && session !== null ? listTurnRanges(session as SessionLike) : [];

  const turns: SurfaceTurn[] = [];
  let cursor = 0;
  for (const range of ranges) {
    // Anything before this turn opened belongs to no turn.
    while (cursor < messages.length && (messages[cursor] as SurfaceMessage).seq <= range.start) {
      turns.push(looseTurn(messages[cursor] as SurfaceMessage));
      cursor += 1;
    }
    const bucket: SurfaceMessage[] = [];
    while (cursor < messages.length) {
      const message = messages[cursor] as SurfaceMessage;
      if (range.end !== null && message.seq >= range.end) break;
      bucket.push(message);
      cursor += 1;
    }
    if (bucket.length > 0) {
      const first = bucket[0] as SurfaceMessage;
      turns.push({ id: `turn:${first.seq}`, startSeq: first.seq, endSeq: range.end, messages: bucket });
    }
  }
  while (cursor < messages.length) {
    turns.push(looseTurn(messages[cursor] as SurfaceMessage));
    cursor += 1;
  }
  return turns;
}

/** One surface message that no turn encloses. */
function looseTurn(message: SurfaceMessage): SurfaceTurn {
  return { id: `loose:${message.seq}`, startSeq: message.seq, endSeq: null, messages: [message] };
}

/** Flatten turns back into the message list the digest and stats address. */
export function turnMessages(turns: readonly SurfaceTurn[]): readonly SurfaceMessage[] {
  const out: SurfaceMessage[] = [];
  for (const turn of turns) for (const message of turn.messages) out.push(message);
  return out;
}
