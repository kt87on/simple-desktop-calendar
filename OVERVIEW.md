# 简洁桌面日历 · 项目总览

> 极简 Windows 桌面日历。核心只做三件事：**看日历、看放假、看上班**，外加一个「特别关注」到期提醒。

## 定位
- 任务栏右端常驻实时时钟挂件条（不占任务栏按钮），点击唤出无边框半透明日历小窗。
- 无账号、无云同步、无广告、无待办/天气等额外功能——"打开就是一张日历"。
- 硬约束：不要擅自加功能。

## 技术栈
- Electron 31（任务栏挂件条 + 无边框透明窗口 + 独立提醒弹窗）
- electron-builder 24（NSIS 安装包）
- 纯 HTML + CSS（`color-mix`）+ 原生 JS，零运行时依赖
- 农历 `lunar.min.js`（第三方，仅读取）
- 特别关注持久化 `userData/reminders.json`（原子写）

## 当前版本
`1.7.22`

> **v1.7.22 要点（3 处微调，核心日历逻辑与已修复的拖拽边界 / 点击热区 / 形态切换逻辑均未动）**：
>
> ① **日历与插件间距紧贴**——`placeMainNearDock()` 的 `MAIN_GAP` 从 6 收到 1px，日历窗口与浮动插件视觉上无缝紧贴（留 1px 仅防极少数 GPU 渲染撕裂线）。紧贴后仍走四方位择优 + 工作区夹取：下方空间不够自动翻到上方紧贴，四周与任务栏都不越界。
> ② **今日单元格深蓝强调**——`.cell.today` 从与 `.cell.selected` 共用的浅蓝中拆出，独立为背景 `#1565C0` + 描边 `#0D47A1` + 白字（`.d` 与 `.sub` 都白），且优先级高于选中态。只改今日一格，选中态 / 节假日 / 周末 / 区间色全都不动。
> ③ **Win10 / Win11 自动检测**——引入 `os` 模块，用 `os.release()` 的内核 build 号判断（`≥22000` 判定 Win11，等价 `Environment.OSVersion.Version.Build`），启动时写入 `settings.json` 的 `isWin11` 配置项。任务栏高度 / 屏幕尺寸一律不硬编码，始终用 `display.workArea` 动态获取；并预留 Win11 像素补偿常量 `WIN11_POS_COMP_X/Y`（默认 0），日后若 Win11 下有极个别像素偏移只需改这两个数字。

> **v1.7.21 要点（外围交互改造 6 条，核心日历逻辑一行未动）**：
>
> ① **修复点击热区（Hit Test）**——此前点插件**可见方框下方**的透明区域也会弹出日历，说明响应范围大于控件实际尺寸。现改为：窗口常驻 `setIgnoreMouseEvents(true, { forward: true })` 全穿透，页面按 `mousemove` 坐标判断是否在 `#card` 矩形内，**在内才** `setIgnoreMouseEvents(false)` 收回响应。方框外彻底穿透、不拦截任何鼠标事件。
>
> ② **新增「🗕 缩小至桌面图标」**（右键菜单）——点击后隐藏桌面插件，只在系统托盘保留静态图标；**左键单击**该托盘图标即切回插件并回到原位置。两种形态互斥，状态存 `dockMode`（`'dock'` / `'icon'`）与 `dockBounds` 落库持久化。
>
> ③ **拖动限制在屏幕工作区内**——新增 `clampDockToWorkArea(b)`，四条边都夹进 `screen.getPrimaryDisplay().workArea`（该区域已自动排除任务栏）。拖动中实时夹取、松手再夹一次并落库；分辨率/任务栏高度变化时也重夹一次。拖不出屏幕，也压不到任务栏。
>
> ④ **日历弹出定位区分两种模式**——新增 `placeMainNearDock(dockRect)`：**图标模式**沿用原逻辑（跟随托盘/鼠标附近）；**插件模式**以插件方框为基准，按上/下/左/右四方位择优，逐个校验候选矩形是否完整落在工作区内，超界就纠偏到反方向或靠边，保证日历整体矩形**绝不超出屏幕四周与任务栏**。
>
> ⑤ **彻底清除"嵌入任务栏"遗留**——`dockEmbedded` / `attachDockToTaskbar` / `dock-embedded` 通道 / `dock.html` 的 `body.embedded` 样式与拖动拦截 / `preload.js` 的 `onDockEmbedded` / `dock-attach.ps1` 全部不存在。日历核心（日期切换、标记、查看逻辑）未改动。
>
> ⑥ **移除无效吸附**——「自动吸附任务栏上方」与右键菜单「贴回任务栏上沿（重置位置）」删除（物理嵌入已放弃，实测从未生效）。默认落点仍是任务栏上沿右侧，但不再"吸"。

