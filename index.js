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
 *   5. 编辑器汉化：给 baoyu-design 系列（claude-slides / claude-design /
 *      claude-design-system / claude-dashboard）的本地编辑器页面注入中文
 *      i18n 消息目录与 DOM 兜底词表。这些文件属于别人的 npm 包，插件一升级
 *      就被覆盖，所以每次启动检查一次并自愈；`/editor-zh` 可手动重打。
 *
 * 设置保存在 ~/.dsh/dsh-miaopeng-kit/settings.json（跨重载保留，不写进插件目录）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { applyEditorZhCn, removeEditorZhCn } from './scripts/editor-zh-cn/apply.mjs'

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

/**
 * 让 /autocompact 作用到 agent 预设里的压缩器。
 *
 * dsh-base 把根层的 compaction-basic 设成 disabled，真正干活的是每个 agent 预设
 * （standard / ptc / minimal / cordis）各自挂的一份，而且不带配置；profile patch 只能按 id
 * 改根层条目，改不到预设内部。所以 profile patch 里的 modelPolicies 对实际压缩没有作用。
 *
 * 压缩器每次判断都读实例的 `this.config`，这里从预设的挂载树里拿到真正在用的
 * BasicCompactionEngine 类，包一层 compactIfNeeded / summarize：调用前把本插件算出的策略
 * 并进实例的配置（原始配置另存，插件卸载后自动还原）。状态挂在 globalThis 的 Symbol 上，
 * 插件热重载后新实例接管，原型只包一次。
 */
const COMPACTION_MODULE = '@deepseek-ai/dsh-compaction-basic'
const COMPACTION_STATE = Symbol.for('dsh-miaopeng-kit.compaction.state')
const COMPACTION_WRAPPED = Symbol.for('dsh-miaopeng-kit.compaction.wrapped')
const COMPACTION_ORIGINAL = Symbol.for('dsh-miaopeng-kit.compaction.original')

const policyKey = (policy) => `${policy.provider}/${policy.model}`
const floor6 = (value) => Math.floor(value * 1e6) / 1e6

/** 原始配置 + 本插件的设置 → 新配置（冻结，与宿主 resolveConfig 的产物同形）。 */
function mergeCompactionConfig(original, state) {
  const overrides = state.policies
  const keys = new Set(overrides.map(policyKey))
  const merged = { ...original }
  if (state.setting.mode === 'ratio') {
    merged.thresholdRatio = state.setting.ratio
    merged.retainRatio = floor6(state.setting.ratio * RETAIN_SHARE)
    delete merged.retainTokens
  }
  merged.modelPolicies = Object.freeze([
    ...overrides.map((policy) => Object.freeze({ ...policy })),
    ...(original.modelPolicies ?? []).filter((policy) => !keys.has(policyKey(policy))),
  ])
  return Object.freeze(merged)
}

/** 每次压缩判断前调用：让实例的 config 对上当前设置；没有本插件状态时还原。 */
function refreshEngineConfig(engine) {
  if (!Object.hasOwn(engine, COMPACTION_ORIGINAL)) {
    Object.defineProperty(engine, COMPACTION_ORIGINAL, { value: engine.config })
  }
  const original = engine[COMPACTION_ORIGINAL]
  const state = globalThis[COMPACTION_STATE]
  if (state === undefined) {
    if (engine.config !== original) engine.config = original
    return undefined
  }
  let merged = state.cache.get(original)
  if (merged === undefined) {
    merged = mergeCompactionConfig(original, state)
    state.cache.set(original, merged)
  }
  if (engine.config !== merged) engine.config = merged
  return state
}

