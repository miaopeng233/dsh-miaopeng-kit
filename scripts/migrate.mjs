#!/usr/bin/env node
/**
 * 把另一份 DSH_HOME（例如 Windows 桌面版的 C:\Users\<你>\.dsh）里的个人数据搬到当前这份。
 * 只在本机之间复制，不经过网络，也不会进 Git 仓库（凭据不能放进公开仓库）。
 *
 *   node migrate.mjs --from /mnt/c/Users/mp/.dsh [--from-profile desktop] [--to-profile web] [--sessions]
 *
 * 复制：
 *   .credentials.yaml          DeepSeek 账号登录状态
 *   dsh-workbuddy/             WorkBuddy 凭据、已启用模型
 *   dsh-miaopeng-kit/          /autocompact 等本插件设置（与目标合并）
 *   dsh-claude-style/、cache/dsh-claude-style/   用量统计、峰谷价缓存
 *   profiles/<from>/cordis.patch.yml → profiles/<to>/cordis.patch.yml   界面与模型设置（用户层）
 *   --sessions：sessions/ 与 storages/（会话历史；工作区路径是旧系统的，可能需要在新环境里重新选工作区）
 *
 * 目标里已有的文件先改名为 *.bak-<时间戳> 再覆盖。插件本身不在这里复制，用 install 装。
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const option = (flag) => {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}
const from = option('--from')
if (!from || !existsSync(from)) throw new Error('用 --from 指定旧的 .dsh 目录，例如 --from /mnt/c/Users/mp/.dsh')
const to = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const fromProfile = option('--from-profile') ?? 'desktop'
const toProfile = option('--to-profile') ?? (process.platform === 'win32' ? 'desktop' : 'web')
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)

function backup(path) {
  if (existsSync(path)) renameSync(path, `${path}.bak-${stamp}`)
}

function copy(relativeFrom, relativeTo = relativeFrom) {
  const source = join(from, relativeFrom)
  if (!existsSync(source)) return console.log(`跳过（旧目录里没有）：${relativeFrom}`)
  const target = join(to, relativeTo)
  backup(target)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
  console.log(`已复制：${relativeFrom}${relativeTo === relativeFrom ? '' : ` → ${relativeTo}`}`)
}

copy('.credentials.yaml')
copy('dsh-workbuddy')
copy('dsh-claude-style')
copy(join('cache', 'dsh-claude-style'))
copy(join('profiles', fromProfile, 'cordis.patch.yml'), join('profiles', toProfile, 'cordis.patch.yml'))

// 本插件设置：旧的为主，但保留目标机器特有的开关（fake-ip 补丁只对 npm 版有意义）。
const settingsFrom = join(from, 'dsh-miaopeng-kit', 'settings.json')
if (existsSync(settingsFrom)) {
  const settingsTo = join(to, 'dsh-miaopeng-kit', 'settings.json')
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return {}
    }
  }
  const current = read(settingsTo)
  const merged = { ...read(settingsFrom), ...('fakeIpPatch' in current ? { fakeIpPatch: current.fakeIpPatch } : {}) }
  mkdirSync(dirname(settingsTo), { recursive: true })
  writeFileSync(settingsTo, `${JSON.stringify(merged, null, 2)}\n`)
  console.log('已合并：dsh-miaopeng-kit/settings.json')
}

if (args.includes('--sessions')) {
  copy('sessions')
  copy('storages')
}

// 从 /mnt/c（Windows 盘）复制过来的文件都是 777，dsh 拒绝读别人可读的凭据。
// 统一收紧成只有自己可读写：文件 600、目录 700。
function ownerOnly(path) {
  if (process.platform === 'win32' || !existsSync(path)) return
  if (statSync(path).isDirectory()) {
    chmodSync(path, 0o700)
    for (const entry of readdirSync(path)) ownerOnly(join(path, entry))
  } else chmodSync(path, 0o600)
}
for (const path of ['.credentials.yaml', 'dsh-workbuddy', 'dsh-miaopeng-kit', 'dsh-claude-style', join('cache', 'dsh-claude-style'), 'sessions', 'storages']) {
  ownerOnly(join(to, path))
}
ownerOnly(join(to, 'profiles', toProfile, 'cordis.patch.yml'))

// 用户层被整体换掉了，CRLF 统一成 LF，免得 YAML 里混行尾。
const patchPath = join(to, 'profiles', toProfile, 'cordis.patch.yml')
if (existsSync(patchPath)) writeFileSync(patchPath, readFileSync(patchPath, 'utf8').replace(/\r\n/g, '\n'))

console.log(`完成：${from} → ${to}（profile ${fromProfile} → ${toProfile}）。接着运行 install 装插件。`)
