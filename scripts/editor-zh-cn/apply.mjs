/**
 * editor-zh-cn — 给 baoyu-design 系列编辑器打简体中文补丁（幂等自愈）。
 *
 * 背景：claude-slides / claude-design / claude-design-system / claude-dashboard 这四个
 * 插件各自带一个预构建的 React 编辑器页面（scripts/editor/index.html + assets/*.js）。
 * 它们内置 i18n 运行时：模块初始化时读取
 *
 *     globalThis.__appifact_i18n = { lang, settled: { <message-id>: <text> } }
 *
 * 只要在 bundle 之前把中文目录放进去，formatMessage 渲染出来就是中文，无需碰 DOM。
 * 少数 UI 文案是纯字符串字面量（没有 message id），由第二层 DOM 兜底按原文替换。
 *
 * 为什么需要自愈：这些文件属于**别人发布的 npm 包**，插件一升级，node_modules 被
 * pnpm 重写，补丁必然消失。所以每次启动检查一次，缺失或版本不符就重新写入。
 *
 * 用法：
 *   import { applyEditorZhCn } from './editor-zh-cn/apply.mjs'
 *   applyEditorZhCn({ log, warn, config })
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 补丁标记：用于识别「已经打过」以及版本比对。 */
const MARKER = 'dsh-miaopeng-kit:editor-zh-cn'
const I18N_TAG = '<script id="zh-i18n">'
const INLINE_TAG = '<script id="zh-cn-inline">'
const EXTERNAL_TAG = '<script src="./zh-cn.js"></script>'

/**
 * 四个编辑器。`protect` 是 DOM 兜底层必须跳过的区域：
 * 幻灯片正文、可编辑文字、演讲者备注、画板内容、图表媒体、用户页面。
 * dashboard 的编辑器服务端只下发固定文件，所以它的补丁必须内联进 index.html。
 */
const EDITORS = [
  {
    key: 'slides',
    skill: 'claude-slides',
    package: 'dsh-claude-slides',
    protect: 'section, [contenteditable], [data-notes-scroll], svg, img, canvas, video, x-embed',
    inline: false,
  },
  {
    key: 'design',
    skill: 'claude-design',
    package: 'dsh-claude-design',
    protect: '[contenteditable], svg, img, canvas, video, x-embed, x-dc, iframe',
    inline: false,
  },
  {
    key: 'design-system',
    skill: 'claude-design-system',
    package: 'dsh-claude-design-system',
    protect: '[contenteditable], svg, img, canvas, video, x-embed, iframe',
    inline: false,
  },
  {
    key: 'dashboard',
    skill: 'claude-dashboard',
    package: 'dsh-claude-dashboard',
    protect: '[contenteditable], svg, img, canvas, video, x-embed, iframe, #dash-root',
    inline: true,
  },
]

/** 复合文案规则：整串匹配不到时按结构翻译。返回 null 表示这条规则不适用。 */
const PATTERNS = [
  [/^(\d+)%, Zoom$/, (_, a) => `${a}%，缩放`],
  [/^Page (\d+), pages$/, (_, a) => `第 ${a} 页，页面`],
  [/^Page (\d+)$/, (_, a) => `第 ${a} 页`],
  [/^Slide (\d+) of (\d+): (.*)$/, (_, a, b, c) => `幻灯片 ${a} / ${b}：${c}`],
  [/^Artboard (\d+) of (\d+): (.*)$/, (_, a, b, c) => `画板 ${a} / ${b}：${c}`],
  [/^Heading, (.*), (\d+) of (\d+)$/, (_, t, a, b) => `标题，${t}，第 ${a} / ${b} 个`],
  [/^Text, (.*), (\d+) of (\d+)$/, (_, t, a, b) => `文本，${t}，第 ${a} / ${b} 个`],
  [/^Shortcut: (.+)$/, (_, k) => `快捷键：${k}`],
  [/^Collapse (.+)$/, (_, a) => `折叠 ${a}`],
  [/^Expand (.+)$/, (_, a) => `展开 ${a}`],
  [/^Open artboard (.+) full window$/, (_, a) => `全屏打开画板 ${a}`],
  [/^Export artboard (.+)$/, (_, a) => `导出画板 ${a}`],
  [/^Add color to (.+)$/, (_, a) => `向 ${a} 添加颜色`],
  [/^Usage notes: (.+)$/, (_, a) => `用法说明：${a}`],
  [/^Zoom the Canvas view \((.+)\)$/, (_, k) => `缩放画布视图（${k}）`],
  [/^Zoom \((.+)\)$/, (_, k) => `缩放（${k}）`],
]

function loadResources() {
  const catalog = JSON.parse(readFileSync(join(HERE, 'catalog-zh.json'), 'utf8'))
  const domMap = JSON.parse(readFileSync(join(HERE, 'dom-map.json'), 'utf8'))
  return { catalog, domMap }
}