> **v1.7.17 要点（在干净的 v1.7.13 基线上重做 10 条需求）**：
> ① **修正「点特别关注列表主窗消失」**——关注列表/提醒弹窗抢焦点触发主窗 `blur → win.hide()`；现主窗 `blur` 回调先判断 `remindlistWin`/`reminderWin` 是否可见，可见则 return，菜单弹出/跳转再加 `suppressBlur` 短时抑制。
> ② **右键菜单合并去重**——「查看/管理」与「查看/跳转」合并为单一父项「📋 查看 / 管理特别关注（N）」，二级菜单 =「打开管理窗口」+ 分隔 + 全部关注项（点击跳转）。
> ③ **嵌入/浮动合并为一键切换**——删除「重新嵌入任务栏」；嵌入时显示「切换为浮动」、浮动时显示「切换为嵌入任务栏」。（**v1.7.20 已再次改写**：嵌入形态整体废除，该菜单项变为「贴回任务栏上沿（重置位置）」的一键归位便利项。**v1.7.21 再改**：该归位项随吸附一并删除，位置改为「🗕 缩小至桌面图标 / 🖥 切回桌面插件」双形态切换。）
> ④ **浮动态可拖动 + 磁吸**——`dock.html` mousedown/move/up（>4px 阈值区分点击与拖动），拖动经 `dock-drag-move` IPC 实时 `setPosition`，松手 `dock-drag-end` 若距任务栏顶边 <60px（**v1.7.20 放宽到 80px**）则 `positionDock()` 吸附紧贴（**v1.7.20 起不再调 `attachDockToTaskbar()`**）。**v1.7.21 已改为：不吸附**，改在拖动中与松手时各调一次 `clampDockToWorkArea()` 把插件夹进屏幕工作区，并落库记住落点。
> ⑤ **时钟去秒省内存**——挂件条只显示 `时:分`（原 `时:分:秒`），`tick()` 仅在内容变化时写 DOM（`lastTimeText`/`lastDateText` 缓存），去掉每秒无谓重绘。
> ⑥ **控制常驻内存**——去托盘（去掉每秒 tooltip 看门狗与图标渲染）+ 去秒 + DOM 变化才写，挂机时 CPU/内存近乎零增长。
> ⑦ **去除系统托盘图标**——挂件条已能长在任务栏，右下角静态时钟图标彻底删除；菜单入口统一收拢到「挂件条右键 + 主窗空白处右键」（新增 `main-show-menu` IPC，主窗 `contextmenu` 排除日期格与输入框）。
> ⑧ **放大按钮图标改版**——尺寸不变，SVG 改为左上「大」+ 右下「小」**两字一样大**、中间一道斜杠，语义比放大镜直白。
> ⑨ **特别关注角标「关」→「注」**——原「关」易被误读为"关闭"。
> ⑩ **主窗右键兜底**——防止挂件条被关掉后无法恢复菜单入口。

> **v1.7.14–16 已废弃**：这三个版本为探索性改动（去托盘/菜单合并/拖动磁吸/去秒/崩溃自愈/嵌入态紧凑布局），因引入回归（启动闪退、日历第六排裁切）被用户否决回退。其合理需求已在上方 v1.7.17 于干净的 v1.7.13 基线上重新实现。

> **v1.7.18 已废弃（仅存活 3 小时）**：试图修「任务栏/浮动态显示不全」，做法是嵌入成功后 `setSize` 强制 resize 重算 viewport。**这个方向是错的**——对着已经 `SetParent` 成 `WS_CHILD` 的窗口改尺寸，Chromium 会直接 kill 渲染进程，实测每 30~50 秒 `render-process-gone reason=killed` 一次；再叠加自愈条件被写成恒真的 `(wasEmbedded || true)`，就变成「崩→重建→嵌入→又崩」的永动机，任务管理器里堆出一串同名进程，而残留进程持有单实例锁又导致新实例秒退（表现为"打开直接闪崩"）。**教训：回退旧基线时不能把"已踩过的坑"一起回退，但也别把未经验证的 hack 当成修复。**

