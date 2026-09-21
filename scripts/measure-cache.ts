/**
 * Cache measurement harness — the M6 release gate.
 *
 * The plan makes one measurement a release gate: "KV Cache 退化导致用户成本上升 |
 * 高 | 只追加不删除；**M6 缓存实测作为发版门槛**". This is that measurement, and
 * it is deliberately **re-runnable and evidence-first**: it reads what already
 * happened rather than asking anyone to remember numbers.
 *
 * Two sources, because each owns a different half:
 *
 * - **Session logs** (`$DSH_HOME/sessions/…/session.v3.jsonl.zstd`) own the
 *   provider-side truth: `usage.cacheReadTokens`, `usage.inputTokens`,
 *   `shadowedSeqs`, and the checkpoint text itself. Multi-frame zstd: the log is
 *   one frame per append, so it is decoded frame by frame.
 * - **The plugin's observer** (`diagnostics.snapshot`) owns the digest-side facts
 *   (`entryCount`, `digestChars`, `format`) and the annotations, neither of which
 *   is written to the session log.
 *
 * What it deliberately does NOT do: pronounce a verdict. It produces the numbers
 * and a list of **leak candidates** for a human to read, because the leak that
 * matters is semantic (a turn's conclusions surviving) and no string comparison
 * decides that. Surfacing candidates is the honest job here.
 *
 * Usage: `npm run measure`
 * @module dsh-context-compaction-optimizer/scripts/measure-cache
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const DSH_HOME = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
const SESSIONS_ROOT = join(DSH_HOME, 'sessions');
const RPC = 'http://127.0.0.1:3080/cco/api';

/** One decoded session log. */
interface SessionLog {
  readonly id: string;
  readonly events: readonly Record<string, unknown>[];
}

/** Decode one multi-frame zstd log into its JSONL events. */
function decodeLog(file: string): Record<string, unknown>[] {
  const buffer = readFileSync(file);
  const frames: number[] = [];
  for (let index = 0; index + 4 <= buffer.byteLength; index += 1) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) {
      frames.push(index);
    }
  }
  const parts: string[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const slice = buffer.subarray(frames[index], index + 1 < frames.length ? frames[index + 1] : buffer.byteLength);
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'));
    } catch {
      /* a partial trailing frame is not fatal */
    }
  }
  const events: Record<string, unknown>[] = [];
  for (const line of parts.join('').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return events;
}

/**
 * Every session log under the sessions root.
 *
 * The layout is two levels deep — `sessions/<escaped-workspace>/<session-id>/` —
 * so this walks rather than assuming one level.
 */
function listLogs(): SessionLog[] {
  const out: SessionLog[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes('session.v3.jsonl.zstd')) {
      const id = dir.replace(/\\/g, '/').replace(/^.*\/(session-[0-9a-f-]+)$/, '$1');
      out.push({ id, events: decodeLog(join(dir, 'session.v3.jsonl.zstd')) });
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry);
      try {
        if (statSync(child).isDirectory()) walk(child, depth + 1);
      } catch {
        /* skip */
      }
    }
  };
  walk(SESSIONS_ROOT, 0);
  return out;
}

/** Text of one message-shaped event, or `''`. */
function messageText(event: Record<string, unknown>): string {
  const type = event['type'];
  const data = (event['data'] ?? {}) as Record<string, unknown>;
  const message = (type === 'user/message' ? data : (data['message'] ?? {})) as Record<string, unknown>;
  const content = message['content'];
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    // Reasoning is model-internal; it is not what an operator recognises, and
    // including it would make every leak candidate list noisy.
    if (record['type'] === 'reasoning') continue;
    if (typeof record['text'] === 'string') parts.push(record['text']);
    else if (Array.isArray(record['content'])) parts.push(JSON.stringify(record['content']));
  }
  return parts.join('');
}

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

/** One measured compaction. */
interface Measurement {
  readonly sessionId: string;
  readonly seq: number;
  /** Host-clock time of the `compaction/summary` event, for observer pairing. */
  readonly time: number | undefined;
  readonly shadowedCount: number;
  readonly shadowedTokens: number | undefined;
  readonly summaryChars: number;
  readonly uncachedInput: number | undefined;
  readonly cacheRead: number | undefined;
  readonly outputTokens: number | undefined;
  readonly summaryText: string;
  readonly shadowedSeqs: readonly number[];
  /** Durable id of each shadowed message, for the annotation join. */
  readonly shadowedIds: ReadonlyMap<number, string>;
  readonly shadowedText: ReadonlyMap<number, string>;
}

