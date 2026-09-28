/**
 * Per-message annotation control.
 *
 * Registered into `conversation.chat.assistant-actions`, whose owner props carry
 * the durable `messageId` — the exact key the host validates against its session
 * log (`01开发日志.md` N001).
 *
 * **One control, two states.** The default is an empty ring; clicking marks the
 * message invalid and shows a cross; clicking again returns it to the ring. The
 * reasoning is the operator's: nearly everything in a conversation *should* be
 * compacted, so the work is finding the few messages worth dropping — a second
 * "this one is fine" button would be a control nobody needs to press, on a row
 * that already holds copy, branch and feedback.
 *
 * Visual treatment is copied from `@deepseek-ai/dsh-client-ui-message-feedback`,
 * which occupies the same row: a 28px round hit target, a 15px glyph, no border,
 * a transparent background, a hover wash, and the harness's own `--dsw-alias-*`
 * tokens. The icons come from the harness's primitives package rather than being
 * drawn here, except the ring, which that set does not include.
 *
 * @module dsh-context-compaction-optimizer/client/components/AnnotationButtons
 */

import { IconCloseOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import React from 'react';

import { translator, type Translate } from '../locale.ts';
import { CLASS, ensureStyles } from '../styles.ts';
import type { AnnotationController, SurfacePhase } from '../store.ts';

/** Props the slot owner supplies, plus what the plugin injects. */
export interface AnnotationButtonsProps {
  /** Durable assistant message id, from `AssistantActionOwnerProps`. */
  readonly messageId: string;
  /** Session the message belongs to, from the standard session props. */
  readonly sessionId: string;
  readonly controller: AnnotationController;
  readonly t?: (key: string) => string;
}

/**
 * The unmarked glyph: an empty ring.
 *
 * Drawn here because the primitives icon set has no circle. Stroke width, size
 * and `currentColor` are chosen to sit beside the 16px outline icons without
 * looking heavier or lighter than them.
 */
function RingGlyph(): React.ReactElement {
  return React.createElement(
    'svg',
    {
      viewBox: '0 0 16 16',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
      'aria-hidden': true,
      focusable: false,
    },
    React.createElement('circle', {
      cx: 8,
      cy: 8,
      r: 5.75,
      stroke: 'currentColor',
      strokeWidth: 1.5,
    }),
  );
}

/** Wrap children in the harness tooltip when it is available. */
function withTooltip(label: string, children: React.ReactElement): React.ReactElement {
  if (typeof Tooltip !== 'function') return children;
  return React.createElement(Tooltip, { label, side: 'bottom' }, children);
}

/**
 * Why the control cannot act yet, in the operator's language (N048).
 *
 * The host can only serve a session it has loaded, so "no surface" is usually a
 * matter of timing rather than a fault. A disabled control that says nothing is
 * what made this look like a broken button, so the reason travels with it as the
 * accessible name and the native title; the panel repeats it in full, because a
 * disabled element does not reliably raise a tooltip.
 */
function phaseNotice(phase: SurfacePhase, translate: Translate): string {
  if (phase === 'session-not-loaded') return translate('action.waiting.session');
  if (phase === 'failed') return translate('action.waiting.failed');
  return translate('action.waiting.loading');
}

/**
 * Why a ready surface still has nothing for this message (N049).
 *
 * `ready` means the turns arrived, so an id they do not hold is not a loading
 * state: either the surface has not been re-read for it yet, or — once it has,
 * and once a compaction has folded that exchange into a checkpoint — the message
 * is off the surface for good and a mark could never take effect. The second case
 * is what a compacted conversation is full of, and saying nothing there is what
 * made a whole session look like a broken control.
 */
function surfaceNotice(
  offSurface: boolean,
  translate: Translate,
): string {
  return offSurface ? translate('action.compacted') : translate('action.checking');
}

/** Toggle one assistant message between unmarked and invalid. */
export function AnnotationButtons(props: AnnotationButtonsProps): React.ReactElement {
  const { messageId, sessionId, controller, t } = props;

  React.useEffect(() => {
    ensureStyles();
  }, []);

  // `getSnapshot` must return a stable reference; the controller guarantees that.
  const view = React.useSyncExternalStore(controller.subscribe, () => controller.view(sessionId));

  React.useEffect(() => {
    // The control bootstraps its own read rather than waiting for the panel
    // trigger to happen to mount: without this, a session whose header rendered
    // later — or whose first read lost the race — left every button dead. `idle`
    // is the one phase that starts a read, so a terminal failure cannot loop.
    if (view.phase === 'idle') {
      void controller.load(sessionId);
      return;
    }
    if (view.phase !== 'ready') return;
    // An id the controller does not know means the cached list predates the turn
    // that produced it. Reading the surface here is what keeps the header counter
    // honest for a reply sent after the last load: without it, marking the newest
    // message would change no number at all. Asked once per id — see N049.
    if (!controller.knows(sessionId, messageId) && controller.needsRefreshFor(sessionId, messageId)) {
      void controller.refreshSurface(sessionId);
    }
  }, [controller, sessionId, messageId, view]);

  // The turn is the unit (N035): this control sits on the turn's closing message
  // but marks — and reflects — the whole exchange, so the inline entry point and
  // the panel can never disagree about what a click means.
  const ready = view.phase === 'ready';
  const turn = ready ? controller.turnFor(sessionId, messageId) : undefined;
  const status = turn === undefined ? 'unmarked' : controller.statusOfTurn(sessionId, turn);
  const invalid = status === 'invalid';
  const translate: Translate = translator(t);
  const offSurface = ready && turn === undefined && controller.isOffSurface(sessionId, messageId);
  const label = !ready
    ? phaseNotice(view.phase, translate)
    : turn === undefined
      ? surfaceNotice(offSurface, translate)
      : translate(invalid ? 'action.unmark' : 'action.markInvalid');

  const control = React.createElement(
    'button',
    {
      type: 'button',
      className: CLASS.action,
      'aria-label': label,
      // Best effort for a disabled element, which does not reliably raise the
      // tooltip on its own; the wrapper below is what makes it dependable.
      title: label,
      'aria-pressed': invalid,
      // Inert until the surface arrives: marking the wrong unit is worse than
      // a control that is briefly unavailable.
      disabled: turn === undefined,
      'data-state': invalid ? 'invalid' : 'unmarked',
      'data-cco-annotation': status,
      // The phase in the DOM, so the reason is inspectable where the control is
      // — this is how the reported symptom was diagnosed.
      'data-cco-phase': view.phase,
      'data-cco-off-surface': offSurface ? 'true' : 'false',
      onClick: (event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (turn === undefined) return;
        void controller.setTurn(sessionId, turn, invalid ? 'unmarked' : 'invalid');
      },
    },
    invalid ? React.createElement(IconCloseOutline16, {}) : React.createElement(RingGlyph, null),
  );

  // A `disabled` button dispatches no mouse events, so a tooltip attached to it
  // never opens and its label never reaches the operator — which is exactly how
  // "grey, no reason given" happened. An inert control therefore sits inside a
  // live wrapper that carries the label.
  return withTooltip(
    label,
    turn === undefined
      ? React.createElement('span', { className: CLASS.actionWrap }, control)
      : control,
  );
}

export default AnnotationButtons;
