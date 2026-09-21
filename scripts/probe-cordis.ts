/**
 * Cordis lifecycle probe (development aid, not shipped).
 *
 * The integration test needs to tear a mounted app down between cases; M1's
 * first attempt assumed `ctx.stop()`, which does not exist. This prints the real
 * surface so the teardown uses a supported call.
 */

import { Context } from '@deepseek-ai/cordis';
import storagePlugin from '@deepseek-ai/dsh-storage';

function surface(label: string, value: unknown): void {
  const seen = new Set<string>();
  let cursor: object | null = value as object | null;
  while (cursor !== null && cursor !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(cursor)) {
      if (key === 'constructor') continue;
      seen.add(key);
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  console.log(`${label}: ${[...seen].sort().join(', ')}`);
}

const app = new Context();
surface('Context prototype', app);
console.log(`Context own keys: ${Object.keys(app).join(', ')}`);

const fiber = app.plugin(storagePlugin as never);
surface('Fiber from ctx.plugin()', fiber);
console.log(`Fiber own keys: ${Object.keys(fiber as object).join(', ')}`);
console.log(`Fiber thenable: ${typeof (fiber as { then?: unknown }).then}`);

const provider = app.get('storage');
console.log(`storage service resolved: ${provider !== undefined}`);
