/**
 * Mount diagnostics (development aid, NOT shipped).
 *
 * The real host entry was added to the profile patch but the composition did
 * not change — the previous rows stayed live, which is what the loader does
 * when a new row fails and it rolls back. That failure is invisible from
 * outside, so this probe reproduces it in isolation: it imports the real entry
 * module itself and reports the exact error, inside a row that is simple enough
 * to mount unconditionally.
 *
 * Readout: GET /ccodiag
 */

const ENTRY_URL =
  'file:///D:/Coding/projects/dsh-context-compaction-optimizer/src/host/index.ts';

const state = {
  probe: 'cco-diag',
  mountedAt: new Date().toISOString(),
  entryImport: { attempted: false },
  loaderEntries: [],
  loadersError: null,
  services: {},
};

function errText(error) {
  if (error === null || error === undefined) return 'nullish';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function probeEntry() {
  state.entryImport = { attempted: true };
  try {
    const mod = await import(ENTRY_URL);
    state.entryImport.ok = true;
    state.entryImport.keys = Object.keys(mod);
    state.entryImport.name = mod.name ?? null;
    state.entryImport.inject = mod.inject ?? null;
    state.entryImport.applyType = typeof mod.apply;
    state.entryImport.defaultType = typeof mod.default;
  } catch (error) {
    state.entryImport.ok = false;
    state.entryImport.error = errText(error);
    state.entryImport.stack = error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 12) : [];
    // Surface the cause chain: a bare "cannot import" hides the real reason.
    const causes = [];
    let cursor = error instanceof Error ? error.cause : undefined;
    for (let i = 0; i < 5 && cursor !== undefined; i += 1) {
      causes.push(errText(cursor));
      cursor = cursor instanceof Error ? cursor.cause : undefined;
    }
    state.entryImport.causes = causes;
  }
}

function probeLoader(ctx) {
  try {
    const loader = ctx.get('loader');
    if (loader === undefined) {
      state.loadersError = 'loader service unavailable';
      return;
    }
    const entries = [...loader.entries()];
    state.loaderEntries = entries.map((entry) => {
      const options = entry.options ?? {};
      return {
        id: options.id ?? null,
        name: options.name ?? null,
        disabled: options.disabled === true,
        state: entry.state ?? entry.fiber?.state ?? null,
        error: entry.error === undefined ? null : errText(entry.error),
      };
    });
  } catch (error) {
    state.loadersError = errText(error);
  }
}

export const name = 'cco-diag';

export function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (webServer !== undefined) {
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: '/ccodiag',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(state, null, 2));
        },
      }),
    );
  }
  probeLoader(ctx);
  probeEntry().catch((error) => {
    state.entryImport.ok = false;
    state.entryImport.error = errText(error);
  });
  console.log('[cco-diag] mounted');
}

export default { name, apply };
