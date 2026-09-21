import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDigest,
  toMessageLike,
  type InjectionOutcome,
  type InterceptorDeps,
  type StreamOptionsLike,
} from '../../src/host/compaction/interceptor.ts';
import { contentText, messageText } from '../../src/host/compaction/text.ts';

const SESSION = 'session-1';

function textMessage(id: string | undefined, role: string, text: string): Record<string, unknown> {
  const base = { role, content: [{ type: 'text', text }] };
  return id === undefined ? base : { id, ...base };
}

function deps(overrides: Partial<InterceptorDeps> & { excluded?: readonly string[] } = {}): {
  deps: InterceptorDeps;
  outcomes: InjectionOutcome[];
} {
  const outcomes: InjectionOutcome[] = [];
  const excluded = new Set(overrides.excluded ?? []);
  const built: InterceptorDeps = {
    annotations: { excludes: (_sessionId, messageId) => excluded.has(messageId) },
    enabled: () => true,
    // The validated format; span rendering is covered in digest.test.ts.
    format: () => 'anchors',
    onOutcome: (outcome) => outcomes.push(outcome),
    createDigestMessage: (text) => ({ digest: text }),
    ...overrides,
  };
  return { deps: built, outcomes };
}

function compactionOptions(messages: unknown[], sessionId: unknown = SESSION): StreamOptionsLike {
  return { purpose: 'compaction', sessionId, messages };
}

test('a non-compaction call is never touched', () => {
  const messages = [textMessage('m-1', 'user', 'hello')];
  const options: StreamOptionsLike = { purpose: undefined, sessionId: SESSION, messages };
  const { deps: d, outcomes } = deps({ excluded: ['m-1'] });

  const outcome = applyDigest(options, d);

  assert.deepEqual(outcome, { kind: 'skipped', reason: 'not-compaction' });
  assert.equal(options.messages, messages, 'the message array must be the original reference');
  assert.equal(outcomes.length, 1);
});

test('injection is skipped when disabled, and the options are untouched', () => {
  const messages = [textMessage('m-1', 'user', 'a'), textMessage('m-2', 'user', 'instruction')];
  const options = compactionOptions(messages);
  const { deps: d } = deps({ excluded: ['m-1'], enabled: () => false });

  assert.deepEqual(applyDigest(options, d), { kind: 'skipped', reason: 'disabled' });
  assert.equal(options.messages, messages);
});

test('injection is skipped without a session id, because annotations are session-scoped', () => {
  const messages = [textMessage('m-1', 'user', 'a'), textMessage('m-2', 'user', 'instruction')];
  // Built directly: passing `undefined` to the helper would trip its default
  // parameter and silently supply a session id, which is what this test exists
  // to rule out.
  const options: StreamOptionsLike = { purpose: 'compaction', messages };
  const { deps: d } = deps({ excluded: ['m-1'] });

  assert.deepEqual(applyDigest(options, d), { kind: 'skipped', reason: 'no-session' });

  for (const sessionId of ['', 42, null]) {
    const other: StreamOptionsLike = { purpose: 'compaction', sessionId, messages };
    assert.deepEqual(applyDigest(other, d), { kind: 'skipped', reason: 'no-session' });
  }
});

test('an empty annotation set is a strict no-op', () => {
  const messages = [textMessage('m-1', 'user', 'a'), textMessage('m-2', 'user', 'instruction')];
  const options = compactionOptions(messages);
  const { deps: d } = deps();

  assert.deepEqual(applyDigest(options, d), { kind: 'skipped', reason: 'nothing-excluded' });
  assert.equal(options.messages, messages);
});

test('an unannotated message is never excluded even when the lookup would match a blank id', () => {
  const messages = [textMessage(undefined, 'user', 'a'), textMessage('m-2', 'user', 'instruction')];
  const options = compactionOptions(messages);
  const { deps: d } = deps({ excluded: ['', 'undefined'] });

  assert.deepEqual(applyDigest(options, d), { kind: 'skipped', reason: 'nothing-excluded' });
});

/**
 * The KV-cache invariant, asserted through the real interceptor rather than only
 * through the core helper. N011/N012 measured 96.5% → 97.1% cache-read ratios
 * with the digest present, which only holds while the prefix is byte-identical.
 */
test('the digest lands immediately before the final message and the prefix is preserved by reference', () => {
  const first = textMessage('m-1', 'user', 'turn 0');
  const second = textMessage('m-2', 'assistant', 'turn 1');
  const instruction = textMessage(undefined, 'user', 'You are now acting as a compaction engine.');
  const original = [first, second, instruction];
  const options = compactionOptions(original);
  const { deps: d } = deps({ excluded: ['m-2'] });

  const outcome = applyDigest(options, d);

  assert.equal(outcome.kind, 'injected');
  if (outcome.kind !== 'injected') return;
  assert.equal(outcome.entryCount, 1);
  assert.equal(outcome.insertIndex, 2);
  assert.equal(outcome.messageCount, 3);

  const applied = options.messages as unknown[];
  assert.equal(applied.length, 4);
  assert.equal(applied[0], first, 'leading message keeps identity');
  assert.equal(applied[1], second, 'leading message keeps identity');
  assert.deepEqual(applied[2], {
    digest: (applied[2] as { digest: string }).digest,
  });
  assert.equal(applied[3], instruction, 'the compaction instruction stays last');
  // The caller's array is untouched.
  assert.equal(original.length, 3);
});

