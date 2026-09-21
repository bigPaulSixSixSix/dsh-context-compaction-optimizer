/**
 * Pipeline wiring.
 *
 * `interceptor.test.ts` proves `applyDigest` decides correctly. This suite proves
 * the layer above it actually *hands it the right things*: that
 * `installCompactionPipeline` subscribes to the two events it claims, forwards
 * `enabled`, `format` and the annotation lookup through to the interceptor, and
 * routes `compaction/summary` events into the observer.
 *
 * That layer has no logic to unit-test, which is exactly why it went untested —
 * and why a wiring mistake there is invisible: the digest would simply render in
 * the wrong format, or not at all, with every lower-level test still green.
 * N037 and N041 were both that shape.
 *
 * Unlike the interceptor tests, this suite does **not** stub the digest factory:
 * `install.ts` supplies none, so the real `createUserMessage` runs and the
 * assertions read the message shape a provider would actually receive.
 *
 * @module tests/unit/install
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installCompactionPipeline, type CompactionPipelineDeps } from '../../src/host/compaction/install.ts';
import { CompactionObserver, type SummaryRecord } from '../../src/host/compaction/observe.ts';
import type { DigestFormat } from '../../src/shared/types.ts';

const SESSION = 'session-1';

type Listener = (...args: unknown[]) => unknown;

/** A `ListenerContext` double that records what was subscribed. */
function listenerContext() {
  const listeners = new Map<string, Listener>();
  return {
    listeners,
    on(name: string, listener: Listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  };
}

interface HarnessOptions {
  readonly format?: DigestFormat;
  readonly enabled?: boolean;
  readonly excluded?: readonly string[];
  readonly onSummary?: (record: SummaryRecord) => void;
}

function harness(options: HarnessOptions = {}) {
  const observer = new CompactionObserver();
  const excluded = new Set(options.excluded ?? ['m-1']);
  // Wrap the public sink so the test sees what arrived without touching private
  // state; `recordSummary` is an ordinary method, so an own property shadows it.
  if (options.onSummary !== undefined) {
    const original = observer.recordSummary.bind(observer);
    observer.recordSummary = (record: SummaryRecord) => {
      options.onSummary?.(record);
      original(record);
    };
  }
  const ctx = listenerContext();
  const deps: CompactionPipelineDeps = {
    annotations: { excludes: (_sessionId, messageId) => excluded.has(messageId) },
    enabled: () => options.enabled ?? true,
    format: () => options.format ?? 'anchors',
    observer,
  };
  installCompactionPipeline(ctx as never, deps);
  return { ctx, observer };
}

function streamOf(ctx: ReturnType<typeof listenerContext>): Listener {
  const listener = ctx.listeners.get('llm/stream');
  assert.ok(listener !== undefined, 'install must subscribe to llm/stream');
  return listener;
}

function eventOf(ctx: ReturnType<typeof listenerContext>): Listener {
  const listener = ctx.listeners.get('session/event');
  assert.ok(listener !== undefined, 'install must subscribe to session/event');
  return listener;
}

interface CallShape {
  purpose: string;
  sessionId: string;
  messages: { content?: { type?: string; text?: string }[] }[];
}

function compactionCall(texts: readonly string[], ids?: readonly string[]): CallShape {
  return {
    purpose: 'compaction',
    sessionId: SESSION,
    messages: texts.map((text, index) => ({
      content: [{ type: 'text', text }],
      ...(ids === undefined ? {} : { id: ids[index] }),
    })) as CallShape['messages'],
  };
}

/**
 * The digest's text, read off the injected message.
 *
 * `install.ts` supplies no `createDigestMessage`, so the spliced entry is a real
 * provider message whose content blocks carry the digest — which is also why
 * this suite is the one that exercises that constructor.
 */
function digestOf(call: CallShape): string {
  const injected = call.messages[call.messages.length - 2];
  return (injected?.content ?? []).map((block) => block.text ?? '').join('');
}

test('install subscribes to exactly the two events the pipeline owns', () => {
  const { ctx } = harness();

  assert.deepEqual([...ctx.listeners.keys()].sort(), ['llm/stream', 'session/event']);
});

test('the llm/stream listener always calls next, so the waterfall continues', () => {
  const { ctx } = harness();
  let nexted = 0;

  streamOf(ctx)(compactionCall(['hello', 'instruction']), () => {
    nexted += 1;
    return 'downstream';
  });

  assert.equal(nexted, 1);
});

test('the llm/stream listener splices a digest into a compaction call', () => {
  const { ctx } = harness({ excluded: ['m-1'] });
  const call = compactionCall(['first', 'second', 'the compaction instruction'], ['m-1', 'm-2', 'm-3']);

  streamOf(ctx)(call, () => undefined);

  assert.equal(call.messages.length, 4, 'the digest message is spliced in');
  assert.match(digestOf(call), /FINGERPRINT 1/);
});

/**
 * The regression this suite exists for: `format` must reach the renderer. A
 * wiring slip here leaves every lower-level test green while the digest silently
 * renders in the wrong shape.
 */
test('the configured format reaches the renderer', () => {
  for (const format of ['anchors', 'spans'] as const) {
    const { ctx } = harness({ format, excluded: ['m-1', 'm-2'] });
    const call = compactionCall(['first excluded', 'second excluded', 'the instruction'], ['m-1', 'm-2', 'm-3']);

    streamOf(ctx)(call, () => undefined);

    const digest = digestOf(call);
    if (format === 'spans') {
      assert.match(digest, /SPAN 1 \(positions 0-1 inclusive/, 'spans must render a range');
    } else {
      assert.match(digest, /FINGERPRINT 1/, 'anchors must render per-message lines');
      assert.ok(!digest.includes('SPAN 1'), 'anchors must not render a range');
    }
  }
});

test('a disabled pipeline leaves the call untouched but still continues', () => {
  const { ctx } = harness({ enabled: false });
  const call = compactionCall(['first', 'instruction'], ['m-1', 'm-2']);
  let nexted = 0;

  streamOf(ctx)(call, () => {
    nexted += 1;
  });

  assert.equal(call.messages.length, 2, 'no digest when injection is disabled');
  assert.equal(nexted, 1);
});

test('a non-compaction call is passed through untouched', () => {
  const { ctx } = harness();
  const call = { purpose: 'chat', sessionId: SESSION, messages: [{ content: [{ type: 'text', text: 'hi' }] }] };

  streamOf(ctx)(call, () => undefined);

  assert.equal(call.messages.length, 1);
});

test('a compaction/summary event reaches the observer', () => {
  const summaries: SummaryRecord[] = [];
  const { ctx } = harness({ onSummary: (record) => summaries.push(record) });

  eventOf(ctx)({}, {
    type: 'compaction/summary',
    seq: 84,
    data: {
      shadowedSeqs: [8, 9, 15],
      shadowedTokenCount: 2652,
      summary: [{ type: 'text', text: 'the checkpoint' }],
      usage: { inputTokens: 892, outputTokens: 447, cacheReadTokens: 18432 },
    },
  });

  assert.equal(summaries.length, 1, 'the summary must reach the observer');
  assert.equal(summaries[0]?.seq, 84);
  assert.equal(summaries[0]?.shadowedCount, 3);
  assert.equal(summaries[0]?.shadowedTokenCount, 2652);
  assert.equal(summaries[0]?.cacheReadTokens, 18432);
});

test('an unrelated session event is ignored by the observer sink', () => {
  const summaries: SummaryRecord[] = [];
  const { ctx } = harness({ onSummary: (record) => summaries.push(record) });

  eventOf(ctx)({}, { type: 'turn/start', seq: 5, data: {} });

  assert.equal(summaries.length, 0);
});
