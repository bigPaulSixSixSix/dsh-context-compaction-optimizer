/**
 * Client copy.
 *
 * The harness ships Chinese and English (`LOCALE_IDS = ['zh', 'en']`), and a
 * plugin's own strings are registered through `ctx.locale.register(ns, { zh, en })`
 * inside an effect, then requested by passing `locale: ns` at slot registration —
 * which is what makes the slot hand the component a `t`.
 *
 * Both dictionaries must carry exactly the same key set; {@link LOCALE_KEYS} is
 * asserted against both so a forgotten translation fails a test rather than
 * silently showing a raw key in one language.
 *
 * @module dsh-context-compaction-optimizer/client/locale
 */

/** Locale namespace this plugin registers. */
export const NS = 'context-compaction-optimizer';

const zh = {
  'action.markInvalid': '标记为无效',
  'action.unmark': '取消标记',
  'action.waiting.loading': '正在等待会话加载，稍后即可标注',
  'action.waiting.session': '宿主尚未加载此会话，暂时无法标注',
  'action.waiting.failed': '标注不可用：会话表面读取失败',
  'action.checking': '正在核对这条消息是否在当前会话表面上…',
  'action.compacted': '此消息已被压缩进检查点，标注不会生效',
  'panel.trigger': '压缩标注',
  'panel.title': '压缩标注',
  'panel.reload': '刷新',
  'panel.clear': '全部清除',
  'panel.close': '关闭',
  'panel.loading': '加载中…',
  'panel.empty': '当前会话没有可标注的回合',
  'panel.sessionNotLoaded': '宿主尚未加载此会话，因此读不到可标注的回合。',
  'panel.noId': '无标识',
  'panel.noText': '无文本内容',
  'panel.turns': '回合',
  'panel.you': '你',
  'panel.steps': '{n} 步',
  'panel.expand': '展开步骤',
  'panel.collapse': '收起步骤',
  'panel.forecast': '本次压缩将排除 {n} 个回合，保留 {m} 个',
  'panel.forecastNote':
    '压缩只摘要较早的部分：DSH 会把最近的上下文逐字保留、不送进摘要器，因此这部分即使被标记也不会被排除。',
  'panel.retentionIgnored': '另有 {n} 个回合的标记未生效——它们位于被逐字保留的最近上下文里。',
  'panel.confirmCompact': '确认压缩',
  'panel.compacting': '压缩中…',
  'panel.compactHint': '确认只影响本次压缩；标注本身不会删除任何消息。',
  'panel.hint': '被标记为无效的回合不会进入压缩摘要（被逐字保留的最近上下文除外）。',
  'stat.invalid': '无效',
  'stat.valid': '有效',
  'stat.unmarked': '未标记',
  'settings.title': '压缩优化器',
  'settings.inject.title': '将标注注入压缩',
  'settings.inject.hint':
    '压缩发生时，在末尾追加一份清单，指明哪些消息已被标记为无效。标注只在压缩真正发生时生效，且不会改写会话——清单追加在已缓存前缀之后，摘要调用仍能复用提供方缓存。',
  'settings.policy.title': '将未标记的消息视为无效',
  'settings.policy.hint':
    '只影响没有任何标注的消息。开启后，一段从未标注过的会话在压缩时会排除全部内容，因此默认关闭。',
  'settings.observe.title': '记录缓存核算',
  'settings.observe.hint': '为每次压缩保留 token 与缓存命中数据，供诊断快照读取。',
  'error.load': '标注加载失败',
  'error.save': '标注保存失败',
} as const;

const en: Record<keyof typeof zh, string> = {
  'action.markInvalid': 'Mark as invalid',
  'action.unmark': 'Unmark',
  'action.waiting.loading': 'Waiting for the session to load; annotation will follow',
  'action.waiting.session': 'The host has not loaded this session, so it cannot be annotated yet',
  'action.waiting.failed': 'Annotations unavailable: the session surface could not be read',
  'action.checking': 'Checking whether this message is on the current session surface…',
  'action.compacted': 'This message was folded into a compaction checkpoint; marking it has no effect',
  'panel.trigger': 'Annotations',
  'panel.title': 'Annotations',
  'panel.reload': 'Reload',
  'panel.clear': 'Clear all',
  'panel.close': 'Close',
  'panel.loading': 'Loading…',
  'panel.empty': 'No annotatable turns in this session',
  'panel.sessionNotLoaded': 'The host has not loaded this session, so its turns cannot be read.',
  'panel.noId': 'no id',
  'panel.noText': 'no text content',
  'panel.turns': 'turns',
  'panel.you': 'you',
  'panel.steps': '{n} steps',
  'panel.expand': 'Expand steps',
  'panel.collapse': 'Collapse steps',
  'panel.forecast': 'This compaction will drop {n} turn(s) and keep {m}',
  'panel.forecastNote':
    'Only the earlier part is summarized: DSH keeps the most recent context verbatim and never sends it to the summarizer, so marking it has no effect.',
  'panel.retentionIgnored':
    'A further {n} marked turn(s) had no effect — they sit in the verbatim-retained recent context.',
  'panel.confirmCompact': 'Compact now',
  'panel.compacting': 'Compacting…',
  'panel.compactHint': 'Confirming affects this compaction only; annotations never delete anything.',
  'panel.hint':
    'Turns marked invalid are left out of the compaction checkpoint — except those in the verbatim-retained recent context.',
  'stat.invalid': 'invalid',
  'stat.valid': 'valid',
  'stat.unmarked': 'unmarked',
  'settings.title': 'Compaction optimizer',
  'settings.inject.title': 'Inject annotations into compaction',
  'settings.inject.hint':
    'When a compaction runs, append a digest naming the messages marked invalid. Marking takes effect only when a compaction actually happens, and it never rewrites the conversation — the digest is appended after the cached prefix, so the summarization call still reuses the provider cache.',
  'settings.policy.title': 'Treat unmarked messages as invalid',
  'settings.policy.hint':
    'Applies only to messages nobody has annotated. With this on, a never-annotated conversation excludes everything from the checkpoint, so it is off by default.',
  'settings.observe.title': 'Record cache accounting',
  'settings.observe.hint':
    'Keep per-compaction token and cache-read figures for the diagnostics snapshot.',
  'error.load': 'Could not load annotations',
  'error.save': 'Could not save the annotation',
};

/** Every key the plugin can request. */
export const LOCALE_KEYS = Object.keys(zh) as readonly (keyof typeof zh)[];

/** Dictionaries handed to `ctx.locale.register`. */
export const dictionaries = { zh, en };

/** Translate one key, falling back to the key itself. */
export type Translate = (key: string) => string;

/** Build a translator from the `t` a slot provides, or an identity fallback. */
export function translator(t: ((key: string) => string) | undefined): Translate {
  return (key: string) => (t === undefined ? (en as Record<string, string>)[key] ?? key : t(key));
}
