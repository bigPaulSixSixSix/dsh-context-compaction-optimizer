/**
 * Client entry point.
 *
 * Registers five contributions and owns the state they share:
 *
 *   locale dictionaries                  zh + en copy
 *   conversation.chat.assistant-actions  per-message invalid toggle
 *   conversation.session.header.actions  panel trigger
 *   shell.overlay                        the panel itself
 *   settings.section                     the settings page
 *
 * Slot choice follows the live slot tree and the M0 findings, not preference:
 * assistant messages have a per-message action slot; user messages have none;
 * the panel lives in the root-scoped overlay because it spans the whole surface.
 *
 * Dependencies reach components through `register({ inject })` rather than React
 * context, because contributions in different slots have no common ancestor to
 * provide one. Localisation reaches them through `locale: NS` at registration,
 * which is what makes the slot pass a `t`.
 *
 * @module dsh-context-compaction-optimizer/client
 */

import type { Context } from '@deepseek-ai/cordis';
import React from 'react';

import { AnnotationButtons } from './components/AnnotationButtons.tsx';
import { PanelOverlay, PanelTrigger } from './components/SessionPanel.tsx';
import { SettingsSection } from './components/SettingsSection.tsx';
import { NS, dictionaries } from './locale.ts';
import { createPanelState } from './panel-state.ts';
import { createRpcClient } from './rpc.ts';
import { AnnotationController } from './store.ts';
import { ensureStyles } from './styles.ts';

/** Plugin name, matching the host half and the package. */
export const name = 'dsh-context-compaction-optimizer';

/**
 * Client services this half consumes.
 *
 * This array — not `dsh.client.inject` in package.json — is the real Cordis
 * service injection; the manifest field is only an informational dependency
 * declaration used for factory ordering.
 */
export const inject = ['slots', 'locale'];

/** The slice of the client context this entry uses. */
interface ClientContext extends Context {
  readonly slots: {
    inject(key: string, callback: () => unknown): unknown;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
  readonly locale: {
    register(ns: string, dictionary: { zh: unknown; en: unknown }): () => void;
    /** Typed translator that reads the active locale at call time. */
    bind(ns: string): (key: string) => string;
  };
  effect(callback: () => unknown, label?: string): unknown;
}

/** Register every client contribution. */
export function apply(ctx: ClientContext): void {
  const rpc = createRpcClient();
  const controller = new AnnotationController(rpc);
  const panel = createPanelState();

  ensureStyles();

  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'context-compaction-optimizer: dictionaries');

  // The nav label lives outside any slot component, so it cannot use a slot's
  // `t`; `bind` gives it the same dictionary, resolved at call time.
  const bound: (key: string) => string =
    typeof ctx.locale.bind === 'function'
      ? ctx.locale.bind(NS)
      : (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key;

  // Mirror the host's unmarked policy so local counters match the server's.
  rpc
    .call<{ settings: { unmarkedPolicy: 'valid' | 'invalid' } }>('settings.get')
    .then((value) => controller.setPolicy(value.settings.unmarkedPolicy))
    .catch(() => {
      /* the panel surfaces load errors; a policy read failure is not fatal */
    });

  const { slots } = ctx;

  slots.inject('conversation.chat.assistant-actions', () =>
    slots.register(
      {
        name: 'conversation.chat.assistant-actions',
        id: 'cco-annotation',
        order: 20,
        locale: NS,
        inject: () => ({ controller }),
      },
      AnnotationButtons,
    ),
  );

  slots.inject('conversation.session.header.actions', () =>
    slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'cco-panel-trigger',
        order: 30,
        locale: NS,
        inject: () => ({ panel, controller }),
      },
      PanelTrigger,
    ),
  );

  slots.inject('shell.overlay', () =>
    slots.register(
      {
        name: 'shell.overlay',
        id: 'cco-panel',
        order: 40,
        locale: NS,
        // The panel owns the manual-compaction confirm, and the RPC client is the
        // only way to reach it; the trigger has no use for it, so it is injected
        // per registration rather than shared.
        inject: () => ({ panel, controller, rpc }),
      },
      PanelOverlay,
    ),
  );

  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'cco-settings',
        order: 60,
        /**
         * The nav label is a thunk, re-read on every projection, and
         * `locale.bind` reads the active locale at call time — so the tab
         * follows a language switch without re-registering. That pairing is the
         * documented contract for registrant-localized labels.
         */
        label: () => bound('settings.title'),
        locale: NS,
        inject: () => ({ rpc }),
      },
      SettingsSection,
    ),
  );
}

export default { name, inject, apply };

// Referenced so the bundler keeps React in the module graph even though this
// module only passes components through; the factory's `require('react')` is
// what the host's module table resolves.
void React;
