/**
 * dsh-miaopeng-kit — client half: 模型选择器改版。
 *
 * 底座是 dsh-claude-style 的选择器，这里只做两件事，不重建它的行：
 *   - 版式：弹层加宽、模型名不折行、描述收成一行（悬停看全文）；
 *   - 信息：每行右侧追加一组标签——价格（免费 / 倍率）、促销、拥堵、不可用、上下文窗口。
 *
 * 数据来源：
 *   - '@huai_xin/dsh-workbuddy/state' 服务：倍率、可用性、负载（WorkBuddy 已在加载）；
 *   - /workbuddy/models：促销文案（打开选择器时按需读取，缓存 2 分钟）；
 *   - /dsh-miaopeng-kit/models：每个模型的上下文窗口与自动压缩阈值（本插件宿主端）。
 *
 * 行与模型的对应：按「分组标题 → 提供方」再按「归一化名称 + 同名序号」匹配，
 * 所以 DeepSeek 官方账号的 V4.1-Flash 不会再串到 WorkBuddy 的数据。
 *
 * 性能：弹层是 body 的直接子节点，所以只观察 body 的 childList（不带 subtree），
 * 弹层打开时再单独观察它；所有写入都在 requestAnimationFrame 里、断开观察器后进行，
 * 并且内容不变就不写 DOM，杜绝自触发循环。
 */

const POPOVER_SELECTOR = '.dsh-claude-model-popover'
const ROW_SELECTOR = '.dsh-claude-model-option'
const RULE_SELECTOR = '.dsh-claude-model-rule'
const RULE_NAME_SELECTOR = '.dsh-claude-model-rule-name'
const NAME_SELECTOR = '.dsh-claude-model-name'
const DESC_SELECTOR = '.dsh-claude-model-desc'
const META_CLASS = 'mpk-meta'
const SIGNATURE_ATTR = 'data-mpk-sig'
const GROUP_ATTR = 'data-mpk-group'

const STATE_SERVICE = '@huai_xin/dsh-workbuddy/state'
const PROMO_TTL = 120000
const MODELS_TTL = 300000

/** 提供方名称中文化（只改显示，不改任何标识）。 */
const PROVIDER_LABELS = {
  'WorkBuddy (Overseas)': 'WorkBuddy 国际版',
  'WorkBuddy (Mainland)': 'WorkBuddy 国内版',
  'DeepSeek Account': 'DeepSeek 官方',
}

const VERDICT_LABEL = {
  'rate limited': '限流',
  'out of credits': '积分不足',
  'no permission': '无权限',
  'credentials rejected': '凭据失效',
  unusable: '不可用',
}

