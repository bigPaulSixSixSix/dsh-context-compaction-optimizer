import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MANUAL_COMPACT_COMMAND,
  buildCompactCommand,
  registerManualCompactCommand,
  runManualCompact,
} from '../../src/host/compaction/manual.ts';

const AGENT = { id: 'session-1' };
const SIGNAL = { aborted: false };
const COMMAND_ID = 'cmd-1';

/** A roster whose `serviceFor` yields whatever the case under test needs. */
function roster(service: unknown, onCall?: (agent: unknown, name: string) => void) {
  return {
    serviceFor(agent: unknown, name: string) {
      onCall?.(agent, name);
      return service;
    },
  };
}

function invocation() {
  return { agent: AGENT, signal: SIGNAL, commandId: COMMAND_ID };
}

test('the command resolves the agent instance and threads agent, signal and commandId', async () => {
  const seen: unknown[][] = [];
  const compaction = {
    async compactNow(...args: unknown[]) {
      seen.push(args);
      return { kind: 'compacted' };
    },
  };
  const calls: { agent: unknown; name: string }[] = [];

  const result = await runManualCompact(
    { agentPresets: roster(compaction, (agent, name) => calls.push({ agent, name })) },
    invocation(),
  );

  assert.deepEqual(calls, [{ agent: AGENT, name: 'compaction' }]);
  assert.deepEqual(seen, [[AGENT, SIGNAL, COMMAND_ID]], 'commandId must reach compactNow for attribution');
  assert.equal(result.kind, 'success');
});

/**
 * The success path returns only the two scalar fields the shell renders. A
 * `CompactionResult` is live runtime data and must never travel into an RPC
 * envelope, so this pins the fact that it does not.
 */
test('a successful run reports nothing but the command result', async () => {
  const compaction = { async compactNow() { return { summary: 'live data', tokens: 123 }; } };

  const result = await runManualCompact({ agentPresets: roster(compaction) }, invocation());

  assert.deepEqual(Object.keys(result).sort(), ['kind', 'text']);
  assert.equal(result.kind, 'success');
  assert.ok(!JSON.stringify(result).includes('live data'));
});

test('a null result is reported as nothing to compact, not as failure', async () => {
  const compaction = { async compactNow() { return null; } };

  const result = await runManualCompact({ agentPresets: roster(compaction) }, invocation());

  assert.equal(result.kind, 'success');
  assert.match(result.text, /nothing to compact/i);
});

test('a missing roster is reported rather than thrown', async () => {
  const result = await runManualCompact({ agentPresets: undefined }, invocation());

  assert.equal(result.kind, 'error');
  assert.match(result.text, /preset roster unavailable/i);
});

test('a preset that mounts no compaction service is reported', async () => {
  const result = await runManualCompact({ agentPresets: roster(undefined) }, invocation());

  assert.equal(result.kind, 'error');
  assert.match(result.text, /mounts no compaction service/i);
});

test('an instance without compactNow is reported instead of being called', async () => {
  const result = await runManualCompact({ agentPresets: roster({ compactIfNeeded() {} }) }, invocation());

  assert.equal(result.kind, 'error');
  assert.match(result.text, /no compactNow/i);
});

test('a throwing roster lookup is contained', async () => {
  const agentPresets = {
    serviceFor() {
      throw new Error('realm is gone');
    },
  };

  const result = await runManualCompact({ agentPresets }, invocation());

  assert.equal(result.kind, 'error');
  assert.match(result.text, /realm is gone/);
});

test('a throwing compaction is contained and its message kept', async () => {
  const compaction = {
    async compactNow() {
      throw new Error('provider refused');
    },
  };

  const result = await runManualCompact({ agentPresets: roster(compaction) }, invocation());

  assert.equal(result.kind, 'error');
  assert.match(result.text, /provider refused/);
});

/**
 * DSH wraps every summary-stage manual-compaction failure in one catch-all
 * whose text names a size check the backend does not actually perform. The real
 * reason lives only in `cause`, so reporting the outer message alone would tell
 * the operator something false and leave them nothing to act on.
 */
test('a nested failure reports the whole cause chain, not just the catch-all label', async () => {
  const root = new Error('summarization produced no text summary content');
  const labelled = new Error('manual compaction could not produce a smaller summary', { cause: root });
  const compaction = {
    async compactNow() {
      throw labelled;
    },
  };

  const result = await runManualCompact({ agentPresets: roster(compaction) }, invocation());

  assert.equal(result.kind, 'error');
  assert.match(result.text, /could not produce a smaller summary/);
  assert.match(result.text, /produced no text summary content/, 'the real cause must survive');
});

test('a self-referential cause chain terminates instead of looping', async () => {
  const looped = new Error('looping failure');
  (looped as { cause?: unknown }).cause = looped;
  const compaction = {
    async compactNow() {
      throw looped;
    },
  };

  const result = await runManualCompact({ agentPresets: roster(compaction) }, invocation());

  assert.equal(result.kind, 'error');
  assert.match(result.text, /looping failure/);
});

test('the built command carries the documented name and a description', () => {
  const command = buildCompactCommand({ agentPresets: undefined }) as {
    name: string;
    description: string;
    handler: unknown;
  };

  assert.equal(command.name, MANUAL_COMPACT_COMMAND);
  assert.equal(command.name, 'cco-compact', 'the operator-facing name is part of the UX');
  assert.ok(command.description.length > 0);
  assert.equal(typeof command.handler, 'function');
});

/**
 * A deployment with no command registry still gets automatic interception, so
 * registration must be a no-op rather than a throw at mount time.
 */
test('registering without a command registry is a silent no-op', () => {
  const disposer = registerManualCompactCommand(undefined, { agentPresets: undefined });

  assert.equal(typeof disposer, 'function');
  assert.doesNotThrow(() => disposer());
});

test('registering hands the definition to the registry and returns its disposer', () => {
  const registered: unknown[] = [];
  let disposed = 0;
  const commands = {
    register(definition: unknown) {
      registered.push(definition);
      return () => {
        disposed += 1;
      };
    },
  };

  const dispose = registerManualCompactCommand(commands, { agentPresets: undefined });
  dispose();

  assert.equal(registered.length, 1);
  assert.equal((registered[0] as { name: string }).name, MANUAL_COMPACT_COMMAND);
  assert.equal(disposed, 1, 'the registry disposer must be the one returned');
});

test('the registered handler drives a real invocation end to end', async () => {
  const compaction = { async compactNow() { return { ok: true }; } };
  let handler: ((invocation: unknown) => Promise<unknown>) | undefined;
  const commands = {
    register(definition: unknown) {
      handler = (definition as { handler: (invocation: unknown) => Promise<unknown> }).handler;
      return () => {};
    },
  };

  registerManualCompactCommand(commands, { agentPresets: roster(compaction) });
  assert.ok(handler !== undefined);

  const result = (await handler(invocation())) as { kind: string };

  assert.equal(result.kind, 'success');
});
