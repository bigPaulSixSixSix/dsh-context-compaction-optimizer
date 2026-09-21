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
import type { AnnotationController } from '../store.ts';

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

/** Toggle one assistant message between unmarked and invalid. */
export function AnnotationButtons(props: AnnotationButtonsProps): React.ReactElement {
  const { messageId, sessionId, controller, t } = props;

  React.useEffect(() => {
    ensureStyles();
  }, []);

  // `getSnapshot` must return a stable reference; the controller guarantees that.
  const view = React.useSyncExternalStore(controller.subscribe, () => controller.view(sessionId));

  // This control only ever mounts for a message that is on the surface, so an id
  // the controller does not know means the cached list predates the turn that
  // produced it. Reading the surface here is what keeps the header counter
  // honest for a reply sent after the last load: without it, marking the newest
  // message would change no number at all.
  React.useEffect(() => {
    if (view.loaded && !controller.knows(sessionId, messageId)) void controller.refreshSurface(sessionId);
  }, [controller, sessionId, messageId, view]);

  // The turn is the unit (N035): this control sits on the turn's closing message
  // but marks — and reflects — the whole exchange, so the inline entry point and
  // the panel can never disagree about what a click means.
  const turn = controller.turnFor(sessionId, messageId);
  const status = turn === undefined ? 'unmarked' : controller.statusOfTurn(sessionId, turn);
  const invalid = status === 'invalid';
  const translate: Translate = translator(t);
  const label = translate(invalid ? 'action.unmark' : 'action.markInvalid');

  return withTooltip(
    label,
    React.createElement(
      'button',
      {
        type: 'button',
        className: CLASS.action,
        'aria-label': label,
        'aria-pressed': invalid,
        // Inert until the surface arrives: marking the wrong unit is worse than
        // a control that is briefly unavailable.
        disabled: turn === undefined,
        'data-state': invalid ? 'invalid' : 'unmarked',
        'data-cco-annotation': status,
        onClick: (event: React.MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (turn === undefined) return;
          void controller.setTurn(sessionId, turn, invalid ? 'unmarked' : 'invalid');
        },
      },
      invalid ? React.createElement(IconCloseOutline16, {}) : React.createElement(RingGlyph, null),
    ),
  );
}

export default AnnotationButtons;
