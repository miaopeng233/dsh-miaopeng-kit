#!/usr/bin/env node
/**
 * 给 DeepSeek Harness 的主进程打「记住窗口大小和位置」的补丁。
 *
 * 宿主把主窗口写死成 1280×820，也没有保存逻辑；这只能在 Electron 主进程
 * （resources/app.asar 里的 lib/main.js）里改，插件够不到。
 *
 * 做法：只替换 asar 里的 lib/main.js——新内容追加到数据区末尾，改写头部里该文件的
 * offset/size/integrity，其他文件（包括 app.asar.unpacked 的标记）原样保留。
 * 原文件备份为 app.asar.miaopeng-backup；用 --restore 还原。
 *
 * 用法（必须先完全退出 DeepSeek Harness，包括托盘）：
 *   node patch-window-state.mjs "D:\dsh\resources\app.asar"
 *   node patch-window-state.mjs "D:\dsh\resources\app.asar" --restore
 *   node patch-window-state.mjs "D:\dsh\resources\app.asar" --check
 *   node patch-window-state.mjs "D:\dsh\resources\app.asar" --after-exit
 *     （插件启动时以分离进程调用：已打过补丁立即退出；否则等所有 DeepSeek Harness
 *      进程退出后再打，下次启动生效）
 *
 * 软件更新会换掉 app.asar，更新后重新运行一次即可（脚本是幂等的）。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'

// 在 Electron 的 RunAsNode 下运行时，fs 会把 .asar 当目录透明读取；这里要按普通文件处理。
process.noAsar = true

const MARKER = '__miaopengWindowState'
const BLOCK_SIZE = 4 * 1024 * 1024

const [asarPath, flag] = process.argv.slice(2)
if (!asarPath) {
  console.error('用法: node patch-window-state.mjs <app.asar 路径> [--restore|--check]')
  process.exit(2)
}
const backupPath = `${asarPath}.miaopeng-backup`

if (flag === '--restore') {
  if (!existsSync(backupPath)) {
    console.error(`没有找到备份 ${backupPath}`)
    process.exit(1)
  }
  copyFileSync(backupPath, asarPath)
  console.log('已还原原始 app.asar')
  process.exit(0)
}

function readArchive(path) {
  const buffer = readFileSync(path)
  const headerPickleSize = buffer.readUInt32LE(4)
  const jsonSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'))
  return { buffer, header, dataOffset: 8 + headerPickleSize }
}

function entryAt(header, path) {
  let node = header
  for (const part of path.split('/')) {
    node = node.files?.[part]
    if (node === undefined) throw new Error(`asar 中找不到 ${path}`)
  }
  return node
}

function integrityOf(content) {
  const blocks = []
  for (let start = 0; start < content.length; start += BLOCK_SIZE) {
    blocks.push(createHash('sha256').update(content.subarray(start, start + BLOCK_SIZE)).digest('hex'))
  }
  return {
    algorithm: 'SHA256',
    hash: createHash('sha256').update(content).digest('hex'),
    blockSize: BLOCK_SIZE,
    blocks,
  }
}

function serializeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const padded = Math.ceil(json.length / 4) * 4
  const payload = Buffer.alloc(4 + padded)
  payload.writeUInt32LE(json.length, 0)
  json.copy(payload, 4)
  const headerPickle = Buffer.alloc(4 + payload.length)
  headerPickle.writeUInt32LE(payload.length, 0)
  payload.copy(headerPickle, 4)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle])
}

const HELPERS = `
/* dsh-miaopeng-kit: remember the main window's size, position and maximized state. */
const __miaopengWindowStateFile = () => join(app.getPath("userData"), "miaopeng-window-state.json");
function ${MARKER}Load() {
	try {
		const state = JSON.parse(readFileSync(__miaopengWindowStateFile(), "utf8"));
		if (!Number.isFinite(state.width) || !Number.isFinite(state.height)) return void 0;
		const width = Math.max(520, Math.round(state.width));
		const height = Math.max(600, Math.round(state.height));
		const maximized = state.maximized === true;
		if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
			const onScreen = __miaopengScreen.getAllDisplays().some(({ workArea: area }) => state.x < area.x + area.width - 80 && state.x + width > area.x + 80 && state.y >= area.y - 16 && state.y < area.y + area.height - 40);
			if (onScreen) return { width, height, x: Math.round(state.x), y: Math.round(state.y), maximized };
		}
		return { width, height, maximized };
	} catch {
		return void 0;
	}
}
function ${MARKER}Track(window, state) {
	if (state?.maximized) window.once("show", () => {
		if (!window.isDestroyed()) window.maximize();
	});
	let timer;
	const save = () => {
		clearTimeout(timer);
		timer = void 0;
		if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
		try {
			writeFileSync(__miaopengWindowStateFile(), JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
		} catch {}
	};
	const later = () => {
		clearTimeout(timer);
		timer = setTimeout(save, 400);
	};
	for (const event of ["resize", "move", "maximize", "unmaximize"]) window.on(event, later);
	window.on("close", save);
}
`

function patchMain(source) {
  if (source.includes(MARKER)) return null
  const electronImport = /^import \{[^}]*\bBrowserWindow\b[^}]*\} from "electron";$/m
  if (!electronImport.test(source)) throw new Error('找不到 electron 的 import 行，宿主版本可能已变化')
  const head = 'function createWindow(preload, show = false, primary = false) {\n\tconst window = new BrowserWindow({\n\t\twidth: 1280,\n\t\theight: 820,'
  const at = source.indexOf(head)
  if (at < 0) throw new Error('找不到 createWindow 的窗口尺寸，宿主版本可能已变化')
  const handler = '\twindow.webContents.setWindowOpenHandler('
  const handlerAt = source.indexOf(handler, at)
  if (handlerAt < 0) throw new Error('找不到 createWindow 的 setWindowOpenHandler')

  const replacedHead = [
    'function createWindow(preload, show = false, primary = false) {',
    `\tconst __miaopengState = primary ? ${MARKER}Load() : void 0;`,
    '\tconst window = new BrowserWindow({',
    '\t\twidth: __miaopengState?.width ?? 1280,',
    '\t\theight: __miaopengState?.height ?? 820,',
    '\t\t...__miaopengState?.x === void 0 ? {} : { x: __miaopengState.x, y: __miaopengState.y },',
  ].join('\n')
  let next = source.slice(0, handlerAt)
    + `\tif (primary) ${MARKER}Track(window, __miaopengState);\n`
    + source.slice(handlerAt)
  next = next.slice(0, at) + HELPERS + replacedHead + next.slice(at + head.length)
  next = next.replace(electronImport, (line) => `${line}\nimport { screen as __miaopengScreen } from "electron";`)
  return next
}

/** 只读头部和 main.js，用于快速判断是否已打补丁（不把整个 asar 读进内存）。 */
function readMainSource(path) {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const headerPickleSize = head.readUInt32LE(4)
    const json = Buffer.alloc(head.readUInt32LE(12))
    readSync(fd, json, 0, json.length, 16)
    const main = entryAt(JSON.parse(json.toString('utf8')), 'lib/main.js')
    const content = Buffer.alloc(main.size)
    readSync(fd, content, 0, main.size, 8 + headerPickleSize + Number(main.offset))
    return content.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

if (flag === '--check') {
  console.log(readMainSource(asarPath).includes(MARKER) ? '已打补丁' : '未打补丁')
  process.exit(0)
}

if (flag === '--after-exit') {
  if (readMainSource(asarPath).includes(MARKER)) process.exit(0)
  // 同一时间只留一个等待进程。
  const lock = `${asarPath}.miaopeng-waiting`
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  if (existsSync(lock) && alive(Number(readFileSync(lock, 'utf8')))) process.exit(0)
  writeFileSync(lock, String(process.pid))
  const othersRunning = () => {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return out.split(/\r?\n/).some((line) => {
      const pid = Number(/^"[^"]*","(\d+)"/.exec(line)?.[1])
      return Number.isInteger(pid) && pid !== process.pid
    })
  }
  const deadline = Date.now() + 7 * 24 * 3600 * 1000
  try {
    while (othersRunning()) {
      if (Date.now() > deadline) process.exit(0)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    // 进程刚退出时文件句柄可能还没释放，稍等再写。
    await new Promise((resolve) => setTimeout(resolve, 1500))
  } finally {
    rmSync(lock, { force: true })
  }
}

const archive = readArchive(asarPath)
const entry = entryAt(archive.header, 'lib/main.js')
const start = archive.dataOffset + Number(entry.offset)
const source = archive.buffer.subarray(start, start + entry.size).toString('utf8')

const patched = patchMain(source)
if (patched === null) {
  console.log('已经打过补丁，无需重复')
  process.exit(0)
}

const content = Buffer.from(patched, 'utf8')
const dataLength = archive.buffer.length - archive.dataOffset
entry.offset = String(dataLength)
entry.size = content.length
entry.integrity = integrityOf(content)

const output = Buffer.concat([serializeHeader(archive.header), archive.buffer.subarray(archive.dataOffset), content])
if (!existsSync(backupPath)) copyFileSync(asarPath, backupPath)
const temporary = `${asarPath}.miaopeng-tmp`
writeFileSync(temporary, output)

// 写完立即自检：重新读回 main.js，必须与补丁内容一致。
const verify = readArchive(temporary)
const verifyEntry = entryAt(verify.header, 'lib/main.js')
const verifyStart = verify.dataOffset + Number(verifyEntry.offset)
if (!verify.buffer.subarray(verifyStart, verifyStart + verifyEntry.size).equals(content)) {
  throw new Error('自检失败：写回的 main.js 与补丁内容不一致，原文件未改动')
}
renameSync(temporary, asarPath)
console.log(`补丁完成。原文件备份在 ${backupPath}`)
