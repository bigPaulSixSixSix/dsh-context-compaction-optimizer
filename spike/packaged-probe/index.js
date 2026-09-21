/**
 * Packaging probe (development aid, NOT a shipped entry point).
 *
 * M0 validated the injection mechanism exclusively through *dynamic* Cordis
 * plugins, which are mounted by `dsh-cordis-host-runner` into a context that
 * runner creates. A shipped plugin is loaded by a different path entirely:
 * `cordis-plugin-loader` reads the profile's composed config, imports the
 * package's entry module, and builds a fiber in the profile's context tree.
 *
 * Those two paths can differ in ways that matter, and nothing had tested it:
 *
 *  1. Does a profile-level fiber's `ctx.on('llm/stream', ...)` receive the
 *     model calls of live agent sessions at all?
 *  2. On that path, is `GenerateOptions.messages` still assignable?
 *
 * Both are load-bearing for the whole plugin, so this probe answers them before
 * any production code depends on the answer.
 *
 * It is deliberately plain ESM JavaScript with no build step, and it exports the
 * `{ name, inject, apply }` namespace shape that first-party packages such as
 * `@deepseek-ai/dsh-storage-domain` use — the shape the loader is known to
 * accept.
 *
 * Readout is a read-only route at `/ccopkg`.
 */

const state = {
  probe: 'cco-packaging-probe',
  mountedAt: new Date().toISOString(),
  loadPath: 'profile cordis.patch.yml insert',
  services: {},
  globals: {},
  llmStreamTotal: 0,
  compactionCalls: [],
  otherCalls: { count: 0, purposes: {} },
  errors: [],
}

function errText(error) {
  if (error === null || error === undefined) return 'nullish'
  if (typeof error === 'string') return error
  if (error.message) return String(error.message)
  return String(error)
}

function ctorName(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  try {
    const ctor = value.constructor
    if (ctor && typeof ctor.name === 'string' && ctor.name.length > 0) return ctor.name
  } catch {
    /* ignore */
  }
  return typeof value
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  let out = ''
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

function collectProbe(ctx) {
  const names = [
    'compaction',
    'agents',
    'sessions',
    'llm',
    'tokenMeter',
    'storageDomain',
    'settings',
    'commands',
    'webServer',
    'sessionQuery',
    'loader',
  ]
  const services = {}
  for (const name of names) {
    let value
    try {
      value = ctx.get(name)
    } catch (error) {
      services[name] = 'THREW: ' + errText(error)
      continue
    }
    if (value === undefined) {
      services[name] = 'undefined'
      continue
    }
    const entry = { type: ctorName(value) }
    if (name === 'compaction') entry.hasCompactNow = typeof value.compactNow
    if (name === 'settings') entry.hasRegister = typeof value.register
    if (name === 'webServer') entry.hasRegister = typeof value.register
    services[name] = entry
  }
  state.services = services
  state.globals = {
    AbortController: typeof AbortController,
    setTimeout: typeof setTimeout,
    require: typeof require,
    process: typeof process,
  }
}

export const name = 'cco-packaging-probe'

export const inject = ['timer']

export function apply(ctx) {
  collectProbe(ctx)

  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    state.errors.push('webServer unavailable; no readout channel')
  } else {
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: '/ccopkg',
        handler: (req, res) => {
          try {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(state, null, 2))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('probe readout failed: ' + errText(error))
          }
        },
      }),
    )
  }

  // The decisive listener: does a profile-level fiber see model calls?
  ctx.on('llm/stream', (options, next) => {
    try {
      state.llmStreamTotal += 1
      if (options && options.purpose === 'compaction') {
        const messages = Array.isArray(options.messages) ? options.messages : []
        let mutable = false
        try {
          options.messages = messages
          mutable = true
        } catch (error) {
          state.errors.push('mutability probe: ' + errText(error))
        }
        state.compactionCalls.push({
          at: new Date().toISOString(),
          provider: options.provider,
          model: options.model,
          messageCount: messages.length,
          messagesMutable: mutable,
          markedIndexes: messages
            .map((message, index) => (textOf(message).indexOf('CCO_SPIKE_MARK') >= 0 ? index : -1))
            .filter((index) => index >= 0),
        })
      } else if (options) {
        state.otherCalls.count += 1
        const purpose = typeof options.purpose === 'string' ? options.purpose : '(unset)'
        state.otherCalls.purposes[purpose] = (state.otherCalls.purposes[purpose] || 0) + 1
      }
    } catch (error) {
      state.errors.push('llm/stream: ' + errText(error))
    }
    return next()
  })

  ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return
      state.lastSessionEvent = event.type
    } catch {
      /* ignore */
    }
  })

  console.log('[cco-packaging-probe] mounted via profile patch; readout at /ccopkg')
}

export default { name, inject, apply }
