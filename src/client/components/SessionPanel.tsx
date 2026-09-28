/**
 * Session annotation panel: the primary operator entry point.
 *
 * M0 established that user messages have **no** official action slot, and that
 * the assistant action row renders only for a turn's closing message and is
 * hover-revealed on older turns (`01开发日志.md` N001). Neither is something a
 * plugin can fix by choosing a different slot. So the dependable surface is a
 * session-level trigger plus an overlay listing the current surface.
 *
 * The trigger and the panel are registered into different slots and therefore
 * cannot share React state; {@link PanelState} carries the open flag and the
 * session id between them.
 *
 * The trigger is an icon button so it matches the other entries in the session
 * header row, and it carries a count because "how many have I marked" is the one
 * thing worth reading at a glance.
 *
 * **One row per turn (N035).** An earlier build listed every surface message and
 * put a toggle on each. Measured against a real session — 741 surface messages
 * against 18 prompts, one turn holding 12 — that asks the operator for a dozen
 * clicks to express one judgement, and the intermediate steps it exposes are
 * precisely the noise worth excluding. Each row therefore summarizes one
 * exchange and toggles it whole, while the step list stays available (read-only)
 * so the operator can still see exactly what they are excluding.
 *
 * **One surface, not two (M5).** Manual compaction adds a preview and a confirm
 * step, and the obvious build is a second dialog. That was rejected: two
 * near-identical lists make "which one actually takes effect" a question the
 * operator has to answer, which is the same class of confusion the panel exists
 * to remove. So the list grew a forecast line and a confirm footer — what the
 * operator annotates *is* what gets confirmed.
 *
 * The forecast line is deliberate placement, not decoration. It states the
 * consequence in the operator's terms above the list, before anything happens,
 * and carries the one caveat that makes it true: DSH summarizes only the earlier
 * part of the conversation and retains the recent tail verbatim, so a mark on
 * that tail cannot take effect (measured in N030: 6 marks, 5 exclusions).
 *
 * @module dsh-context-compaction-optimizer/client/components/SessionPanel
 */

import { IconCloseOutline16, IconContextInjectionOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import React from 'react';

import type { SurfaceMessage, SurfaceTurn } from '../../shared/types.ts';
import { translator, type Translate } from '../locale.ts';
import type { PanelState } from '../panel-state.ts';
import type { RpcClient } from '../rpc.ts';
import { CLASS, ensureStyles } from '../styles.ts';
import type { AnnotationController, AnnotationView } from '../store.ts';

/** Props the slot owner supplies to the header trigger. */
export interface PanelTriggerProps {
  readonly sessionId: string;
  readonly panel: PanelState;
  readonly controller: AnnotationController;
  readonly t?: (key: string) => string;
}

/** Ring glyph, mirroring the inline control so one shape means one thing. */
function RingGlyph(): React.ReactElement {
  return React.createElement(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true },
    React.createElement('circle', { cx: 8, cy: 8, r: 5.75, stroke: 'currentColor', strokeWidth: 1.5 }),
  );
}

function withTooltip(label: string, children: React.ReactElement): React.ReactElement {
  if (typeof Tooltip !== 'function') return children;
  return React.createElement(Tooltip, { label, side: 'bottom' }, children);
}

function kindOf(message: SurfaceMessage): string {
  return message.eventType.replace('/message', '').replace('/result', '');
}

