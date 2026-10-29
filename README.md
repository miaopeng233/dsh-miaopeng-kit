# dsh-miaopeng-kit

miaopeng 的 DeepSeek Harness 整合插件：装这一个就够了。

## 功能

| 功能 | 说明 |
|---|---|
| `/autocompact` | 统一设置自动压缩阈值：`/autocompact 400K`、`1M`、`40%`、`off`、`default`；不带参数查看每个模型的实际阈值。窗口比阈值还小的模型按默认 80% 提前压缩。 |
| 上下文环按阈值显示 | 环、百分比、弹层里的 `~387K / 400K` 都以压缩阈值为分母，到 100% 就是即将压缩。 |
| 模型选择器 | 弹层加宽、名字和描述单行；每行显示 免费 / 倍率（绿=便宜，橙=贵）/ 上游促销（夜间免费、Free now…）/ 拥堵 / 不可用 / 上下文窗口；同名模型补 id；每组免费 → 促销 → 其他排序；提供方名称中文化。 |
| 窗口尺寸记忆 | 记住主窗口大小、位置和最大化状态（主进程补丁，见下）。 |

## 一键安装（任何一台电脑）

先安装 DeepSeek Harness 并启动一次，然后在 PowerShell 里粘贴：

```powershell
irm https://raw.githubusercontent.com/OWNER/dsh-miaopeng-kit/main/get.ps1 | iex
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

并移除被取代或重复的插件：dshmarket（宿主自带插件管理）、dsh-model-picker（与 claude-style 的选择器重复）、
dsh-context、dsh-better-sidebar（宿主自带对应功能）、dsh-whale-widget。前端样式因此从约 1.2MB 降到约 0.8MB。

版本锁死是为了上游更新不会把环境弄坏；确认新版没问题后改 `package.json` 里的版本号再安装。
`defaults.patch.yml` 是默认界面配置，安装时只追加对方还没有的条目，不覆盖已有设置。

## 窗口补丁

宿主把主窗口写死成 1280×820，只能改 `resources\app.asar` 里的主进程。`scripts/patch-window-state.mjs`
只替换其中的 `lib/main.js`，原文件备份为 `app.asar.miaopeng-backup`。**DeepSeek Harness 自动更新后补丁会被覆盖，重新运行一次 `install.ps1` 即可**（幂等）。

```powershell
$env:ELECTRON_RUN_AS_NODE=1; & "D:\dsh\DeepSeek Harness.exe" scripts\patch-window-state.mjs "D:\dsh\resources\app.asar" --check
```

## 文件

- `index.js` — 宿主端：`/autocompact`、上下文环阈值、`/dsh-miaopeng-kit/models` 路由
- `client.js` — 前端：模型选择器
- `get.ps1` — 在线一键安装；`install.ps1`、`scripts/install.mjs` — 安装
- `scripts/patch-window-state.mjs` — 窗口补丁
- 设置保存在 `~/.dsh/dsh-miaopeng-kit/settings.json`

## 排查

- 所有界面改动都在 `requestAnimationFrame` 里、断开观察器后写入，内容不变不写 DOM，不会再出现把界面卡死的死循环。
- 同步状态：浏览器里打开 `/dsh-miaopeng-kit/models` 看 `lastSync`。
