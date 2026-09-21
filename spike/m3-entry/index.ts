/**
 * M3 end-to-end harness (development aid, NOT a shipped entry point).
 *
 * Mounts the *real* M3 code — `AnnotationService`, `installCompactionPipeline`,
 * `CompactionObserver` — into a live profile through the patch path that N015
 * proved works, so the injection can be exercised against a genuine `/compact`
 * instead of a synthetic message list.
 *
 * This exists because every M0 validation went through a *dynamic* Cordis
 * plugin whose listener body was a hand-written script. The shipped code has a
 * different shape (services, a core layer, real message construction), and the
 * only way to know it behaves the same is to run it.
 *
 * Routes (GET, query-parameter only — adequate for a harness, and it avoids
 * hand-rolling request-body parsing):
 *   GET /ccom3                    → observer snapshot + service state
 *   GET /ccom3/annotate?...       → set one annotation
 *   GET /ccom3/surface?sessionId= → current surface with durable message ids
 *
 * Removal: the row in `~/.dsh/profiles/web/cordis.patch.yml` and this directory
 * are both throwaway; see `01开发日志.md` N015/N016.
 */

import { AnnotationService } from '../../src/host/annotations/service.ts';
import { CompactionObserver, readCompactionSummary } from '../../src/host/compaction/observe.ts';
import { installCompactionPipeline } from '../../src/host/compaction/install.ts';
import { messageText } from '../../src/host/compaction/text.ts';

const MARKERS = ['CCO_SPIKE_MARK', 'axolotl', 'ZQ7', '美西螈', '雨衣', '咖啡机'];

const state: Record<string, unknown> = {
  harness: 'cco-m3',
  mountedAt: new Date().toISOString(),
  ready: false,
  errors: [],
  summaries: [],
  lastSummaryHead: '',
};

function errText(error: unknown): string {
  if (error === null || error === undefined) return 'nullish';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function leakScan(text: string): string[] {
  const hits: string[] = [];
  for (const marker of MARKERS) if (text.includes(marker)) hits.push(marker);
  return hits;
}

function summaryTextOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const summary = (data as Record<string, unknown>)['summary'];
  if (!Array.isArray(summary)) return '';
  let out = '';
  for (const block of summary) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string') out += record['text'];
  }
  return out;
}

/** Live surface projection: durable message ids plus a text preview. */
function surfaceOf(session: unknown): unknown[] {
  const model = session as { surface?: { nodes?: unknown }; eventAt?: (seq: unknown) => unknown };
  const nodes = model.surface?.nodes;
  if (!Array.isArray(nodes) || typeof model.eventAt !== 'function') return [];
  const out: unknown[] = [];
  for (const seq of nodes) {
    const event = model.eventAt(seq) as Record<string, unknown> | undefined;
    if (event === undefined || event === null) continue;
    const type = event['type'];
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const data = event['data'] as Record<string, unknown> | undefined;
    const message = type === 'user/message' ? data : (data?.['message'] as Record<string, unknown>);
    out.push({
      seq,
      type,
      role: (message?.['role'] as string | undefined) ?? 'unknown',
      id: (message?.['id'] as string | undefined) ?? null,
      head: messageText(message).slice(0, 140),
    });
  }
  return out;
}

export const name = 'cco-m3-harness';

export const inject = ['timer'];

export function apply(ctx: any): void {
  const errors = state['errors'] as string[];
  const observer = new CompactionObserver();
  const annotations = new AnnotationService(ctx);
  const enabled = { value: true };

  annotations.hydrate().catch((error: unknown) => errors.push('hydrate: ' + errText(error)));

  installCompactionPipeline(ctx, {
    annotations,
    enabled: () => enabled.value,
    observer,
  });

  // Harness-only: keep the generated summary text so leakage is observable.
  ctx.on('session/event', (_session: unknown, event: unknown) => {
    try {
      const record = readCompactionSummary(event);
      if (record === null) return;
      const data = (event as Record<string, unknown>)['data'];
      const text = summaryTextOf(data);
      (state['summaries'] as unknown[]).push({
        ...record,
        leakedMarkers: leakScan(text),
      });
      state['lastSummaryHead'] = text.slice(0, 800);
    } catch (error) {
      errors.push('summary scan: ' + errText(error));
    }
  });

  ctx.on('session/created', () => {
    state['sessionCount'] = (ctx.get('sessions')?.list?.() ?? []).length;
  });

  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    errors.push('webServer unavailable');
    return;
  }

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/ccom3',
      handler: async (req: { url?: string }, res: any) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const reply = (payload: unknown): void => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload, null, 2));
        };
        try {
          if (url.pathname === '/ccom3/surface') {
            const sessionId = url.searchParams.get('sessionId') ?? '';
            const session = ctx.get('sessions')?.get?.(sessionId);
            reply({ sessionId, found: session !== undefined, messages: session === undefined ? [] : surfaceOf(session) });
            return;
          }
          if (url.pathname === '/ccom3/annotate') {
            const sessionId = url.searchParams.get('sessionId') ?? '';
            const messageId = url.searchParams.get('messageId') ?? '';
            const status = url.searchParams.get('status') ?? 'invalid';
            const result = await annotations.set(sessionId, messageId, status as 'valid' | 'invalid' | 'unmarked');
            reply({ ok: true, applied: result.applied, records: result.records.length });
            return;
          }
          if (url.pathname === '/ccom3/toggle') {
            enabled.value = url.searchParams.get('on') !== 'false';
            reply({ ok: true, enabled: enabled.value });
            return;
          }
          if (url.pathname === '/ccom3/clear') {
            const sessionId = url.searchParams.get('sessionId') ?? '';
            reply({ ok: true, cleared: await annotations.clear(sessionId) });
            return;
          }
          const sessions = (ctx.get('sessions')?.list?.() ?? []) as { id?: unknown }[];
          reply({
            ...state,
            ready: true,
            enabled: enabled.value,
            sessionIds: sessions.map((session) => String(session.id)),
            observer: observer.snapshot(),
          });
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('harness error: ' + errText(error));
        }
      },
    }),
  );

  state['ready'] = true;
  console.log('[cco-m3-harness] mounted; readout at /ccom3');
}

export default { name, inject, apply };
