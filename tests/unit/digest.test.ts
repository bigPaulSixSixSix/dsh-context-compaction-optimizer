import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_MAX_CHARS,
  DIGEST_REQUIREMENTS,
  DIGEST_TITLE,
  buildDigestEntries,
  extractAnchor,
  injectBeforeLast,
  planInjection,
  renderAnnotationDigest,
} from '../../src/core/digest.ts';
import type { MessageLike } from '../../src/shared/types.ts';

function msg(role: string, text: string, id?: string): MessageLike {
  return id === undefined ? { role, text } : { id, role, text };
}

test('renderAnnotationDigest returns null when nothing is excluded', () => {
  assert.equal(renderAnnotationDigest([]), null);
});

test('extractAnchor returns short text verbatim', () => {
  assert.equal(extractAnchor('short message'), 'short message');
});

test('extractAnchor truncates at the code-point limit without splitting surrogate pairs', () => {
  const emoji = '\u{1F600}';
  const anchor = extractAnchor(emoji.repeat(200), 5);
  assert.equal(Array.from(anchor).length, 5);
  assert.equal(anchor, emoji.repeat(5));
  // A split surrogate pair would leave a lone high surrogate behind.
  for (const unit of anchor) {
    const code = unit.codePointAt(0) ?? 0;
    assert.ok(code < 0xD800 || code > 0xDFFF, 'anchor must not contain a lone surrogate');
  }
});

test('extractAnchor honours a custom limit', () => {
  assert.equal(extractAnchor('abcdefgh', 3), 'abc');
  assert.equal(extractAnchor('abcdefgh', 0), '');
});

test('buildDigestEntries records the ORIGINAL index, not the filtered rank', () => {
  const messages = [msg('user', 'keep 0'), msg('assistant', 'drop 1'), msg('user', 'drop 3'), msg('assistant', 'keep 4')];
  const entries = buildDigestEntries(messages, (m) => m.text.startsWith('drop'));
  assert.deepEqual(
    entries.map((e) => e.position),
    [1, 2],
  );
  assert.deepEqual(
    entries.map((e) => e.role),
    ['assistant', 'user'],
  );
});

test('renderAnnotationDigest emits the validated framing: unquoted anchors and three requirements', () => {
  const digest = renderAnnotationDigest([
    { position: 15, role: 'user', anchor: 'CCO_SPIKE_MARK irrelevant chatter' },
  ]);
  assert.ok(digest !== null);
  assert.ok(digest.startsWith(DIGEST_TITLE), 'digest must open with the title line');
  assert.match(digest, /1 message\(s\) in the conversation above were marked INVALID/);
  assert.match(digest, /FINGERPRINT 1 \(position 15, role user\): CCO_SPIKE_MARK irrelevant chatter/);
  for (const requirement of DIGEST_REQUIREMENTS) {
    assert.ok(digest.includes(requirement), `digest must carry requirement: ${requirement.slice(0, 40)}...`);
  }
});

test('the anchor is never wrapped in quotes', () => {
  const digest = renderAnnotationDigest([{ position: 0, role: 'user', anchor: 'anchor text' }]);
  assert.ok(digest !== null);
  assert.ok(!digest.includes('"anchor text"'), 'N009 showed a quoted anchor invites quoting it back');
  assert.ok(!digest.includes("'anchor text'"));
});

/**
 * A tool-only assistant turn has no text to quote. It is still excluded, so it
 * still gets a line — but the line must not look like a fingerprint that failed
 * to render, which is what a colon with nothing after it reads as.
 */
test('a message with no text renders a self-describing line, not a blank anchor', () => {
  const digest = renderAnnotationDigest([{ position: 1, role: 'assistant', anchor: '' }]);
  assert.ok(digest !== null);
  assert.match(digest, /FINGERPRINT 1 \(position 1, role assistant, no text content\)/);
  assert.ok(!/\):\s*$/m.test(digest), 'no line may end in a colon followed only by whitespace');
  assert.ok(!/FINGERPRINT \d+ \([^)]*\):\s*$/m.test(digest), 'the anchor slot must never be empty');
  // The message is still excluded and still counted; only its locator changes.
  assert.match(digest, /^1 message\(s\)/m);
});

