/**
 * Built-artifact tests.
 *
 * The client half is not like the rest of the plugin: it is not imported by
 * anything we control, it is *evaluated by the host's browser module loader*.
 * A bundle that is valid TypeScript, passes every unit test, and still has the
 * wrong envelope shape would fail only in a browser, at page load, with no
 * useful signal from this side.
 *
 * So these tests load `lib/client.js` the way the loader does — install a fake
 * `window.__ModuleLoader__`, evaluate the file, invoke the captured factory with
 * a recording `require` — and assert the contract:
 *
 *   1. the registration carries the package's own id;
 *   2. the factory returns `{ name, inject, apply }`;
 *   3. React is requested from the module table rather than bundled in.
 *
 * They are skipped when `lib/` has not been built, because the pure-logic suites
 * must stay runnable without a build step.
 *
 * @module tests/unit/bundle
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const CLIENT_BUNDLE = join(ROOT, 'lib/client.js');
const HOST_BUNDLE = join(ROOT, 'lib/index.js');
const PKG_NAME = 'dsh-context-compaction-optimizer';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const built = await exists(CLIENT_BUNDLE);
const skip = built ? false : 'lib/client.js not built — run `npm run build` first';

interface Registration {
  id: string;
  factory: (require: (spec: string) => unknown) => Record<string, unknown>;
}

/** Evaluate the bundle against a fake loader and return what it registered. */
async function loadClientBundle(requireImpl: (spec: string) => unknown): Promise<Registration> {
  const code = await readFile(CLIENT_BUNDLE, 'utf8');
  let captured: Registration | undefined;
  const window = {
    __ModuleLoader__: {
      load(registration: Registration) {
        captured = registration;
      },
    },
  };
  // eslint-disable-next-line no-new-func -- deliberately evaluating the built artifact
  const evaluate = new Function('window', 'require', code);
  evaluate(window, requireImpl);
  if (captured === undefined) throw new Error('bundle registered nothing with window.__ModuleLoader__');
  return captured;
}

test('the client bundle registers under the package id', { skip }, async () => {
  const registration = await loadClientBundle(() => ({}));
  assert.equal(registration.id, PKG_NAME);
  assert.equal(typeof registration.factory, 'function');
});

test('the client bundle exports the { name, inject, apply } contract', { skip }, async () => {
  const registration = await loadClientBundle(() => ({}));
  const exports = registration.factory(() => ({}));
  assert.equal(exports['name'], PKG_NAME);
  assert.deepEqual(exports['inject'], ['slots', 'locale']);
  assert.equal(typeof exports['apply'], 'function');
});

/**
 * The reason React must stay external: the host's module table holds the one
 * React instance every plugin shares. A bundled copy would produce a second
 * React and break hooks in ways that only appear at runtime.
 */
test('the client bundle requires react from the module table instead of bundling it', { skip }, async () => {
  const requested: string[] = [];
  const reactStub = {
    createElement: () => null,
    useSyncExternalStore: () => undefined,
    useState: () => [undefined, () => undefined],
    useEffect: () => undefined,
    useCallback: (fn: unknown) => fn,
  };
  const primitivesStub = {
    Tooltip: (props: { children?: unknown }) => props.children ?? null,
    IconCloseOutline16: () => null,
    IconContextInjectionOutline16: () => null,
  };
  const resolve = (spec: string): unknown => {
    requested.push(spec);
    if (spec === 'react') return reactStub;
    if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null };
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
    throw new Error(`bundle requested an unexpected external: ${spec}`);
  };

  const registration = await loadClientBundle(resolve);
  registration.factory(resolve);

  assert.ok(requested.includes('react'), `expected react to be required, saw ${requested.join(', ')}`);
  for (const spec of requested) {
    assert.ok(
      spec === 'react' || spec === 'react/jsx-runtime' || spec.startsWith('@deepseek-ai/dsh-client-'),
      `unexpected external requested: ${spec}`,
    );
  }
});

test('the client bundle is wrapped in the loader envelope', { skip }, async () => {
  const code = await readFile(CLIENT_BUNDLE, 'utf8');
  assert.match(code, /^window\.__ModuleLoader__\.load\(\{/);
  assert.match(code, /\bfactory: \(require\) => \{/);
  assert.match(code, /return module\.exports;/);
  assert.ok(code.trimEnd().endsWith('});'), 'the envelope must be closed');
  // A module that reached for `window` API beyond the loader would not survive
  // the fake environment above; assert it does not also ship a React copy.
  assert.ok(
    !/react\.development\.js|ReactDOM/.test(code),
    'the bundle must not contain a vendored React',
  );
});

test('the host bundle is importable and exports the plugin contract', { skip: !(await exists(HOST_BUNDLE)) ? 'lib/index.js not built' : false }, async () => {
  // A Windows absolute path is not a valid ESM specifier; the loader needs a URL.
  const module = (await import(pathToFileURL(HOST_BUNDLE).href)) as Record<string, unknown>;
  assert.equal(module['name'], PKG_NAME);
  assert.deepEqual(module['inject'], ['storageDomain', 'settings']);
  assert.equal(typeof module['apply'], 'function');
  assert.equal(typeof module['default'], 'object');
});