/** Session-header icon button that opens the panel. */
export function PanelTrigger(props: PanelTriggerProps): React.ReactElement {
  const { sessionId, panel, controller, t } = props;

  React.useEffect(() => {
    ensureStyles();
  }, []);

  const view = React.useSyncExternalStore(controller.subscribe, () => controller.view(sessionId));
  const panelState = React.useSyncExternalStore(panel.subscribe, panel.snapshot);
  const translate = translator(t);
  const label = translate('panel.trigger');

  React.useEffect(() => {
    // `idle` only. The controller retries a transient failure on its own, so
    // re-issuing a load for every terminal phase would restart that schedule
    // forever; an explicit reload is what the toolbar button is for.
    if (view.phase === 'idle') void controller.load(sessionId);
  }, [controller, sessionId, view.phase]);

  const count = view.stats.invalid;

  return withTooltip(
    label,
    React.createElement(
      'button',
      {
        type: 'button',
        className: CLASS.trigger,
        'aria-label': label,
        'aria-haspopup': 'dialog',
        'aria-expanded': panelState.open && panelState.sessionId === sessionId,
        'data-cco-trigger': count,
        'data-state': count > 0 ? 'invalid' : 'unmarked',
        onClick: () => panel.toggle(sessionId),
      },
      React.createElement(IconContextInjectionOutline16, {}),
      // Flows beside the glyph with the surrounding header text's own font, so
      // the icon keeps its size and the button widens instead.
      count > 0 ? React.createElement('span', { className: CLASS.count }, String(count)) : null,
    ),
  );
}

/** Props for the overlay panel. */
export interface PanelOverlayProps {
  readonly panel: PanelState;
  readonly controller: AnnotationController;
  readonly rpc: RpcClient;
  readonly t?: (key: string) => string;
}