/** 目录指纹：内容变了就重打，没变就跳过。 */
function fingerprint(catalog, domMap) {
  return createHash('sha256')
    .update(JSON.stringify(catalog))
    .update(JSON.stringify(domMap))
    .digest('hex')
    .slice(0, 12)
}

/** 找到某个编辑器目录；插件没装就返回 null。 */
function resolveEditorDir(editor) {
  // profile 的 node_modules 里，插件的 skills/<skill>/scripts/editor
  const roots = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir !== undefined) roots.push(join(profileDir, 'node_modules'))
  // 兜底：从本模块往上找（node_modules 与 plugins 两种布局都覆盖）
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    if (dir.endsWith('node_modules')) { roots.push(dir); break }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  roots.push(join(HERE, '..', '..', '..', '..', 'node_modules'))

  for (const root of roots) {
    const candidate = join(root, editor.package, 'skills', editor.skill, 'scripts', 'editor')
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return null
}

function buildI18nBoot(catalog, version) {
  return `/* ${MARKER} v${version}：注入 __appifact_i18n 中文消息目录。
 * 必须在 bundle 模块之前执行（本段放在 <head> 里）。 */
(function () {
  'use strict';
  var SETTLED = ${JSON.stringify(catalog).replace(/<\//g, '<\\/')};
  var g = globalThis;
  if (!g.__appifact_i18n || typeof g.__appifact_i18n !== 'object') {
    g.__appifact_i18n = { lang: 'zh-CN', settled: SETTLED };
  } else {
    g.__appifact_i18n.lang = 'zh-CN';
    if (!g.__appifact_i18n.settled || typeof g.__appifact_i18n.settled !== 'object') g.__appifact_i18n.settled = {};
    for (var k in SETTLED) if (Object.prototype.hasOwnProperty.call(SETTLED, k)) g.__appifact_i18n.settled[k] = SETTLED[k];
  }
})();`
}

