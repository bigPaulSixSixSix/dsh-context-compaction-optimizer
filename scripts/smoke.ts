/**
 * Live mount smoke test.
 *
 * The unit suites stop at the artifact boundary: they prove the bundles are
 * shaped correctly and that the wiring inside them is right, but nothing there
 * can tell you whether a *deployed* host actually mounted the plugin. That
 * question only has an answer against a running process, and it is the one a
 * release has to answer — M7 ships into other people's hosts.
 *
 * Every probe is read-only, and the one that touches a write path
 * (`compaction.trigger`) deliberately addresses a **session that does not
 * exist**: `surfaceOrThrow` rejects it before the compaction port is reached, so
 * the check proves the method is routed without compacting anything.
 *
 * Usage: `npm run smoke [baseUrl]`   (default http://127.0.0.1:3080)
 * @module dsh-context-compaction-optimizer/scripts/smoke
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080';
const RPC = `${BASE}/cco/api`;

interface Check {
  readonly name: string;
  readonly detail: string;
  readonly ok: boolean;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

async function call(method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: params ?? {} }),
  });
  return (await response.json()) as { ok: boolean; value?: unknown; error?: { code: string; message: string } };
}

async function get(method: string): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  const response = await fetch(`${RPC}?method=${encodeURIComponent(method)}`);
  return (await response.json()) as { ok: boolean; value?: unknown; error?: { code: string; message: string } };
}

console.log(`# 挂载冒烟测试\n\n目标: ${RPC}\n`);

// 1. The route exists at all. A host that never mounted the plugin 404s here.
try {
  const settings = await get('settings.get');
  if (!settings.ok) {
    record('RPC 路由可达', false, `settings.get 失败: ${settings.error?.code} ${settings.error?.message}`);
  } else {
    const value = (settings.value as { settings?: Record<string, unknown> }).settings ?? {};
    const expected = ['unmarkedPolicy', 'injectDigest', 'digestFormat', 'observeCache'];
    const missing = expected.filter((key) => !(key in value));
    record(
      'RPC 路由可达',
      true,
      `settings.get 返回 ${Object.keys(value).join(', ')}`,
    );
    // The N037 shape: a declared setting that never reaches `get()`. Checking it
    // here catches it on a real host, not only in the unit suite.
    record(
      '设置项完整',
      missing.length === 0,
      missing.length === 0 ? `四个键齐全，digestFormat=${String(value['digestFormat'])}` : `缺少 ${missing.join(', ')}`,
    );
  }
} catch (error) {
  record('RPC 路由可达', false, `无法连接 ${RPC}: ${error instanceof Error ? error.message : String(error)}`);
}

// 2. Session listing, and the surface shape the panel depends on.
try {
  const sessions = await get('session.list');
  const ids = ((sessions.value as { sessions?: { id: string }[] }).sessions ?? []).map((row) => row.id);
  record('会话列表可读', sessions.ok, `${ids.length} 个会话`);

  const first = ids[0];
  if (first === undefined) {
    record('表面投影可读', false, '没有会话可用于探测');
  } else {
    // POST rather than the GET shorthand: the shorthand takes query parameters
    // only, and `encodeURIComponent` on a composed string would escape the `&`.
    const surface = await call('session.surface', { sessionId: first });
    const value = surface.value as { turns?: unknown[]; messages?: unknown[] } | undefined;
    if (Array.isArray(value?.turns)) {
      record('表面按回合返回', true, `${value.turns.length} 个回合（新形状）`);
    } else if (Array.isArray(value?.messages)) {
      // The exact regression the shape check is for: an old host answering.
      record('表面按回合返回', false, '返回的是 messages——宿主仍是旧代码');
    } else {
      record('表面按回合返回', false, `既无 turns 也无 messages: ${JSON.stringify(surface).slice(0, 120)}`);
    }
  }
} catch (error) {
  record('会话列表可读', false, error instanceof Error ? error.message : String(error));
}

// 3. The manual-compaction command is registered, probed through a session that
//    does not exist so nothing is compacted.
try {
  const result = await call('compaction.trigger', { sessionId: 'smoke-test-nonexistent-session' });
  const code = result.error?.code;
  if (code === 'not-found') {
    record('手动压缩命令已注册', true, '未知会话被正确拒绝（未触碰压缩）');
  } else if (code === 'unsupported-method') {
    record('手动压缩命令已注册', false, '宿主未加载该方法');
  } else {
    record('手动压缩命令已注册', result.ok, `意外应答: ${JSON.stringify(result).slice(0, 120)}`);
  }
} catch (error) {
  record('手动压缩命令已注册', false, error instanceof Error ? error.message : String(error));
}

// 4. A read-only route must refuse mutations over GET.
try {
  const response = await fetch(`${RPC}?method=annotations.set&sessionId=x`);
  record('GET 不承载写操作', response.status === 405, `HTTP ${response.status}`);
} catch (error) {
  record('GET 不承载写操作', false, error instanceof Error ? error.message : String(error));
}

for (const check of checks) {
  console.log(`${check.ok ? '✔' : '✖'} ${check.name}: ${check.detail}`);
}
const failed = checks.filter((check) => !check.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
// `process.exit()` here trips a libuv assertion on Windows: `fetch` leaves
// keep-alive handles open and tearing the loop down underneath them is not
// clean. Setting the exit code lets the loop drain normally.
process.exitCode = failed === 0 ? 0 : 1;
