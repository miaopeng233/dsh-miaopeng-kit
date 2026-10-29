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
              })),
            }))
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' })
            res.end(body)
          }
          const fresh = new URL(req.url ?? '/', 'http://local').searchParams.has('refresh')
          ;(catalog.size === 0 || fresh ? scanModels() : Promise.resolve(catalog)).then(send, () => send(catalog))
        },
      })
      return typeof dispose === 'function' ? dispose : undefined
    }, 'dsh-miaopeng-kit: routes')
  })

  // 4. 窗口尺寸记忆补丁
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