export function wrapCompactionEngine(Engine) {
  const proto = Engine?.prototype
  if (typeof proto?.compactIfNeeded !== 'function' || Object.hasOwn(proto, COMPACTION_WRAPPED)) return false
  const { compactIfNeeded, summarize } = proto
  Object.defineProperty(proto, COMPACTION_WRAPPED, { value: true })
  proto.compactIfNeeded = function (agent, trigger, signal) {
    const state = refreshEngineConfig(this)
    // off 只关「按阈值」的自动压缩；上下文真的溢出时的补救压缩保留，否则这一轮直接报错。
    if (state?.setting.mode === 'off' && trigger === 'pressure') return Promise.resolve(null)
    return compactIfNeeded.call(this, agent, trigger, signal)
  }
  if (typeof summarize === 'function') {
    proto.summarize = function (...args) {
      refreshEngineConfig(this)
      return summarize.apply(this, args)
    }
  }
  return true
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

  /** 本插件实例的标记：热重载时旧实例只清理自己发布的状态。 */
  const stateOwner = Symbol('dsh-miaopeng-kit owner')
  /** 当前设置 + 模型目录 → 每个模型的覆盖策略。 */
  function computePolicies() {
    const policies = []
    for (const model of catalog.values()) {
      const policy = policyFor(setting, model.provider, model.id, model.window, model.output)
      if (policy !== undefined) policies.push(policy)
    }
    return policies.sort((a, b) => policyKey(a).localeCompare(policyKey(b)))
  }
  function publishCompactionState(policies = computePolicies()) {
    globalThis[COMPACTION_STATE] = { owner: stateOwner, setting, policies, cache: new WeakMap() }
    return policies
  }
  ctx.effect(() => () => {
    if (globalThis[COMPACTION_STATE]?.owner === stateOwner) delete globalThis[COMPACTION_STATE]
  }, 'dsh-miaopeng-kit: compaction state')

  /** 已接管的压缩器类（通常只有一个，所有预设共用同一个模块），经 /dsh-miaopeng-kit/models 暴露。 */
  const engineClasses = new Set()
  /** 从各 agent 预设的挂载树里找压缩器类并包装。预设可能晚于本插件挂载、也会换代，所以定时找。 */
  function wrapPresetEngines() {
    const generations = ctx.get('agentPresets')?.generations
    if (typeof generations?.values !== 'function') return
    for (const generation of generations.values()) {
      const tree = generation?.mount?.tree
      if (typeof tree?.entries !== 'function') continue
      for (const entry of tree.entries()) {
        if (entry?.options?.name !== COMPACTION_MODULE) continue
        const Engine = entry.fiber?.runtime?.callback
        if (wrapCompactionEngine(Engine)) log('已接管 agent 预设里的压缩器，/autocompact 对所有预设生效')
        if (typeof Engine === 'function' && Object.hasOwn(Engine.prototype, COMPACTION_WRAPPED)) engineClasses.add(Engine)
      }
    }
  }
  {
    let timer
    const startedAt = Date.now()
    const tick = () => {
      try {
        wrapPresetEngines()
      } catch (error) {
        warn('compaction engine scan failed', error)
      }
      // 前一分钟每 2 秒找一次（预设在启动时异步挂载），之后每 30 秒（预设换代时）。
      timer = setTimeout(tick, Date.now() - startedAt < 60000 ? 2000 : 30000)
      timer.unref?.()
    }
    tick()
    ctx.effect(() => () => clearTimeout(timer), 'dsh-miaopeng-kit: compaction engine scan')
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
    // 真正生效的是这一步：交给预设里压缩器的包装层（见 wrapCompactionEngine）。
    // 下面写 profile patch 只是留档：根层条目是 disabled 的，宿主将来启用它时也能对上。
    const policies = publishCompactionState()

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

  /**
   * 命令结果在对话里只占一行，所以只说一句话：设成了什么、有几个模型例外。
   * 例外 = 窗口装不下设定值、改按窗口 80% 压缩的模型。
   */
  function describe() {
    if (setting.mode === 'off') return '自动压缩已关闭，只能手动 /compact'
    if (setting.mode === 'default') return '自动压缩：默认，窗口用到 80% 时压缩'
    if (setting.mode === 'ratio') return `自动压缩：窗口用到 ${Math.round(setting.ratio * 100)}% 时压缩`
    const count = exceptions().size
    return `自动压缩：${formatTokens(setting.tokens)}${count > 0 ? `（${count} 个小窗口模型提前压缩）` : ''}`
  }

  /**
   * 达不到设定值的模型（按名称去重）：名称 → 实际阈值文本。
   * W − O − 64K 不为正的模型宿主无法计算阈值，标为「窗口过小」。
   */
  function exceptions() {
    const result = new Map()
    if (setting.mode !== 'tokens') return result
    for (const model of catalog.values()) {
      const at = effectiveThreshold(setting, model.window, model.output)
      if (at >= setting.tokens || result.has(model.name)) continue
      result.set(model.name, model.window - (model.output ?? 0) - DEFAULT_HEADROOM > 0 ? formatTokens(at) : '窗口过小')
    }
    return result
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
            // 结果卡片只显示一行：设定值 + 例外模型各自的实际阈值。
            const listed = [...exceptions()].map(([name, at]) => `${name} ${at}`)
            const head = setting.mode === 'tokens' ? `自动压缩：${formatTokens(setting.tokens)}` : describe()
            return { kind: 'success', text: listed.length > 0 ? `${head}；提前压缩：${listed.join('、')}` : head }
          }
          const previous = setting
          setting = parsed
          try {
            writeSettings(ctx, { autocompact: setting })
            const count = await syncCompaction()
            log(`autocompact: ${count} model policies written`)
            return { kind: 'success', text: describe() }
          } catch (error) {
            setting = previous
            writeSettings(ctx, { autocompact: setting })
            publishCompactionState()
            return { kind: 'error', text: `设置失败：${error?.message ?? error}` }
          }
        },
      })
    }, 'dsh-miaopeng-kit: /autocompact')
  })

  // 1b. /editor-zh 命令：手动重打编辑器汉化（升级 baoyu 插件后可用）
  ctx.inject(['commands'], (scope) => {
    scope.effect(function* () {
      yield scope.commands.register({
        name: 'editor-zh',
        description: '重打 baoyu 编辑器汉化补丁（幻灯片/画布/设计系统/仪表盘）',
        input: { hint: 'apply | remove | status' },
        handler: async (invocation) => {
          const action = (invocation.rawInput ?? '').trim().toLowerCase() || 'apply'
          if (action === 'remove') {
            const result = removeEditorZhCn({ log, warn })
            return { kind: 'success', text: result.removed.length > 0 ? `已移除汉化：${result.removed.join('、')}` : '没有可移除的汉化补丁' }
          }
          if (action !== 'apply' && action !== 'status') {
            return { kind: 'error', text: '用法：/editor-zh apply（重打）、/editor-zh remove（移除）、/editor-zh status' }
          }
          const result = applyEditorZhCn({ log, warn, config: { editorZhCn: true } })
          if (result.state === 'error') {
            return { kind: 'error', text: `汉化失败：${result.errors?.join('；') ?? '未知错误'}` }
          }
          if (action === 'status') {
            const parts = []
            if (result.patched.length > 0) parts.push(`待打：${result.patched.join('、')}`)
            if (result.current.length > 0) parts.push(`已是最新：${result.current.join('、')}`)
            if (result.skipped.length > 0) parts.push(`未安装：${result.skipped.join('、')}`)
            return { kind: 'success', text: `汉化目录 v${result.version}；${parts.join('；') || '无编辑器'}` }
          }
          if (result.patched.length === 0 && result.current.length > 0) {
            return { kind: 'success', text: `汉化已是最新（v${result.version}）：${result.current.join('、')}` }
          }
          return {
            kind: 'success',
            text: `已汉化 ${result.patched.join('、')}（v${result.version}）${result.skipped.length > 0 ? `；未安装：${result.skipped.join('、')}` : ''}。刷新编辑器页面即可看到中文。`,
          }
        },
      })
    }, 'dsh-miaopeng-kit: /editor-zh')
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
              compactionEngines: engineClasses.size,
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
          const billing = claudeStyleBilling()
          turnUsage(sessionId, billing).then((turns) => reply(200, { currency: billing.currency, turns }), (error) => reply(500, { error: String(error?.message ?? error) }))
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
   * claude-style 设置里的「计费币种」和「自定义计费表」，从 Loader 读生效中的配置（用户改动即时可见）。
   * 币种为 off 时不算钱；计费表每行 `模型|输入|缓存读|输出`，单位是所选币种 / 百万 token，同名以计费表为准。
   */
  function claudeStyleBilling() {
    let config
    try {
      for (const entry of ctx.get('loader')?.entries?.() ?? []) {
        if (entry?.options?.name === 'dsh-claude-style' && entry.options.disabled !== true) {
          config = entry.options.config
          break
        }
      }
    } catch {}
    const choice = config?.billingCurrency
    const currency = choice === 'USD' || choice === 'off' ? choice : 'CNY'
    const rate = (text) => (text === '' || !Number.isFinite(Number(text)) || Number(text) < 0 ? null : Number(text))
    const rows = new Map()
    for (const entry of Array.isArray(config?.billingTable) ? config.billingTable : []) {
      if (typeof entry !== 'string') continue
      const [model = '', input = '', cacheRead = '', output = ''] = entry.split('|').map((part) => part.trim())
      const key = model.toLowerCase().split('/').pop()
      if (key && !rows.has(key)) rows.set(key, { cacheMiss: rate(input), cacheHit: rate(cacheRead), output: rate(output) })
    }
    return { currency, rows }
  }

  /**
   * 计费方式：用户用什么付费就按什么记。
   *   - WorkBuddy（国内版 / 国际版）→ 积分；每轮的积分由前端按余额变化实测，这里只标出地区；
   *   - DeepSeek 官方账号 → 官方价格表（峰谷价），币种跟随 claude-style 的设置；
   *   - 其他提供方 → claude-style 价格目录里有的按目录价，没有就只给 token。
   * 必须先看提供方再查价：WorkBuddy 上的 deepseek-v4.1-flash 在价格表里也有官方别名。
   */
  function billingOf(provider, model, time, { currency, rows }) {
    const region = /dsh-workbuddy\/(cn|intl)$/.exec(provider)?.[1]
    if (region !== undefined) return { kind: 'credits', region }
    if (currency === 'off') return { kind: 'tokens' }
    const base = priceTier(provider, model, time, currency)
    const row = rows.get(model.trim().toLowerCase().split('/').pop())
    const tier = row === undefined ? base : {
      cacheMiss: row.cacheMiss ?? base?.cacheMiss ?? 0,
      cacheHit: row.cacheHit ?? base?.cacheHit ?? 0,
      output: row.output ?? base?.output ?? 0,
    }
    return tier === null ? { kind: 'tokens' } : { kind: 'money', currency, tier }
  }

  async function turnUsage(sessionId, billingSettings) {
    const events = await readSessionEvents(sessionId)
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
      const billing = billingOf(held.provider, held.model, time, billingSettings)
      // 一轮里换过计费方式（极少见）时，以最后一步为准，金额只累计按钱计的步骤。
      held.kind = billing.kind
      if (billing.kind === 'credits') held.region = billing.region
      if (billing.kind === 'money') {
        held.currency = billing.currency
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
    // 官方价格表只对 DeepSeek 官方（账号登录 deepseek-account、API key deepseek-official）有效。
    if (/^deepseek-(?:account|official)$|^deepseek$/i.test(provider)) {
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

  // 5b. fake-ip 补丁自愈（npm 版 dsh）：只在用户手动运行过 scripts/patch-fakeip.mjs
  //     之后才做；`npm i -g @deepseek-ai/dsh` 升级会冲掉补丁，这里补回，下次重启生效。
  if (process.platform !== 'win32' && readSettings(ctx, {}).fakeIpPatch === true) {
    import('./scripts/patch-fakeip.mjs')
      .then(({ patchFakeIp }) => {
        const result = patchFakeIp()
        if (result.state === 'applied') warn('fake-ip 补丁被 dsh 升级冲掉，已重新打上：重启 dsh 后 web_fetch 恢复')
        else if (result.state === 'unknown') warn('dsh 改了 isPublicIpAddress 的写法，fake-ip 补丁需要更新')
      })
      .catch((error) => warn('fake-ip patch check failed', error))
  }

  // 启动后同步一次：新启用的模型也能拿到覆盖策略。等其他提供方挂载完成再扫描。
  const startup = setTimeout(() => {
    syncCompaction()
      .then((count) => log(`${describe()}，覆盖 ${count} 个模型`))
      .catch((error) => warn('startup sync failed', error))
  }, 8000)
  startup.unref?.()
  ctx.effect(() => () => clearTimeout(startup), 'dsh-miaopeng-kit: startup sync')

  // 6. 编辑器汉化自愈：baoyu 系列插件升级会覆盖补丁，每次启动检查一次。
  //    放在 compaction 同步之后，避免启动瞬间的 IO 竞争。
  if (config.editorZhCn !== false) {
    const zhStartup = setTimeout(() => {
      try {
        applyEditorZhCn({ log, warn, config })
      } catch (error) {
        warn('editor-zh-cn startup failed', error)
      }
    }, 3000)
    zhStartup.unref?.()
    ctx.effect(() => () => clearTimeout(zhStartup), 'dsh-miaopeng-kit: editor-zh-cn startup')
  }
}
