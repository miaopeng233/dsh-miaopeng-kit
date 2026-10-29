/**
 * dsh-miaopeng-kit — host half.
 *
 *   1. `/autocompact <size>`：一条命令统一设置自动压缩阈值（例如 400K）。
 *      dsh-compaction-basic 只认窗口比例，所以这里按每个模型的窗口 W 换算出
 *      `modelPolicies[].thresholdRatio = size / W`，写回 profile patch 里
 *      compaction-basic 那一段，宿主 HMR 监听该文件并自动热重载。
 *      窗口本来就比 size 小的模型保持默认（0.8W），不会更晚压缩。
 *   2. 上下文环按「压缩阈值」显示：包装 token-meter 的 contextPressure 视图，
 *      把发给前端的 contextWindow 换成有效阈值。环、百分比、弹层里的
 *      「~120K / 400K」都由宿主原生组件渲染，不碰 DOM。
 *   3. `/dsh-miaopeng-kit/models` 路由：给前端选择器提供每个模型的窗口与阈值。
 *   4. 窗口尺寸记忆：主进程补丁只能在应用退出后打（app.asar 运行时被占用），
 *      所以启动时起一个分离的等待进程，退出后打补丁，下次启动生效。
 *
 * 设置保存在 ~/.dsh/dsh-miaopeng-kit/settings.json（跨重载保留，不写进插件目录）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-miaopeng-kit'

/** 与 dsh-compaction-basic 的默认值保持一致。 */
const DEFAULT_THRESHOLD_RATIO = 0.8
const DEFAULT_HEADROOM = 65536
/** 压缩后逐字保留的近期对话，占阈值的比例。 */
const RETAIN_SHARE = 0.2

const ROUTE_PREFIX = '/dsh-miaopeng-kit'
const COMPACTION_ID = 'compaction-basic'

function settingsPath(ctx) {
  const resolvePath = ctx.get('dshHomePath')
  if (typeof resolvePath === 'function') return resolvePath('dsh-miaopeng-kit', 'settings.json')
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-miaopeng-kit', 'settings.json')
}

function readSettings(ctx, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(settingsPath(ctx), 'utf8')) }
  } catch {
    return { ...fallback }
  }
}

function writeSettings(ctx, settings) {
  const path = settingsPath(ctx)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}

/**
 * 解析命令参数。
 * @returns {{ mode: 'tokens', tokens: number } | { mode: 'ratio', ratio: number } | { mode: 'off' } | { mode: 'default' } | { mode: 'status' } | null}
 */
export function parseSize(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === '' || text === 'status') return { mode: 'status' }
  if (text === 'off' || text === '关' || text === '关闭') return { mode: 'off' }
  if (text === 'default' || text === 'reset' || text === '默认') return { mode: 'default' }
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text)
  if (percent !== null) {
    const ratio = Number(percent[1]) / 100
    return ratio > 0.05 && ratio < 1 ? { mode: 'ratio', ratio } : null
  }
  const size = /^(\d+(?:\.\d+)?)\s*(k|m)?$/.exec(text.replace(/[,_]/g, ''))
  if (size === null) return null
  const scale = size[2] === 'm' ? 1e6 : size[2] === 'k' ? 1e3 : 1
  const tokens = Math.round(Number(size[1]) * scale)
  return tokens >= 16000 ? { mode: 'tokens', tokens } : null
}