const BUSY_LABEL = { busy: '拥堵', congested: '严重拥堵' }

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return ''
  if (value >= 1e6) return `${Math.round(value / 1e5) / 10}M`
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`
  return String(value)
}

/** 倍率文本 → 数值；'free' → 0；未知 → null。 */
function rateValue(rate) {
  if (rate === 'free') return 0
  const match = /(\d+(?:\.\d+)?)/.exec(String(rate ?? ''))
  return match === null ? null : Number(match[1])
}

/** 倍率分档：越便宜越绿。 */
function rateTier(value) {
  if (value === null) return 'unknown'
  if (value === 0) return 'free'
  if (value <= 0.2) return 'low'
  if (value <= 0.6) return 'mid'
  return 'high'
}

/**
 * 行里的模型名，返回两种归一化形式：
 *   full    — 品牌词 + 可见文本（主题把品牌词换成了图标，替代文本放在 combine-alt 里）；
 *   visible — 只有可见文本。
 * 上游名字有的带品牌词（「Kimi-K2.5」），有的不带（腾讯的「Hy3」、阶跃的「Step-5-Preview」），
 * 两种形式都要试。本插件自己追加的 id 标签不算在内。
 */
function rowKey(row) {
  const node = row.querySelector(NAME_SELECTOR)
  if (node === null) return { full: '', visible: '' }
  const alt = node.querySelector('.dsh-claude-model-combine-alt')
  let visible = ''
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) visible += child.textContent ?? ''
    else if (child instanceof Element
      && !child.classList.contains('dsh-claude-model-combine')
      && !child.classList.contains('dsh-claude-model-combine-alt')
      && !child.classList.contains('mpk-id')) visible += child.textContent ?? ''
  }
  return { full: normalize(`${alt?.textContent ?? ''} ${visible}`), visible: normalize(visible) }
}

/** 按从严到宽的顺序找同名条目：全名相等 → 可见文本相等 → 后缀一致。 */
function matchEntries(entries, key) {
  const named = entries.map((entry) => [entry, normalize(entry.name)])
  const rules = [
    ([, name]) => name === key.full,
    ([, name]) => name === key.visible,
    ([, name]) => key.visible.length >= 3 && (name.endsWith(key.visible) || key.full.endsWith(name)),
  ]
  for (const rule of rules) {
    const found = named.filter(rule).map(([entry]) => entry)
    if (found.length > 0) return found
  }
  return []
}

function el(tag, className, text, title) {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  if (title !== undefined) node.title = title
  return node
}

const STYLE = `
.dsh-claude-model-popover[data-open] {
  width: min(500px, calc(100vw - 24px)) !important;
  max-width: min(500px, calc(100vw - 24px)) !important;
}
${POPOVER_SELECTOR} .dsh-claude-popover-body { display: flex; flex-direction: column; }
${POPOVER_SELECTOR} ${ROW_SELECTOR} { align-items: center; gap: 8px; padding-top: 6px; padding-bottom: 6px; }
${POPOVER_SELECTOR} .dsh-claude-model-copy { min-width: 0; flex: 1 1 auto; }
${POPOVER_SELECTOR} ${NAME_SELECTOR} { white-space: nowrap; }
${POPOVER_SELECTOR} .dsh-claude-model-line { flex-wrap: nowrap; min-width: 0; }
${POPOVER_SELECTOR} ${DESC_SELECTOR} {
  display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
${POPOVER_SELECTOR} ${ROW_SELECTOR}[data-mpk-state="down"] .dsh-claude-model-copy { opacity: .5; }
/* 主题给标题字号用了高优先级的 !important，这里叠加选择器把优先级压过去。 */
html body ${POPOVER_SELECTOR} ${RULE_SELECTOR} ${RULE_NAME_SELECTOR}[${GROUP_ATTR}][${GROUP_ATTR}] { font-size: 0 !important; letter-spacing: 0 !important; }
html body ${POPOVER_SELECTOR} ${RULE_SELECTOR} ${RULE_NAME_SELECTOR}[${GROUP_ATTR}][${GROUP_ATTR}]::after { content: attr(${GROUP_ATTR}); font-size: var(--mpk-rule-size, 11px) !important; }

.${META_CLASS} {
  display: inline-flex; align-items: center; gap: 4px; flex: none; margin-left: auto;
  font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; white-space: nowrap;
}
.mpk-tag {
  padding: 0 6px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8a8f98) 13%, transparent);
  color: var(--dsw-alias-label-secondary, #555);
}
.mpk-tag[data-tone="free"] { background: color-mix(in srgb, #16a34a 16%, transparent); color: #15803d; font-weight: 600; }
.mpk-tag[data-tone="low"] { color: #15803d; }
.mpk-tag[data-tone="high"] { color: #b45309; }
.mpk-tag[data-tone="promo"] { background: transparent; box-shadow: inset 0 0 0 1px currentColor; color: #15803d; }
.mpk-tag[data-tone="warn"] { background: color-mix(in srgb, #f59e0b 16%, transparent); color: #b45309; }
.mpk-tag[data-tone="bad"] { background: color-mix(in srgb, #ef4444 14%, transparent); color: #b91c1c; }
.mpk-busy { display: inline-flex; align-items: center; gap: 3px; color: #b45309; }
.mpk-busy::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.mpk-busy[data-level="congested"] { color: #dc2626; }
.mpk-ctx {
  min-width: 34px; text-align: right; color: var(--dsw-alias-label-tertiary, #8a8f98);
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 10.5px;
}
.mpk-id { color: var(--dsw-alias-label-tertiary, #8a8f98); font-size: 10.5px; margin-left: 4px; font-weight: 400; }
@media (prefers-color-scheme: dark) {
  .mpk-tag[data-tone="free"], .mpk-tag[data-tone="low"], .mpk-tag[data-tone="promo"] { color: #4ade80; }
  .mpk-tag[data-tone="high"], .mpk-tag[data-tone="warn"], .mpk-busy { color: #fbbf24; }
  .mpk-tag[data-tone="bad"], .mpk-busy[data-level="congested"] { color: #f87171; }
}
`

window.__ModuleLoader__.load({
  id: 'dsh-miaopeng-kit',
  factory() {
    return {
      inject: [],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-miaopeng-kit')
        style.textContent = STYLE
        document.head.appendChild(style)

        /** WorkBuddy 状态快照（倍率、可用性、负载）。 */
        let snapshot = null
        /** provider → id → promotion */
        let promotions = new Map()
        let promotionsAt = 0
        /** 本插件宿主端的模型表。 */
        let models = []
        let modelsAt = 0
        let unsubscribe = null
        const timers = []

        // ---------- 数据 ----------

        const fetchJson = (path) => fetch(path, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : undefined))
          .catch(() => undefined)

        let loading = null
        function ensureData() {
          const now = Date.now()
          const tasks = []
          if (now - modelsAt > MODELS_TTL) {
            modelsAt = now
            tasks.push(fetchJson('/dsh-miaopeng-kit/models').then((body) => {
              if (Array.isArray(body?.models)) models = body.models
            }))
          }
          if (now - promotionsAt > PROMO_TTL && snapshot !== null) {
            promotionsAt = now
            const regions = Object.values(snapshot.providers ?? {})
            tasks.push(Promise.all(regions.map((provider) => (
              fetchJson(`/workbuddy/models?region=${encodeURIComponent(provider.region)}`).then((body) => {
                const byId = new Map()
                for (const model of body?.models ?? []) {
                  if (model?.promotion !== undefined && typeof model.id === 'string') byId.set(model.id, model.promotion)
                }
                return [provider.provider, byId]
              })
            ))).then((entries) => { promotions = new Map(entries) }))
          }
          if (tasks.length === 0 || loading !== null) return
          loading = Promise.all(tasks).finally(() => {
            loading = null
            schedule()
          })
        }

        /**
         * 分组标题文本 → 该组可选的模型条目（按顺序）。
         * 条目：{ id, name, rate, verdict, busy, promotion, contextWindow, threshold }
         *
         * 按提供方 id 合并两路数据：标题用的是 LLM 提供方名（如「WorkBuddy (Mainland)」），
         * WorkBuddy 状态里却是它自己的面板名（「WorkBuddy 大陆版」），显示名对不上，
         * 所以两种名字都映射到同一个提供方 id。
         */
        function groupIndex() {
          const byProvider = new Map()
          const labels = new Map()
          const entryOf = (provider, id) => {
            if (!byProvider.has(provider)) byProvider.set(provider, new Map())
            const list = byProvider.get(provider)
            if (!list.has(id)) list.set(id, { id })
            return list.get(id)
          }
          for (const model of models) {
            labels.set(model.providerName, model.provider)
            Object.assign(entryOf(model.provider, model.id), { name: model.name, contextWindow: model.contextWindow, threshold: model.threshold })
          }
          for (const provider of Object.values(snapshot?.providers ?? {})) {
            if (provider.displayName) labels.set(provider.displayName, provider.provider)
            for (const [id, model] of Object.entries(provider.models ?? {})) {
              const entry = entryOf(provider.provider, id)
              entry.name ??= model.name ?? id
              Object.assign(entry, {
                rate: model.rate,
                verdict: model.verdict,
                busy: model.busy,
                promotion: promotions.get(provider.provider)?.get(id),
              })
            }
          }
          const groups = new Map()
          for (const [label, provider] of labels) groups.set(label, [...(byProvider.get(provider)?.values() ?? [])])
          return groups
        }

        // ---------- 渲染 ----------

        function buildMeta(entry) {
          const meta = el('span', META_CLASS)
          const verdict = VERDICT_LABEL[entry.verdict]
          if (verdict !== undefined) {
            const tag = el('span', 'mpk-tag', verdict, `上游状态：${entry.verdict}`)
            tag.dataset.tone = entry.verdict === 'rate limited' ? 'warn' : 'bad'
            meta.append(tag)
          }
          const busy = BUSY_LABEL[entry.busy]
          if (busy !== undefined) {
            const tag = el('span', 'mpk-busy', busy, entry.busy === 'congested' ? '上游严重拥堵，响应可能很慢' : '上游拥堵，响应可能变慢')
            tag.dataset.level = entry.busy
            meta.append(tag)
          }
          const promo = entry.promotion
          if (promo !== undefined) {
            const label = promo.label || (promo.kind === 'discount' ? '折扣' : promo.kind)
            if (label) {
              const window = [promo.from, promo.until].filter(Boolean).join(' – ')
              const tag = el('span', 'mpk-tag', label, [promo.text, window, promo.discounted ? `折后 ${promo.discounted}` : ''].filter(Boolean).join('\n') || label)
              tag.dataset.tone = 'promo'
              if (typeof promo.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(promo.color)) tag.style.color = promo.color
              meta.append(tag)
            }
          }
          const value = rateValue(entry.rate)
          if (value !== null) {
            const tier = rateTier(value)
            const tag = el('span', 'mpk-tag', value === 0 ? '免费' : `${entry.rate}`.replace(/x$/i, '×'), value === 0 ? '当前免费，不消耗积分' : `消耗倍率 ${entry.rate}（越低越省）`)
            tag.dataset.tone = tier
            meta.append(tag)
          }
          if (Number.isFinite(entry.contextWindow)) {
            const compact = Number.isFinite(entry.threshold) && entry.threshold < entry.contextWindow
              ? `\n自动压缩：${formatTokens(entry.threshold)}` : ''
            meta.append(el('span', 'mpk-ctx', formatTokens(entry.contextWindow), `上下文窗口 ${entry.contextWindow.toLocaleString()} tokens${compact}`))
          }
          return meta
        }

        function signatureOf(entry) {
          if (entry === undefined) return '-'
          const promo = entry.promotion
          return [entry.id, entry.rate, entry.verdict, entry.busy, promo?.label, promo?.kind, promo?.color, entry.contextWindow, entry.threshold].join('|')
        }

        /** 排序档位：免费 0、有促销 1、普通 2、不可用 3。 */
        function rankOf(entry) {
          if (entry === undefined) return 2
          if (VERDICT_LABEL[entry.verdict] !== undefined && entry.verdict !== 'rate limited') return 3
          if (rateValue(entry.rate) === 0) return 0
          if (entry.promotion !== undefined) return 1
          return 2
        }

        /**
         * 只改 CSS order 来排序（免费在前），不移动节点：行归 React 所有，
         * 挪动它们会让后续渲染出错。分组之间的先后保持不变。
         */
        function setOrder(node, value) {
          const text = String(value)
          if (node.style.order !== text) node.style.order = text
        }

        function decoratePopover(popover) {
          const groups = groupIndex()
          let label = ''
          let entries = []
          const seen = new Map()
          let group = 0
          let index = 0
          for (const node of popover.querySelectorAll(`${RULE_SELECTOR}, ${ROW_SELECTOR}`)) {
            index += 1
            if (node.matches(RULE_SELECTOR)) {
              group += 1
              setOrder(node, group * 10000)
              const nameNode = node.querySelector(RULE_NAME_SELECTOR)
              if (nameNode === null) continue
              // 中文名只通过属性 + CSS 显示：文字节点归 React 所有，替换它会让后续渲染出错。
              const original = nameNode.textContent ?? ''
              const shown = PROVIDER_LABELS[original] ?? original
              if (shown !== original) {
                if (nameNode.getAttribute(GROUP_ATTR) !== shown) {
                  nameNode.style.setProperty('--mpk-rule-size', getComputedStyle(nameNode).fontSize)
                  nameNode.setAttribute(GROUP_ATTR, shown)
                }
              } else if (nameNode.hasAttribute(GROUP_ATTR)) nameNode.removeAttribute(GROUP_ATTR)
              label = original
              entries = groups.get(original) ?? groups.get(shown) ?? []
              seen.clear()
              continue
            }
            const key = rowKey(node)
            const occurrence = seen.get(key.full) ?? 0
            seen.set(key.full, occurrence + 1)
            const matches = matchEntries(entries, key)
            const entry = matches[occurrence] ?? matches[0]
            setOrder(node, group * 10000 + (rankOf(entry) + 1) * 1000 + index)
            const signature = `${label}|${signatureOf(entry)}|${matches.length}`
            if (node.getAttribute(SIGNATURE_ATTR) === signature) continue
            node.setAttribute(SIGNATURE_ATTR, signature)
            node.querySelector(`:scope > .${META_CLASS}`)?.remove()
            node.querySelector('.mpk-id')?.remove()
            if (entry === undefined) {
              node.removeAttribute('data-mpk-state')
              continue
            }
            if (VERDICT_LABEL[entry.verdict] !== undefined && entry.verdict !== 'rate limited') node.setAttribute('data-mpk-state', 'down')
            else node.removeAttribute('data-mpk-state')
            // 同名模型（例如 Hy3 / Hy3）补上 id 区分。
            if (matches.length > 1) node.querySelector(NAME_SELECTOR)?.append(el('span', 'mpk-id', entry.id))
            const description = node.querySelector(DESC_SELECTOR)
            if (description !== null && !description.title) description.title = description.textContent ?? ''
            node.append(buildMeta(entry))
          }
        }

        // ---------- 调度 ----------

        let popoverObserver = null
        let observedPopover = null
        const bodyObserver = new MutationObserver(() => schedule())

        const observeBody = () => bodyObserver.observe(document.body, { childList: true })
        const observePopover = (popover) => popoverObserver?.observe(popover, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-open'] })

        let queued = false
        function schedule() {
          if (queued) return
          queued = true
          requestAnimationFrame(() => {
            queued = false
            // 弹层常驻 DOM，开合只切换 data-open，所以盯住元素本身而不是只等它被插入。
            const popover = document.querySelector(POPOVER_SELECTOR)
            if (popover !== observedPopover) {
              popoverObserver?.disconnect()
              observedPopover = popover
              if (popover !== null) {
                popoverObserver ??= new MutationObserver(() => schedule())
                observePopover(popover)
              }
            }
            if (popover === null || popover.getAttribute('data-open') !== 'true') return
            ensureData()
            popoverObserver?.disconnect()
            bodyObserver.disconnect()
            try {
              decoratePopover(popover)
            } catch (error) {
              console.warn('[dsh-miaopeng-kit] decorate failed', error)
            } finally {
              popoverObserver?.takeRecords()
              bodyObserver.takeRecords()
              observePopover(popover)
              observeBody()
            }
          })
        }

        observeBody()

        const adopt = (service) => {
          snapshot = service.getSnapshot?.() ?? null
          if (typeof service.subscribe === 'function') {
            unsubscribe = service.subscribe(() => {
              snapshot = service.getSnapshot()
              schedule()
            })
          }
          schedule()
        }
        const tryAdopt = (attempt) => {
          const service = ctx.get?.(STATE_SERVICE)
          if (service !== undefined && service !== null) return adopt(service)
          if (attempt < 40) timers.push(setTimeout(() => tryAdopt(attempt + 1), 250))
        }
        tryAdopt(0)

        ctx.effect(() => () => {
          for (const timer of timers) clearTimeout(timer)
          bodyObserver.disconnect()
          popoverObserver?.disconnect()
          if (typeof unsubscribe === 'function') unsubscribe()
          style.remove()
          for (const node of document.querySelectorAll(`.${META_CLASS}, .mpk-id`)) node.remove()
          for (const node of document.querySelectorAll(`[${SIGNATURE_ATTR}]`)) {
            node.removeAttribute(SIGNATURE_ATTR)
            node.style.order = ''
          }
          for (const node of document.querySelectorAll(`[${GROUP_ATTR}]`)) node.removeAttribute(GROUP_ATTR)
        }, 'dsh-miaopeng-kit: 模型选择器')
      },
    }
  },
})
