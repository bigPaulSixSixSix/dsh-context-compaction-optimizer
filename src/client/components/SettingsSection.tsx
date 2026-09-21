/**
 * Settings page.
 *
 * Registered through `settings.section`, which gives a full content area rather
 * than a single preference row — the plugin has three related settings and each
 * needs a sentence of explanation, which `settings.general.item` could not hold.
 * M0 (`01开发日志.md` N001) established that only a **host-plane** plugin can
 * register a settings namespace, which is where the host half lives.
 *
 * All three preferences render as the harness's own `Switch`, matching the
 * Plugins settings cards, and the layout copies their numbers (a grid of rows,
 * 13px/1.5 label rows, 12px/1.5 tertiary hints). The unmarked policy started as
 * a `<select>`, but it is genuinely a binary choice — keep, or treat as invalid —
 * so a switch expresses it exactly and drops the one control on the page that
 * would have needed bespoke styling to look native.
 *
 * @module dsh-context-compaction-optimizer/client/components/SettingsSection
 */

import { Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import React from 'react';

import type { PluginSettings } from '../../shared/types.ts';
import { translator } from '../locale.ts';
import { CLASS, ensureStyles } from '../styles.ts';
import type { RpcClient } from '../rpc.ts';

/** Props injected by the slot registration. */
export interface SettingsSectionProps {
  readonly rpc: RpcClient;
  readonly t?: (key: string) => string;
}

/** Settings page for the compaction optimizer. */
export function SettingsSection(props: SettingsSectionProps): React.ReactElement {
  const { rpc, t } = props;
  const translate = translator(t);
  const [settings, setSettings] = React.useState<PluginSettings | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    ensureStyles();
  }, []);

  const reload = React.useCallback(async () => {
    try {
      const value = await rpc.call<{ settings: PluginSettings }>('settings.get');
      setSettings(value.settings);
      setError(false);
    } catch {
      setError(true);
    }
  }, [rpc]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const patch = React.useCallback(
    async (change: Partial<PluginSettings>) => {
      setPending(true);
      try {
        const value = await rpc.call<{ settings: PluginSettings }>('settings.update', { patch: change });
        setSettings(value.settings);
        setError(false);
      } catch {
        setError(true);
        await reload();
      } finally {
        setPending(false);
      }
    },
    [reload, rpc],
  );

  if (settings === null) {
    return React.createElement('div', { className: CLASS.hint }, translate('panel.loading'));
  }

  const toggleRow = (
    key: string,
    titleKey: string,
    hintKey: string,
    checked: boolean,
    onChange: (next: boolean) => void,
  ): React.ReactElement => {
    const label = translate(titleKey);
    const control =
      typeof Switch === 'function'
        ? React.createElement(Switch, {
            checked,
            label,
            disabled: pending,
            onChange,
          })
        : React.createElement('input', {
            type: 'checkbox',
            checked,
            'aria-label': label,
            disabled: pending,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.checked),
          });

    return React.createElement(
      'div',
      { key, className: CLASS.settingsRow },
      React.createElement(
        'div',
        { className: CLASS.toggleRow },
        React.createElement('span', { className: CLASS.toggleLabel }, label),
        control,
      ),
      React.createElement('p', { className: CLASS.hint }, translate(hintKey)),
    );
  };

  return React.createElement(
    'div',
    { className: CLASS.settings, 'data-cco-settings': 'ready' },
    toggleRow('inject', 'settings.inject.title', 'settings.inject.hint', settings.injectDigest, (next) =>
      void patch({ injectDigest: next }),
    ),
    toggleRow(
      'policy',
      'settings.policy.title',
      'settings.policy.hint',
      settings.unmarkedPolicy === 'invalid',
      (next) => void patch({ unmarkedPolicy: next ? 'invalid' : 'valid' }),
    ),
    // No format switch. `spans` is the shipped rendering and `anchors` is a
    // working fallback reachable through `settings.update`; exposing both as a
    // switch would ask the operator to choose between two internal renderings of
    // the same exclusion set, with nothing in the panel to decide on. See
    // DigestFormat for the measurements behind the default.
    toggleRow('observe', 'settings.observe.title', 'settings.observe.hint', settings.observeCache, (next) =>
      void patch({ observeCache: next }),
    ),
    error ? React.createElement('p', { className: CLASS.error }, translate('error.save')) : null,
  );
}

export default SettingsSection;