function buildDomLayer(editor, domMap, version) {
  const mapJson = JSON.stringify(domMap).replace(/<\//g, '<\\/')
  const patterns = PATTERNS.map(([re, fn]) => `[${re.toString()}, ${fn.toString()}]`).join(',\n    ')
  return `/* ${MARKER} v${version}：DOM 兜底，处理没有 message id 的纯字符串 UI 文案。 */
(function () {
  'use strict';
  if (window.__dshEditorZhCn) return;
  window.__dshEditorZhCn = true;
  var MAP = ${mapJson};
  var PATTERNS = [
    ${patterns}
  ];
  var PROTECTED = ${JSON.stringify(editor.protect)};
  function inside(el, sel) { return !!(el && el.closest && el.closest(sel)); }
  function translate(v) {
    var t = v.trim();
    if (!t) return null;
    if (Object.prototype.hasOwnProperty.call(MAP, t)) return v.replace(t, MAP[t]);
    for (var i = 0; i < PATTERNS.length; i++) {
      var m = t.match(PATTERNS[i][0]);
      if (!m) continue;
      var out = PATTERNS[i][1].apply(null, m);
      if (out == null || out === '') continue;
      return v.replace(t, out);
    }
    return null;
  }
  function walk(root) {
    if (!root) return;
    var n, tw;
    try { tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null); }
    catch (e) { return; }
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) {
        var p = n.parentElement;
        if (!p || inside(p, PROTECTED)) continue;
        var nv = translate(n.nodeValue);
        if (nv !== null) n.nodeValue = nv;
      } else if (n.nodeType === 1) {
        if (inside(n, PROTECTED)) continue;
        var attrs = ['title', 'aria-label', 'placeholder'];
        for (var i = 0; i < attrs.length; i++) {
          var val = n.getAttribute && n.getAttribute(attrs[i]);
          if (!val) continue;
          var nv2 = translate(val);
          if (nv2 !== null) n.setAttribute(attrs[i], nv2);
        }
      }
    }
  }
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var raf = window.requestAnimationFrame || function (f) { return window.setTimeout(f, 16); };
    raf(function () { scheduled = false; walk(document.body); });
  }
  function start() {
    if (!document.body) return;
    walk(document.body);
    try {
      new MutationObserver(schedule).observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder']
      });
    } catch (e) { }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`
}

/** 幂等写入：内容相同就不动文件（避免触发编辑器 HMR 与多余 mtime 变化）。 */
function writeIfChanged(path, content) {
  if (existsSync(path)) {
    try { if (readFileSync(path, 'utf8') === content) return false } catch { /* 读不到就重写 */ }
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, path)
  return true
}

/** 清掉旧补丁（换版本或要移除时用），返回是否有改动。 */
function stripPatch(html) {
  let out = html
  out = out.replace(/\n?<script id="zh-i18n">[\s\S]*?<\/script>/g, '')
  out = out.replace(/\n?<script id="zh-cn-inline">[\s\S]*?<\/script>/g, '')
  out = out.replace(/\n?<script src="\.\/zh-cn\.js"><\/script>/g, '')
  return out
}

/** 给单个编辑器打补丁。返回 'patched' | 'current' | 'skipped'。 */
function patchEditor(editor, resources, version) {
  const dir = resolveEditorDir(editor)
  if (dir === null) return { state: 'skipped', reason: 'not installed' }

  const htmlPath = join(dir, 'index.html')
  const original = readFileSync(htmlPath, 'utf8')

  // 已是同版本：跳过（但外部 js 可能被插件升级删掉，需一并确认）
  const currentTag = `${MARKER} v${version}`
  if (original.includes(currentTag)) {
    const jsPath = join(dir, 'zh-cn.js')
    if (editor.inline || existsSync(jsPath)) return { state: 'current', dir }
  }

  const i18nBoot = buildI18nBoot(resources.catalog, version)
  const domLayer = buildDomLayer(editor, resources.domMap, version)

  // 外部 js 承载两层（slides/design/design-system 可用）；dashboard 必须内联
  if (!editor.inline) {
    writeIfChanged(join(dir, 'zh-cn.js'), `${i18nBoot}\n\n${domLayer}\n`)
  }

  let html = stripPatch(original)
  const headBlock = `${I18N_TAG}\n${i18nBoot}\n</script>`
  html = html.includes('<head>') ? html.replace('<head>', `<head>\n${headBlock}`) : `${headBlock}\n${html}`

  if (editor.inline) {
    const block = `${INLINE_TAG}\n${domLayer}\n</script>`
    html = html.includes('</body>') ? html.replace('</body>', `${block}\n</body>`) : `${html}\n${block}`
  } else {
    const ref = `${EXTERNAL_TAG}`
    html = html.includes('</body>') ? html.replace('</body>', `${ref}\n</body>`) : `${html}\n${ref}`
  }

  writeIfChanged(htmlPath, html)
  return { state: 'patched', dir }
}

/**
 * 给全部编辑器打补丁。
 *
 * @param {object} options
 * @param {(message: string) => void} [options.log]  成功日志
 * @param {(message: string, error?: unknown) => void} [options.warn] 警告日志
 * @param {object} [options.config]  插件配置；`config.editorZhCn === false` 可关闭
 * @returns {{ state: 'ok' | 'off' | 'error', version?: string, patched?: string[], current?: string[], skipped?: string[], errors?: string[] }}
 */
export function applyEditorZhCn(options = {}) {
  const { log = () => {}, warn = () => {}, config = {} } = options
  if (config.editorZhCn === false) return { state: 'off' }

  let resources
  try {
    resources = loadResources()
  } catch (error) {
    warn('editor-zh-cn: 资源缺失（catalog-zh.json / dom-map.json）', error)
    return { state: 'error', errors: ['resources missing'] }
  }

  const version = fingerprint(resources.catalog, resources.domMap)
  const patched = []
  const current = []
  const skipped = []
  const errors = []

  for (const editor of EDITORS) {
    try {
      const result = patchEditor(editor, resources, version)
      if (result.state === 'patched') patched.push(editor.key)
      else if (result.state === 'current') current.push(editor.key)
      else skipped.push(editor.key)
    } catch (error) {
      errors.push(`${editor.key}: ${error?.message ?? error}`)
    }
  }

  if (patched.length > 0) {
    log(`editor-zh-cn: 已汉化 ${patched.join('、')}${current.length > 0 ? `（其余 ${current.length} 个已是最新）` : ''}`)
  }
  for (const error of errors) warn(`editor-zh-cn: ${error}`)

  return { state: 'ok', version, patched, current, skipped, errors }
}

/** 移除全部补丁（插件卸载或想恢复英文时用）。 */
export function removeEditorZhCn(options = {}) {
  const { log = () => {}, warn = () => {} } = options
  const removed = []
  for (const editor of EDITORS) {
    try {
      const dir = resolveEditorDir(editor)
      if (dir === null) continue
      const htmlPath = join(dir, 'index.html')
      const html = readFileSync(htmlPath, 'utf8')
      const stripped = stripPatch(html)
      if (stripped !== html) { writeIfChanged(htmlPath, stripped); removed.push(editor.key) }
      rmSync(join(dir, 'zh-cn.js'), { force: true })
    } catch (error) {
      warn(`editor-zh-cn: 移除 ${editor.key} 失败`, error)
    }
  }
  if (removed.length > 0) log(`editor-zh-cn: 已移除 ${removed.join('、')} 的汉化补丁`)
  return { state: 'ok', removed }
}

export { EDITORS, MARKER }
