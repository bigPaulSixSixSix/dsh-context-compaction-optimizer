/**
 * Host entry point.
 *
 * Assembles the three halves of the plugin's host side: durable annotations
 * (M1), the compaction interceptor (M3), and the operator surface — settings
 * plus the client RPC route (M2).
 *
 * Placement (established by N005/N015): this mounts as a **profile-level** row.
 * From there a plugin receives `llm/stream` for live agent sessions and can
 * reach `storageDomain`, `settings` and `webServer`. It can NOT reach
 * `ctx.compaction`, which lives inside the agent preset's isolate realm — which
 * is precisely why injection happens on the `llm/stream` waterfall rather than
 * by subclassing the compaction engine.
 *
 * **Manual compaction (M5) is the one thing that needs the service**, and N028
 * measured the escape hatch: `ctx.get('compaction')` is `undefined` here, but
 * `agentPresets.serviceFor(agent, 'compaction')` resolves the agent's own
 * isolated instance at call time. That is what keeps this a single host-plane
 * row — no preset row for an operator to add, and no realm of our own.
 *
 * @module dsh-context-compaction-optimizer/host
 */

import { AnnotationService } from './annotations/service.ts';
import { installCompactionPipeline } from './compaction/install.ts';
import { MANUAL_COMPACT_COMMAND, registerManualCompactCommand } from './compaction/manual.ts';
import { CompactionObserver } from './compaction/observe.ts';
import { registerRpcRoutes } from './rpc/routes.ts';
import { listTurns } from './session/surface.ts';
import { registerSettings } from './settings/scope.ts';

/** Plugin name, matching the package and the patch row. */
export const name = 'dsh-context-compaction-optimizer';

/**
 * Hard dependencies.
 *
 * Both are core rather than optional: without `storageDomain` an annotation
 * cannot be persisted, and without `settings` the operator cannot configure the
 * unmarked policy. Waiting for them is correct — mounting into a degraded state
 * would silently accept writes it cannot keep. `webServer` is deliberately NOT
 * injected: a headless profile has no browser route, and the interception must
 * still work there.
 */
export const inject = ['storageDomain', 'settings'];

/** Minimum context surface this entry uses. */
interface HostContext {
  readonly settings: Parameters<typeof registerSettings>[0];
  get(name: string): any;
  on(name: string, listener: (...args: never[]) => unknown): unknown;
  effect(callback: () => unknown, label?: string): unknown;
  logger?: { info?(message: string): void; warn?(message: string): void };
}

/** Wire the plugin into a Cordis context. */
export function apply(ctx: HostContext): void {
  const observer = new CompactionObserver();
  const annotations = new AnnotationService(ctx as never);

  // Settings own the unmarked policy; the service caches it so the synchronous
  // digest path never has to await anything.
  const settings = registerSettings(ctx.settings, (next) => {
    annotations.setUnmarkedPolicy(next.unmarkedPolicy);
  });
  annotations.setUnmarkedPolicy(settings.get().unmarkedPolicy);

  ctx.effect(() => () => {
    settings.dispose();
    void annotations.dispose();
  }, 'cco:dispose');

  annotations.hydrate().catch((error: unknown) => {
    ctx.logger?.warn?.(
      `context-compaction-optimizer: could not load stored annotations: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  installCompactionPipeline(ctx as never, {
    annotations,
    enabled: () => settings.get().injectDigest,
    format: () => settings.get().digestFormat,
    observer,
  });

  // Manual compaction. Registered before the web-server branch on purpose: a
  // headless profile has no panel, but `/cco-compact` is still usable from the
  // shell. All three services are optional — automatic interception must keep
  // working in a deployment that has none of them.
  const commands = ctx.get('commands');
  const agentPresets = ctx.get('agentPresets');
  const agents = ctx.get('agents');

  ctx.effect(() => registerManualCompactCommand(commands, { agentPresets }), 'cco:compact-command');

  const sessions = ctx.get('sessions');
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    ctx.logger?.info?.('context-compaction-optimizer: no web server; interception active, UI route absent');
    return;
  }

  ctx.effect(
    () =>
      registerRpcRoutes(webServer, {
        annotations,
        settings,
        observer,
        turns: (sessionId: string) => {
          const session = sessions?.get?.(sessionId);
          return session === undefined ? null : listTurns(session);
        },
        sessions: () => {
          const list = sessions?.list?.() ?? [];
          return list.map((session: { id?: unknown }) => ({ id: String(session.id) }));
        },
        // Absent when there is no command registry: the panel then reports the
        // capability as unavailable instead of offering a button that cannot work.
        compaction:
          commands === undefined
            ? undefined
            : {
                /**
                 * Submit the command line the operator's confirmation stands for.
                 *
                 * Deliberately goes through the registry rather than calling the
                 * compaction service here: one path means the panel and a typed
                 * `/cco-compact` cannot drift apart, and the shell logs the run.
                 */
                async trigger(sessionId: string) {
                  const agent = agents?.get?.(sessionId);
                  if (agent === undefined) {
                    return { kind: 'error' as const, text: `no live agent for session ${sessionId}` };
                  }
                  try {
                    const execution = await commands.execute(
                      agent,
                      `/${MANUAL_COMPACT_COMMAND}`,
                      [],
                      new AbortController().signal,
                    );
                    if (execution === undefined) {
                      return { kind: 'error' as const, text: `/${MANUAL_COMPACT_COMMAND} did not resolve` };
                    }
                    const result = execution.result;
                    // Only these two scalar fields are read; the execution and its
                    // id stay inside the host.
                    return result.kind === 'success'
                      ? { kind: 'success' as const, text: result.text ?? 'compaction complete' }
                      : { kind: 'error' as const, text: result.text };
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { kind: 'error' as const, text: `could not run /${MANUAL_COMPACT_COMMAND}: ${message}` };
                  }
                },
              },
      }),
    'cco:rpc',
  );

  ctx.logger?.info?.('context-compaction-optimizer: host side active');
}

export default { name, inject, apply };
