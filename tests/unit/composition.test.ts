/**
 * Packaging contract.
 *
 * `bundle.test.ts` proves the two artifacts behave correctly once they are
 * loaded. This suite proves the *manifest* that gets them loaded actually
 * resolves: every path `package.json` promises, the patch row a profile merges,
 * and the module-table declarations the client relies on.
 *
 * It exists because this layer fails silently. A `types` path pointing at a file
 * the build never emits still installs, still runs, and only breaks the first
 * consumer whose tooling trusts the declaration — which is exactly the shape of
 * defect the last few rounds kept finding in other layers (N037's dropped
 * setting, N041's unrecorded format).
 *
 * @module tests/unit/composition
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const PKG_NAME = 'dsh-context-compaction-optimizer';

interface ExportsEntry {
  readonly types?: string;
  readonly default?: string;
}

interface Manifest {
  readonly name: string;
  readonly version?: string;
  readonly main?: string;
  readonly types?: string;
  readonly files?: readonly string[];
  readonly license?: string;
  readonly exports?: Record<string, ExportsEntry>;
  readonly dsh?: {
    readonly bundle?: { readonly patch?: string };
    readonly client?: { readonly platform?: string; readonly inject?: readonly string[] };
  };
  readonly peerDependencies?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
}

const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as Manifest;

async function exists(path: string): Promise<boolean> {
  try {
    await access(join(ROOT, path));
    return true;
  } catch {
    return false;
  }
}

test('the manifest names this package', () => {
  assert.equal(manifest.name, PKG_NAME);
});

/**
 * Every declared path must exist. `types` is the one that bit: `build.mjs`
 * emits JavaScript only, so the declaration pointed at a file that was never
 * produced.
 */
test('every path the manifest declares resolves', async () => {
  const declared: [string, string | undefined][] = [
    ['main', manifest.main],
    ['types', manifest.types],
  ];
  for (const [entry, path] of Object.entries(manifest.exports ?? {})) {
    declared.push([`exports["${entry}"].default`, path.default]);
    declared.push([`exports["${entry}"].types`, path.types]);
  }
  const missing: string[] = [];
  for (const [label, path] of declared) {
    if (path === undefined) continue;
    if (!(await exists(path))) missing.push(`${label} -> ${path}`);
  }
  assert.deepEqual(missing, [], 'the manifest promises files that do not exist');
});

test('the bundle patch is declared, present, and inserts exactly one row', async () => {
  const patch = manifest.dsh?.bundle?.patch;
  assert.equal(patch, './cordis.patch.yml');
  assert.ok(await exists(patch), 'the declared patch file must exist');

  const text = await readFile(join(ROOT, patch), 'utf8');
  const rows = text.split('\n').filter((line) => /^\s*-\s+id:\s*\S/.test(line));
  assert.equal(rows.length, 1, 'the patch must insert exactly one row');
  assert.match(rows[0] ?? '', /context-compaction-optimizer/);

  const names = text.split('\n').filter((line) => /^\s*name:\s*\S/.test(line));
  assert.equal(names.length, 1);
  assert.match(names[0] ?? '', new RegExp(PKG_NAME));
});

/**
 * The documented decision (N018): operator settings live in the
 * `context-compaction-optimizer` namespace of `settings.yaml`, registered
 * through `ctx.settings`. A `config:` block here would be a second, invisible
 * source of truth that the settings UI cannot see.
 */
test('the patch carries no config block, because settings live in ctx.settings', async () => {
  const text = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8');
  const body = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.ok(!/^\s*config:/m.test(body), 'settings must not also be declared as patch config');
});

test('the client half declares the web platform and its module-table dependencies', () => {
  const client = manifest.dsh?.client;
  assert.equal(client?.platform, 'web');
  const inject = client?.inject ?? [];
  assert.ok(inject.length > 0, 'the client injection list drives factory ordering');
  for (const spec of inject) {
    assert.match(spec, /^@deepseek-ai\/dsh-client-/, `unexpected client dependency ${spec}`);
  }
});

/**
 * `files` is the same promise as `types`, one layer up: it names what npm packs.
 * A missing entry is only a warning at pack time, so a package can ship without
 * its README and LICENSE and nobody notices until a consumer looks for them.
 */
test('every file the pack list names exists', async () => {
  const missing: string[] = [];
  for (const entry of manifest.files ?? []) {
    if (!(await exists(entry))) missing.push(entry);
  }
  assert.deepEqual(missing, [], 'the pack list names files that do not exist');
});

/**
 * The license is asserted in two places — the manifest field and the file npm
 * packs — and they must agree, because only the file is legally operative.
 */
test('the declared license has a matching file', async () => {
  assert.equal(manifest.license, 'Apache-2.0');
  assert.ok(await exists('LICENSE'), 'the manifest declares a license the package does not ship');
});

/**
 * `lib/` is gitignored, so nothing tracked guarantees a fresh build at publish
 * time. `prepublishOnly` is what closes that gap; without it a publish ships
 * whatever happens to be on disk.
 */
test('publishing rebuilds the artifacts it ships', () => {
  const scripts = (manifest as { scripts?: Record<string, string> }).scripts ?? {};
  assert.match(scripts['prepublishOnly'] ?? '', /build\.mjs/, 'a publish must rebuild lib/');
});

test('the manifest names the repository a consumer or a badge would link to', () => {
  const repository = (manifest as { repository?: { url?: string } }).repository;
  assert.match(repository?.url ?? '', /github\.com\/bigPaulSixSixSix\/dsh-context-compaction-optimizer/);
});
/**
 * `version` is not decoration: the bundle channel resolves the package by name,
 * and an unversioned or private publish silently fails at `npm publish` time
 * rather than here.
 */
test('the manifest is publishable', () => {
  assert.match(manifest.version ?? '', /^\d+\.\d+\.\d+/, 'a semver version is required');
  assert.ok((manifest as { private?: boolean }).private !== true, 'private packages cannot be published');
  assert.equal(manifest.name, PKG_NAME);
});

/**
 * The host half injects these; if one moves from `peerDependencies` to
 * `dependencies` the package starts shipping its own copy of a harness service,
 * which is how a plugin ends up with two registries.
 */
test('harness services stay peer dependencies, not bundled dependencies', () => {
  const bundled = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(bundled, ['zod'], 'only zod is safe to bundle; everything else is the harness');
  for (const spec of Object.keys(manifest.peerDependencies ?? {})) {
    assert.match(spec, /^(@deepseek-ai\/|zod$|@deepseek-ai\/schemastery$)/, `unexpected peer ${spec}`);
  }
});
