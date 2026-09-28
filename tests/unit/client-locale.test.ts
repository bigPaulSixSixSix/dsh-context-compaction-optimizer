/**
 * Locale contract tests.
 *
 * `locale.ts` claims "a forgotten translation fails a test rather than silently
 * showing a raw key in one language", but the `Record<keyof typeof zh, string>`
 * annotation only enforces that the two dictionaries agree with each other — it
 * says nothing about the keys the components actually ask for. A typo at a call
 * site, or a key added to one dictionary and used before the other has it, shows
 * the raw key in the UI and nothing notices.
 *
 * So this reads the client sources from disk and checks both directions: every
 * key asked for exists, and every key defined is asked for.
 *
 * **Comments are stripped before scanning, and that is not an optimisation.**
 * The first version scanned raw source, and an apostrophe in a comment paired
 * with the next quote in the file, producing one enormous bogus "literal" that
 * swallowed the real keys between them — which reported seven perfectly good
 * settings keys as unused. {@link MAX_LITERAL} turns any repeat of that into a
 * loud failure instead of a wrong verdict.
 *
 * @module tests/unit/client-locale
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { LOCALE_KEYS, dictionaries } from '../../src/client/locale.ts';

const CLIENT_DIR = join(process.cwd(), 'src/client');

/** No real translation key comes close to this. */
const MAX_LITERAL = 60;

/** The definitions themselves: long copy, and never a call site. */
const DEFINITIONS = 'locale.ts';

/** Every source file under `src/client` that *asks for* copy. */
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(full)));
    else if (/\.tsx?$/.test(entry.name) && entry.name !== DEFINITIONS) out.push(full);
  }
  return out;
}

/**
 * Remove comments while preserving string literals.
 *
 * Strings are copied through verbatim — including escapes — so a quote inside a
 * string cannot end the string early, and a comment cannot contribute one.
 */
export function stripComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      out += char;
      index += 1;
      while (index < text.length && text[index] !== char) {
        if (text[index] === '\\') {
          out += text[index] ?? '';
          index += 1;
        }
        out += text[index] ?? '';
        index += 1;
      }
      out += char;
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Every single-quoted literal in a source file, with comments removed. */
async function literalsOf(file: string): Promise<string[]> {
  const text = stripComments(await readFile(file, 'utf8'));
  return [...text.matchAll(/'([^'\n]*)'/g)].map((match) => match[1] ?? '');
}

/** The shape of a locale key: `namespace.name[.name]`. */
const KEY_SHAPE = /^[a-z][a-z0-9]*(\.[A-Za-z0-9]+)+$/;

test('comment stripping keeps literals and drops prose apostrophes', () => {
  const sample = "// it's a comment with 'quotes'\nconst a = 'kept'; /* and 'this' too */\nconst b = 'also kept';";
  const stripped = stripComments(sample);
  assert.ok(!stripped.includes('comment'), 'comments must be gone');
  assert.ok(stripped.includes("'kept'"), 'a literal beside a comment survives');
  assert.ok(stripped.includes("'also kept'"), 'a literal after a block comment survives');
});

test('both dictionaries carry exactly the same keys', () => {
  const zh = Object.keys(dictionaries.zh).sort();
  const en = Object.keys(dictionaries.en).sort();
  assert.deepEqual(en, zh, 'a key present in one language and not the other shows a raw key');
  assert.deepEqual(zh, [...LOCALE_KEYS].sort(), 'LOCALE_KEYS must mirror the dictionaries');
});

test('no translation is empty', () => {
  for (const key of LOCALE_KEYS) {
    assert.ok(dictionaries.zh[key].trim().length > 0, `zh ${key} is empty`);
    assert.ok(dictionaries.en[key].trim().length > 0, `en ${key} is empty`);
  }
});

/**
 * The check the module doc promised: a key asked for at a call site must exist.
 * The call sites include keys passed to local helpers (`toggleRow(...)`), so the
 * scan looks at every literal of key shape rather than only the ones inside a
 * `translate(...)` call — RPC names like `session.surface` have the same shape,
 * which is why existence is checked in this direction only.
 */
test('every key the client asks for exists', async () => {
  const known = new Set<string>(LOCALE_KEYS);
  const requested = new Set<string>();
  let longest = '';

  for (const file of await sources(CLIENT_DIR)) {
    for (const literal of await literalsOf(file)) {
      if (literal.length > longest.length) longest = literal;
      if (KEY_SHAPE.test(literal)) requested.add(literal);
    }
  }

  // The guard that makes a scanner defect loud: a mis-paired quote yields a huge
  // span of source here, which is exactly how the first version went wrong.
  assert.ok(
    longest.length <= MAX_LITERAL,
    `a captured literal of ${longest.length} chars suggests mis-paired quotes: ${JSON.stringify(longest.slice(0, 80))}`,
  );
  assert.ok(requested.size > 0, 'the scan must find keys, or it proves nothing');

  const unknown = [...requested].filter((literal) => {
    if (known.has(literal)) return false;
    // Only this plugin's namespaces are candidates; the rest are RPC methods,
    // slot names and package ids, which share the shape but not the meaning.
    const namespace = literal.slice(0, literal.indexOf('.') + 1);
    const ours = LOCALE_KEYS.some((key) => key.startsWith(namespace));
    if (!ours) return false;
    // `settings.get`, `settings.update`, `settings.section` are RPC/slot names.
    return !['settings.get', 'settings.update', 'settings.section'].includes(literal);
  });
  assert.deepEqual(unknown.sort(), [], 'the client asks for keys no dictionary defines');
});

/**
 * The other direction: copy nothing asks for is dead weight, and a typo in a key
 * passed to a helper shows up here as the *real* key having lost its reference.
 */
test('every key in the dictionaries is asked for', async () => {
  const used = new Set<string>();
  for (const file of await sources(CLIENT_DIR)) {
    for (const literal of await literalsOf(file)) used.add(literal);
  }

  const unused = LOCALE_KEYS.filter((key) => !used.has(key));
  assert.deepEqual(unused, [], 'these keys are never referenced, so the copy is dead');
});

/**
 * The failure mode this guards against is real in this codebase: the panel body
 * switches on the surface phase and names a key per branch, so a new phase
 * without copy would surface as a raw key to the operator.
 */
test('the surface phase copy is complete', () => {
  for (const key of [
    'action.waiting.loading',
    'action.waiting.session',
    'action.waiting.failed',
    'panel.loading',
    'panel.empty',
    'panel.sessionNotLoaded',
    'error.load',
  ]) {
    assert.ok((LOCALE_KEYS as readonly string[]).includes(key), `missing copy for ${key}`);
  }
});
