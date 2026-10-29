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
/*
 * 分组标题：吸顶，上方一条分隔线，滚动时始终知道自己在哪一组。
 * 主题给标题用了高优先级的 !important，这里叠加选择器把优先级压过去。
 */
html body ${POPOVER_SELECTOR} ${RULE_SELECTOR}${RULE_SELECTOR} {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; min-height: 0;
  margin: 0 !important; padding: 8px 12px 4px !important;
  background: var(--mpk-pop-bg, #fff);
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
html body ${POPOVER_SELECTOR} ${RULE_SELECTOR}${RULE_SELECTOR}[data-mpk-first] { border-top-color: transparent; padding-top: 6px !important; }
/* 主题用 ::after 在标题后画细线；分隔已经交给上边框，这里去掉。 */
html body ${POPOVER_SELECTOR} ${RULE_SELECTOR}${RULE_SELECTOR}::after { display: none !important; }
html body ${POPOVER_SELECTOR} ${RULE_SELECTOR} ${RULE_NAME_SELECTOR}${RULE_NAME_SELECTOR} {
  font-size: 12px !important; line-height: 18px !important; font-weight: 600 !important; letter-spacing: 0 !important;
  color: var(--dsw-alias-label-secondary, #70686a) !important; text-transform: none !important;
}
html body ${POPOVER_SELECTOR} ${RULE_SELECTOR} ${RULE_NAME_SELECTOR}[${GROUP_ATTR}][${GROUP_ATTR}] { font-size: 0 !important; }
html body ${POPOVER_SELECTOR} ${RULE_SELECTOR} ${RULE_NAME_SELECTOR}[${GROUP_ATTR}][${GROUP_ATTR}]::after { content: attr(${GROUP_ATTR}); font-size: 12px !important; }

/*
 * 底部对话统计：一排「标签 数值」——花费、Token、缓存命中、轮次；标签浅、数值深，不用分隔符靠间距分组。
 * 速度、输入 / 输出拆分等明细点开看（本插件自己的弹层，从统计栏上方弹出）。
 * 段落沿用 claude-style 的节点（文字归 React 所有），只写属性，显示交给 CSS：
 * 原文字 font-size: 0 隐藏，::before 画标签，::after 画数值。
 */
.dsh-claude-inline-stats[data-mpk-stats] { cursor: pointer; display: inline-flex !important; align-items: center; gap: 14px !important; }
.dsh-claude-inline-stats[data-mpk-stats] > .dsh-claude-inline-seg { display: none !important; }
.dsh-claude-inline-stats[data-mpk-stats] > .dsh-claude-inline-seg[data-mpk-short] {
  /* 段里有 0 号字的裸文字（如「轮」「步」），按基线对齐会把这一段撑高，所以居中对齐。 */
  display: inline-flex !important; align-items: center; gap: 4px; order: var(--mpk-order, 9) !important;
  font-size: 0 !important; letter-spacing: 0 !important; line-height: 20px !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important; height: auto !important; min-height: 0 !important;
  background: none !important; box-shadow: none !important; transform: none !important;
}
.dsh-claude-inline-stats[data-mpk-stats] > .dsh-claude-inline-seg[data-mpk-short] > * { display: none !important; }
.dsh-claude-inline-stats[data-mpk-stats] > .dsh-claude-inline-seg[data-mpk-short]::before {
  content: attr(data-mpk-label); position: static; display: inline; width: auto; height: auto; margin: 0; background: none;
  font-size: var(--mpk-stats-size, 12px); color: var(--dsw-alias-label-tertiary, #91888a);
}
.dsh-claude-inline-stats[data-mpk-stats] > .dsh-claude-inline-seg[data-mpk-short]::after {
  content: attr(data-mpk-short); font-size: var(--mpk-stats-size, 12px); font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, #70686a); font-weight: 500;
}
.dsh-claude-inline-stats[data-mpk-stats] > .dsh-claude-inline-seg[data-mpk-free]::after { color: #15803d; }
@media (prefers-color-scheme: dark) { .dsh-claude-inline-stats[data-mpk-stats] > .dsh-claude-inline-seg[data-mpk-free]::after { color: #4ade80; } }

.mpk-stats-pop {
  position: fixed; z-index: 1000; width: 300px; box-sizing: border-box; padding: 12px 14px;
  background: var(--mpk-pop-bg, #fff); color: var(--dsw-alias-label-primary, #1f1e1d);
  border-radius: 12px; font-size: 12px; line-height: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 9%, transparent), 0 8px 24px rgba(0,0,0,.12);
  font-variant-numeric: tabular-nums;
}
.mpk-stats-pop h4 { margin: 0 0 6px; font-family: inherit; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, #70686a); }
.mpk-stats-pop section + section { margin-top: 10px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, currentColor 9%, transparent); }
.mpk-stats-pop .mpk-row { display: flex; justify-content: space-between; gap: 12px; }
.mpk-stats-pop .mpk-row > span:first-child { color: var(--dsw-alias-label-secondary, #70686a); }
.mpk-stats-pop .mpk-row[data-current] > span:first-child { color: inherit; font-weight: 600; }
.mpk-stats-pop .mpk-note { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #91888a); }
.mpk-stats-pop .mpk-free { font-weight: 600; }
/* 模型按钮上的「免费 / 倍率」小标签。 */
.dsh-claude-model-btn[data-mpk-tag]::after {
  content: attr(data-mpk-tag); margin-left: 6px; font-size: 0.86em; font-weight: 500;
  color: var(--dsw-alias-label-tertiary, #91888a); font-variant-numeric: tabular-nums;
}
.dsh-claude-model-btn[data-mpk-free]::after { color: #15803d; font-weight: 600; }
@media (prefers-color-scheme: dark) { .dsh-claude-model-btn[data-mpk-free]::after { color: #4ade80; } }
/* 每条回答下方的本轮用量：跟在时间后面的一行小字。 */
.mpk-turn-usage {
  margin-left: 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #91888a);
  font-variant-numeric: tabular-nums; white-space: nowrap; cursor: default;
}
/*
 * 侧栏会话的悬停卡片：宿主写死了深色底（#2C2C2E），浅色主题里像一块黑补丁。
 * 改成和菜单、弹层一样的表面色，跟随浅色 / 深色主题。一两个字的提示条（如「归档会话」）保持深色，那是通行做法。
 */
html body [class*="_card_"]:has(> [class*="_hoverContent"]),
html body [class*="_card_"]:has([class*="_hoverTitle"]) {
  --dsw-hovercard-bg: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1, #fff));
  box-shadow: var(--dsw-elevation-panel, var(--dsw-shadow-lv3));
}
html body [class*="_card_"] [class*="_hoverTitle"] { color: var(--dsw-alias-label-primary, #161616); }
html body [class*="_card_"] :is([class*="_hoverPath"], [class*="_hoverTime"]) { color: var(--dsw-alias-label-secondary, #70686a); }
html body [class*="_card_"] [class*="_hoverStatus"] { color: var(--dsw-alias-label-tertiary, #91888a); }
/*
 * 启动时宿主的首次引导会先盖一层「正在加载设置…」遮罩（约 0.2 秒），读到「引导已完成」才撤掉；
 * 已完成引导的人每次启动都会看到顶部闪一行字。只隐藏这个加载中的状态，真正的引导页照常显示。
 */
html body [class*="_onboardingOverlay"]:has(> [class*="_onboardingStage"] > [role="status"]:only-child) {
  visibility: hidden !important; pointer-events: none !important;
}
/* 上下文百分比：占用低时用中性色，升高后才交给主题的颜色梯度提醒。 */
html body [data-dsh-claude-context-meter][data-dsh-claude-ramp-span="low"] button,
html body [data-dsh-claude-context-meter][data-dsh-claude-ramp-span="low"] button span,
html body [data-dsh-claude-meter-ring][data-dsh-claude-ramp-span="low"] .dsh-claude-meter-ring-value { color: var(--dsw-alias-label-secondary, #70686a) !important; }

/*
 * 推理等级：最高档的点阵保留，但不再循环闪烁——几百个方块同时做无限动画会让拖到 Max 时卡顿（实测 50–100ms 长任务）。
 * 滑块下方按当前模型实际支持的档位标出刻度名。
 */
html body .dsh-claude-effort-matrix-sq.dsh-claude-effort-matrix-sq,
html body .dsh-claude-effort-matrix-sq.dsh-claude-effort-matrix-sq::before,
html body .dsh-claude-effort-matrix-sq.dsh-claude-effort-matrix-sq::after { animation: none !important; }
.mpk-effort-scale { position: relative; height: 16px; margin-top: 6px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #91888a); }
.mpk-effort-scale > span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
.mpk-effort-scale > span:first-child { transform: none; }
.mpk-effort-scale > span:last-child:not(:first-child) { transform: translateX(-100%); }
.mpk-effort-scale > span[data-current] { color: var(--dsw-alias-label-primary, #1f1e1d); font-weight: 600; }

/* 英文文案换中文（只写属性，显示交给 CSS）。 */
[data-mpk-text] { font-size: 0 !important; letter-spacing: 0 !important; }
[data-mpk-text]::after { content: attr(data-mpk-text); font-size: var(--mpk-text-size, 12px); }
@media (prefers-color-scheme: dark) {
  .mpk-stats-pop { box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 8px 24px rgba(0,0,0,.4); }
}

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
.mpk-tag[data-tone="high"] { color: #b45309; }
.mpk-tag[data-tone="promo"] { background: transparent; box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 40%, transparent); }
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
  .mpk-tag[data-tone="free"] { color: #4ade80; }
  .mpk-tag[data-tone="high"], .mpk-tag[data-tone="warn"], .mpk-busy { color: #fbbf24; }
  .mpk-tag[data-tone="bad"], .mpk-busy[data-level="congested"] { color: #f87171; }
}
`

/**
 * 斜杠菜单里没有图标和中文标题的命令，按内置命令的写法补齐。
 * 图标取宿主自己的图标库，和内置命令风格一致。
 */

/** 权限分段按钮（claude-style 写死英文）→ 与会话页「完全权限」一致的中文。 */
const SEGMENT_LABELS = { Read: '只读', Edit: '编辑', Auto: '自动', Yolo: '完全权限' }

/** 首页问候（claude-style 写死英文）→ 中文。{name}、{weekday} 原样带过去。 */
const GREETINGS = [
  ['Afternoon, {name}. What’s next?', '下午好，{name}。接下来做什么？'],
  ['Back at it, {name}?', '又开工了，{name}？'],
  ['Burning the midnight oil, {name}?', '还在挑灯夜战吗，{name}？'],
  ['Coffee and Claude time?', '来杯咖啡，开工吧？'],
  ['Evening, how are things?', '晚上好，一切还顺利吗？'],
  ['Fresh start, {name}?', '新的开始，{name}？'],
  ['Good afternoon, {name}.', '下午好，{name}。'],
  ['Good evening, {name}.', '晚上好，{name}。'],
  ['Good morning, {name}!', '早上好，{name}！'],
  ['Happy {weekday}, {name}.', '{weekday}愉快，{name}。'],
  ['Hello, night owl.', '你好呀，夜猫子。'],
  ['Hey there, {name}.', '嗨，{name}。'],
  ['How was your day, {name}?', '今天过得怎么样，{name}？'],
  ['How’s the day going, {name}?', '今天进展如何，{name}？'],
  ['Midday check-in, {name}?', '午间小憩一下，{name}？'],
  ['Morning, {name}. What’s first?', '早，{name}。先做哪件事？'],
  ['Still up, {name}?', '还没睡呀，{name}？'],
  ['Welcome back, {name}.', '欢迎回来，{name}。'],
  ['What are you working on?', '在忙什么呢？'],
  ['What shall we build?', '今天想做点什么？'],
  ['What’s on the agenda today?', '今天有什么安排？'],
  ['Winding down, or just getting started?', '准备收工，还是刚刚开始？'],
  ['You are here!', '你来啦！'],
].map(([en, zh]) => {
  const pattern = en.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('{name}', '(?<name>.+?)').replace('{weekday}', '(?<weekday>[A-Za-z]+)')
  return { pattern: new RegExp(`^${pattern}$`), zh }
})
const WEEKDAYS = { Sunday: '周日', Monday: '周一', Tuesday: '周二', Wednesday: '周三', Thursday: '周四', Friday: '周五', Saturday: '周六' }

function translateGreeting(text) {
  for (const { pattern, zh } of GREETINGS) {
    const match = pattern.exec(text)
    if (match === null) continue
    return zh.replace('{name}', match.groups?.name ?? '').replace('{weekday}', WEEKDAYS[match.groups?.weekday] ?? match.groups?.weekday ?? '')
  }
  return null
}

const COMMAND_FACES = {
  autocompact: { label: '自动压缩', icon: 'IconGaugeOutlineRegular' },
  workbuddy: { label: 'WorkBuddy', icon: 'IconGlobeOutlineRegular' },
}

window.__ModuleLoader__.load({
  id: 'dsh-miaopeng-kit',
  factory(require) {
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    return {
      inject: [],
      apply(ctx) {
        // ---------- 斜杠命令：补图标和中文标题 ----------
        // commandUi.candidates 是实例方法（inputTriggers 每次都经 this 调用），包一层即可；
        // 停用时还原。
        ctx.inject(['commandUi'], (scope) => {
          const service = scope.commandUi
          const original = service.candidates
          if (typeof original !== 'function') return
          service.candidates = async function candidates(...args) {
            const rows = await original.apply(this, args)
            for (const row of rows ?? []) {
              const face = COMMAND_FACES[row?.name]
              if (face === undefined) continue
              if (row.label === undefined) row.label = face.label
              if (row.icon === undefined && primitives[face.icon]) row.icon = primitives[face.icon]
            }
            return rows
          }
          scope.effect(() => () => {
            if (service.candidates !== original) service.candidates = original
          })
        })

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
          const ruleNodes = []
          const background = getComputedStyle(popover).backgroundColor
          if (popover.style.getPropertyValue('--mpk-pop-bg') !== background) popover.style.setProperty('--mpk-pop-bg', background)
          for (const node of popover.querySelectorAll(`${RULE_SELECTOR}, ${ROW_SELECTOR}`)) {
            index += 1
            if (node.matches(RULE_SELECTOR)) {
              group += 1
              ruleNodes.push(node)
              setOrder(node, group * 10000)
              const nameNode = node.querySelector(RULE_NAME_SELECTOR)
              if (nameNode === null) continue
              // 中文名只通过属性 + CSS 显示：文字节点归 React 所有，替换它会让后续渲染出错。
              const original = nameNode.textContent ?? ''
              const shown = PROVIDER_LABELS[original] ?? original
              if (shown !== original) {
                if (nameNode.getAttribute(GROUP_ATTR) !== shown) nameNode.setAttribute(GROUP_ATTR, shown)
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
          ruleNodes.forEach((rule, at) => {
            setAttr(rule, 'data-mpk-first', at === 0 ? '' : null)
          })
        }

        /** 只在值变化时写属性；null 表示移除。 */
        function setAttr(node, name, value) {
          if (value === null) {
            if (node.hasAttribute(name)) node.removeAttribute(name)
          } else if (node.getAttribute(name) !== value) node.setAttribute(name, value)
        }

        /** 选择器里打勾的那一行：所在分组（提供方）+ 匹配到的模型数据。弹层关闭时行仍在 DOM 里。 */
        function currentModel() {
          const popover = document.querySelector(POPOVER_SELECTOR)
          if (popover === null) return null
          let label = ''
          for (const node of popover.querySelectorAll(`${RULE_SELECTOR}, ${ROW_SELECTOR}`)) {
            if (node.matches(RULE_SELECTOR)) {
              label = node.querySelector(RULE_NAME_SELECTOR)?.textContent ?? ''
              continue
            }
            if (node.getAttribute('aria-checked') !== 'true') continue
            const entries = groupIndex().get(label) ?? groupIndex().get(PROVIDER_LABELS[label]) ?? []
            return { label, entry: matchEntries(entries, rowKey(node))[0] }
          }
          return null
        }

        const regionOf = (label) => (/Overseas|国际|海外|\/intl$/.test(label) ? 'intl' : /Mainland|国内|大陆|\/cn$/.test(label) ? 'cn' : null)
        /** 输入框里的模型按钮带着当前会话真正使用的 provider id。 */
        const currentProvider = () => document.querySelector('[data-slot="conversation.input.model.label"]')?.closest('[data-provider-id]')?.getAttribute('data-provider-id') ?? null

        function shortCount(value) {
          if (!Number.isFinite(value)) return null
          if (value < 1e4) return value.toLocaleString('zh-CN')
          if (value < 1e8) return `${(value / 1e4).toFixed(value < 1e6 ? 1 : 0)}万`
          return `${(value / 1e8).toFixed(2)}亿`
        }

        // ---------- 用量与费用：用什么付费就按什么记 ----------
        //
        // 宿主端 /dsh-miaopeng-kit/turns 按轮给出 token 与计费方式（money / credits / tokens）。
        // 积分没有逐次扣费回执，所以每轮结束后实测余额变化，记在本机（localStorage），
        // 底栏、统计弹层、上下文弹层里的「费用」和每条回答下方的小字都用同一份数据。

        /** WorkBuddy 积分余额：region → { total, at }，30 秒内复用。 */
        const credits = new Map()
        /** 计量锚点：region → 上一次结算时的余额。只在一轮结算时移动，后台刷新不动它。 */
        const anchors = new Map()
        function ensureCredits(region, force = false) {
          const held = credits.get(region)
          if (!force && held !== undefined && Date.now() - held.at < 30000) return Promise.resolve(held)
          credits.set(region, { ...held, at: Date.now() })
          return fetchJson(`/workbuddy/credits?region=${region}`).then((json) => {
            const total = json?.credits?.ok ? json.credits.total : undefined
            // failed：这次没读到且之前也没有数，弹层显示「暂不可用」而不是一直「读取中」。
            const next = { total: total ?? held?.total, failed: total === undefined && held?.total === undefined, at: Date.now() }
            credits.set(region, next)
            if (total !== undefined && !anchors.has(region)) anchors.set(region, total)
            return next
          })
        }
        const balanceOf = (region) => {
          ensureCredits(region)
          return credits.get(region)?.total
        }

        const CREDIT_LOG_KEY = 'dsh-miaopeng-kit:credits'
        function readCreditLog() {
          try {
            return JSON.parse(localStorage.getItem(CREDIT_LOG_KEY) ?? '{}') ?? {}
          } catch {
            return {}
          }
        }
        let creditLog = readCreditLog()
        function recordCredits(key, value) {
          creditLog = { ...creditLog, [key]: Math.round(value * 100) / 100 }
          const keys = Object.keys(creditLog)
          if (keys.length > 2000) for (const old of keys.slice(0, keys.length - 2000)) delete creditLog[old]
          try {
            localStorage.setItem(CREDIT_LOG_KEY, JSON.stringify(creditLog))
          } catch {
            // 存不下就只在本次运行里显示。
          }
        }

        /** 一轮结束：等扣费落账后读余额，差值记到这一轮；晚到的扣费在第二次读取时补上。 */
        function measureTurn(region, key) {
          const settle = (first) => ensureCredits(region, true).then((held) => {
            const anchor = anchors.get(region)
            if (held.total === undefined || anchor === undefined) return
            const spent = Math.max(0, anchor - held.total)
            anchors.set(region, held.total)
            if (first || spent > 0) recordCredits(key, (first ? 0 : creditLog[key] ?? 0) + spent)
            scheduleUsage()
          })
          timers.push(setTimeout(() => settle(true), 4000))
          timers.push(setTimeout(() => settle(false), 20000))
        }

        const sessionIdNow = () => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null
        /** 会话 → { at, latest, turns } */
        const turnCache = new Map()
        let turnsLoading = null
        function loadTurns(session, force = false) {
          const held = turnCache.get(session)
          if (!force && held !== undefined && Date.now() - held.at < 15000) return
          if (turnsLoading === session) return
          turnsLoading = session
          // 币种和自定义计费表由宿主按 claude-style 的设置决定，这里只取结果。
          fetchJson(`/dsh-miaopeng-kit/turns?session=${encodeURIComponent(session)}`).then((json) => {
            turnsLoading = null
            if (!Array.isArray(json?.turns)) return
            turnCache.set(session, { at: Date.now(), currency: json.currency, turns: json.turns })
            scheduleUsage()
          })
        }

        /** 已结束的轮次（回答末尾的操作行出现即结束）。首次看到某个会话时只记下已有的轮次，不计量。 */
        const seenTurns = new Map()
        function watchTurns(session) {
          let latest = 0
          for (const tail of document.querySelectorAll('[data-chat-flow-kind="turn-tail"][data-chat-turn]')) {
            latest = Math.max(latest, Number(tail.getAttribute('data-chat-turn')) || 0)
          }
          const seen = seenTurns.get(session)
          seenTurns.set(session, Math.max(seen ?? 0, latest))
          if (seen === undefined || latest <= seen) return
          loadTurns(session, true)
          const region = regionOf(currentProvider() ?? '')
          if (region !== null) measureTurn(region, `${session}#${latest}`)
        }

        function formatMoney(amount, currency) {
          const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : null
          if (symbol === null || !Number.isFinite(amount)) return null
          if (amount === 0) return `${symbol}0`
          return `${symbol}${amount >= 1 ? amount.toFixed(2) : amount >= 0.01 ? amount.toFixed(3) : amount.toFixed(4)}`
        }
        const formatCredits = (value) => `${Math.round(value * 100) / 100} 积分`

        /** 一轮的花费文本；null 表示不知道（不显示）。 */
        function turnCost(session, turn) {
          if (turn.kind === 'money') return formatMoney(turn.amount, turn.currency)
          if (turn.kind === 'credits') {
            const value = creditLog[`${session}#${turn.turn}`]
            return value === undefined ? null : formatCredits(value)
          }
          return null
        }

        /** 本会话合计：按计费方式分别相加。 */
        function sessionTotals(session) {
          const data = turnCache.get(session)
          const totals = { money: 0, currency: data?.currency ?? 'CNY', hasMoney: false, credits: 0, hasCredits: false, unmeasured: 0, input: 0, cacheRead: 0, output: 0, turns: 0 }
          for (const turn of data?.turns ?? []) {
            totals.turns += 1
            totals.input += turn.input + turn.cacheRead
            totals.cacheRead += turn.cacheRead
            totals.output += turn.output
            if (turn.kind === 'money') {
              totals.money += turn.amount
              totals.hasMoney = true
            } else if (turn.kind === 'credits') {
              const value = creditLog[`${session}#${turn.turn}`]
              if (value === undefined) totals.unmeasured += 1
              else {
                totals.credits += value
                totals.hasCredits = true
              }
            }
          }
          return { ...totals, loaded: data !== undefined }
        }
        function totalsText(totals) {
          const parts = []
          if (totals.hasMoney && totals.money > 0) parts.push(formatMoney(totals.money, totals.currency))
          if (totals.hasCredits && totals.credits > 0) parts.push(formatCredits(totals.credits))
          return parts.join(' + ')
        }

        /** 本会话花了多少：有记录按记录；还没有花费时按当前计费方式给出「免费 / 0 积分 / ¥0」。 */
        function spentText(session) {
          const totals = sessionTotals(session)
          const spent = totalsText(totals)
          if (spent) return spent
          const now = billingNow()
          return now.kind === 'credits' ? (now.free ? '免费' : '0 积分') : formatMoney(0, totals.currency) ?? '—'
        }

        /** 当前选中模型的计费方式：{ kind: 'credits', region } | { kind: 'money' }，以及选择器里的数据。 */
        function billingNow() {
          ensureData()
          const provider = currentProvider()
          const entry = selectedEntry() ?? currentModel()?.entry
          const region = regionOf(provider ?? '')
          const free = entry !== undefined && rateValue(entry.rate) === 0
          return region !== null ? { kind: 'credits', region, free, entry } : { kind: 'money', free: false, entry }
        }

        /** 输入框下方模型按钮当前选中的模型，在 WorkBuddy 状态里的条目（倍率 / 状态 / 促销）；没有选择器打开也能用。 */
        function selectedEntry() {
          const trigger = document.querySelector('[data-slot="conversation.input.model.label"]')?.closest('[data-provider-id][data-model-id]')
          if (!trigger) return undefined
          const providerId = trigger.getAttribute('data-provider-id')
          const modelId = trigger.getAttribute('data-model-id')
          for (const provider of Object.values(snapshot?.providers ?? {})) {
            if (provider.provider !== providerId) continue
            const model = provider.models?.[modelId]
            if (model === undefined) return undefined
            return { id: modelId, rate: model.rate, verdict: model.verdict, busy: model.busy, promotion: promotions.get(providerId)?.get(modelId) }
          }
          return undefined
        }

        /** 模型按钮上跟一个小标签：免费 / 倍率，和选择器里的写法一致。按钱计费的模型不加。 */
        function decorateModelTag() {
          // 可见的是 claude-style 的模型按钮；宿主原来的按钮被它隐藏，但仍携带 provider / model id。
          const buttons = document.querySelectorAll('.dsh-claude-model-btn')
          if (buttons.length === 0) return
          const entry = billingNow().entry
          const value = rateValue(entry?.rate)
          const text = value === null ? null : value === 0 ? '免费' : String(entry.rate).replace(/x$/i, '×')
          for (const button of buttons) {
            setAttr(button, 'data-mpk-tag', text)
            setAttr(button, 'data-mpk-free', value === 0 ? '' : null)
            setAttr(button, 'title', text === null ? null : value === 0 ? '当前模型免费，不消耗积分' : `当前模型消耗倍率 ${text}`)
          }
        }

        /**
         * 底栏四项：花费 / Token / 缓存命中 / 轮次。没有数据的项不显示（新会话还没回答时只剩花费）。
         * 花费：按计费方式（钱 / 积分 / 免费）；当前模型会扣积分时带上余额。
         */
        function footerItems(session, totals) {
          if (session === null || totals === null) return {}
          const items = {}
          const cost = costLine(session)
          const freeNow = !totals.hasMoney && !totals.hasCredits && billingNow().free
          items.cost = { label: '花费', value: cost.replace(/^本会话 /, ''), free: freeNow, title: '本会话花费；点击查看明细' }
          if (!totals.loaded || totals.turns === 0) return items
          const tokens = totals.input + totals.output
          items.tokens = {
            label: 'Token',
            value: shortCount(tokens),
            title: `本会话 ${tokens.toLocaleString('zh-CN')} tokens：输入 ${totals.input.toLocaleString('zh-CN')}（其中缓存 ${totals.cacheRead.toLocaleString('zh-CN')}），输出 ${totals.output.toLocaleString('zh-CN')}`,
          }
          if (totals.input > 0) {
            items.cache = { label: '缓存命中', value: `${Math.round((totals.cacheRead / totals.input) * 100)}%`, title: '输入里命中缓存的比例；越高越省钱、越快' }
          }
          items.turns = { label: '轮次', value: String(totals.turns), title: `本会话 ${totals.turns} 轮对话` }
          return items
        }

        /**
         * 底栏只回答两个问题：这个会话花了多少、（积分计费时）还剩多少。
         * 当前模型是否免费看模型选择器；明细在点开的弹层里。
         */
        function costLine(session) {
          const parts = [`本会话 ${spentText(session)}`]
          const now = billingNow()
          // 免费模型不扣积分，余额只在会扣的时候才值得占位置；随时可以在弹层里看。
          const balance = now.kind === 'credits' && !now.free ? balanceOf(now.region) : undefined
          if (balance !== undefined) parts.push(`余 ${shortCount(balance)} 积分`)
          return parts.join(' · ')
        }

        function decorateStats() {
          const root = document.querySelector('.dsh-claude-inline-stats')
          const session = sessionIdNow()
          if (session !== null) {
            loadTurns(session)
            watchTurns(session)
          }
          if (root === null) return
          setAttr(root, 'data-mpk-stats', '')
          setAttr(root, 'title', '点击查看本会话用量')
          if (!root.style.getPropertyValue('--mpk-stats-size')) root.style.setProperty('--mpk-stats-size', getComputedStyle(root).fontSize)

          // 借用 claude-style 的四个段落当容器；数值一律来自本插件按会话缓存的数据，切换会话时不会串到上一个会话。
          const segs = [...root.querySelectorAll(':scope > .dsh-claude-inline-seg')]
          const segOf = (test) => segs.find(test) ?? null
          const slots = {
            cost: segOf((seg) => seg.querySelector('.dsh-claude-inline-cost') !== null),
            tokens: segOf((seg) => seg.querySelector('.dsh-claude-inline-total') !== null),
            cache: segOf((seg) => seg.getAttribute('data-dsh-claude-ramp') === 'cache'),
            turns: segOf((seg) => /轮|turn/i.test(seg.textContent ?? '')),
          }
          const totals = session === null ? null : sessionTotals(session)
          const items = footerItems(session, totals)
          // 轮次按对话里看得到的轮数（含失败的轮），和 claude-style 自己的计数一致。
          const shownTurns = Number(slots.turns?.querySelector('.dsh-claude-digit-group')?.textContent)
          if (items.turns !== undefined && Number.isFinite(shownTurns) && shownTurns > 0) {
            items.turns = { ...items.turns, value: String(shownTurns), title: `本会话 ${shownTurns} 轮对话` }
          }
          let order = 0
          for (const [key, seg] of Object.entries(slots)) {
            if (seg === null) continue
            const item = items[key]
            setAttr(seg, 'data-mpk-label', item?.label ?? null)
            setAttr(seg, 'data-mpk-short', item?.value ?? null)
            setAttr(seg, 'data-mpk-free', item?.free ? '' : null)
            setAttr(seg, 'title', item?.title ?? null)
            seg.style.setProperty('--mpk-order', String(order++))
          }
          if (statsPop !== null) renderStatsPop()
          decorateModelTag()
          decorateUsage()
          decorateContextPanel()
        }

        // ---------- 每条回答下方：本轮用量 ----------

        let usageQueued = false
        function scheduleUsage() {
          if (usageQueued) return
          usageQueued = true
          requestAnimationFrame(() => {
            usageQueued = false
            decorateUsage()
            decorateContextPanel()
          })
        }
        function decorateUsage() {
          const session = sessionIdNow()
          const data = session === null ? undefined : turnCache.get(session)
          if (data === undefined) return
          const byTurn = new Map(data.turns.map((turn) => [String(turn.turn), turn]))
          for (const tail of document.querySelectorAll('[data-chat-flow-kind="turn-tail"][data-chat-turn]')) {
            const actions = tail.querySelector('[data-clock="end"]')
            if (actions === null) continue
            const turn = byTurn.get(tail.getAttribute('data-chat-turn'))
            let line = actions.querySelector(':scope > .mpk-turn-usage')
            if (turn === undefined || turn.input + turn.cacheRead + turn.output === 0) {
              line?.remove()
              continue
            }
            const cost = turnCost(session, turn)
            const input = turn.input + turn.cacheRead
            const text = [`输入 ${shortCount(input)}`, `输出 ${shortCount(turn.output)}`, cost].filter(Boolean).join(' · ')
            if (line?.getAttribute(SIGNATURE_ATTR) === text) continue
            if (line === null) {
              line = el('span', 'mpk-turn-usage')
              actions.append(line)
            }
            line.setAttribute(SIGNATURE_ATTR, text)
            line.textContent = text
            const hit = input > 0 ? Math.round((turn.cacheRead / input) * 100) : 0
            const how = turn.kind === 'money' ? '按价格表计算' : turn.kind === 'credits' ? (cost === null ? '积分未计量（这一轮在开启积分计量前或在其他设备上完成）' : '积分 = 本轮结束前后的余额差') : '这个提供方没有价格信息'
            line.title = `${turn.model}\n输入 ${input.toLocaleString('zh-CN')} tokens（缓存命中 ${hit}%）\n输出 ${turn.output.toLocaleString('zh-CN')} tokens\n${how}`
          }
        }

        /** 上下文环弹层里的「费用」一行，换成按计费方式的本会话花费。 */
        function decorateContextPanel() {
          const session = sessionIdNow()
          if (session === null) return
          const panel = [...document.querySelectorAll('[role="dialog"], [class*="_panel"]')].find((node) => node.textContent.includes('上下文已用'))
          if (panel === undefined) return
          for (const label of panel.querySelectorAll('*')) {
            if (label.childElementCount !== 0 || label.textContent.trim() !== '费用') continue
            const value = label.nextElementSibling ?? label.parentElement?.nextElementSibling
            if (value === null || value === undefined) continue
            showText(value, spentText(session))
          }
        }

        // ---------- 统计弹层（从统计栏自己上方弹出） ----------

        let statsPop = null
        function renderStatsPop() {
          const root = document.querySelector('.dsh-claude-inline-stats')
          const session = sessionIdNow()
          if (root === null || session === null || statsPop === null) return closeStatsPop()
          const totals = sessionTotals(session)
          const now = billingNow()
          const row = (label, value, attrs = {}) => {
            const node = el('div', 'mpk-row')
            node.append(el('span', '', label), el('span', attrs.free ? 'mpk-free' : '', value))
            if (attrs.current) node.setAttribute('data-current', '')
            return node
          }
          const sections = []

          const money = el('section', '')
          money.append(el('h4', '', '费用'))
          money.append(row('本会话', spentText(session)))
          if (now.kind === 'credits') {
            money.append(row('当前模型', now.free ? '免费' : now.entry?.rate ? `倍率 ${String(now.entry.rate).replace(/x$/i, '×')}` : '按积分计费', { free: now.free }))
            for (const id of ['cn', 'intl']) {
              const balance = balanceOf(id)
              money.append(row(id === 'cn' ? 'WorkBuddy 国内版余额' : 'WorkBuddy 国际版余额', balance !== undefined ? `${balance} 积分` : credits.get(id)?.failed ? '暂不可用' : '读取中…', { current: id === now.region }))
            }
            money.append(el('div', 'mpk-note', '积分按每轮结束前后的余额差计算；同一账号在别处同时使用时会一并计入。'))
          } else {
            money.append(el('div', 'mpk-note', 'DeepSeek 官方按峰谷价计算，其他按价格目录估算；币种和自定义单价在 claude-style 设置的「计费币种」「自定义计费表」里改。'))
          }
          if (totals.unmeasured > 0) money.append(el('div', 'mpk-note', `${totals.unmeasured} 轮积分未计量（在开启积分计量前完成）。`))
          sections.push(money)

          const usage = el('section', '')
          usage.append(el('h4', '', 'Token'))
          usage.append(row('输入', totals.input.toLocaleString('zh-CN')))
          usage.append(row('输出', totals.output.toLocaleString('zh-CN')))
          if (totals.input > 0) usage.append(row('缓存命中', `${Math.round((totals.cacheRead / totals.input) * 100)}%`))
          sections.push(usage)

          statsPop.replaceChildren(...sections)
          const rect = root.getBoundingClientRect()
          const background = getComputedStyle(document.querySelector(POPOVER_SELECTOR) ?? document.body).backgroundColor
          statsPop.style.setProperty('--mpk-pop-bg', background === 'rgba(0, 0, 0, 0)' ? '#fff' : background)
          statsPop.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 308))}px`
          statsPop.style.bottom = `${innerHeight - rect.top + 8}px`
        }
        function openStatsPop() {
          statsPop = el('div', 'mpk-stats-pop')
          statsPop.setAttribute('role', 'dialog')
          statsPop.setAttribute('aria-label', '本会话用量')
          document.body.append(statsPop)
          renderStatsPop()
        }
        function closeStatsPop() {
          statsPop?.remove()
          statsPop = null
        }
        // 捕获阶段拦下统计栏的点击：原本它会打开右侧上下文环的弹层。
        const onStatsClick = (event) => {
          const inside = event.target instanceof Element && event.target.closest('.dsh-claude-inline-stats[data-mpk-stats]')
          if (inside) {
            if (event.type === 'click') (statsPop === null ? openStatsPop : closeStatsPop)()
            event.preventDefault()
            event.stopPropagation()
          } else if (statsPop !== null && event.type === 'pointerdown' && !statsPop.contains(event.target)) closeStatsPop()
        }
        const onStatsKey = (event) => {
          if (event.key === 'Escape' && statsPop !== null) closeStatsPop()
          if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.matches('.dsh-claude-inline-stats[data-mpk-stats]')) {
            event.preventDefault()
            event.stopPropagation()
            ;(statsPop === null ? openStatsPop : closeStatsPop)()
          }
        }
        for (const type of ['click', 'pointerdown', 'mousedown']) document.addEventListener(type, onStatsClick, true)
        document.addEventListener('keydown', onStatsKey, true)

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

        /** 用属性 + CSS 显示译文；text 为 null 时还原。 */
        function showText(node, text) {
          if (text !== null && !node.hasAttribute('data-mpk-text')) node.style.setProperty('--mpk-text-size', getComputedStyle(node).fontSize)
          setAttr(node, 'data-mpk-text', text)
        }

        /** 推理等级弹层：滑块下方按当前模型支持的档位标出刻度名。 */
        const EFFORT_NAMES = { off: 'Off', none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }
        function decorateEffort() {
          const box = document.querySelector('.dsh-claude-effort-popover[data-open="true"] .dsh-claude-effort')
          if (box === null) return
          const track = box.querySelector('.dsh-claude-effort-track')
          const ticks = [...box.querySelectorAll('.dsh-claude-effort-tick')]
          const trigger = document.querySelector('[data-slot="conversation.input.model.label"]')?.closest('[data-provider-id]')
          const model = models.find((entry) => entry.provider === trigger?.getAttribute('data-provider-id') && entry.id === trigger?.getAttribute('data-model-id'))
          let names = (model?.efforts ?? []).map((id) => EFFORT_NAMES[id] ?? id)
          if (names.length === ticks.length + 1 && names[0] === 'Off') names = names.slice(1)
          let scale = box.querySelector(':scope > .mpk-effort-scale')
          if (track === null || ticks.length < 2 || names.length !== ticks.length) {
            scale?.remove()
            return
          }
          const current = track.getAttribute('aria-valuetext') ?? ''
          const signature = `${names.join('/')}|${current}|${ticks.map((tick) => tick.style.left).join(',')}`
          if (scale?.getAttribute(SIGNATURE_ATTR) === signature) return
          if (scale === null) {
            scale = el('div', 'mpk-effort-scale')
            scale.setAttribute('aria-hidden', 'true')
            track.after(scale)
          }
          scale.setAttribute(SIGNATURE_ATTR, signature)
          scale.replaceChildren(...names.map((name, at) => {
            const label = el('span', '', name)
            label.style.left = ticks[at].style.left
            if (name.toLowerCase() === current.toLowerCase()) label.setAttribute('data-current', '')
            return label
          }))
        }

        /** 首页问候、权限分段按钮。 */
        function decorateLabels() {
          for (const node of document.querySelectorAll('[data-dsh-claude-part="hero-title-group"] > span:not([class])')) {
            showText(node, translateGreeting((node.textContent ?? '').trim()))
          }
          for (const node of document.querySelectorAll('.dsh-claude-segment')) {
            showText(node, SEGMENT_LABELS[(node.textContent ?? '').trim()] ?? null)
          }
          decorateContextPanel()
          decorateUsage()
          decorateEffort()
        }
        // 首页一出现就要换掉英文，所以观察节点增删（不看文字和属性，开销很小），合并到下一帧处理。
        // 生成回答时节点变化很密，所以节流：最多每 150ms 一次，第一次立即在下一帧处理（问候语不闪英文）。
        let labelsQueued = false
        let labelsAt = 0
        let labelsTimer
        const runLabels = () => {
          labelsQueued = false
          labelsAt = performance.now()
          try {
            decorateLabels()
            syncCaret()
          } catch (error) {
            console.warn('[dsh-miaopeng-kit] labels failed', error)
          }
        }

        /*
         * claude-style 自绘的输入光标只在选区 / 滚动 / 窗口大小变化时重算位置。从首页发出第一条消息后，
         * 输入框整体挪到新会话页底部，这几样都没变，光标就停在旧坐标（落在占位文字中间）。
         * 输入框换了位置时补发一次 selectionchange 让它重算；跟着过渡动画再补两次。
         */
        let caretKey = ''
        const caretTimers = []
        function syncCaret() {
          if (document.querySelector('[data-dsh-claude-caret-layer]') === null) return
          const field = document.activeElement?.closest?.('[contenteditable="true"]') ?? document.querySelector('[contenteditable="true"]')
          if (!field) return
          const box = field.getBoundingClientRect()
          const key = `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)}`
          if (key === caretKey) return
          const first = caretKey === ''
          caretKey = key
          if (first) return
          for (const timer of caretTimers.splice(0)) clearTimeout(timer)
          for (const delay of [0, 300, 700]) {
            caretTimers.push(setTimeout(() => document.dispatchEvent(new Event('selectionchange')), delay))
          }
        }
        const labelsObserver = new MutationObserver(() => {
          if (labelsQueued) return
          labelsQueued = true
          const wait = labelsAt + 150 - performance.now()
          if (wait <= 0) requestAnimationFrame(runLabels)
          else labelsTimer = setTimeout(() => requestAnimationFrame(runLabels), wait)
        })
        labelsObserver.observe(document.body, { childList: true, subtree: true })
        // 统计数字在生成时频繁变化，React 会反复重写文本；每秒对齐一次属性即可，
        // 不挂观察器（写属性不会再触发自己）。
        const statsTimer = setInterval(() => {
          if (document.visibilityState !== 'visible') return
          try {
            decorateStats()
            decorateEffort()
            syncCaret()
          } catch (error) {
            console.warn('[dsh-miaopeng-kit] stats failed', error)
          }
        }, 1000)

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
          clearInterval(statsTimer)
          closeStatsPop()
          for (const type of ['click', 'pointerdown', 'mousedown']) document.removeEventListener(type, onStatsClick, true)
          document.removeEventListener('keydown', onStatsKey, true)
          labelsObserver.disconnect()
          clearTimeout(labelsTimer)
          for (const timer of caretTimers.splice(0)) clearTimeout(timer)
          for (const node of document.querySelectorAll('.mpk-effort-scale')) node.remove()
          for (const node of document.querySelectorAll('[data-mpk-text]')) node.removeAttribute('data-mpk-text')
          for (const node of document.querySelectorAll('[data-mpk-stats], [data-mpk-show], [data-mpk-short], [data-mpk-first], [data-mpk-tag]')) {
            for (const name of ['data-mpk-stats', 'data-mpk-show', 'data-mpk-short', 'data-mpk-label', 'data-mpk-tone', 'data-mpk-first', 'data-mpk-tag', 'data-mpk-free']) node.removeAttribute(name)
          }
          bodyObserver.disconnect()
          popoverObserver?.disconnect()
          if (typeof unsubscribe === 'function') unsubscribe()
          style.remove()
          for (const node of document.querySelectorAll(`.${META_CLASS}, .mpk-id, .mpk-turn-usage`)) node.remove()
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