test('a no-text line still carries the two locators it has left', () => {
  const digest = renderAnnotationDigest([{ position: 42, role: 'assistant', anchor: '' }]);
  assert.ok(digest !== null);
  assert.match(digest, /position 42/);
  assert.match(digest, /role assistant/);
});

/**
 * The operator's second question: two marked messages can share an opening, and
 * a marked message can share one with an *unmarked* neighbour. Text alone cannot
 * separate them — `position` and `role` are what do, so they must always be
 * present on every line.
 */
test('every fingerprint line carries a position and a role, which is what survives identical openings', () => {
  const digest = renderAnnotationDigest([
    { position: 2, role: 'user', anchor: '继续' },
    { position: 3, role: 'user', anchor: '继续' },
    { position: 4, role: 'assistant', anchor: '' },
  ]);
  assert.ok(digest !== null);
  const lines = (digest.match(/^FINGERPRINT .*$/gm) ?? []);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.match(line, /position \d+/);
    assert.match(line, /role \w+/);
  }
  // The duplicate opening is still distinguishable by position alone.
  assert.match(lines[0] ?? '', /position 2/);
  assert.match(lines[1] ?? '', /position 3/);
});

test('fingerprint numbering is dense and independent of position', () => {
  const digest = renderAnnotationDigest([
    { position: 3, role: 'user', anchor: 'a' },
    { position: 40, role: 'assistant', anchor: 'b' },
    { position: 47, role: 'assistant', anchor: 'c' },
  ]);
  assert.ok(digest !== null);
  assert.match(digest, /FINGERPRINT 1 \(position 3, role user\)/);
  assert.match(digest, /FINGERPRINT 2 \(position 40, role assistant\)/);
  assert.match(digest, /FINGERPRINT 3 \(position 47, role assistant\)/);
  assert.match(digest, /^3 message\(s\)/m);
});

/**
 * The KV-cache invariant. This is the single most important property in the
 * module: the summarization call's token prefix must be byte-identical to the
 * pre-injection request, otherwise the provider must re-prefill the whole
 * compacted region. N011/N012 measured this holding in production.
 */
test('injectBeforeLast preserves every leading element by reference and keeps the last element last', () => {
  const first = msg('user', 'turn 0');
  const second = msg('assistant', 'turn 1');
  const instruction = msg('user', 'you are now acting as a compaction engine');
  const messages = [first, second, instruction];
  const digest = msg('user', DIGEST_TITLE);

  const result = injectBeforeLast(messages, digest);

  assert.equal(result.length, messages.length + 1);
  assert.equal(result[0], first, 'leading element must be the same object');
  assert.equal(result[1], second, 'leading element must be the same object');
  assert.equal(result[2], digest);
  assert.equal(result[3], instruction, 'the compaction instruction must stay last');
  // The original array is untouched.
  assert.equal(messages.length, 3);
  assert.equal(messages[2], instruction);
});

test('injectBeforeLast handles a single-element and an empty list', () => {
  const only: MessageLike = { role: 'user', text: 'instruction' };
  const digest: MessageLike = { role: 'user', text: 'digest' };
  assert.deepEqual(injectBeforeLast([only], digest), [digest, only]);
  assert.deepEqual(injectBeforeLast([], digest), [digest]);
});

test('planInjection returns null when nothing is marked, so an unconfigured install is a no-op', () => {
  const messages = [msg('user', 'a', 'm-1'), msg('user', 'instruction', 'm-2')];
  assert.equal(planInjection(messages, () => false), null);
});

test('planInjection returns null for an empty message list', () => {
  assert.equal(planInjection([], () => true), null);
});

test('planInjection targets the slot immediately before the final message', () => {
  const messages = [msg('user', 'a', 'm-1'), msg('assistant', 'b', 'm-2'), msg('user', 'instruction', 'm-3')];
  const plan = planInjection(messages, (m) => m.id === 'm-1');
  assert.ok(plan !== null);
  assert.equal(plan.insertIndex, 2);
  assert.equal(plan.insertIndex, messages.length - 1);
  assert.equal(plan.entries.length, 1);
  assert.match(plan.digest, /FINGERPRINT 1 \(position 0, role user\)/);
});