function messageIdOf(event: Record<string, unknown>): string | null {
  const data = (event['data'] ?? {}) as Record<string, unknown>;
  const message = (event['type'] === 'user/message' ? data : (data['message'] ?? {})) as Record<string, unknown>;
  const id = message['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function measure(log: SessionLog): Measurement[] {
  const bySeq = new Map<number, Record<string, unknown>>();
  for (const event of log.events) {
    const seq = event['seq'];
    if (typeof seq === 'number') bySeq.set(seq, event);
  }
  const out: Measurement[] = [];
  for (const event of log.events) {
    if (event['type'] !== 'compaction/summary') continue;
    const data = (event['data'] ?? {}) as Record<string, unknown>;
    const usage = (data['usage'] ?? {}) as Record<string, unknown>;
    const shadowedSeqs = Array.isArray(data['shadowedSeqs'])
      ? (data['shadowedSeqs'] as unknown[]).filter((value): value is number => typeof value === 'number')
      : [];
    const shadowed = new Set(shadowedSeqs);

    const checkpoint = log.events.find(
      (candidate) =>
        candidate['type'] === 'user/message' &&
        typeof candidate['seq'] === 'number' &&
        (candidate['seq'] as number) > (event['seq'] as number) &&
        messageText(candidate).includes('automatically generated checkpoint'),
    );

    const shadowedIds = new Map<number, string>();
    const shadowedText = new Map<number, string>();
    for (const seq of shadowedSeqs) {
      const candidate = bySeq.get(seq);
      if (candidate === undefined) continue;
      const id = messageIdOf(candidate);
      if (id !== null) shadowedIds.set(seq, id);
      shadowedText.set(seq, messageText(candidate));
    }

    out.push({
      sessionId: log.id,
      seq: event['seq'] as number,
      time: typeof event['time'] === 'number' ? (event['time'] as number) : undefined,
      shadowedCount: shadowedSeqs.length,
      shadowedTokens: typeof data['shadowedTokenCount'] === 'number' ? data['shadowedTokenCount'] : undefined,
      summaryChars: messageText(checkpoint ?? {}).length,
      uncachedInput: typeof usage['inputTokens'] === 'number' ? usage['inputTokens'] : undefined,
      cacheRead: typeof usage['cacheReadTokens'] === 'number' ? usage['cacheReadTokens'] : undefined,
      outputTokens: typeof usage['outputTokens'] === 'number' ? usage['outputTokens'] : undefined,
      summaryText: messageText(checkpoint ?? {}),
      shadowedSeqs,
      shadowedIds,
      shadowedText,
    });
  }
  return out;
}

/** CJK runs and long ASCII tokens: the units a leak is visible in. */
function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.match(/[\u4e00-\u9fff]{2,12}/g) ?? []) {
    for (let size = Math.min(4, run.length); size >= 2; size -= 1) {
      for (let at = 0; at + size <= run.length; at += 1) out.add(run.slice(at, at + size));
    }
  }
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9._/-]{5,}/g) ?? []) {
    // Trailing punctuation is not part of the token. The checkpoint truncates
    // with an ellipsis (`https://harrypotter.fandom.com/...`), and keeping those
    // dots turned the prefix comparison against the full URL into a mismatch —
    // which is exactly how N038's leak escaped the first audit.
    out.add(raw.replace(/[._/-]+$/, '').toLowerCase());
  }
  return out;
}

/** Whether two ASCII tokens are the same word up to truncation. */
function sameToken(left: string, right: string): boolean {
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  // Six is short enough to catch a truncation like `harrypotter.fandom.com/` and
  // long enough that `context` vs `contextual` is the kind of coincidence a
  // candidate list can afford.
  return short.length >= 6 && long.startsWith(short);
}

function isAsciiToken(term: string): boolean {
  return /^[a-z]/.test(term);
}

