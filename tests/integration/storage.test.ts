/**
 * Integration test for the host adapter layer.
 *
 * M1 could only unit-test `src/core/**`; the adapter imports real DSH packages
 * and needed `node_modules`. This test closes that gap by mounting the actual
 * storage stack (`storage` + `storage-json` + `storage-domain`) into a Cordis
 * context and driving `AnnotationService` against it.
 *
 * What it proves that the unit tests cannot:
 *  - our import style matches each package's real runtime export shape;
 *  - `annotationDomainSpec` is accepted by the real `DomainFacility.open()`;
 *  - a `MessageId`-shaped key survives the per-record writer (Spike 3 asserted
 *    this through a dynamic plugin; this asserts it through our own code);
 *  - the write-through cache stays consistent with what is on disk, and survives
 *    a simulated restart.
 *
 * Environment notes pinned by N014:
 *  - the storage root is workspace-local, because the DSH file sandbox denies
 *    writes outside the session workspace, so `os.tmpdir()` is not usable;
 *  - Cordis has no `Context.stop()`. Teardown disposes the fibers returned by
 *    `ctx.plugin()` (verified by `scripts/probe-cordis.ts`).
 *
 * @module tests/integration/storage
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import storagePlugin from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';

import { AnnotationService } from '../../src/host/annotations/service.ts';
import { ANNOTATION_DOMAIN_NAME } from '../../src/host/annotations/domain.ts';

const STORAGE_ROOT = '.test-storage';
const SESSION = 'session-1003d64e-4569-497f-a942-aa30483c2cec';
const MESSAGE_A = '849a35d0-e091-4af9-8ae9-abae67abcdb1';
const MESSAGE_B = '11884b7c-4965-4f21-92ab-c10921ebc22f';

/** A mounted app plus its teardown. */
interface Harness {
  readonly service: AnnotationService;
  dispose(): Promise<void>;
}

/** Structural view of the fiber `ctx.plugin()` returns. */
interface Fiber {
  dispose(): unknown;
}

/**
 * Mount the real storage stack and construct the service inside a plugin, which
 * is the only place a Cordis `Service` may be instantiated.
 */
async function harness(root: string): Promise<Harness> {
  const app = new Context();
  const fibers: Fiber[] = [];

  const mount = async (plugin: unknown, config?: unknown): Promise<void> => {
    const fiber = (
      config === undefined ? app.plugin(plugin as never) : app.plugin(plugin as never, config as never)
    ) as unknown as Fiber;
    fibers.push(fiber);
    await (fiber as unknown as Promise<unknown>);
  };

  await mount(storagePlugin);
  await mount(storageJson, { root });
  await mount(storageDomain, { backend: 'json' });

  let service: AnnotationService | undefined;
  await mount({
    apply(ctx: Context) {
      service = new AnnotationService(ctx);
    },
  });

  if (service === undefined) throw new Error('harness: AnnotationService was not constructed');
  const constructed = service;

  return {
    service: constructed,
    async dispose() {
      await constructed.dispose().catch(() => undefined);
      for (const fiber of fibers.reverse()) {
        await Promise.resolve(fiber.dispose()).catch(() => undefined);
      }
      await Promise.resolve((app.fiber as unknown as Fiber).dispose()).catch(() => undefined);
    },
  };
}

test('AnnotationService persists annotations through the real storage domain', async (t) => {
  const root = join(process.cwd(), STORAGE_ROOT);
  await rm(root, { recursive: true, force: true });

  const h = await harness(root);
  t.after(async () => {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const annotations = h.service;

  // An empty session must be a well-defined no-op, not an error.
  assert.deepEqual(annotations.list(SESSION), []);
  assert.equal(annotations.excludes(SESSION, MESSAGE_A), false, 'unmarked defaults to kept');

  // Write through, then read from the synchronous snapshot.
  const result = await annotations.set(SESSION, MESSAGE_A, 'invalid');
  assert.equal(result.applied, 1);
  assert.equal(annotations.excludes(SESSION, MESSAGE_A), true);
  assert.equal(annotations.list(SESSION).length, 1);

  // The record must have reached disk under the domain's per-record layout.
  const domainDir = join(root, ANNOTATION_DOMAIN_NAME, 'annotations');
  const files = await readdir(domainDir);
  assert.equal(files.length, 1, `expected one record file, saw ${files.join(', ')}`);
  const fileName = files[0] ?? '';
  assert.ok(fileName.endsWith('.json'));
  assert.ok(fileName.includes(MESSAGE_A), `record file must carry the message id: ${fileName}`);
  assert.ok(fileName.includes(SESSION), `record file must carry the session id: ${fileName}`);
  assert.ok((await stat(join(domainDir, fileName))).size > 0);

  // A second annotation, a policy flip, then back.
  await annotations.bulkSet(SESSION, [{ messageId: MESSAGE_B, status: 'invalid' }]);
  assert.equal(annotations.list(SESSION).length, 2);
  annotations.setUnmarkedPolicy('invalid');
  assert.equal(annotations.excludes(SESSION, 'some-unmarked-message'), true);
  annotations.setUnmarkedPolicy('valid');
  assert.equal(annotations.excludes(SESSION, 'some-unmarked-message'), false);

  // Storage is scoped per session: a fork shares MessageIds but must not inherit.
  assert.equal(annotations.excludes('session-forked-child', MESSAGE_A), false);

  // Clearing removes records from disk and from the snapshot.
  const cleared = await annotations.clear(SESSION);
  assert.equal(cleared, 2);
  assert.deepEqual(annotations.list(SESSION), []);
  assert.equal((await readdir(domainDir)).length, 0);
});

test('AnnotationService rebuilds its snapshot from disk on hydrate', async (t) => {
  const root = join(process.cwd(), STORAGE_ROOT);
  await rm(root, { recursive: true, force: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // First instance writes and goes away, simulating a restart.
  const writer = await harness(root);
  await writer.service.set(SESSION, MESSAGE_A, 'invalid');
  await writer.dispose();

  // The second instance starts with a cold cache and must recover from the domain.
  const reader = await harness(root);
  t.after(async () => {
    await reader.dispose();
  });

  assert.deepEqual(reader.service.list(SESSION), [], 'cache starts cold');
  await reader.service.hydrate();
  const records = reader.service.list(SESSION);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.messageId, MESSAGE_A);
  assert.equal(records[0]?.status, 'invalid');
  assert.equal(reader.service.excludes(SESSION, MESSAGE_A), true);
});
