#!/usr/bin/env node
/**
 * 把 dsh-miaopeng-kit 安装进 DeepSeek Harness 的 desktop profile。
 *
 *   node install.mjs --app "D:\dsh" [--profile <dir>] [--no-window-patch] [--uninstall]
 *
 * 安装后 profile 的依赖和组合包列表里都只有 dsh-miaopeng-kit 一项：它锁定版本带上
 * claude-style（外观）和 WorkBuddy（模型），并在自己的组合包 patch 里启用它们；
 * 其余被它取代或与它重复的插件全部移除。
 *
 * 步骤：
 *   1. 复制本插件到 <profile>/plugins/dsh-miaopeng-kit；
 *   2. 改写 profile 的 package.json：依赖和组合包只留本插件；
 *   3. 清理被移除插件留在 cordis.patch.yml 里的配置段；
 *   4. 用应用自带的 pnpm 安装；
 *   5. 给主进程打「记住窗口大小」补丁（--no-window-patch 跳过）。
 * 运行前请完全退出 DeepSeek Harness（包括托盘）；install.ps1 会自动处理。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-miaopeng-kit'
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const PACKAGE_FILES = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'scripts']

const args = process.argv.slice(2)
const option = (flag) => {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = option('--app') ?? 'D:\\dsh'
const profileDir = option('--profile') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop')
const uninstall = args.includes('--uninstall')
const kit = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dsh.kit

const manifestPath = join(profileDir, 'package.json')
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
  manifest.dependencies[NAME] = `file:./plugins/${NAME}`
  bundles.push(NAME)
}
manifest.dsh.profile.bundles = bundles
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

// 3. 配置：删掉被移除插件的配置段（指向不存在条目的配置会让加载报错）
const patchPath = join(profileDir, 'cordis.patch.yml')
// 一段从 "- id:" 起，到下一段或顶层注释为止（注释属于后面那一段，删除时保留）。
const blockPattern = /^- (?:id|insert): [\s\S]*?(?=^- (?:id|insert): |^#|(?![\s\S]))/gm
let patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8').replace(/\r\n/g, '\n') : '[]\n'
const dropIds = new Set([...kit.removePatchIds, ...(uninstall ? ['ui-skin-claude-style'] : [])])
patch = patch.replace(blockPattern, (block) => {
  const id = /^- id: (\S+)/.exec(block)?.[1]
  return id !== undefined && dropIds.has(id) ? '' : block
})
writeFileSync(patchPath, patch)

// 4. 安装
const pnpmCandidates = [
  join(appDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
  join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
]
const pnpm = pnpmCandidates.find((path) => existsSync(path))
if (pnpm === undefined) throw new Error('找不到应用自带的 pnpm，请用 --app 指定安装目录')
execFileSync(process.execPath, [pnpm, 'install', '--prefer-offline', '--config.confirmModulesPurge=false'], {
  cwd: profileDir,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})

// pnpm 认为本地目录依赖「已是最新」时不会重新复制，升级后 node_modules 里会留着旧文件；
// 这里直接同步一遍，保证运行的就是刚装的版本。
if (!uninstall) {
  const installed = join(profileDir, 'node_modules', NAME)
  for (const file of PACKAGE_FILES) {
    if (existsSync(join(root, file))) cpSync(join(root, file), join(installed, file), { recursive: true, force: true })
  }
}

// 5. 窗口补丁
if (!uninstall && !args.includes('--no-window-patch')) {
  const asar = join(appDir, 'resources', 'app.asar')
  execFileSync(process.execPath, [join(root, 'scripts', 'patch-window-state.mjs'), asar], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
  })
}

console.log(uninstall ? `${NAME} 已卸载` : `${NAME} 已安装，重新打开 DeepSeek Harness 即可`)
