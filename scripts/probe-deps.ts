/**
 * Dependency shape probe (development aid, not shipped).
 *
 * M1 wrote `src/host/**` against the API surface that M0 documented from type
 * declarations, but never executed it because the workspace had no
 * `node_modules`. This script answers the one question that cannot be answered
 * from types alone: what does each package actually export at runtime, and does
 * our adapter's import style match it.
 *
 * Usage: `node scripts/probe-deps.ts`
 */

const targets: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain',
  'zod',
];

for (const target of targets) {
  try {
    const mod: Record<string, unknown> = await import(target);
    const keys = Object.keys(mod);
    const defaultType = typeof mod['default'];
    console.log(`${target}`);
    console.log(`  default: ${defaultType}`);
    console.log(`  exports (${keys.length}): ${keys.slice(0, 25).join(', ')}`);
  } catch (error) {
    console.log(`${target}`);
    console.log(`  IMPORT FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}