/** What `compaction.trigger` reports back. */
interface TriggerResult {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

/** The operator's prompt, when the turn opens with one. */
function promptOf(turn: SurfaceTurn): SurfaceMessage | null {
  const first = turn.messages[0];
  return first !== undefined && first.eventType === 'user/message' ? first : null;
}

/** The turn's last assistant message: what the exchange concluded with. */
function closingOf(turn: SurfaceTurn): SurfaceMessage | null {
  for (let index = turn.messages.length - 1; index >= 0; index -= 1) {
    const message = turn.messages[index] as SurfaceMessage;
    if (message.eventType === 'assistant/message') return message;
  }
  return null;
}

/** One line summarizing a turn, from its prompt through to its conclusion. */
function turnPreview(turn: SurfaceTurn, translate: Translate): string {
  const prompt = promptOf(turn);
  const closing = closingOf(turn);
  const head = (message: SurfaceMessage): string =>
    message.head.length === 0 ? `(${translate('panel.noText')})` : message.head;
  if (prompt !== null && closing !== null) return `${head(prompt)} → ${head(closing)}`;
  if (prompt !== null) return head(prompt);
  if (closing !== null) return head(closing);
  const first = turn.messages[0];
  return first === undefined ? '' : head(first);
}

/** One line of muted explanation inside the panel body. */
function hintLine(text: string, detail?: string | null): React.ReactElement {
  const children: (string | React.ReactElement)[] = [text];
  if (detail !== undefined && detail !== null && detail.length > 0) {
    children.push(React.createElement('div', { style: { marginTop: '4px' } }, detail));
  }
  return React.createElement(
    'div',
    { className: CLASS.hint, style: { padding: '12px 16px' } },
    ...children,
  );
}

/**
 * The panel body: the rows, or the one honest reason there are none (N048).
 *
 * "No annotatable turns" and "the surface could not be read" both leave `rows`
 * empty, and showing the first for the second is simply false — it was the
 * reason a dead button had no explanation anywhere in the UI. Each phase now
 * says what it is, and a terminal failure carries the host's own message.
 */
function panelBody(
  view: AnnotationView,
  rows: React.ReactElement[],
  translate: Translate,
): React.ReactNode {
  if (view.phase === 'ready') {
    const body = rows.length === 0 ? [hintLine(translate('panel.empty'))] : rows;
    // A `ready` view carrying an error can only be a failed write: every
    // successful read clears it, and `setStatus` re-reads before recording the
    // failure. Until now that error had nowhere to appear — the same silence
    // that hid the surface failures.
    if (view.error === null) return body;
    return [hintLine(translate('error.save'), view.error), ...body];
  }
  if (view.phase === 'session-not-loaded') {
    return hintLine(translate('panel.sessionNotLoaded'), view.error);
  }
  if (view.phase === 'failed') {
    return hintLine(translate('error.load'), view.error);
  }
  return hintLine(translate('panel.loading'));
}

function summaryLine(view: AnnotationView, translate: Translate): string {
  const { total, invalid, valid, unmarked } = view.stats;
  const parts = [`${translate('panel.turns')} ${total}`, `${translate('stat.invalid')} ${invalid}`];
  if (valid > 0) parts.push(`${translate('stat.valid')} ${valid}`);
  if (unmarked > 0) parts.push(`${translate('stat.unmarked')} ${unmarked}`);
  return parts.join(' · ');
}

/** Turn list, forecast, and the manual-compaction confirm. */
export function PanelOverlay(props: PanelOverlayProps): React.ReactElement | null {
  const { panel, controller, rpc, t } = props;
  const translate = translator(t);
  const state = React.useSyncExternalStore(panel.subscribe, panel.snapshot);
  const sessionId = state.sessionId;

  const view = React.useSyncExternalStore(controller.subscribe, () =>
    sessionId === null ? controller.view('') : controller.view(sessionId),
  );

  const [expanded, setExpanded] = React.useState<readonly string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<TriggerResult | null>(null);

  React.useEffect(() => {
    ensureStyles();
  }, []);

  React.useEffect(() => {
    // Expansion and any previous outcome are scoped to one viewing of one
    // session: carrying them across a switch would report a result for a session
    // it never described.
    setExpanded([]);
    setResult(null);
  }, [sessionId, state.open]);

  React.useEffect(() => {
    // Re-read on every open, not only the first: the surface grows while the
    // panel is closed, and a panel that listed only what existed at mount would
    // hide the newest exchange — the one most likely to be annotated.
    if (state.open && sessionId !== null) void controller.load(sessionId);
  }, [controller, state.open, sessionId]);

  if (!state.open || sessionId === null) return null;

  const { total, invalid } = view.stats;
  // What the summarizer will be told to drop, in the operator's unit. Derived
  // from the same counts the header shows, so the number being confirmed is the
  // number the digest will carry.
  const keep = total - invalid;

  const triggerCompaction = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      const value = await rpc.call<TriggerResult>('compaction.trigger', { sessionId });
      setResult(value);
      if (value.kind === 'success') {
        // The surface this panel was describing no longer exists; reload rather
        // than let it describe a region that has been replaced.
        setExpanded([]);
        await controller.load(sessionId);
        // A compaction replaces exactly the range it summarized, so a marked
        // turn still on the surface afterwards was outside that range — the
        // verbatim-retained tail — and its mark did nothing. Derived from the
        // outcome rather than predicted, because where the range boundary falls
        // is DSH's decision, not ours to estimate.
        const after = controller.view(sessionId);
        const ignored = after.turns.filter((turn) => controller.statusOfTurn(sessionId, turn) === 'invalid').length;
        if (ignored > 0) {
          setResult({
            kind: 'success',
            text: `${value.text} · ${translate('panel.retentionIgnored').replace('{n}', String(ignored))}`,
          });
        }
      }
    } catch (error) {
      setResult({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const button = (
    label: string,
    onClick: () => void,
    options: { readonly danger?: boolean } = {},
  ): React.ReactElement =>
    React.createElement(
      'button',
      {
        type: 'button',
        className: options.danger === true ? `${CLASS.btn} ${CLASS.btnDanger}` : CLASS.btn,
        onClick,
      },
      label,
    );

  const toggleExpanded = (turnId: string): void => {
    setExpanded((previous) =>
      previous.includes(turnId) ? previous.filter((id) => id !== turnId) : [...previous, turnId],
    );
  };

  const rows: React.ReactElement[] = [];
  for (const turn of view.turns) {
    const status = controller.statusOfTurn(sessionId, turn);
    const invalidTurn = status === 'invalid';
    const prompt = promptOf(turn);
    const label = translate(invalidTurn ? 'action.unmark' : 'action.markInvalid');
    const steps = turn.messages.length;
    const isOpen = expanded.includes(turn.id);
    const addressable = turn.messages.some((message) => message.messageId !== null);

    rows.push(
      React.createElement(
        'div',
        {
          key: turn.id,
          className: CLASS.row,
          'data-cco-turn': status,
          'data-cco-steps': steps,
        },
        steps > 1
          ? React.createElement(
              'button',
              {
                type: 'button',
                className: CLASS.disclosure,
                'aria-expanded': isOpen,
                'aria-label': translate(isOpen ? 'panel.collapse' : 'panel.expand'),
                onClick: () => toggleExpanded(turn.id),
              },
              isOpen ? '▾' : '▸',
            )
          : React.createElement('span', { className: CLASS.disclosure }),
        React.createElement(
          'span',
          { className: CLASS.rowMeta },
          prompt === null ? `#${turn.startSeq}` : `${translate('panel.you')} #${turn.startSeq}`,
        ),
        React.createElement('span', { className: CLASS.rowText }, turnPreview(turn, translate)),
        React.createElement(
          'span',
          { className: CLASS.rowSteps },
          translate('panel.steps').replace('{n}', String(steps)),
        ),
        React.createElement(
          'span',
          { className: CLASS.rowActions },
          addressable
            ? withTooltip(
                label,
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: CLASS.action,
                    'aria-label': label,
                    'aria-pressed': invalidTurn,
                    'data-state': invalidTurn ? 'invalid' : 'unmarked',
                    onClick: () => void controller.setTurn(sessionId, turn, invalidTurn ? 'unmarked' : 'invalid'),
                  },
                  invalidTurn ? React.createElement(IconCloseOutline16, {}) : React.createElement(RingGlyph, null),
                ),
              )
            : React.createElement('span', { className: CLASS.rowMeta }, translate('panel.noId')),
        ),
      ),
    );

    if (!isOpen) continue;
    for (const message of turn.messages) {
      // Read-only: the toggle belongs to the exchange, and showing where the
      // steps are is the point — offering a second place to click is not.
      rows.push(
        React.createElement(
          'div',
          { key: `${turn.id}:${message.seq}`, className: CLASS.step, 'data-notext': message.head.length === 0 ? true : undefined },
          React.createElement('span', { className: CLASS.rowMeta }, `${kindOf(message)} #${message.seq}`),
          React.createElement(
            'span',
            { className: CLASS.rowText },
            message.head.length === 0 ? `(${translate('panel.noText')})` : message.head,
          ),
        ),
      );
    }
  }

  return React.createElement(
    'div',
    {
      className: CLASS.overlay,
      role: 'dialog',
      'aria-label': translate('panel.title'),
      onClick: (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) panel.close();
      },
    },
    React.createElement(
      'div',
      { className: CLASS.card, 'data-cco-panel': 'open' },
      React.createElement(
        'div',
        { className: CLASS.cardHead },
        React.createElement('strong', null, translate('panel.title')),
        React.createElement('span', { className: CLASS.stat }, summaryLine(view, translate)),
      ),
      React.createElement(
        'div',
        { className: CLASS.forecast, 'data-cco-forecast': invalid },
        React.createElement(
          'div',
          null,
          translate('panel.forecast').replace('{n}', String(invalid)).replace('{m}', String(keep)),
        ),
        React.createElement('div', { className: CLASS.hint }, translate('panel.forecastNote')),
      ),
      React.createElement(
        'div',
        { className: CLASS.toolbar },
        button(translate('panel.reload'), () => void controller.load(sessionId)),
        React.createElement('span', { style: { flex: 1 } }),
        button(translate('panel.clear'), () => void controller.clear(sessionId), { danger: true }),
        button(translate('panel.close'), () => panel.close()),
      ),
      React.createElement(
        'div',
        { className: CLASS.hint, style: { padding: '8px 16px' } },
        translate('panel.hint'),
      ),
      React.createElement(
        'div',
        { className: CLASS.cardBody },
        panelBody(view, rows, translate),
      ),
      React.createElement(
        'div',
        { className: CLASS.footer },
        React.createElement(
          'button',
          {
            type: 'button',
            className: `${CLASS.btn} ${CLASS.btnDanger}`,
            disabled: busy,
            onClick: () => void triggerCompaction(),
          },
          busy ? translate('panel.compacting') : translate('panel.confirmCompact'),
        ),
        result === null
          ? React.createElement('span', { className: CLASS.hint }, translate('panel.compactHint'))
          : React.createElement('span', { className: CLASS.result, 'data-state': result.kind }, result.text),
      ),
    ),
  );
}

export default PanelOverlay;
