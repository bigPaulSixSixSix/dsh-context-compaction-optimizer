/**
 * Manual compaction: the `/cco-compact` command.
 *
 * Automatic compaction is influenced on the `llm/stream` waterfall (M3), which
 * needs no compaction service at all. **Triggering** one is the opposite
 * problem: the service is published by the agent preset inside an `isolate`
 * realm, which the Cordis contract states is "invisible outside the group that
 * declares them — including to the host". A host-plane row therefore cannot
 * `inject: ['compaction']`, and N028 measured `ctx.get('compaction')` here as
 * `undefined`.
 *
 * The supported way out is `agentPresets.serviceFor(agent, 'compaction')`, whose
 * documented purpose is exactly this shape — "a request that is ABOUT a session
 * but arrives from outside it". It yields the agent's own instance at call time,
 * which is what makes a single host-plane row sufficient: no preset row, no
 * realm of our own, nothing for an operator to edit.
 *
 * The command also gives the operator a manual path that does not depend on the
 * panel, which is why the confirmed preview submits the same command line rather
 * than calling the service behind the command's back.
 *
 * @module dsh-context-compaction-optimizer/host/compaction/manual
 */

/** Command name, without the leading slash. */
export const MANUAL_COMPACT_COMMAND = 'cco-compact';

/** What the command reports back to the shell. Mirrors `CommandResult`. */
export interface ManualCompactResult {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

/** The agent-preset roster slice this module needs. */
export interface AgentPresetLookup {
  serviceFor(agent: unknown, name: string): unknown;
}

/** The command registry slice this module needs. */
export interface CommandRegistryLike {
  register(definition: unknown): () => void;
}

/** One invocation, as the shell hands it to the handler. */
export interface CommandInvocationLike {
  readonly commandId: unknown;
  readonly agent: unknown;
  readonly signal: unknown;
}

/** Dependencies, all optional so a headless deployment degrades cleanly. */
export interface ManualCompactDeps {
  readonly agentPresets: AgentPresetLookup | undefined;
}

/**
 * Flatten an error and its `cause` chain into one line.
 *
 * The chain matters more here than usual. DSH classifies every manual-compaction
 * summary-stage failure as
 *
 *     ManualCompactionError('summary', 'manual compaction could not produce a
 *     smaller summary', { cause })
 *
 * — a catch-all whose text names a size check that does not exist in the
 * backend. The real reason (aborted stream, empty model output, routing failure)
 * lives only in `cause`, so reporting `message` alone tells the operator
 * something both false and unactionable. Measured: N030.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current === undefined || current === null) break;
    const text = current instanceof Error ? current.message : String(current);
    if (text.length > 0 && !parts.includes(text)) parts.push(text);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.length === 0 ? String(error) : parts.join(' ← ');
}

/**
 * Run one manual compaction against the invoking agent.
 *
 * Never throws: the shell logs `command/done` from what this returns, and a
 * rejected compaction is an operator-visible outcome rather than a crash.
 */
export async function runManualCompact(
  deps: ManualCompactDeps,
  invocation: CommandInvocationLike,
): Promise<ManualCompactResult> {
  if (deps.agentPresets === undefined) {
    return { kind: 'error', text: 'agent preset roster unavailable; cannot reach this session\'s compaction service' };
  }

  // Live data: only the shape is inspected. The instance is never serialized,
  // copied, or stored.
  let compaction: unknown;
  try {
    compaction = deps.agentPresets.serviceFor(invocation.agent, 'compaction');
  } catch (error) {
    return { kind: 'error', text: `could not resolve the compaction service: ${errorText(error)}` };
  }
  if (typeof compaction !== 'object' || compaction === null) {
    return { kind: 'error', text: 'this session\'s preset mounts no compaction service' };
  }

  const compactNow = (compaction as { compactNow?: unknown }).compactNow;
  if (typeof compactNow !== 'function') {
    return { kind: 'error', text: 'the compaction service exposes no compactNow()' };
  }

  try {
    // `commandId` is threaded through so the checkpoint is attributable to the
    // invocation the operator actually made — the shell logs `command/run`
    // against it.
    const result: unknown = await (compactNow as (...args: unknown[]) => Promise<unknown>).call(
      compaction,
      invocation.agent,
      invocation.signal,
      invocation.commandId,
    );
    // The result is live compaction data; only its absence is read.
    return result === null || result === undefined
      ? { kind: 'success', text: 'nothing to compact' }
      : { kind: 'success', text: 'compaction complete' };
  } catch (error) {
    return { kind: 'error', text: `compaction failed: ${errorText(error)}` };
  }
}

/** Build the command definition the registry accepts. */
export function buildCompactCommand(deps: ManualCompactDeps): unknown {
  return {
    name: MANUAL_COMPACT_COMMAND,
    description: 'Compact this session now, honouring the operator annotations currently marked invalid.',
    handler: (invocation: CommandInvocationLike) => runManualCompact(deps, invocation),
  };
}

/**
 * Register the command. The returned disposer is the registry's.
 *
 * A registry that is absent is not an error: the plugin's automatic behaviour
 * does not depend on it, so a deployment without `commands` simply has no
 * manual trigger.
 */
export function registerManualCompactCommand(
  commands: CommandRegistryLike | undefined,
  deps: ManualCompactDeps,
): () => void {
  if (commands === undefined) return () => {};
  return commands.register(buildCompactCommand(deps));
}