> **v1.7.20 关键回滚 + 关键修复（强烈建议升级，本次交付）**：
>
> ─────── **关键回滚：彻底废除任务栏嵌入，回到 v1.7.11 浮动方案** ───────
> ① **v1.7.13~v1.7.19 一共 7 次"真嵌入任务栏"尝试，全部失败**——做法都是 `SetWindowLong(GWL_STYLE,...|WS_CHILD) + SetParent(ReBarWindow32)`，每次都被 Chromium 用 `render-process-gone reason=killed` 反噬。**根因不是 v1.7.18 以为的 setSize**，而是 **SetParent 改父为 WS_CHILD 后，Chromium 渲染线程做 surface tree 自检、自检失败就主动 kill 自己**。日志铁证：
> ```
> [2026-09-03T07:58:40Z] dock render-process-gone reason=killed   (v1.7.18)
> [2026-09-03T08:42:07Z] dock render-process-gone reason=killed   (v1.7.19 setSize 已移除仍崩)
> ```
> ② **崩溃循环 = 进程堆积**——嵌入 → 崩 → 重建 → 再嵌 → 又崩；任务管理器里堆出 4~5 个同名 v1.7.18/19 进程，且残留进程持有单实例锁导致后续启动直接 `app.quit()` 秒退（表现为「打开直接闪崩」）。
> ③ **v1.7.20 决策**——彻底回退到 **v1.7.11 浮动方案**：贴任务栏上沿的置顶 topmost 无边框窗，宽度 116、任务栏同高。视觉上仍紧贴任务栏上沿右侧，等效"看起来长在任务栏里"；不再 SetParent、不再调 SetWindowLong、不与 ReBarWindow32 抢子窗，**渲染进程永不自杀**。`dock-attach.ps1` 一并废弃，`package.json` 删除 `extraResources` 这项；托盘菜单里"切换为浮动 / 切换为嵌入"按钮合并为一个"贴回任务栏上沿（重置位置）"，并加 `screen.on('display-metrics-changed')` 自动重新贴合。
> ④ **保留 v1.7.19 固定像素布局**——`pushDockSize() + applyDockSize()` 在浮动态同样必要：transparent + 无边框 + 极小尺寸组合下，首帧 Chromium 仍可能按 16px viewport 渲染出椭圆/被裁，固定像素布局兜底。
>
> ─────── **其它加固** ───────
> ⑤ **单实例锁强化**——`requestSingleInstanceLock({ key: 'yg.simplecalendar.v1' })` 加自定义命名空间（理论上与本地 Electron 默认 key 同步生效），即便如此兜底仍保留。
> ⑥ **启动时清理残留**——新增 `cleanupStaleInstances()`：在 `whenReady` **最开头**（建窗之前）用 PowerShell `Get-CimInstance Win32_Process` 取所有 `SimpleCalendar.exe` 的 **PID + 父 PID**，以自己为根求子孙传递闭包，**只杀闭包之外**的进程。<br>> **⚠️ 首版踩的大坑（v1.7.20 首次打包自查发现，已修）**：最初写成 `tasklist` 列名 + 跳过自己 + 其余全杀。**这在 Electron 上是错的**——渲染 / GPU / utility 子进程的可执行文件同名，tasklist 异步返回时窗口已建好、子进程已 fork，于是被当成"残留"杀掉。实测日志：`[..43.571] dock created OK` → `[..43.972] cleanup: killing 4 stale peer(s): 19460,21956,12580,17152`，杀完主进程随之退出（表现就是"挂件条建好就消失"）。**教训：在本程序里"按进程名批量清理"永远是错的，必须按父子关系过滤。**
> ⑦ **`verify_v1720.js`** ——新增 8 项 `[关键]` 反向断言：嵌入相关函数 / 状态变量 / timer / IPC 通道必须全部不存在；其它 v1.7.19 崩溃保护 / 固定像素布局 / 十年需求仍生效。
> ⑧ **`verify_v1719.js` / `tmp/asar_extract` 已清理**——文档体系跟着版本号全量重命名。

> **v1.7.20 之前版本的关键修复/废弃记录**（按发布顺序）：