test('the fingerprint carries the ORIGINAL index and the verbatim anchor', () => {
  const messages = [
    textMessage('m-1', 'user', 'keep me'),
    textMessage('m-2', 'assistant', 'drop me please'),
    textMessage(undefined, 'user', 'instruction'),
  ];
  const options = compactionOptions(messages);
  const { deps: d } = deps({ excluded: ['m-2'] });

  applyDigest(options, d);
  const digest = (options.messages as { digest?: string }[])[2]?.digest ?? '';

  assert.match(digest, /FINGERPRINT 1 \(position 1, role assistant\): drop me please/);
  assert.ok(!digest.includes('keep me'), 'a kept message must not be fingerprinted');
});

test('a throwing digest factory fails safely and leaves the request untouched', () => {
  const messages = [textMessage('m-1', 'user', 'a'), textMessage(undefined, 'user', 'instruction')];
  const options = compactionOptions(messages);
  const { deps: d, outcomes } = deps({
    excluded: ['m-1'],
    createDigestMessage: () => {
      throw new Error('factory exploded');
    },
  });

  const outcome = applyDigest(options, d);

  assert.deepEqual(outcome, { kind: 'failed', error: 'factory exploded' });
  assert.equal(options.messages, messages, 'a failed injection must not partially mutate');
  assert.equal(outcomes.length, 1, 'failures are still reported to the observer');
});

test('a throwing exclusion lookup fails safely', () => {
  const messages = [textMessage('m-1', 'user', 'a'), textMessage(undefined, 'user', 'instruction')];
  const options = compactionOptions(messages);
  const { deps: d } = deps({
    annotations: {
      excludes: () => {
        throw new Error('lookup exploded');
      },
    },
  });

  const outcome = applyDigest(options, d);
  assert.equal(outcome.kind, 'failed');
  assert.equal(options.messages, messages);
});

test('a malformed messages field degrades to a skip instead of throwing', () => {
  const { deps: d } = deps({ excluded: ['m-1'] });
  for (const messages of [undefined, null, 'not-an-array', 42, {}]) {
    const options: StreamOptionsLike = { purpose: 'compaction', sessionId: SESSION, messages };
    assert.deepEqual(applyDigest(options, d), { kind: 'skipped', reason: 'nothing-excluded' });
  }
});

test('toMessageLike keeps a placeholder for unrecognized messages so indices do not shift', () => {
  const likes = [toMessageLike(null), toMessageLike(textMessage('m-2', 'user', 'x'))];
  assert.equal(likes.length, 2);
  assert.equal(likes[0]?.id, undefined);
  assert.equal(likes[0]?.role, 'unknown');
  assert.equal(likes[1]?.id, 'm-2');
});

test('a tool result yields a non-empty anchor from its nested content', () => {
  const toolResult = {
    id: 'm-9',
    role: 'user',
    content: [
      {
        type: 'tool-result',
        content: [{ type: 'text', text: 'command output that should be locatable' }],
      },
    ],
  };
  assert.equal(messageText(toolResult), 'command output that should be locatable');

  const options = compactionOptions([toolResult, textMessage(undefined, 'user', 'instruction')]);
  const { deps: d } = deps({ excluded: ['m-9'] });
  applyDigest(options, d);
  const digest = (options.messages as { digest?: string }[])[1]?.digest ?? '';
  assert.match(digest, /command output that should be locatable/);
});

test('contentText is depth-bounded and does not recurse forever', () => {
  const deep: Record<string, unknown> = { type: 'text', text: 'bottom' };
  let node: Record<string, unknown> = { type: 'tool-result', content: [deep] };
  for (let i = 0; i < 20; i += 1) node = { type: 'tool-result', content: [node] };
  // Must return rather than hang or blow the stack.
  assert.equal(typeof contentText(node), 'string');
});

/**
 * DSH puts `reasoning` before `text` in an assistant message, and reasoning is
 * orders of magnitude longer (N034 measured 662 code points of thinking against
 * a 2-character answer). Concatenating in block order therefore makes the panel
 * preview — and the digest anchor — show the model's private thinking where the
 * operator needs to recognise the reply.
 */
test('an assistant message yields its visible answer, not its reasoning', () => {
  const message = {
    id: 'm-1',
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'The user is asking me to acknowledge a backup password and other things.' },
      { type: 'text', text: '收到' },
    ],
  };

  const text = messageText(message);

  assert.equal(text, '收到');
  assert.ok(!text.includes('reasoning'), 'private thinking must not lead the preview');
});

test('reasoning is used only when a message carries nothing else', () => {
  const message = {
    id: 'm-2',
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'thinking with no visible output' }],
  };

  // A non-empty anchor matters more than purity here: an empty one makes the
  // message unlocatable for the summarizer.
  assert.equal(messageText(message), 'thinking with no visible output');
});

test('text after a reasoning block still leads when order is reversed', () => {
  const message = {
    id: 'm-3',
    role: 'assistant',
    content: [
      { type: 'text', text: 'the answer' },
      { type: 'reasoning', text: 'the thinking' },
    ],
  };

  assert.equal(messageText(message), 'the answer');
});

test('the anchor for an assistant message is its answer, so the digest fingerprints that', () => {
  const message = {
    id: 'm-4',
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'a long private deliberation that should not be fingerprinted' },
      { type: 'text', text: 'the locatable answer' },
    ],
  };
  const options = compactionOptions([message, textMessage(undefined, 'user', 'instruction')]);
  const { deps: d } = deps({ excluded: ['m-4'] });

  applyDigest(options, d);
  const digest = (options.messages as { digest?: string }[])[1]?.digest ?? '';

  assert.match(digest, /the locatable answer/);
  assert.ok(
    !digest.includes('a long private deliberation'),
    'reasoning must not be handed to the summarizer as an identification fingerprint',
  );
});
