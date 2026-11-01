#!/usr/bin/env node
/**
 * 把 dsh-miaopeng-kit 安装进 DeepSeek Harness 的 profile。
 *
 *   Windows 桌面版：node install.mjs --app "D:\dsh" [--no-window-patch]          （install.ps1 调用）
 *   WSL / Linux：  node install.mjs [--profile-name web]                          （install.sh 调用）
 *   通用选项：     [--profile <dir>] [--no-extras] [--no-prefs] [--uninstall]
 *
 * 安装后 profile 的组合包列表里是 dsh-miaopeng-kit + package.json 里 dsh.kit.extras 列出的
 * 额外插件（baoyu-design 四个编辑器）。dsh-miaopeng-kit 锁定版本带上 claude-style、WorkBuddy 等，
 * 并在自己的组合包 patch 里启用它们；其余被它取代或与它重复的插件全部移除。
 *
 * 步骤：
 *   1. 复制本插件到 <profile>/plugins/dsh-miaopeng-kit；
 *   2. 改写 profile 的 package.json：本插件 + 额外插件（--no-extras 跳过额外插件）；
 *   3. 清理被移除插件留在 cordis.patch.yml 里的配置段；用户层还是空的就用 profile/cordis.patch.yml
 *      里的个人偏好打底（--no-prefs 跳过）；
 *   4. pnpm 安装（Windows 用应用自带的 pnpm，其他平台用 PATH 上的 pnpm）；
 *   5. Windows：给主进程打「记住窗口大小」补丁（--no-window-patch 跳过）。
 * 运行前请完全退出 DeepSeek Harness；install.ps1 / install.sh 会自动处理。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-miaopeng-kit'
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const PACKAGE_FILES = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'scripts']
const WINDOWS = process.platform === 'win32'

const args = process.argv.slice(2)
const option = (flag) => {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = option('--app') ?? (WINDOWS ? 'D:\\dsh' : undefined)
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileName = option('--profile-name') ?? (WINDOWS ? 'desktop' : 'web')
const profileDir = option('--profile') ?? join(dshHome, 'profiles', profileName)
const uninstall = args.includes('--uninstall')
const withExtras = !args.includes('--no-extras')
const withPrefs = !args.includes('--no-prefs')
const kit = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dsh.kit
const extras = kit.extras ?? {}

const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath) && !WINDOWS) {
  // npm 版第一次运行前还没有 profile；让 dsh 自己按模板生成一份。
  execFileSync('dsh', ['--profile', profileName, '--dump-default-config'], { stdio: 'ignore' })
}
if (!existsSync(manifestPath)) throw new Error(`找不到 profile：${manifestPath}（先启动一次 DeepSeek Harness）`)

// 1. 复制
const target = join(profileDir, 'plugins', NAME)
rmSync(target, { recursive: true, force: true })
if (!uninstall) {
  mkdirSync(target, { recursive: true })
  for (const file of PACKAGE_FILES) {
    if (existsSync(join(root, file))) cpSync(join(root, file), join(target, file), { recursive: true })
  }
}
for (const name of kit.remove) rmSync(join(profileDir, 'plugins', name), { recursive: true, force: true })

// 2. 依赖与 bundle
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const managed = new Set([NAME, ...kit.bundles, ...kit.remove])
manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([name]) => !managed.has(name)))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = (manifest.dsh.profile.bundles ?? BASE_BUNDLES).filter((name) => !managed.has(name))
if (!uninstall) {
  if (withExtras) {
    for (const [name, version] of Object.entries(extras.dependencies ?? {})) {
      manifest.dependencies[name] ??= version
      if (!bundles.includes(name)) bundles.push(name)
    }
  }
  manifest.dependencies[NAME] = `file:./plugins/${NAME}`
  bundles.push(NAME)
}
manifest.dsh.profile.bundles = bundles
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

// 新发布的包会被 pnpm 的 minimumReleaseAge 挡住；额外插件按清单放行。
const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
if (!uninstall && withExtras && extras.minimumReleaseAgeExclude?.length && existsSync(workspacePath)) {
  let workspace = readFileSync(workspacePath, 'utf8').replace(/\r\n/g, '\n')
  const missing = extras.minimumReleaseAgeExclude.filter((entry) => !workspace.includes(`- ${entry}`))
  if (missing.length) {
    if (!/^minimumReleaseAgeExclude:/m.test(workspace)) workspace = `${workspace.trimEnd()}\nminimumReleaseAgeExclude:\n`
    workspace = workspace.replace(/^minimumReleaseAgeExclude:\n/m, (head) => head + missing.map((entry) => `  - ${entry}\n`).join(''))
    writeFileSync(workspacePath, workspace)
  }
}

// 3. 配置：删掉被移除插件的配置段（指向不存在条目的配置会让加载报错）
const patchPath = join(profileDir, 'cordis.patch.yml')
// 一段从 "- id:" 起，到下一段或顶层注释为止（注释属于后面那一段，删除时保留）。
const blockPattern = /^- (?:id|insert): [\s\S]*?(?=^- (?:id|insert): |^#|(?![\s\S]))/gm
let patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8').replace(/\r\n/g, '\n') : '[]\n'
const prefsPath = join(root, 'profile', 'cordis.patch.yml')
const userLayerEmpty = !/^- (?:id|insert): /m.test(patch)
if (!uninstall && withPrefs && userLayerEmpty && existsSync(prefsPath)) {
  patch = readFileSync(prefsPath, 'utf8').replace(/\r\n/g, '\n')
  console.log('profile 用户层为空，已写入 profile/cordis.patch.yml 里的个人偏好')
}
const dropIds = new Set([...kit.removePatchIds, ...(uninstall ? ['ui-skin-claude-style'] : [])])
patch = patch.replace(blockPattern, (block) => {
  const id = /^- id: (\S+)/.exec(block)?.[1]
  return id !== undefined && dropIds.has(id) ? '' : block
})
writeFileSync(patchPath, patch)

// 4. 安装
const pnpmCandidates = [
  ...(appDir ? [join(appDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')] : []),
  join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
]
const bundledPnpm = WINDOWS ? pnpmCandidates.find((path) => existsSync(path)) : undefined
const pnpmArgs = ['install', '--prefer-offline', '--config.confirmModulesPurge=false']
if (bundledPnpm !== undefined) {
  execFileSync(process.execPath, [bundledPnpm, ...pnpmArgs], {
    cwd: profileDir,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
} else if (WINDOWS) {
  throw new Error('找不到应用自带的 pnpm，请用 --app 指定安装目录')
} else {
  execFileSync('pnpm', pnpmArgs, { cwd: profileDir, stdio: 'inherit' })
}

// pnpm 认为本地目录依赖「已是最新」时不会重新复制，升级后 node_modules 里会留着旧文件；
// 这里直接同步一遍，保证运行的就是刚装的版本。
if (!uninstall) {
  const installed = join(profileDir, 'node_modules', NAME)
  for (const file of PACKAGE_FILES) {
    if (existsSync(join(root, file))) cpSync(join(root, file), join(installed, file), { recursive: true, force: true })
  }
}

// 5. 窗口补丁（只有 Windows 桌面版有主窗口）
if (WINDOWS && !uninstall && !args.includes('--no-window-patch')) {
  const asar = join(appDir, 'resources', 'app.asar')
  execFileSync(process.execPath, [join(root, 'scripts', 'patch-window-state.mjs'), asar], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
  })
}

const restart = WINDOWS ? '重新打开 DeepSeek Harness 即可' : `运行 dsh ${profileName} 启动`
console.log(uninstall ? `${NAME} 已卸载` : `${NAME} 已安装（profile：${profileDir}），${restart}`)
