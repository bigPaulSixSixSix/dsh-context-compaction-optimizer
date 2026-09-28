/**
 * In-process test runner.
 *
 * `node --test <dir>` cannot be used in this environment: the DSH file sandbox
 * blocks the child-process pipes the test runner spawns, and the run dies with
 * `spawn EPERM` before a single test executes (recorded in `01开发日志.md` N014).
 *
 * Importing the test modules instead runs `node:test` inside this process and
 * avoids spawning entirely. Node 24 strips TypeScript types natively, so no
 * build step is needed either.
 *
 * Usage: `npm test`
 */

// Importing a module that calls `test()` registers its cases; node:test runs
// them as the module graph settles and sets the process exit code on failure.
import '../tests/unit/annotations.test.ts';
import '../tests/unit/digest.test.ts';
import '../tests/unit/keys.test.ts';
import '../tests/unit/interceptor.test.ts';
import '../tests/unit/install.test.ts';
import '../tests/unit/manual-compact.test.ts';
import '../tests/unit/observe.test.ts';
import '../tests/unit/rpc-methods.test.ts';
import '../tests/unit/rpc-routes.test.ts';
import '../tests/unit/surface.test.ts';
import '../tests/unit/settings.test.ts';
import '../tests/unit/composition.test.ts';
import '../tests/unit/client-rpc.test.ts';
import '../tests/unit/client-store.test.ts';
import '../tests/unit/client-styles.test.ts';
import '../tests/unit/client-locale.test.ts';
// Built-artifact contract tests; skipped until `npm run build` has produced lib/.
import '../tests/unit/bundle.test.ts';

// Integration tests mount the real storage stack; they need `node_modules`.
import '../tests/integration/storage.test.ts';
