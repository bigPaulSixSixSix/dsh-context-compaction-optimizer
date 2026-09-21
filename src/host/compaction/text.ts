/**
 * Text extraction for DSH content blocks.
 *
 * The core layer takes a plain `{ role, text }` view of each message, so this is
 * where knowledge of DSH's block shapes lives. Two shapes matter:
 *
 * 1. A `tool/result` message carries no top-level text block at all — its
 *    payload is nested inside a `tool-result` block. A naive
 *    `block.type === 'text'` walk would produce an empty anchor for every tool
 *    message, silently making those annotations unlocatable.
 * 2. An `assistant/message` carries `reasoning` before its `text` (N034). Block
 *    order is not significance order: concatenating naively makes every consumer
 *    read the model's private thinking instead of what it actually answered.
 *
 * Traversal is depth-bounded and total-length-bounded: content blocks are live
 * runtime data, and an unbounded recursive walk over a hostile or merely
 * surprising payload is how a plugin turns a model call into a hang.
 *
 * @module dsh-context-compaction-optimizer/host/compaction/text
 */

/** Maximum nesting depth walked before giving up. */
const MAX_DEPTH = 5;

/** Maximum characters collected per message, well above the anchor budget. */
const MAX_CHARS = 4096;

/**
 * Block type carrying model-internal reasoning rather than visible output.
 *
 * Measured (N034): an assistant message is typically
 * `[{ type: 'reasoning', … }, { type: 'text', text: '收到' }]`. Reasoning comes
 * first and is orders of magnitude longer, so concatenating in block order made
 * every downstream consumer see the reasoning instead of the answer — the panel
 * preview showed "The user is asking me to acknowledge…" where the operator
 * needed to see "收到".
 */
const REASONING_TYPE = 'reasoning';

function appendText(
  value: unknown,
  depth: number,
  budget: { left: number },
  out: string[],
  includeReasoning: boolean,
): void {
  if (budget.left <= 0 || depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    const slice = value.length > budget.left ? value.slice(0, budget.left) : value;
    out.push(slice);
    budget.left -= slice.length;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendText(item, depth + 1, budget, out, includeReasoning);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const block = value as Record<string, unknown>;
  const type = typeof block['type'] === 'string' ? block['type'] : undefined;
  // Reasoning is skipped in the primary pass so the visible output leads.
  if (type === REASONING_TYPE && !includeReasoning) return;
  // Direct text blocks.
  if (type === 'text' && typeof block['text'] === 'string') {
    appendText(block['text'], depth + 1, budget, out, includeReasoning);
    return;
  }
  // Nested payloads: `tool-result` wraps the tool's own content blocks.
  if (block['content'] !== undefined) {
    appendText(block['content'], depth + 1, budget, out, includeReasoning);
    return;
  }
  if (block['text'] !== undefined) appendText(block['text'], depth + 1, budget, out, includeReasoning);
}

function collectText(content: unknown, includeReasoning: boolean): string {
  const out: string[] = [];
  appendText(content, 0, { left: MAX_CHARS }, out, includeReasoning);
  return out.join('');
}

/**
 * Concatenate the text a message exposes, including nested tool-result content.
 *
 * Visible output wins: a message carrying both reasoning and an answer yields
 * the answer. Reasoning is used only when there is nothing else, so a
 * reasoning-only message still gets a non-empty preview and a locatable anchor
 * rather than silently looking empty.
 */
export function contentText(content: unknown): string {
  const visible = collectText(content, false);
  return visible.length > 0 ? visible : collectText(content, true);
}

/** Text of one message-shaped value, or `''` when it carries none. */
export function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  return contentText((message as Record<string, unknown>)['content']);
}

/** Durable id of one message-shaped value, or `undefined` when absent. */
export function messageId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const id = (message as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Role of one message-shaped value, defaulting to `unknown`. */
export function messageRole(message: unknown): string {
  if (typeof message !== 'object' || message === null) return 'unknown';
  const role = (message as Record<string, unknown>)['role'];
  return typeof role === 'string' && role.length > 0 ? role : 'unknown';
}
