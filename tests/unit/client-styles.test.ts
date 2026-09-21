/**
 * Stylesheet contract tests.
 *
 * The stylesheet is read from disk rather than imported: `styles.ts` pulls in
 * `styles.css`, and Node has no loader for that extension. Splitting the class
 * names into `class-names.ts` is what keeps this testable at all.
 *
 * These catch the failure modes that actually happened while building this UI:
 * invented theme-token names that silently rendered as fallbacks, and a header
 * trigger whose fixed width shrank its own glyph.
 *
 * @module tests/unit/client-styles
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CLASS, STYLE_TAG_ID } from '../../src/client/class-names.ts';

const CSS = await readFile(join(process.cwd(), 'src/client/styles.css'), 'utf8');

/** The declaration body of one rule. */
function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  assert.ok(match !== null, `no rule found for ${selector}`);
  return match[1] ?? '';
}

function hasRule(selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*\\{`).test(CSS);
}

test('the stylesheet declares every class the components use', () => {
  for (const [name, value] of Object.entries(CLASS)) {
    for (const single of value.split(' ')) {
      assert.ok(hasRule(`.${single}`), `CLASS.${name} (${single}) has no rule in styles.css`);
    }
  }
});

test('the class map has no duplicate names', () => {
  const names = Object.values(CLASS).flatMap((value) => value.split(' '));
  assert.equal(new Set(names).size, names.length);
});

test('the style tag id is namespaced to the plugin', () => {
  assert.equal(STYLE_TAG_ID, 'dsh-context-compaction-optimizer/styles.css');
});

/** The stylesheet is inlined as text, so it must never be parsed as JS. */
test('the stylesheet carries no template-literal syntax', () => {
  assert.ok(!CSS.includes('${'), 'a stray interpolation would mean the CSS is being built as JS');
});

/**
 * Every colour must come from a harness theme token. The first version of this
 * component used invented `--dsh-*` names that do not exist, so it silently
 * rendered with fallback colours and looked nothing like its neighbours.
 *
 * Two prefixes are legitimate, both copied from harness components:
 * `--dsw-alias-*` theme tokens, and `--dsh-content-font-delta`, which scales a
 * glyph with the content font size.
 */
test('the stylesheet uses only real harness theme tokens', () => {
  const referenced = [...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1] ?? '');
  assert.ok(referenced.length > 0, 'the stylesheet must reference theme tokens');
  for (const token of referenced) {
    assert.ok(
      token.startsWith('--dsw-alias-') || token === '--dsh-content-font-delta',
      `unexpected token ${token}: only harness tokens are known to exist`,
    );
  }
  for (const token of ['--dsw-alias-label-tertiary', '--dsw-alias-label-secondary', '--dsw-alias-interactive-bg-hover']) {
    assert.ok(referenced.includes(token), `the stylesheet should use ${token}`);
  }
});

/**
 * The regression the header trigger hit: it reused the fixed 28px round button
 * and painted the count inside it, so the glyph and the number competed for one
 * box and the icon shrank as soon as a count appeared.
 */
test('the header trigger grows to fit its count instead of squeezing the glyph', () => {
  const trigger = ruleFor(`.${CLASS.trigger}`);

  assert.ok(
    !/(^|[;{])\s*width\s*:/.test(trigger),
    'the trigger must not declare a width: a fixed box is what shrank the icon',
  );
  assert.match(trigger, /display:\s*inline-flex/, 'icon and count must lay out in a row');
  assert.match(trigger, /border:\s*none/, 'matching the framework means no border');

  // Typography mirrors the header label beside this button. `font: inherit` was
  // tried first and was wrong: it takes the parent's font, while that label sets
  // its own explicitly, so the two disagreed.
  assert.match(trigger, /font-size:\s*12px/, 'the count must use the header label size');
  assert.match(trigger, /line-height:\s*22px/, 'and its line box');
  assert.match(trigger, /font-family:\s*inherit/, 'while still inheriting the family');
  assert.ok(
    !/(^|[;{])\s*font\s*:\s*inherit/.test(trigger),
    'the font shorthand would override the explicit size and line height',
  );

  const glyph = ruleFor(`.${CLASS.trigger} svg`);
  assert.match(glyph, /flex:\s*0\s+0\s+auto/, 'the glyph must be excluded from flex shrinking');
  assert.match(glyph, /width:/, 'the glyph keeps an explicit size');

  assert.match(ruleFor(`.${CLASS.count}`), /font:\s*inherit/);
});

/**
 * The settings page copies the Plugins settings cards, so its numbers are the
 * ones that make it look like it belongs to that family.
 */
test('the settings layout copies the Plugins card metrics', () => {
  assert.match(ruleFor(`.${CLASS.settings}`), /display:\s*grid/);
  assert.match(ruleFor(`.${CLASS.settingsRow}`), /padding:\s*12px\s+0/);

  const toggle = ruleFor(`.${CLASS.toggleRow}`);
  assert.match(toggle, /justify-content:\s*space-between/, 'the control sits at the far edge');
  assert.match(toggle, /font-size:\s*13px/);
  assert.match(toggle, /line-height:\s*1\.5/);

  const hint = ruleFor(`.${CLASS.hint}`);
  assert.match(hint, /font-size:\s*12px/);
  assert.match(hint, /color:\s*var\(--dsw-alias-label-tertiary\)/);
  assert.match(hint, /margin:\s*0/);
});