> **v1.7.19 关键修复（仍然保留在 v1.7.20 中）**：
> ① **彻底终结崩溃循环 / 进程堆积**——`closed` 自愈条件由恒真的 `(wasEmbedded || true)` 改回只在真正崩溃时重建（**v1.7.20 最终形态：`!quitting && dockOn && dockCrashed && dockRecreateCount < DOCK_RECREATE_MAX`**）；`render-process-gone` 不再同步 `destroy`（改为延迟到下一个 tick，且由 `closed` 统一计数），并加 `DOCK_RECREATE_MAX=3` 硬上限；崩过之后设 `dockNoEmbed`（**v1.7.20 该标志位已删除——反正都不嵌入**）；稳定运行满 5 分钟自动清零崩溃计数。移除误报率极高的 `unresponsive` 监听。v1.7.20 更彻底：嵌入方案本身被废除，从源头不再产生崩溃。
> ② **显示不全改用固定像素布局**——viewport 被错算成 ~16px 是 Chromium 的既有行为，主进程 `pushDockSize()` 把物理窗口真实宽高发给 `dock.html`，页面用固定 px 覆盖 `html`/`body`/`#card`。viewport 算错也照样按真实尺寸排布，内容完整，且完全不触碰窗口尺寸。
> ③ **`preload.js` 的 `onDockEmbedded` 原样透传 `{ embedded, sysDark }`** —— 避免 `body.embedded` 类永远加不上。（**v1.7.20 已随嵌入方案一并删除**：`dock-embedded` 通道、`onDockEmbedded`、`body.embedded` 样式全部移除。）
> ④ **`second-instance` 兜底**——主窗已销毁则 `createWindow()` 重建。

> **v1.7.13 要点**：① **真正嵌进任务栏**（此前是"贴在任务栏上面"）—— 真因是 `SetParent` 对 `WS_POPUP` 顶层窗不会自动置 `WS_CHILD`，返回值却仍非 0，旧代码误判成功；现在先手动 `WS_CHILD` 化再用 `GetParent()` 回读校验。② 修复**放大模式下区间中间格不变绿**（`#widget.max .cell` 的 `background:transparent` 特异性压过了 `.cell.range-between`）。③ 挂件条右键可查看嵌入状态、手动重试/退出嵌入。④ 修掉一个会让 `dock-attach.ps1` 在用户机器上直接报语法错的坑：**ps1 必须有 UTF-8 BOM**，否则 Windows 会按 GBK 解码，中文注释的字节会吞掉换行符。

> **v1.7.12 要点**：① 关注列表弹窗改为**独立窗口** `remindlist.html`（表头 `-webkit-app-region: drag` 原生拖动，可拖到屏幕任意位置，不再受日历窗口裁剪）；② 任务栏挂件条**优先尝试真正嵌入任务栏**（`dock-attach.ps1` + 跨进程 `SetParent`，失败自动回落「贴任务栏上沿」浮动）；③ 区间天数中间格绿色**提亮**（白日 `0.08`→`0.15`、补黑夜覆盖），让连成的色带更醒目。
>
> **v1.7.11 要点**：① 修复「托盘右键菜单无效」（`buildTrayMenu()` 中 `const menu` 被重新赋值 → 运行时抛错被 `catch` 静默吞掉，菜单从未挂上）；② 修复「放大无效」（`.max` 类只在浏览器 fallback 分支里 toggle，Electron 路径下没同步 → 改为主进程 `expand-changed` 主动推送）；③ 新增任务栏挂件条 `dock.html`；④ 特别关注限 15 字 / 10 条；⑤ 移除「悬停 2 秒气泡」，改指「关」角标；⑥ 关注列表弹窗降透明度 + 内容列加宽 + 可按表头拖动。

## 文档索引（权威顺序）
| 文档 | 用途 |
|---|---|
| `PROGRAM_SPEC.md` | **权威规格书**（可让 AI 零上下文复刻）：定位/技术栈/目录/设计/行为/数据/打包/限制/修改指引 |
| `DESIGN_SPEC.md` | 视觉设计专项（"纸与光"设计系统：token/排版/间距/深度/微交互） |
| `README.md` | GitHub 说明（面向下载用户） |
| `使用说明.html` | 安装后「查看文档」打开的帮助页（面向最终用户） |

## 构建 / 运行
```bash
npm install          # 装 electron + electron-builder
npm run dev          # 开发预览
npm run build        # node make-icon.js && node build.js && electron-builder --win nsis → dist/ 安装包
node build.js        # 重建 calendar.html（浏览器可直接打开预览）
```

> 详见 `PROGRAM_SPEC.md` 各章节，功能/行为以它为准。
