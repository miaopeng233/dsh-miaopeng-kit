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

## 安装方式一：应用内「插件」页

插件 → 安装 → 填 `github:miaopeng233/dsh-miaopeng-kit`。外观、WorkBuddy、上下文洞察、插件市场、右侧边栏和默认设置随之一起生效；
窗口尺寸记忆会在第一次退出应用后自动补上，下次启动生效。已经单独装过其中某些插件也没关系，宿主会去重。

## 安装方式二：一行命令（会顺带清理被取代的旧插件）

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

## 文件

- `index.js` — 宿主端：`/autocompact`、上下文环阈值、`/dsh-miaopeng-kit/models` 路由
- `client.js` — 前端：模型选择器、统计栏、中文标签、命令图标
- `get.ps1` — 在线一键安装；`install.ps1`、`scripts/install.mjs` — 安装
- `scripts/patch-window-state.mjs` — 窗口补丁
- 设置保存在 `~/.dsh/dsh-miaopeng-kit/settings.json`

## 排查

- 所有界面改动都在 `requestAnimationFrame` 里、断开观察器后写入，内容不变不写 DOM，不会再出现把界面卡死的死循环。
- 同步状态：浏览器里打开 `/dsh-miaopeng-kit/models` 看 `lastSync`。
