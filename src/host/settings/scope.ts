/**
 * Settings namespace registration.
 *
 * The plugin's operator-visible preferences live in `ctx.settings`, not in the
 * bundle patch's `config:`. That is the DSH-native channel: a namespace
 * registered here shows up in **Settings → Plugins**, is persisted to
 * `$DSH_HOME/settings.yaml`, is hot-reloaded from an external edit, and is
 * editable while the plugin runs. A patch-layer `config:` would be a second
 * source of truth that the settings UI could not see.
 *
 * Schema library note: settings take a **schemastery** schema (the descriptor
 * serializes it with `toJSON()`), while the storage domain takes **zod**. Both
 * libraries are in play in this plugin for that reason alone.
 *
 * Namespace rule: lowercase-hyphenated, matching the package name.
 *
 * @module dsh-context-compaction-optimizer/host/settings/scope
 */

import z from '@deepseek-ai/schemastery';

import type { PluginSettings, UnmarkedPolicy } from '../../shared/types.ts';

/** Registered settings namespace. */
export const SETTINGS_NAMESPACE = 'context-compaction-optimizer';

/**
 * Operator-visible preferences.
 *
 * Defaults are stated in the schema so an absent `settings.yaml` section
 * resolves to them. `unmarkedPolicy` defaults to `valid` for the safe posture:
 * an unconfigured install never drops content the operator did not explicitly
 * mark.
 */
export const settingsSchema = z.object({
  unmarkedPolicy: z.union(['valid', 'invalid']).default('valid'),
  injectDigest: z.boolean().default(true),
  digestFormat: z.union(['anchors', 'spans']).default('spans'),
  observeCache: z.boolean().default(false),
});

/** The scope handle `ctx.settings.register` returns. */
export interface SettingsScopeLike {
  get(): PluginSettings;
  watch(callback: (next: PluginSettings, prev: PluginSettings) => void | Promise<void>): () => void;
  update(patch: object): Promise<void>;
}

/** The slice of `ctx.settings` this module needs. */
export interface SettingsProviderLike {
  register(
    ns: string,
    schema: unknown,
    options?: { base?: Partial<PluginSettings>; applies?: 'live' | 'restart' },
  ): SettingsScopeLike;
}

/** Live view of the plugin's settings. */
export interface SettingsHandle {
  /** Current resolved value. */
  get(): PluginSettings;
  /** Merge a partial patch into the user layer. */
  update(patch: Partial<PluginSettings>): Promise<void>;
  /** Stop observing changes. */
  dispose(): void;
}

function normalize(value: PluginSettings): PluginSettings {
  const policy: UnmarkedPolicy = value.unmarkedPolicy === 'invalid' ? 'invalid' : 'valid';
  return {
    unmarkedPolicy: policy,
    injectDigest: value.injectDigest !== false,
    // Must be carried through explicitly: this object IS what `get()` returns,
    // so a field omitted here is a field the rest of the host never sees. Its
    // absence is silent — the digest renderer's own default would mask it — so
    // `settings.test.ts` pins every key. The fallback matches the schema default
    // rather than the legacy format, so an unexpected value degrades to what a
    // fresh install would use.
    digestFormat: value.digestFormat === 'anchors' ? 'anchors' : 'spans',
    observeCache: value.observeCache === true,
  };
}

/**
 * Register the namespace and return a live handle.
 *
 * `onChange` fires for every committed change, including edits made to
 * `settings.yaml` outside the app, so the annotation service's cached policy
 * cannot drift from what the operator sees.
 */
export function registerSettings(
  provider: SettingsProviderLike,
  onChange?: (next: PluginSettings, prev: PluginSettings) => void,
): SettingsHandle {
  const scope = provider.register(SETTINGS_NAMESPACE, settingsSchema, { applies: 'live' });

  let current = normalize(scope.get());

  const stop = scope.watch((next) => {
    const previous = current;
    current = normalize(next);
    onChange?.(current, previous);
  });

  return {
    get: () => current,
    async update(patch) {
      await scope.update(patch as object);
      // `watch` is asynchronous by contract, so refresh synchronously as well:
      // a caller that writes then reads must not observe its own stale value.
      current = normalize(scope.get());
      onChange?.(current, current);
    },
    dispose: () => {
      stop();
    },
  };
}
