#!/usr/bin/env node
/**
 * 把 baoyu-design 的四个技能装进 Claude Code，并打上编辑器汉化补丁。
 *
 *   node scripts/claude-skills.mjs                 安装 / 更新（拉取 github.com/JimLiu/baoyu-design 最新版）
 *   node scripts/claude-skills.mjs --source <dir>  用本地已有的 baoyu-design 仓库
 *   node scripts/claude-skills.mjs --remove        卸载这四个技能
 *   [--skills-dir <dir>]                           默认 $CLAUDE_CONFIG_DIR/skills，没设就是 ~/.claude/skills
 *
 * 技能装好后在 Claude Code 里用 /claude-slides、/claude-design、/claude-design-system、/claude-dashboard。
 * baoyu-design 里的 dataviz 不装：Claude Code 已经自带同名技能。
 * 技能不会自己升级，更新时重跑本脚本即可（汉化会一起重打），然后重启 Claude Code。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EDITORS, applyEditorZhCn } from './editor-zh-cn/apply.mjs'

const REPO = 'https://github.com/JimLiu/baoyu-design.git'
const SKILLS = EDITORS.map((editor) => editor.skill)

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const skillsDir = resolve(option('--skills-dir') ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills'))

if (args.includes('--remove')) {
  for (const skill of SKILLS) rmSync(join(skillsDir, skill), { recursive: true, force: true })
  console.log(`已从 ${skillsDir} 移除：${SKILLS.join('、')}`)
  process.exit(0)
}

let source = option('--source')
let temp
if (source === undefined) {
  temp = mkdtempSync(join(tmpdir(), 'baoyu-design-'))
  source = join(temp, 'baoyu-design')
  execFileSync('git', ['clone', '--quiet', '--depth', '1', REPO, source], { stdio: 'inherit' })
}

try {
  mkdirSync(skillsDir, { recursive: true })
  for (const skill of SKILLS) {
    const from = join(source, 'skills', skill)
    if (!existsSync(join(from, 'SKILL.md'))) throw new Error(`${from} 里没有 SKILL.md，不是 baoyu-design 仓库？`)
    // 先复制到旁边再替换，复制中途失败不会留下半个技能。
    const target = join(skillsDir, skill)
    const staging = `${target}.installing`
    rmSync(staging, { recursive: true, force: true })
    cpSync(from, staging, { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  }
  let commit = ''
  try { commit = execFileSync('git', ['-C', source, 'log', '-1', '--format=%h %cs'], { encoding: 'utf8' }).trim() } catch {}
  console.log(`已安装到 ${skillsDir}：${SKILLS.join('、')}${commit ? `（baoyu-design ${commit}）` : ''}`)

  const result = applyEditorZhCn({ skillsDirs: [skillsDir], log: console.log, warn: console.warn })
  if (result.state !== 'ok' || result.errors?.length) {
    console.error('编辑器汉化未完全成功：', result.errors?.join('；') ?? result.state)
    process.exitCode = 1
  } else {
    console.log(`编辑器汉化 v${result.version}：${[...result.patched, ...result.current].join('、') || '无'}`)
  }
  console.log('重启 Claude Code（或开新会话）后生效。')
} finally {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
}
