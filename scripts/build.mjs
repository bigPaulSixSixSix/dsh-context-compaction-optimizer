/**
 * Build script.
 *
 * Produces the two artifacts the bundle channel requires:
 *
 *   lib/index.js   host half  — ESM, with every `@deepseek-ai/*` package and
 *                              `zod` left external so the plugin resolves the
 *                              harness's own instances instead of shipping
 *                              duplicate copies.
 *   lib/client.js  client half — one CommonJS bundle wrapped in the browser
 *                              module envelope.
 *
 * Why a hand-written wrapper instead of a bundler preset: the envelope is a
 * *contract* with the host, not an implementation detail. The reference
 * bundles (`dshmarket`, `dsh-better-sidebar`) are wrapped as
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => { … } })
 *
 * with the bundle body declaring its own `module`/`exports` and returning
 * `module.exports`. Writing that explicitly means a bundler upgrade cannot
 * silently change the shape the host depends on.
 *
 * Why esbuild rather than the tsdown the reference plugins use: esbuild needs no
 * install scripts on this platform, and the wrapper above already does the part
 * tsdown's preset was providing. Migrating later is a build-only change.
 *
 * Usage: `node scripts/build.mjs`
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_NAME = 'dsh-context-compaction-optimizer';

/** Left external on the host: the harness provides these. */
const HOST_EXTERNAL = ['@deepseek-ai/*', 'zod'];

/**
 * Left external on the client: resolved from the browser module table the host
 * publishes. Anything else would be bundled, which is how a plugin ends up
 * shipping a second copy of React.
 */
const CLIENT_EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-*'];

async function buildHost() {
  const outfile = join(ROOT, 'lib/index.js');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/host/index.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: HOST_EXTERNAL,
    sourcemap: true,
    logLevel: 'warning',
  });
  return outfile;
}

async function buildClient() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/client/index.tsx'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    jsx: 'transform',
    external: CLIENT_EXTERNAL,
    sourcemap: false,
    logLevel: 'warning',
    // The client stylesheet is authored as CSS and inlined as text, so it is
    // never at the mercy of a JS literal's escaping rules.
    loader: { '.css': 'text' },
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error('build-client: esbuild produced no output');

  const outfile = join(ROOT, 'lib/client.js');
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(
    outfile,
    [
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(PKG_NAME)},`,
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
      '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
      output.text,
      '\t\treturn module.exports;',
      '\t}',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return outfile;
}

const host = await buildHost();
const client = await buildClient();
console.log(`built ${host.replace(ROOT, '.')}`);
console.log(`built ${client.replace(ROOT, '.')}`);
