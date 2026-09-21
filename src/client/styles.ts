/**
 * Client style injection.
 *
 * The rules live in `styles.css` and are inlined as text by the bundler
 * (`loader: { '.css': 'text' }`). They used to live in a template literal here,
 * which cost two broken builds: prose in a comment containing a backtick closed
 * the literal, and the CSS then failed to parse as TypeScript. A real `.css`
 * file cannot have that failure mode.
 *
 * Injection mirrors the harness's own components (`data-plugin` names the owner,
 * `data-plugin-css` makes the injection idempotent) so a second mount — or
 * several components rendering at once — cannot append the sheet twice.
 *
 * @module dsh-context-compaction-optimizer/client/styles
 */

import { CLASS, STYLE_TAG_ID } from './class-names.ts';
import css from './styles.css';

export { CLASS, STYLE_TAG_ID };

/** The stylesheet text, exposed for diagnostics. */
export const STYLESHEET: string = css;

/**
 * Inject the stylesheet once.
 *
 * A no-op outside a browser, so the module stays importable from Node.
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset['plugin'] = 'dsh-context-compaction-optimizer';
  tag.dataset['pluginCss'] = STYLE_TAG_ID;
  tag.textContent = STYLESHEET;
  document.head.appendChild(tag);
}

/** Remove the stylesheet. Used on unload. */
export function removeStyles(): void {
  if (typeof document === 'undefined') return;
  const tag = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`);
  if (tag !== null) tag.remove();
}
