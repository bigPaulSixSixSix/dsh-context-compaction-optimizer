import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerSettings, settingsSchema } from '../../src/host/settings/scope.ts';
import { DEFAULT_SETTINGS, type PluginSettings } from '../../src/shared/types.ts';

/** Resolve a raw stored section through the real schemastery schema. */
function resolve(section: Record<string, unknown>): PluginSettings {
  const schema = settingsSchema as unknown as (value: unknown) => PluginSettings;
  return schema(section);
}

/**
 * A settings provider double: it owns the stored section and resolves it through
 * the schema, which is exactly the division of labour the real provider has.
 * `normalize()` is what the plugin adds on top, and what these tests are about.
 */
function provider(initial: Record<string, unknown> = {}) {
  let stored: Record<string, unknown> = { ...initial };
  const watchers = new Set<(next: PluginSettings, prev: PluginSettings) => void>();
  const handle = {
    seed(section: Record<string, unknown>) {
      stored = { ...section };
    },
    register() {
      return {
        get: () => resolve(stored),
        watch(callback: (next: PluginSettings, prev: PluginSettings) => void) {
          watchers.add(callback);
          return () => watchers.delete(callback);
        },
        async update(patch: object) {
          stored = { ...stored, ...(patch as Record<string, unknown>) };
          const next = resolve(stored);
          for (const watcher of watchers) watcher(next, next);
        },
      };
    },
  };
  return handle as never as Parameters<typeof registerSettings>[0] & { seed(section: Record<string, unknown>): void };
}

/**
 * `normalize()` builds the object `get()` hands to the rest of the host, so a
 * field missing there is a field nothing can read. Adding `digestFormat` to the
 * schema and the settings UI but not to `normalize` left the toggle inert with
 * no error anywhere — this pins every key instead.
 */
test('every declared setting survives normalization', () => {
  const handle = registerSettings(provider());

  assert.deepEqual(Object.keys(handle.get()).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});

test('defaults resolve for an absent section', () => {
  const handle = registerSettings(provider());

  assert.deepEqual(handle.get(), DEFAULT_SETTINGS);
});

test('the schema itself defaults the digest format to the shipped rendering', () => {
  assert.equal(resolve({}).digestFormat, 'spans');
});

test('a stored digestFormat is carried through, including the anchors fallback', () => {
  const spans = registerSettings(provider({ digestFormat: 'spans' }));
  assert.equal(spans.get().digestFormat, 'spans');

  // The legacy rendering stays reachable through settings even though the panel
  // no longer offers a switch: it is a working fallback, not dead code.
  const anchors = registerSettings(provider({ digestFormat: 'anchors' }));
  assert.equal(anchors.get().digestFormat, 'anchors');

  // Fail closed rather than coerce: an unrecognized value must never silently
  // pick a rendering, and the schema refusing it is what makes `normalize`'s
  // narrowing a belt rather than the only braces.
  assert.throws(() => resolve({ digestFormat: 'nonsense' }));
});

test('an update is visible synchronously to a caller that writes then reads', async () => {
  const handle = registerSettings(provider());

  await handle.update({ digestFormat: 'spans' });

  assert.equal(handle.get().digestFormat, 'spans');
});