test('a plan can be applied and the resulting list keeps the prefix intact', () => {
  const messages = [
    msg('user', 'turn 0', 'm-1'),
    msg('assistant', 'turn 1', 'm-2'),
    msg('user', 'instruction', 'm-3'),
  ];
  const plan = planInjection(messages, (m) => m.id === 'm-2');
  assert.ok(plan !== null);
  const applied = injectBeforeLast(messages, msg('user', plan.digest, 'digest'));
  assert.equal(applied[0], messages[0]);
  assert.equal(applied[1], messages[1]);
  assert.equal(applied[2]?.text, plan.digest);
  assert.equal(applied[3], messages[2]);
  assert.equal(plan.entries[0]?.anchor, 'turn 1');
});

test('anchor length is capped at the validated 170 characters', () => {
  assert.equal(ANCHOR_MAX_CHARS, 170);
  const long = 'x'.repeat(500);
  const entries = buildDigestEntries([msg('user', long, 'm-1')], () => true);
  assert.equal(entries[0]?.anchor.length, 170);
});

/**
 * The span format exists because the turn unit made marking a whole exchange one
 * click: one measured turn produced 170 entries and a 24,108-character digest.
 * Collapsing a run to its bounds costs two anchors instead of 170.
 */
test('consecutive excluded messages collapse into one span with both boundary anchors', () => {
  const entries = buildDigestEntries(
    [msg('user', 'first opening', 'm-1'), msg('assistant', 'middle text', 'm-2'), msg('user', 'last opening', 'm-3')],
    () => true,
  );

  const digest = renderAnnotationDigest(entries, 'spans');
  assert.ok(digest !== null);
  assert.match(digest, /SPAN 1 \(positions 0-2 inclusive, 3 messages, user to user\)/);
  assert.match(digest, /first message begins: first opening/);
  assert.match(digest, /last message begins: last opening/);
  assert.ok(!digest.includes('middle text'), 'the middle is described by the bounds, not quoted');
  assert.match(digest, /EVERY message of EVERY listed span/);
});

test('a gap between excluded messages splits the run into separate ranges', () => {
  const entries = buildDigestEntries(
    [msg('user', 'a', 'm-1'), msg('assistant', 'kept', 'm-2'), msg('user', 'b', 'm-3')],
    (message) => message.id !== 'm-2',
  );

  const digest = renderAnnotationDigest(entries, 'spans');
  assert.ok(digest !== null);
  assert.match(digest, /in 2 excluded range\(s\)/);
  // Each run holds one message here, so both degrade to fingerprint lines — the
  // kept message in between is what stops them merging into a single range.
  assert.match(digest, /FINGERPRINT 1 \(position 0, role user\): a/);
  assert.match(digest, /FINGERPRINT 2 \(position 2, role user\): b/);
  assert.ok(!digest.includes('positions 0-2'), 'the kept message must not be swallowed into a span');
});

test('a span of one degrades to the validated fingerprint line', () => {
  const entries = buildDigestEntries([msg('user', 'solo', 'm-1')], () => true);

  const digest = renderAnnotationDigest(entries, 'spans');
  assert.ok(digest !== null);
  assert.match(digest, /FINGERPRINT 1 \(position 0, role user\): solo/);
  assert.ok(!digest.includes('SPAN 1'), 'a single message is not a range');
});

test('the anchor format is unchanged and remains the default', () => {
  const entries = buildDigestEntries([msg('user', 'a', 'm-1'), msg('assistant', 'b', 'm-2')], () => true);

  const implied = renderAnnotationDigest(entries);
  const explicit = renderAnnotationDigest(entries, 'anchors');

  assert.equal(implied, explicit);
  assert.match(implied ?? '', /FINGERPRINT 1/);
  assert.match(implied ?? '', /FINGERPRINT 2/);
  assert.ok(!(implied ?? '').includes('SPAN'));
});

test('planInjection threads the format through to the rendered digest', () => {
  const messages = [msg('user', 'a', 'm-1'), msg('assistant', 'b', 'm-2'), msg('user', 'instruction', 'm-3')];

  const plan = planInjection(messages, (m) => m.id !== 'm-3', 'spans');

  assert.ok(plan !== null);
  assert.match(plan.digest, /SPAN 1 \(positions 0-1 inclusive/);
});
