# dsh-miaopeng-kit

miaopeng 的 DeepSeek Harness 整合插件：装这一个就够了。

## 功能

| 功能 | 说明 |
|---|---|
| `/autocompact` | 统一设置自动压缩阈值：`/autocompact 400K`、`1M`、`40%`、`off`、`default`；不带参数查看每个模型的实际阈值。窗口比阈值还小的模型按默认 80% 提前压缩。 |
| 上下文环按阈值显示 | 环、百分比、弹层里的 `~387K / 400K` 都以压缩阈值为分母，到 100% 就是即将压缩。 |
| 模型选择器 | 分组标题吸顶并显示模型数；每行显示 免费 / 倍率（绿=便宜，橙=贵）/ 上游促销 / 拥堵 / 不可用 / 上下文窗口；同名模型补 id；每组免费 → 促销 → 其他排序；提供方名称中文化。 |
| 用量与费用 | 用什么付费就显示什么：DeepSeek 官方按官方峰谷价显示 ¥ 或 $，WorkBuddy 显示积分（每轮结束前后的余额差），其他提供方按价格目录估算，没有价格就只显示 token。币种和单价沿用 claude-style 设置里的「计费币种」（选关闭则不算钱）和「自定义计费表」——中转站、OpenRouter 等目录里没有的模型，在计费表里填上单价即可计费，改动即时生效。底栏一排「花费 · Token · 缓存命中 · 轮次」（当前模型扣积分时花费后带余额），模型按钮旁标出「免费」或倍率；点开是费用 / 余额 / token 明细；每条回答下方一行小字显示本轮用量和花费；上下文弹层里的「费用」也换成同一口径。 |
| 推理等级 | 滑块下方按当前模型实际支持的档位标出刻度（各模型不同：DeepSeek 官方 Off/Low/High/Max，GLM-5.3 等 Low/High/Max，MiniMax 5 档，Hy4 只有 High…）；最高档点阵不再循环闪烁，拖到 Max 不再卡顿。 |
| 配色 | 只有「免费」用绿色，倍率、促销、底栏都是中性色；橙 / 红只用于拥堵、贵、不可用这类需要注意的状态。上下文百分比占用低时为中性色。侧栏会话的悬停卡片改为跟随主题的浅色 / 深色表面（宿主原本写死深色）。 |
| 中文界面 | 权限按钮（只读 / 编辑 / 完全权限）、首页问候语。推理等级等专业术语保留英文。 |
| 输入光标 | 修正 claude-style 自绘光标在首页发出第一条消息、跳到新会话后停在旧位置的问题。 |
| 斜杠命令 | `/autocompact`、`/workbuddy` 补上图标和中文标题，和内置命令一致。 |
| 窗口尺寸记忆 | 记住主窗口大小、位置和最大化状态（主进程补丁，见下）。 |
| 启动不闪黑 | 系统深色、应用浅色时，启动末尾不再整页变黑、不再闪「正在加载设置…」（见下）。 |
| 编辑器汉化 | 把 [baoyu-design](https://github.com/JimLiu/baoyu-design) 四个插件的本地编辑器（`claude-slides` 幻灯片、`claude-design` 画布、`claude-design-system` 设计系统、`claude-dashboard` 仪表盘）完整汉化：1341 条 i18n 消息 + 1682 条纯字符串词表，覆盖按钮、菜单、右键菜单、悬停提示、属性面板、导出对话框。插件升级会覆盖补丁，因此每次启动自动检查并重打；也可用 `/editor-zh` 手动重打（见下）。 |

## 安装方式零：WSL / Linux（npm 版，推荐）

需要 Node.js ≥ 22.19 和编译工具（`sudo apt install -y build-essential`，node-pty 要现场编译）。一行命令：

```bash
curl -fsSL https://raw.githubusercontent.com/miaopeng233/dsh-miaopeng-kit/main/get.sh | bash
```

它会装好 `@deepseek-ai/dsh` 和 pnpm（没装的话），把本插件、baoyu-design 四个编辑器插件装进 `~/.dsh/profiles/web`，
profile 用户层还是空的就用 `profile/cordis.patch.yml` 里的个人偏好打底。之后 `dsh web` 启动，在 Windows 浏览器里打开它打印的地址。

**从另一台机器 / Windows 桌面版搬家**（凭据、WorkBuddy 登录、/autocompact、用量统计、界面与模型设置）：

```bash
curl -fsSL https://raw.githubusercontent.com/miaopeng233/dsh-miaopeng-kit/main/get.sh | bash -s -- --migrate-from /mnt/c/Users/<你>/.dsh
# 加 --sessions 连会话历史一起搬（工作区路径是旧系统的）
```

凭据只在本机之间复制，不会进仓库；从 `/mnt/c` 复制来的文件会自动改成 600 权限（dsh 拒绝读别人可读的凭据文件）。
源码在 `~/.dsh/dsh-miaopeng-kit-src`，以后在那里 `./install.sh` 重装。`./install.sh --no-extras --no-prefs` 只装本插件。

**桌面快捷方式**：`./install.sh --shortcut`（或单独运行 `scripts/wsl-shortcut.sh`）在 Windows 桌面建「DeepSeek Harness」，
双击即在一个窗口里启动 `dsh web`，并用 Chrome / Edge 的应用模式打开成独立窗口（和原来的桌面版一样没有标签栏、地址栏；`DSH_BROWSER=default` 改用默认浏览器）；已经在跑就只打开浏览器。关掉那个窗口就退出 dsh
（故意不放后台：WSL 没有会话时可能关掉发行版，后台进程会被悄悄杀掉）。

**TUN 代理（fake-ip）下 web_fetch 全部失败？** Clash / mihomo 的 TUN 模式把域名解析到 `198.18.x.x`，
宿主把它当内网拒绝。需要的话手动打一次补丁（只额外放行 `198.18.0.0/15`，内网、回环照旧拒绝），重启 dsh 生效：

```bash
node ~/.dsh/dsh-miaopeng-kit-src/scripts/patch-fakeip.mjs            # 打补丁；--check 检查，--remove 移除
```

打过一次后，`npm i -g @deepseek-ai/dsh` 升级冲掉补丁时，插件启动会自动补回（`--remove` 同时关闭自愈）。

## 安装方式一：应用内「插件」页

插件 → 安装 → 填 `github:miaopeng233/dsh-miaopeng-kit`。外观、WorkBuddy、上下文洞察、插件市场、右侧边栏和默认设置随之一起生效；
窗口尺寸记忆会在第一次退出应用后自动补上，下次启动生效。已经单独装过其中某些插件也没关系，宿主会去重。

## 安装方式二：Windows 桌面版一行命令（会顺带清理被取代的旧插件）

先安装 DeepSeek Harness 并启动一次，然后在 PowerShell 里粘贴：

```powershell
irm https://raw.githubusercontent.com/miaopeng233/dsh-miaopeng-kit/main/get.ps1 | iex
```

它会下载本仓库、自动找到应用安装位置、退出应用、装好插件并打窗口补丁。之后重新打开 DeepSeek Harness 即可。
源码保存在 `%USERPROFILE%\.dsh\dsh-miaopeng-kit-src`，应用更新后在那里再运行一次 `install.ps1` 就能补回窗口补丁。

本地安装 / 其他选项：

```powershell
.\install.ps1                    # 自动找安装目录
.\install.ps1 -App "E:\dsh"      # 指定安装目录
.\install.ps1 -NoWindowPatch     # 不打窗口补丁
.\install.ps1 -Uninstall         # 卸载
```

## 一个插件包含什么

安装后 profile 里只有 `dsh-miaopeng-kit` 一个依赖。它锁定版本带上：

- `dsh-claude-style` 0.19.5 — 整体外观
- `@huai_xin/dsh-workbuddy` 0.8.3 — WorkBuddy 模型（国内版 / 国际版）
- `dsh-context` 0.77.0 — 上下文洞察
- `dshmarket` 1.73.1 — 插件市场
- `dsh-better-sidebar` 0.28.2 — 右侧边栏

并移除被取代或重复的插件：dsh-model-picker（与 claude-style 的选择器重复）、dsh-whale-widget、旧的 rate-badge / threshold-mark。

版本锁死是为了上游更新不会把环境弄坏；确认新版没问题后改 `package.json` 里的版本号再安装。
`cordis.patch.yml` 是组合包 patch：启用上面两个插件并给出默认界面设置；用户自己在设置里改过的值总是优先。

## 宿主补丁（窗口尺寸、启动不闪黑）

有两处只能改 `resources\app.asar`，`scripts/patch-window-state.mjs` 只替换这两个文件，原文件备份为 `app.asar.miaopeng-backup`：

- `lib/main.js`：宿主把主窗口写死成 1280×820，补丁让它记住大小、位置和最大化状态。
- `dsh-client-ui-theme/lib/client.js`：主题运行时启动时先按「跟随系统」渲染，系统是深色、应用选浅色时，
  启动末尾会整页闪黑（同时顶部出现「正在加载设置…」）。补丁让它从一开始就用已保存的主题；宿主修好后自动跳过。

启动时那层「正在加载设置…」遮罩（已完成引导的人每次都会闪一下）由插件样式隐藏，不需要补丁。插件每次启动都会检查：没打补丁时
起一个等待进程，应用退出后自动补上。所以**应用自动更新后不用手动处理**：更新后第一次退出时补上，再打开就恢复。
不想要这个补丁：在插件配置里设 `windowPatch: false`。

```powershell
$env:ELECTRON_RUN_AS_NODE=1; & "D:\dsh\DeepSeek Harness.exe" scripts\patch-window-state.mjs "D:\dsh\resources\app.asar" --check
```

## 编辑器汉化

把 [baoyu-design](https://github.com/JimLiu/baoyu-design) 四个插件的本地编辑器完整汉化：

| 插件 | 编辑器 |
|---|---|
| `dsh-claude-slides` | 幻灯片编辑器 |
| `dsh-claude-design` | 画布设计编辑器 |
| `dsh-claude-design-system` | 设计系统编辑器 |
| `dsh-claude-dashboard` | 数据仪表盘编辑器 |

**做法**：这些编辑器内置 `formatMessage({ id, defaultMessage })` 运行时，模块初始化时读取
`globalThis.__appifact_i18n = { lang, settled }`。补丁把 **1341 条 `id → 中文`** 目录注入进去
（在 bundle 之前执行），React 渲染出来直接是中文，不依赖 DOM 后处理；ICU 复数/选择结构按中文
习惯简化，占位符 `{name}` `{count}` 原样保留。

少数 UI 文案是**纯字符串字面量**（没有 message id，如 `label:"Image or video"`），由第二层
DOM 兜底按原文替换，共 **1682 条**，并处理复合结构（`Pencil  P` 双空格快捷键、`Shortcut: X`、
`Sources：…` 冒号前缀、`Page 1, pages`、`Collapse X` 等）。

**安全边界**：不触碰幻灯片正文（`<section>`）、可编辑区（`[contenteditable]`）、演讲者备注、
画板内容（`x-dc`）、图表媒体（`svg/img/canvas/video/x-embed/iframe`）、仪表盘用户页面（`#dash-root`）。

**自愈**：这些文件属于别人发布的 npm 包，插件一升级 `node_modules` 就被重写，补丁必然消失。
所以每次启动检查一次，缺失或版本不符就重新写入（内容没变则不写文件，不触发 HMR）。
也可以手动操作：

```
/editor-zh          重打补丁
/editor-zh status   查看哪些已打、哪些已是最新、哪些未安装
/editor-zh remove   移除补丁，恢复英文
```

不想要这个功能：在插件配置里设 `editorZhCn: false`。

**刻意保留英文**：数据名称（token `brand`、画板名 `Main`、调色板 `Palette`）、技术标识
（`PDF`/`PNG`/`token`/`Props`/`README`）、快捷键（`Ctrl+0`），以及仪表盘里由 Agent 生成的页面正文。

## 文件

- `index.js` — 宿主端：`/autocompact`、上下文环阈值、`/dsh-miaopeng-kit/models` 路由、`/editor-zh`
- `client.js` — 前端：模型选择器、统计栏、中文标签、命令图标
- `get.sh`、`install.sh` — WSL / Linux 在线安装、本地安装；`get.ps1`、`install.ps1` — Windows 桌面版
- `scripts/install.mjs` — 安装（两个平台共用）；`scripts/migrate.mjs` — 从另一份 `.dsh` 搬凭据和设置
- `scripts/dsh-web-launch.sh`、`scripts/wsl-shortcut.sh` — 桌面快捷方式的启动器与创建脚本（WSL）
- `scripts/patch-fakeip.mjs` — web_fetch 放行 TUN fake-ip 网段（npm 版，手动开启）
- `profile/cordis.patch.yml` — 个人偏好快照（界面、默认模型、压缩策略），新 profile 用它打底
- `scripts/patch-window-state.mjs` — 窗口补丁
- `scripts/editor-zh-cn/` — 编辑器汉化：`apply.mjs`（幂等打补丁）、`catalog-zh.json`（1341 条 i18n 目录）、`dom-map.json`（1682 条 DOM 词表）
- 设置保存在 `~/.dsh/dsh-miaopeng-kit/settings.json`

## 排查

- 所有界面改动都在 `requestAnimationFrame` 里、断开观察器后写入，内容不变不写 DOM，不会再出现把界面卡死的死循环。
- 同步状态：浏览器里打开 `/dsh-miaopeng-kit/models` 看 `lastSync`。
