import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_SEPARATOR,
  STORAGE_KEY_PATTERN,
  keyBelongsToSession,
  splitStorageKey,
  storageKey,
} from '../../src/core/keys.ts';

// Realistic values taken from the live session that Spike 3 audited
// (`01开发日志.md` N008): session ids and durable MessageIds.
const SESSION = 'session-1003d64e-4569-497f-a942-aa30483c2cec';
const MESSAGE = '849a35d0-e091-4af9-8ae9-abae67abcdb1';

test('storageKey composes a key the per-record writer accepts', () => {
  const key = storageKey(SESSION, MESSAGE);
  assert.equal(key, `${SESSION}${KEY_SEPARATOR}${MESSAGE}`);
  assert.match(key, STORAGE_KEY_PATTERN);
});

test('storageKey round-trips through splitStorageKey', () => {
  assert.deepEqual(splitStorageKey(storageKey(SESSION, MESSAGE)), {
    sessionId: SESSION,
    messageId: MESSAGE,
  });
});

test('the composed key stays within the storage charset for realistic ids', () => {
  // The exact regression this guards: `:` would be rejected by the per-record
  // writer, so the separator must not be one.
  assert.ok(!KEY_SEPARATOR.includes(':'));
  assert.match(storageKey(SESSION, MESSAGE), /^[a-zA-Z0-9_-]+$/);
});

test('storageKey rejects ids that would produce an unsafe path segment', () => {
  assert.throws(() => storageKey('session:bad', MESSAGE), /not path-safe/);
  assert.throws(() => storageKey(SESSION, 'has/slash'), /not path-safe/);
  assert.throws(() => storageKey(SESSION, `${MESSAGE}${KEY_SEPARATOR}x`), /not path-safe/);
  assert.throws(() => storageKey('', MESSAGE), /non-empty/);
  assert.throws(() => storageKey(SESSION, '   '), /non-empty/);
});

test('the separator is reserved, so an id containing it can never be accepted', () => {
  // Splitting relies on `_` being absent from both components.
  assert.throws(() => storageKey('a_b', MESSAGE), /not path-safe/);
});

test('splitStorageKey rejects keys that are not composed', () => {
  assert.throws(() => splitStorageKey('plain-uuid'), /not a composed annotation key/);
  assert.throws(() => splitStorageKey('_leading'), /not a composed annotation key/);
  assert.throws(() => splitStorageKey('trailing_'), /not a composed annotation key/);
});

test('keyBelongsToSession scopes a key to one session, which is what makes fork isolation work', () => {
  const key = storageKey(SESSION, MESSAGE);
  assert.equal(keyBelongsToSession(key, SESSION), true);
  // A forked child shares the MessageId but not the session id, so it must not
  // match the parent's record.
  assert.equal(keyBelongsToSession(key, 'session-forked-child'), false);
});
