/**
 * Style identifiers.
 *
 * Split out from `styles.ts` so it can be imported where the stylesheet itself
 * cannot be: `styles.ts` pulls in `styles.css`, and Node has no loader for that
 * extension. Keeping the names here means the class-name/CSS pairing can still be
 * asserted by a unit test.
 *
 * Every value must appear in `styles.css`; `tests/unit/client-styles.test.ts`
 * asserts the pairing, because a rename on one side is otherwise silent.
 *
 * @module dsh-context-compaction-optimizer/client/class-names
 */

/** Marker attribute identifying our stylesheet tag. */
export const STYLE_TAG_ID = 'dsh-context-compaction-optimizer/styles.css';

/**
 * Class names used by the components.
 *
 * One name maps to one class, never a compound string: a component that wants
 * the base look plus a modifier composes them itself. A compound value here
 * would make "no duplicate class names" impossible to assert and would hide
 * which rule a component actually depends on.
 */
export const CLASS = {
  action: 'cco-action',
  actionWrap: 'cco-action-wrap',
  trigger: 'cco-trigger',
  count: 'cco-count',
  overlay: 'cco-overlay',
  card: 'cco-card',
  cardHead: 'cco-card-head',
  cardBody: 'cco-card-body',
  row: 'cco-row',
  rowMeta: 'cco-row-meta',
  rowText: 'cco-row-text',
  rowActions: 'cco-row-actions',
  rowSteps: 'cco-row-steps',
  disclosure: 'cco-disclosure',
  step: 'cco-step',
  toolbar: 'cco-toolbar',
  forecast: 'cco-forecast',
  footer: 'cco-footer',
  result: 'cco-result',
  stat: 'cco-stat',
  btn: 'cco-btn',
  btnDanger: 'cco-btn-danger',
  error: 'cco-error',
  hint: 'cco-hint',
  settings: 'cco-settings',
  settingsRow: 'cco-settings-row',
  toggleRow: 'cco-toggle-row',
  toggleLabel: 'cco-toggle-label',
} as const;