export function formatTokens(value) {
  if (value >= 1e6) return `${Math.round(value / 1e5) / 10}M`
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`
  return String(value)
}

/** 默认策略下的阈值：floor(min(W × 0.8, W − O − B))。 */
function defaultThreshold(window, output) {
  return Math.floor(Math.min(window * DEFAULT_THRESHOLD_RATIO, window - output - DEFAULT_HEADROOM))
}

/** 给定设置，一个模型的有效阈值。 */
export function effectiveThreshold(setting, window, output = 0) {
  const base = defaultThreshold(window, output)
  if (setting.mode === 'tokens') return Math.max(1, Math.min(setting.tokens, base))
  if (setting.mode === 'ratio') return Math.max(1, Math.floor(Math.min(window * setting.ratio, window - output - DEFAULT_HEADROOM)))
  return Math.max(1, base)
}

/** 一个模型需要的覆盖策略；不需要覆盖时返回 undefined。 */
function policyFor(setting, provider, model, window, output) {
  if (setting.mode !== 'tokens') return undefined
  if (setting.tokens >= defaultThreshold(window, output)) return undefined
  const floor6 = (value) => Math.floor(value * 1e6) / 1e6
  const thresholdRatio = floor6(setting.tokens / window)
  const retainRatio = floor6((setting.tokens * RETAIN_SHARE) / Math.max(1, window - output))
  if (!(retainRatio < thresholdRatio)) return undefined
  return { provider, model, thresholdRatio, retainRatio }
}

export function apply(ctx, config = {}) {
  const fallback = parseSize(config.autocompact ?? '400K')
  const initial = fallback === null || fallback.mode === 'status' ? { mode: 'tokens', tokens: 400000 } : fallback
  let setting = readSettings(ctx, { autocompact: initial }).autocompact
  const log = (message) => ctx.logger?.info?.(`dsh-miaopeng-kit: ${message}`)
  const warn = (message, error) => ctx.logger?.warn?.(`dsh-miaopeng-kit: ${message}${error ? `: ${error?.message ?? error}` : ''}`)

  /** 最近一次同步的结果，经 /dsh-miaopeng-kit/models 暴露，便于排查。 */
  let lastSync = { state: 'pending' }

  /** 已知模型：provider/model → { window, output, name, providerName }。 */
  let catalog = new Map()
  /** 窗口 → 输出预留，用于在没有模型身份的投影视图里估算阈值。 */
  let outputByWindow = new Map()

  async function scanModels() {
    const llm = ctx.get('llm')
    if (llm === undefined) return catalog
    const next = new Map()
    const outputs = new Map()
    for (const provider of llm.listProviders()) {
      let models = []
      try {
        models = await llm.listModels(provider.id)
      } catch (error) {
        warn(`listModels(${provider.id}) failed`, error)
        continue
      }
      await Promise.all(models.map(async (model) => {
        try {
          const info = await llm.resolveModelInfo(provider.id, model.id)
          const window = info.context?.contextWindow
          if (!Number.isInteger(window)) return
          const output = info.defaultMaxTokens ?? 0
          next.set(`${provider.id}/${model.id}`, {
            provider: provider.id,
            providerName: provider.name ?? provider.displayName ?? provider.id,
            id: model.id,
            name: model.name,
            window,
            output,
            efforts: Array.isArray(info.reasoning?.efforts) ? info.reasoning.efforts.map((effort) => effort?.id ?? String(effort)) : [],
          })
          if (!outputs.has(window) || outputs.get(window) < output) outputs.set(window, output)
        } catch {
          // 单个模型解析失败不影响其他模型。
        }
      }))
    }
    catalog = next
    outputByWindow = outputs
    return catalog
  }

  /** 把当前设置写成 compaction-basic 的配置。 */
  async function syncCompaction() {
    lastSync = { state: 'running', at: new Date().toISOString() }
    try {
      const count = await syncCompactionInner()
      lastSync = { state: 'ok', at: new Date().toISOString(), policies: count }
      return count
    } catch (error) {
      lastSync = { state: 'error', at: new Date().toISOString(), error: String(error?.stack ?? error) }
      throw error
    }
  }

  /**
   * compaction-basic 在根层没有常驻 fiber，configEditor 编辑不了它；所以直接改写
   * profile patch 里属于它的那一段（其余内容和注释原样保留），宿主 HMR 监听这个
   * 文件，写入后会自动重新组合，无需重启。
   */
  async function syncCompactionInner() {
    const patchPath = ctx.get('profileContext')?.patchPath
    if (typeof patchPath !== 'string') throw new Error('找不到 profile patch（profileContext 不可用）')
    await scanModels()
    const policies = []
    for (const model of catalog.values()) {
      const policy = policyFor(setting, model.provider, model.id, model.window, model.output)
      if (policy !== undefined) policies.push(policy)
    }
    policies.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))

    const config = []
    if (setting.mode === 'off') config.push('    auto: false')
    if (setting.mode === 'ratio') {
      config.push(`    thresholdRatio: ${setting.ratio}`)
      config.push(`    retainRatio: ${Math.floor(setting.ratio * RETAIN_SHARE * 1e6) / 1e6}`)
    }
    if (policies.length > 0) {
      config.push('    modelPolicies:')
      for (const policy of policies) {
        config.push(`      - provider: ${JSON.stringify(policy.provider)}`)
        config.push(`        model: ${JSON.stringify(policy.model)}`)
        config.push(`        thresholdRatio: ${policy.thresholdRatio}`)
        config.push(`        retainRatio: ${policy.retainRatio}`)
      }
    }
    const block = [
      `- id: ${COMPACTION_ID}`,
      '  name: "@deepseek-ai/dsh-compaction-basic"',
      ...(config.length > 0 ? ['  config:', ...config] : []),
    ].join('\n')

    const original = readFileSync(patchPath, 'utf8')
    const normalized = original.replace(/\r\n/g, '\n')
    const before = normalized.endsWith('\n') ? normalized : `${normalized}\n`
    // 这一段：从 "- id: compaction-basic" 起，到下一个顶层条目或顶层注释为止。
    const pattern = new RegExp(`^- id: ${COMPACTION_ID}\\n(?:(?:  .*|\\s*)\\n)*?(?=^[-#]|(?![\\s\\S]))`, 'm')
    const after = pattern.test(before)
      ? before.replace(pattern, `${block}\n`)
      : `${before.replace(/\n*$/, '\n')}${block}\n`
    if (after === original) return policies.length
    const temporary = `${patchPath}.dsh-miaopeng-kit.tmp`
    writeFileSync(temporary, after)
    renameSync(temporary, patchPath)
    return policies.length
  }

  function describe() {
    if (setting.mode === 'off') return '自动压缩：已关闭（只能手动 /compact）'
    if (setting.mode === 'default') return '自动压缩：默认（窗口的 80%）'
    if (setting.mode === 'ratio') return `自动压缩：窗口的 ${Math.round(setting.ratio * 100)}%`
    return `自动压缩：${formatTokens(setting.tokens)}（窗口更小的模型按 80% 提前压缩）`
  }

  // 1. /autocompact 命令
  ctx.inject(['commands'], (scope) => {
    scope.effect(function* () {
      yield scope.commands.register({
        name: 'autocompact',
        description: '设置自动压缩阈值，例如 /autocompact 400K、/autocompact 40%、/autocompact off',
        input: { hint: '400K | 1M | 40% | off | default' },
        handler: async (invocation) => {
          const parsed = parseSize(invocation.rawInput)
          if (parsed === null) {
            return { kind: 'error', text: '用法：/autocompact 400K（也可以 1M、250000、40%、off、default）' }
          }
          if (parsed.mode === 'status') {
            const lines = [describe()]
            for (const model of [...catalog.values()].slice(0, 40)) {
              lines.push(`· ${model.providerName} / ${model.name}：窗口 ${formatTokens(model.window)} → 压缩于 ${formatTokens(effectiveThreshold(setting, model.window, model.output))}`)
            }
            return { kind: 'success', text: lines.join('\n') }
          }
          const previous = setting
          setting = parsed
          try {
            writeSettings(ctx, { autocompact: setting })
            const count = await syncCompaction()
            return { kind: 'success', text: `${describe()}；已为 ${count} 个模型写入覆盖策略，立即生效。上下文环会在下一次请求后按新阈值显示。` }
          } catch (error) {
            setting = previous
            writeSettings(ctx, { autocompact: setting })
            return { kind: 'error', text: `设置失败：${error?.message ?? error}` }
          }
        },
      })
    }, 'dsh-miaopeng-kit: /autocompact')
  })

  // 2. 上下文环按阈值显示
  ctx.inject(['sessionProjections'], (scope) => {
    const thresholdOf = (window) => effectiveThreshold(setting, window, outputByWindow.get(window) ?? 0)
    let wrapped
    let original
    let target
    const install = () => {
      const registration = scope.sessionProjections.registrations?.get?.('contextPressure')
      const wire = registration?.def?.wire
      if (wire === undefined || wire.view === wrapped) return
      original = wire.view
      target = wire
      const inner = original
      wrapped = (state) => {
        const view = inner(state)
        const window = view?.contextWindow
        if (!Number.isInteger(window)) return view
        const threshold = thresholdOf(window)
        return threshold > 0 && threshold < window ? { ...view, contextWindow: threshold } : view
      }
      wire.view = wrapped
    }
    install()
    // 启动时 token-meter 可能还没注册 contextPressure，而前端一连上就会拉快照，
    // 晚装一步就会显示成按窗口计算；所以前 30 秒每 250ms 检查一次，之后每 10 秒一次
    // （token-meter 热重载会换掉定义）。检查本身是 O(1)。
    let timer
    const startedAt = Date.now()
    const tick = () => {
      install()
      timer = setTimeout(tick, Date.now() - startedAt < 30000 ? 250 : 10000)
      timer.unref?.()
    }
    tick()
    scope.effect(() => () => {
      clearTimeout(timer)
      if (target !== undefined && target.view === wrapped) target.view = original
    }, 'dsh-miaopeng-kit: context ring threshold')
  })

  // 3. 前端用的模型数据
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/models`,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' })
            res.end()
            return
          }
          const send = (models) => {
            const body = Buffer.from(JSON.stringify({
              setting,
              lastSync,
              models: [...models.values()].map((model) => ({
                provider: model.provider,
                providerName: model.providerName,
                id: model.id,
                name: model.name,
                contextWindow: model.window,
                threshold: effectiveThreshold(setting, model.window, model.output),
                efforts: model.efforts,
              })),
            }))
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' })
            res.end(body)
          }
          const fresh = new URL(req.url ?? '/', 'http://local').searchParams.has('refresh')
          ;(catalog.size === 0 || fresh ? scanModels() : Promise.resolve(catalog)).then(send, () => send(catalog))
        },
      })
      const disposeTurns = scope.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/turns`,
        handler: (req, res) => {
          const params = new URL(req.url ?? '/', 'http://local').searchParams
          const sessionId = params.get('session') ?? ''
          const reply = (status, payload) => {
            const body = Buffer.from(JSON.stringify(payload))
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' })
            res.end(body)
          }
          if (!/^session-[\w-]+$/.test(sessionId)) return reply(400, { error: 'bad session' })
          turnUsage(sessionId, params.has('debug'), params.get('currency') === 'USD' ? 'USD' : 'CNY').then((turns) => reply(200, { turns }), (error) => reply(500, { error: String(error?.message ?? error) }))
        },
      })
      return () => {
        if (typeof dispose === 'function') dispose()
        if (typeof disposeTurns === 'function') disposeTurns()
      }
    }, 'dsh-miaopeng-kit: routes')
  })

  // 4. 逐轮用量：每条回答下方显示本轮的输入 / 输出 / 费用。
  //    读法与 claude-style 计费一致：assistant/message 带 usage，同一 (turn, step) 重试时以最后一次为准。
  async function readSessionEvents(sessionId) {
    const query = ctx.get('sessionQuery')
    if (query === null || query === undefined) return []
    if (typeof query.observeSession === 'function') {
      const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
      try {
        return Array.isArray(observation.events) ? observation.events : []
      } finally {
        if (typeof observation.dispose === 'function') observation.dispose()
        else if (Symbol.dispose in observation) observation[Symbol.dispose]()
      }
    }
    const snapshot = await query.readSession?.(sessionId)
    return Array.isArray(snapshot?.events) ? snapshot.events : []
  }

  /**
   * 计费方式：用户用什么付费就按什么记。
   *   - WorkBuddy（国内版 / 国际版）→ 积分；每轮的积分由前端按余额变化实测，这里只标出地区；
   *   - DeepSeek 官方账号 → 官方价格表（峰谷价），币种跟随 claude-style 的设置；
   *   - 其他提供方 → claude-style 价格目录里有的按目录价，没有就只给 token。
   * 必须先看提供方再查价：WorkBuddy 上的 deepseek-v4.1-flash 在价格表里也有官方别名。
   */
  function billingOf(provider, model, time, currency) {
    const region = /dsh-workbuddy\/(cn|intl)$/.exec(provider)?.[1]
    if (region !== undefined) return { kind: 'credits', region }
    const tier = priceTier(provider, model, time, currency)
    return tier === null ? { kind: 'tokens' } : { kind: 'money', currency, tier }
  }

  async function turnUsage(sessionId, debug, currency) {
    const events = await readSessionEvents(sessionId)
    if (debug) {
      return events.filter((event) => event?.type === 'assistant/message').slice(-2).map((event) => ({
        time: event.time, turn: event.data?.turn, step: event.data?.step, usage: event.data?.usage, source: event.data?.message?.source,
      }))
    }
    const steps = new Map()
    for (const event of events) {
      if (event?.type !== 'assistant/message') continue
      const usage = event.data?.usage
      const turn = event.data?.turn
      if (usage === undefined || turn === undefined) continue
      steps.set(`${turn}:${event.data?.step}`, { turn, time: event.time, usage, source: event.data?.message?.source ?? {} })
    }
    const turns = new Map()
    const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0)
    for (const { turn, time, usage, source } of steps.values()) {
      const held = turns.get(turn) ?? { turn, input: 0, cacheRead: 0, output: 0, amount: 0, kind: null, provider: '', model: '' }
      const input = count(usage.inputTokens)
      const cacheRead = count(usage.cacheReadTokens) + count(usage.cacheWriteTokens)
      const output = count(usage.outputTokens)
      held.input += input
      held.cacheRead += cacheRead
      held.output += output
      held.provider = String(source.provider ?? held.provider)
      held.model = String(source.model ?? held.model)
      const billing = billingOf(held.provider, held.model, time, currency)
      // 一轮里换过计费方式（极少见）时，以最后一步为准，金额只累计按钱计的步骤。
      held.kind = billing.kind
      if (billing.kind === 'credits') held.region = billing.region
      if (billing.kind === 'money') {
        held.currency = currency
        held.amount += (input * billing.tier.cacheMiss + cacheRead * billing.tier.cacheHit + output * billing.tier.output) / 1e6
      }
      turns.set(turn, held)
    }
    return [...turns.values()].map((turn) => ({ ...turn, amount: turn.kind === 'money' ? Math.round(turn.amount * 1e5) / 1e5 : null }))
  }

  /** claude-style 随包的价格表（官方峰谷价 + 第三方模型目录）。 */
  let priceTable
  function prices() {
    if (priceTable === undefined) {
      try {
        const require = createRequire(import.meta.url)
        priceTable = JSON.parse(readFileSync(join(dirname(require.resolve('dsh-claude-style/package.json')), 'lib', 'prices.json'), 'utf8'))
      } catch {
        priceTable = null
      }
    }
    return priceTable
  }
  const CATALOG_SUFFIXES = ['-high', '-low', '-fast', '-sg', '-256k', '-128k', '-1m', '-32k', '-200k', '-flex']
  function priceTier(provider, model, time, currency) {
    const table = prices()
    if (table === null) return null
    const bare = model.trim().toLowerCase().split('/').pop()
    if (bare === '') return null
    // 官方价格表只对 DeepSeek 官方账号有效。
    if (/deepseek-account|^deepseek$/i.test(provider)) {
      const id = table.models?.[bare] ? bare : table.aliases?.[bare]
      const price = id === undefined ? undefined : table.models?.[id]?.[currency]
      if (price === undefined) return null
      return isPeak(time, table.schedule) ? price.peak : price.offPeak
    }
    const candidates = [table.aliases?.[bare], bare]
    for (const suffix of CATALOG_SUFFIXES) if (bare.endsWith(suffix) && bare.length > suffix.length) candidates.push(bare.slice(0, -suffix.length))
    const id = candidates.find((candidate) => candidate !== undefined && Object.hasOwn(table.catalog ?? {}, candidate))
    if (id === undefined) return null
    const published = currency === 'CNY' ? table.catalogCny?.[id] : undefined
    const parts = (published ?? table.catalog[id]).split(' ').map(Number)
    if (parts.length !== 3 || !parts.every((value) => Number.isFinite(value) && value >= 0) || (parts[0] === 0 && parts[2] === 0)) return null
    const rate = published !== undefined ? 1 : currency === 'CNY' ? table.usdToCny ?? 7.2 : 1
    return { cacheMiss: parts[0] * rate, cacheHit: parts[1] * rate, output: parts[2] * rate }
  }
  function isPeak(time, schedule) {
    if (schedule === undefined || !Number.isFinite(time)) return false
    const parts = (zone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(time)).map((part) => [part.type, part.value]))
    const clock = parts(schedule.timeZone)
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(clock.weekday)
    if (!schedule.peakDays.includes(weekday)) return false
    const local = parts(schedule.holidayZone)
    if (schedule.holidays.includes(`${local.year}-${local.month}-${local.day}`)) return false
    const minutes = Number(clock.hour) * 60 + Number(clock.minute)
    const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
    return schedule.peakWindows.some((window) => minutes >= toMinutes(window.start) && minutes < toMinutes(window.end))
  }

  // 5. 窗口尺寸记忆补丁
  if (process.platform === 'win32' && config.windowPatch !== false) {
    // 宿主进程就是以 RunAsNode 运行的应用本体，安装目录由它推出。
    const asar = join(dirname(process.execPath), 'resources', 'app.asar')
    const script = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'patch-window-state.mjs')
    if (existsSync(asar) && existsSync(script)) {
      try {
        spawn(process.execPath, [script, asar, '--after-exit'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
        }).unref()
      } catch (error) {
        warn('window patch waiter failed to start', error)
      }
    }
  }

  // 启动后同步一次：新启用的模型也能拿到覆盖策略。等其他提供方挂载完成再扫描。
  const startup = setTimeout(() => {
    syncCompaction()
      .then((count) => log(`${describe()}，覆盖 ${count} 个模型`))
      .catch((error) => warn('startup sync failed', error))
  }, 8000)
  startup.unref?.()
  ctx.effect(() => () => clearTimeout(startup), 'dsh-miaopeng-kit: startup sync')
}
