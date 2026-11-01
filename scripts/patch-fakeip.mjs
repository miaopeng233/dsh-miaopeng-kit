#!/usr/bin/env node
/**
 * 让 web_fetch 放行 TUN 代理的 fake-ip 网段 198.18.0.0/15。
 *
 * Clash / mihomo 等 TUN 模式把所有域名解析到 198.18.x.x，宿主的
 * `@deepseek-ai/dsh-web-fetch-http` 把它当成非公网地址一律拒绝，内置网页抓取全部失败。
 * 补丁只改 `isPublicIpAddress` 的 IPv4 分支，额外放行这一个 /15；内网、回环等照旧拒绝。
 *
 * 需要你自己运行一次本脚本来开启；开启后记在 ~/.dsh/dsh-miaopeng-kit/settings.json
 * （fakeIpPatch: true），插件启动时发现 dsh 升级冲掉了补丁就自动补回。--remove 同时关闭自愈。
 *
 * 适用于 npm 安装的 dsh（WSL / Linux / macOS）：那里是普通 JS 文件，直接文本替换即可。
 * Windows 桌面版的同一函数在 app.asar 里：由 patch-window-state.mjs 在应用退出后按同一开关打 / 撤，
 * 在应用里用 /fakeip on|off 切换。
 *
 *   node patch-fakeip.mjs            打补丁（幂等）
 *   node patch-fakeip.mjs --check    只检查
 *   node patch-fakeip.mjs --remove   移除
 *   node patch-fakeip.mjs --file <index.js>   指定文件
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE = join('@deepseek-ai', 'dsh-web-fetch-http', 'lib', 'index.js')
export const MARK = '/* miaopeng-fakeip */'
export const ORIGINAL = 'if (parsed instanceof ipaddr.IPv4) return parsed.range() === "unicast";'
export const PATCHED = `if (parsed instanceof ipaddr.IPv4) return parsed.range() === "unicast" || ${MARK} parsed.match(ipaddr.IPv4.parse("198.18.0.0"), 15);`

/** 从 dsh 包根目录往下找；npm 可能把依赖提升到上一层 node_modules。 */
function candidatesFrom(packageRoot) {
  return [join(packageRoot, 'node_modules', MODULE), join(dirname(dirname(packageRoot)), MODULE)]
}

function dshPackageRoots() {
  const roots = []
  // 宿主进程里 argv[1] 就是 dsh 的 lib/bin.js。
  for (const entry of [process.argv[1]]) {
    try {
      let dir = dirname(realpathSync(entry))
      for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
        const manifest = join(dir, 'package.json')
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') {
          roots.push(dir)
          break
        }
      }
    } catch {}
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    roots.push(join(globalRoot, '@deepseek-ai', 'dsh'))
  } catch {}
  return roots
}

export function findWebFetchModule() {
  for (const root of dshPackageRoots()) {
    for (const file of candidatesFrom(root)) if (existsSync(file)) return file
  }
  return undefined
}

/**
 * @returns {{ file?: string, state: 'patched' | 'applied' | 'removed' | 'unpatched' | 'missing' | 'unknown' }}
 *   applied = 这次刚打上（需重启 dsh 生效）；unknown = 宿主改了写法，找不到要替换的那一行。
 */
export function patchFakeIp({ file = findWebFetchModule(), mode = 'apply' } = {}) {
  if (file === undefined || !existsSync(file)) return { state: 'missing' }
  const source = readFileSync(file, 'utf8')
  const patched = source.includes(MARK)
  if (mode === 'check') return { file, state: patched ? 'patched' : source.includes(ORIGINAL) ? 'unpatched' : 'unknown' }
  if (mode === 'remove') {
    if (!patched) return { file, state: 'unpatched' }
    writeFileSync(file, source.replace(PATCHED, ORIGINAL))
    return { file, state: 'removed' }
  }
  if (patched) return { file, state: 'patched' }
  if (!source.includes(ORIGINAL)) return { file, state: 'unknown' }
  writeFileSync(file, source.replace(ORIGINAL, PATCHED))
  return { file, state: 'applied' }
}

const settingsFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-miaopeng-kit', 'settings.json')

/** 用户是否开启了 fake-ip 补丁（/fakeip on 或手动运行过本脚本）。 */
export function fakeIpOptedIn() {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')).fakeIpPatch === true
  } catch {
    return false
  }
}

/** 记录用户是否开启（只有手动开启过才会自愈）。 */
export function setFakeIpOptIn(enabled) {
  const path = settingsFile()
  let settings = {}
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
  settings.fakeIpPatch = enabled
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--file')
  const mode = args.includes('--check') ? 'check' : args.includes('--remove') ? 'remove' : 'apply'
  const result = patchFakeIp({ file: at < 0 ? undefined : args[at + 1], mode })
  if (mode === 'apply' && (result.state === 'applied' || result.state === 'patched')) setFakeIpOptIn(true)
  if (mode === 'remove' && result.state !== 'missing') setFakeIpOptIn(false)
  const text = {
    patched: '已带 fake-ip 补丁',
    applied: '已打上 fake-ip 补丁（重启 dsh 生效）',
    removed: '已移除 fake-ip 补丁（重启 dsh 生效）',
    unpatched: '未打 fake-ip 补丁',
    missing: '找不到 @deepseek-ai/dsh-web-fetch-http（dsh 没用 npm 装？）',
    unknown: '宿主改了 isPublicIpAddress 的写法，补丁需要更新',
  }[result.state]
  console.log(`${text}${result.file ? `\n  ${result.file}` : ''}`)
  if (result.state === 'missing' || result.state === 'unknown') process.exitCode = 1
}