/**
 * Terms the checkpoint shares with **excluded** content and with nothing that
 * was kept.
 *
 * The comparison set is the shadowed-but-*unmarked* messages, not "everything
 * outside the shadowed range": the summarization input holds only shadowed
 * messages, so a term from a kept excerpt is not evidence of anything. Getting
 * this wrong made the first version of this report flag the *unmarked* novels'
 * own URLs.
 *
 * ASCII tokens match by prefix, because the checkpoint truncates: N038's leak
 * survived as `harrypotter.fandom.com/` while the excluded message held the full
 * path, and exact comparison missed it.
 *
 * A candidate, not a verdict: a term the model invented that happens to occur in
 * excluded content is indistinguishable from one it copied. Printing them for a
 * human to read is the honest job.
 */
function leakCandidates(measurement: Measurement, marked: ReadonlySet<string>): string[] | null {
  if (measurement.summaryText.length === 0) return [];
  let excludedText = '';
  let retainedText = '';
  for (const seq of measurement.shadowedSeqs) {
    const text = measurement.shadowedText.get(seq) ?? '';
    const id = measurement.shadowedIds.get(seq);
    if (id !== undefined && marked.has(id)) excludedText += text;
    else retainedText += text;
  }
  if (excludedText.length === 0) return null;

  const summaryTerms = [...terms(measurement.summaryText)];
  const excludedTerms = [...terms(excludedText)];
  const retainedTerms = [...terms(retainedText)];
  const found: string[] = [];
  for (const term of summaryTerms) {
    // Short CJK fragments are unavoidable noise: overlapping 2-grams of the
    // model's own phrasing collide with any excluded text by chance.
    if (!isAsciiToken(term) && term.length < 3) continue;

    const matches = (pool: readonly string[]): boolean =>
      isAsciiToken(term)
        ? pool.some((other) => isAsciiToken(other) && sameToken(term, other))
        : pool.includes(term);

    if (matches(retainedTerms)) continue;
    if (matches(excludedTerms)) found.push(term);
  }
  // Report the longest few: a short leak is almost always implied by a longer
  // one, and a readable list is what makes the audit usable.
  return [...new Set(found)].sort((a, b) => b.length - a.length).slice(0, 8);
}

async function fetchAnnotations(sessionId: string): Promise<Set<string> | null> {
  try {
    const response = await fetch(`${RPC}?method=annotations.list&sessionId=${encodeURIComponent(sessionId)}`);
    const body = (await response.json()) as { ok?: boolean; value?: { records?: { messageId: string; status: string }[] } };
    if (body.ok !== true) return null;
    const records = body.value?.records ?? [];
    return new Set(records.filter((record) => record.status === 'invalid').map((record) => record.messageId));
  } catch {
    return null;
  }
}

/** One digest injection as the plugin recorded it. */
interface InjectionRecord {
  readonly at: number;
  readonly sessionId: string;
  readonly format: string;
  readonly entryCount: number;
  readonly digestChars: number;
}

async function fetchInjections(): Promise<readonly InjectionRecord[] | null> {
  try {
    const response = await fetch(`${RPC}?method=diagnostics.snapshot`);
    const body = (await response.json()) as { ok?: boolean; value?: { observer?: { injections?: InjectionRecord[] } } };
    if (body.ok !== true) return null;
    return body.value?.observer?.injections ?? null;
  } catch {
    return null;
  }
}

/**
 * The injection that produced one compaction's digest.
 *
 * The observer keys injections by session and wall-clock instant, and the log
 * keys the summary by the same clock, so the **latest injection for that session
 * at or before the summary** is the one that fed it. Chosen over positional
 * pairing because a session can carry failed attempts that injected and never
 * summarised.
 */
function pairInjection(
  injections: readonly InjectionRecord[] | null,
  measurement: Measurement,
): InjectionRecord | undefined {
  if (injections === null || measurement.time === undefined) return undefined;
  let best: InjectionRecord | undefined;
  for (const injection of injections) {
    if (injection.sessionId !== measurement.sessionId) continue;
    if (injection.at > measurement.time) continue;
    if (best === undefined || injection.at > best.at) best = injection;
  }
  return best;
}

function pct(part: number | undefined, whole: number | undefined): string {
  if (part === undefined || whole === undefined || whole === 0) return '—';
  return `${((part / whole) * 100).toFixed(2)}%`;
}

const logs = listLogs();
const measurements = logs.flatMap(measure).sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.seq - b.seq);
const injections = await fetchInjections();

console.log('# 压缩缓存实测报告\n');
console.log(`数据源: ${SESSIONS_ROOT}`);
console.log(`会话日志: ${logs.length}    完成的压缩: ${measurements.length}`);
console.log(
  injections === null
    ? '清单侧读数: 不可用（`diagnostics.snapshot` 取不到——宿主未运行或该方法不可达）\n'
    : `清单侧读数: 观察器中 ${injections.length} 条注入记录\n`,
);

if (measurements.length === 0) {
  console.log('没有可测量的压缩记录。先跑一次真实压缩再重新运行。');
  process.exit(0);
}

console.log(
  '| 会话 | seq | 遮蔽条数 | 遮蔽 token | 摘要字符 | 清单字符 | 格式 | 未缓存 input | cacheRead | 命中率 | 输出 token |',
);
console.log('| :--- | ---: | ---: | ---: | ---: | ---: | :--- | ---: | ---: | ---: | ---: |');
for (const m of measurements) {
  const total = (m.uncachedInput ?? 0) + (m.cacheRead ?? 0);
  const injection = pairInjection(injections, m);
  console.log(
    `| ${m.sessionId.slice(0, 20)}… | ${m.seq} | ${m.shadowedCount} | ${m.shadowedTokens ?? '—'} | ${m.summaryChars} | ${
      injection?.digestChars ?? '—'
    } | ${injection?.format ?? '—'} | ${m.uncachedInput ?? '—'} | ${m.cacheRead ?? '—'} | ${pct(m.cacheRead, total)} | ${
      m.outputTokens ?? '—'
    } |`,
  );
}

const withUsage = measurements.filter((m) => m.cacheRead !== undefined && m.uncachedInput !== undefined);
if (withUsage.length > 0) {
  console.log('\n## 发版门槛怎么读\n');
  console.log('**不要用命中率的绝对值**。命中率由提供方缓存的存活状态主导——一次长时间空闲后的压缩读不到任何缓存，');
  console.log('与清单无关（表中 `session-1003d64e… seq=2596` 的 2.65% 就是这种冷缓存，它的清单很小，未缓存输入却高达 69 万）。\n');
  console.log('该门槛真正要守的是 **N006 的结论：追加清单只增加「清单自身」的未缓存输入**，前缀命中不因此下降。');
  console.log('因此判读方式是看 `未缓存 input` 是否约等于「常规调用开销 + 清单字符数 / 3.5」。');
  console.log('配对照跑（同一会话、同一模型，有/无清单各一次）比看绝对值可靠。\n');
}

console.log('\n## 泄漏候选（需人工判读）\n');
console.log('判定口径：某词出现在检查点、出现在**被标记**的消息、且**未**出现在同一遮蔽区内未标记的消息中。');
console.log('对照集只能是「遮蔽但未标记」——摘要输入里只有遮蔽区，拿区外内容当对照会把未标记素材本身误报成泄漏。');
console.log('CJK 只判读 ≥3 字符的词（短碎片是模型自造句与任意文本的偶然碰撞）；ASCII token 按**前缀**匹配（≥6 字符），');
console.log('因为检查点会截断——N038 的泄漏以 `harrypotter.fandom.com/...` 存活，全等匹配漏掉了它。\n');
let candidateRows = 0;
let skipped = 0;
for (const m of measurements) {
  const marked = await fetchAnnotations(m.sessionId);
  if (marked === null) {
    skipped += 1;
    continue;
  }
  const candidates = leakCandidates(m, marked);
  if (candidates === null) {
    skipped += 1;
    continue;
  }
  if (candidates.length === 0) continue;
  candidateRows += 1;
  console.log(
    `- **${m.sessionId.slice(0, 20)}… seq=${m.seq}**（已标记 ${marked.size} 条）: ${candidates
      .map((term) => JSON.stringify(term))
      .join(', ')}`,
  );
}
if (candidateRows === 0) console.log('- 无。');
if (skipped > 0) {
  console.log(
    `\n_${skipped} 次压缩未做泄漏判读_：标注需经 RPC 读取，而该会话已不在内存中（重启后或非活动会话）。` +
      '要在这些记录上跑审计，需在压缩后**保持宿主不重启**再运行本工具。',
  );
}
