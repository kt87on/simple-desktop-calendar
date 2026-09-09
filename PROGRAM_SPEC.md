# 简洁桌面日历 · 程序规格书（可复制级 / AI 可直接复刻）

> **用途**：本文件是为「让 AI 在零上下文情况下重建该程序」而写。任何 AI 拿到本文件，都能完整还原软件的功能、视觉、行为与打包方式。修改或升级时，直接把本文件 + 源码目录交给 AI 即可。
> **版本**：2.4.0 　**作者**：YG　**协议**：MIT　**平台**：Windows

---

## 1. 软件定位（务必严格遵守，不要擅自加功能）

- **一句话**：极简 Windows 桌面日历，核心只做三件事——**看日历、看放假、看上班**，外加一个真正有用的「特别关注」提醒。
- **产品描述（原文）**：受够了 Windows 原生的日历，也实在受不了市面上第三方日历软件，明明很简单的需求，硬塞一堆没必要的功能。自己写了这款极简日历，核心只做一件事：看日历、看放假、看上班，就够了。想要更多功能，看手机不就行了。
- **硬约束**：不加账号、不加云同步、不加待办/日程/天气/记事等任何额外功能。保持"打开就是一张日历"。
- **形态**：桌面常驻实时时钟挂件条（**v1.7.21 起两种形态二选一**：默认「桌面插件」= 可拖动小方框；「桌面图标」= 插件收起、只在系统托盘留静态图标）+ 点击唤出的无边框半透明日历小窗（非传统窗口），配一个独立的提醒弹窗。**v1.7.20 起默认无托盘图标**，仅在「桌面图标」形态下才创建。

---

## 2. 技术栈与运行环境

| 项 | 值 |
|---|---|
| 桌面壳 | Electron 31（`electron` devDependency） |
| 打包 | electron-builder 24.13.3，目标 `nsis`（Windows 安装包） |
| 前端 | 纯 HTML + CSS（`color-mix` 主题派生）+ 原生 JS，无框架、无打包器 |
| 农历 | 第三方库 `lunar.min.js`（lunar-javascript 的浏览器版，仅读取其接口，**不修改**） |
| 持久化 | 特别关注存 `userData/reminders.json`（主进程原子写：先写 `.tmp` 再 `rename`） |
| 运行系统 | Windows 10/11（依赖任务栏挂件条与窗口 API；macOS/Linux 不保证） |
| Node | 构建机装 Node 即可（代码本身用 CommonJS，Electron 主进程） |

**构建/运行命令**
```bash
npm install          # 装 electron + electron-builder（仅打包/运行桌面端需要）
npm run dev          # electron . 开发预览
npm run build        # node make-icon.js && node build.js && electron-builder --win nsis → dist/ 生成安装包
node build.js        # 把 lunar.min.js + app.js 注入 template.html，生成 calendar.html
node make-icon.js    # 生成 icon.ico（多尺寸）
```

---

## 3. 目录结构与文件职责

```
简洁桌面日历/
├── package.json      # 版本/作者/NSIS 打包配置（见第 7 节）
├── template.html     # 主界面模板：含全部 CSS（设计系统）+ DOM 骨架 + 两个注入占位符
├── app.js            # 主界面渲染层逻辑（IIFE）：日历/农历/节假日/区间选择/特别关注/主题
├── electron-main.js  # 主进程：任务栏挂件条 / 右键菜单 / 双窗口 / 提醒巡检 / IPC / 开机自启
├── preload.js        # contextBridge 暴露 window.api（见下「IPC 通道」）
├── holidays.js       # 节假日与「最近节日」数据 + 计算（本年/跨年），主进程 require
├── reminder.html     # 提醒弹窗界面（知道了 / 稍后提醒，内联 JS）
├── remindlist.html   # **v1.7.12 新增**：关注列表独立窗口（三列，表头 -webkit-app-region: drag）
├── dock.html         # **v1.7.11 新增**：任务栏挂件条界面（上行 24h 时钟 / 下行年月日）
├── settings.html     # **v2.4.0 新增**：设置弹窗（四分区 + 「皮肤设置」入口）
├── skin.html         # **v2.4.0 第二轮新增**：独立皮肤设置窗口（per-surface 皮肤编辑 + 图片取景）
（**v1.7.20 已删除 `dock-attach.ps1`**——v1.7.12~19 用于把挂件条 SetParent 进任务栏的 PowerShell 助手，随嵌入方案一并废弃，`package.json` 的 `extraResources` 也同步移除）
├── lunar.min.js      # 第三方农历库（window.Solar / window.Lunar），不修改
├── build.js          # 读 lunar + app，替换占位符，写 calendar.html
├── calendar.html     # 构建产物（lunar+app 已内联），可直接浏览器打开预览
├── make-icon.js      # 零依赖生成 icon.ico（蓝磁贴+白日历卡）
├── icon.ico          # 16/32/48/256 多尺寸，exe/安装包/快捷方式/控制面板共用（v1.7.20 起不再用于托盘）
├── installer.nsh     # NSIS 完成页扩展：增加"查看说明文档"勾选
├── 使用说明.html     # 安装后"查看文档"打开的帮助页（独立 HTML）
├── README.md         # GitHub 说明
├── LICENSE           # MIT
└── PROGRAM_SPEC.md   # 本文件
```

**关键约定**
- `template.html` 内有两个**占位符字符串**（必须原样保留，build.js 替换）：
  - `<script>/*__LUNAR_LIB__*/</script>` → 替换为 `lunar.min.js` 全文
  - `<script>/*__APP__*/</script>` → 替换为 `app.js` 全文
- 运行时主进程加载 `calendar.html`（已自包含 lunar + app）作为主日历，加载 `reminder.html` 作为提醒弹窗。其余源文件用于开发与重建。
- `files`（package.json）只打包运行必需文件，**不含 node_modules**（Electron 运行时由 electron-builder 自动注入）。

**IPC 通道（preload.js → 渲染层 `window.api`）**
- 渲染 → 主：`toggle-expand`（放大/还原）、`exit-app`（退出）、`set-theme`(mode)、`resize-window`(w)、`ack-reminder`(id, action)、**`dock-toggle-main`**（挂件条左键 → 开/隐藏主窗）、**`dock-show-menu`**（挂件条右键 → 弹功能菜单）、**`main-show-menu`**（**v1.7.20**：主窗空白处右键 → 弹**同一份**功能菜单，挂件条被关掉后的唯一恢复入口）、**`dock-drag-move`**(x,y)（**v1.7.20**：浮动态拖动实时 `setPosition`）、**`dock-drag-move`**（**v1.7.21**：拖动时实时 `clampDockToWorkArea` 夹进工作区）、**`dock-drag-end`**（**v1.7.21**：松手夹一次并落库，**不再吸附**）、**`dock-set-mouse`**(ignore)（**v1.7.21**：页面按坐标开关「鼠标穿透」，用于精确控制点击热区）、**`dock-hit-ready`**（**v1.7.21**：自检探针，证明穿透状态下 mousemove 确实 forward 进了页面）、**`remindlist-open`**（开关注列表窗口）、**`remindlist-goto-ym`**(y,m,d)（列表点日期跳转）、**`remindlist-remove`**(id)（列表删关注）、**`remindlist-close`**（关列表窗口）
- 主 → 渲染：`theme-changed`(mode)、`goto-ym`(y,m,d)、`reminders-changed`(list)、**`expand-changed`(bool)**（**v1.7.11 修复放大无效的关键**：主窗尺寸态变化时主动推送，渲染层据此同步 `.max` 类）、**`remindlist-data`**(data)（关注列表窗口的数据推送）、**（v1.7.20 已删除）`dock-embedded`**——v1.7.12~19 用于回推挂件条是否已嵌入任务栏（payload `{embedded, sysDark}`，v1.7.19 修正为原样透传对象而非布尔）。嵌入方案废除后，主进程不再发该通道，`preload.js` 的 `onDockEmbedded` 与 `dock.html` 的 `body.embedded` 逻辑一并删除
- invoke 往返：`list-reminders`、`add-reminder`(item)、`remove-reminder`(id)
- 暴露方法：`toggleExpand` / `exitApp` / `setTheme` / `resizeWindow` / `onThemeChanged` / `onGotoYm` / `listReminders` / `addReminder` / `removeReminder` / `onRemindersChanged` / `ackReminder` / **`onExpandChanged`** / **`dockToggleMain`** / **`dockShowMenu`** / **`mainShowMenu`**（**v1.7.20**：主窗右键兜底菜单）/ **`dockDragMove`** / **`dockDragEnd`** / **`dockSetMouse`**（**v1.7.21**：按坐标开关鼠标穿透）/ **`dockHitReady`**（**v1.7.21**：自检探针）/ **`openReminderListWindow`** / **`remindlistGoto`** / **`remindlistRemove`** / **`remindlistClose`** / **`onRemindlistData`**

---

## 4. 设计系统（"纸与光"视觉语言）

### 4.1 设计 Token（CSS `:root` 变量，template.html；黑夜用 `[data-theme="dark"]` 覆盖）
| Token | 白日值 | 黑夜值 | 用途 |
|---|---|---|---|
| `--paper` | `rgba(252,251,249,0.82)` | `rgba(28,32,44,0.86)` | 宣纸/墨纸半透明底 |
| `--paper-edge` | `rgba(31,35,48,0.08)` | `rgba(255,255,255,0.07)` | 卡片描边 |
| `--ink` | `#1f2430` | `#e8eaf0` | 主文字 |
| `--ink-soft` | `#6b7280` | `#9aa3b3` | 次级文字 |
| `--ink-faint` | `#9aa1ad` | `#6a7283` | 最弱/跨月文字 |
| `--accent` | `#3b6fd4` | `#6b9bff` | 雅蓝主色 |
| `--accent-soft` | `color-mix(accent 13%, transparent)` | `16%` | 今日/选中淡底 |
| `--accent-line` | `color-mix(accent 52%, transparent)` | `60%` | 今日/选中描边 |
| `--accent-ink` | `color-mix(accent 78%, #1f2430)` | `86%, #fff` | 今日/选中文字 |
| `--cinnabar` | `#d6453f` | `#ef6b65` | 朱砂红（节假日/休） |
| `--cinnabar-soft` | `rgba(214,69,63,0.07)` | `0.18` | 节假日淡底 |
| `--cinnabar-line` | `rgba(214,69,63,0.42)` | `0.55` | 节假日描边 |
| `--weekend` | `#c0564f` | （沿用） | 周末主数字（柔和砖红） |
| `--workday` | `#3b6fd4` | （沿用） | 补班/班 蓝 |
| `--holiday-fg` | `#cf463f` | （沿用） | 节假日文字 |
| `--shadow-soft` | `0 18px 44px rgba(31,35,48,.16), inset 0 1px 0 rgba(255,255,255,.65)` | 深色版 | 单层柔和阴影+内高光 |

> **主题为手动「白日/黑夜」切换**（不再是"跟随系统强调色"）。`--accent` 为固定值，其余由 `color-mix` 自动派生，整体联动。

### 4.2 关键状态色（硬编码，非 token）
| 状态 | 值 | 说明 |
|---|---|---|
| 区间端点 `.range` | 底 `rgba(34,197,94,0.16)` + 描边 `rgba(34,197,94,0.75)`，数字 `#15803d` | 深绿 |
| 区间中间 `.range-between` | 底 `rgba(34,197,94,0.08)`，数字 `#15803d`，无描边 | 浅绿 |
| 特别关注 `.reminder` | 底 `rgba(255,193,7,0.22)` + 描边 `rgba(255,152,0,0.65)`，数字 `#b26500` | 金黄（黑夜略调亮） |
| 角标 `.chip-focus` | `#ff9800` 底白字，左上角「注」（**v1.7.20 改名**） | 特别关注标记 |
| 月份水印 `#bgMonth` | 白日 `rgba(31,35,48,0.16)`；黑夜 `rgba(255,255,255,0.06)` | 背景大号月份数字，**无 text-shadow** |
| 普通单元格 `.cell` | 白日 `transparent`；黑夜 `rgba(255,255,255,0.04)` | 透明化让水印透出 |

### 4.3 排版
- 字体栈：`"Segoe UI Variable","Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif`
- 时钟 `30px/600` · 日期 `11px/700` · 农历 `10px/400`
- 表头 `8px/600` 字距 2px · 单元格主数字 `14px/700` · 副数字 `8px/500`
- 放大态（`#widget.max`）字号等比放大（约 2.24×）

### 4.4 布局（竖长方形 widget，340×430）
1. `#infoBar`（62px）：左时钟 + 右(日期/农历)
2. `#dragBar`（38px，可拖拽 `-webkit-app-region:drag`）：左(年/月选择+箭头+今) / 右(周起始开关+主题+放大)
3. `#body > #calendar`：表头 + 6×7 网格；含 `#bgMonth`(月份水印) + `#litGlow`(灯效层)
- 圆角 14px（widget）/ 6px（单元格）· 网格 gap 2px

### 4.5 微交互
- 单元格 hover：轻微抬升 `translateY(-1px)` + 墨色细描边（白日 `rgba(255,255,255,0.85)` 底）
- **灯效**：淡蓝径向光晕跟随鼠标，中心亮向外渐隐
- 今日/选中：雅蓝透明描边+极淡底（同效果）
- 周起始开关：真 toggle（轨道+滑块+一/日标签，平滑过渡 cubic-bezier）
- 月份切换：仅网格淡入，无缩放抖动

### 4.6 皮肤系统（v2.4.0）

v2.4.0 第二轮把「主题 + 皮肤」重构为 **per-surface 皮肤配置树**，并完整落地**图片皮肤**。主进程仍是皮肤状态的唯一真相，渲染层只被动消费下发的解析结果。

**数据模型（`electron-main.js`，持久化到 `settings.json` 的 `skin` 字段）**

```js
skin = {
  __v: 2,                                    // 迁移版本门（旧字段一次性迁移后只写本结构）
  surfaces: {
    calendar: { type, color, image, text },  // type ∈ light|dark|system|color|image
    expanded: { follow, type, color, image, text },  // follow='calendar'|null
    desktop:  { follow, type, color, image, text },
    dock:     { type, color, image, text }   // dock 独立，不跟随
  },
  opacity: { calendar: 1, desktop: 1, dock: 1 }  // 窗口级透明度；calendar 同时作用于 mini/max
}
```

- `follow='calendar'`（仅 expanded/desktop）：跟随日历表面；取消跟随 = **copy-on-write** 快照（深拷贝日历当前配置，之后独立编辑）。
- `text` ∈ `auto|light|dark`：决定 color/image 表面的生效文字明暗（`auto` 用 `isDarkColor` / 图片平均亮度自动判定）。
- 迁移：`skin.__v===2 && skin.surfaces` 直接 `normalizeSkin`；否则 `migrateSkin` 从旧字段（theme/skinMode/nativeSkin/skinColor/desktopFollowCalendar/dockFollowCalendar/mainOpacity/desktopOpacity/dockOpacity）一次性迁移。迁移后 `saveSettings` **只写 `skin`**，停写旧键。

**解析链路（主进程唯一入口）**

1. `resolveSurfaceConfig(surface)`：expanded/desktop 若 `follow==='calendar'` 返回 calendar 配置，否则返回自身；dock 独立。
2. `surfaceTheme(surface)`：推导每表面生效明暗——`light/dark` 直接、`system` 读 `nativeTheme.shouldUseDarkColors`、`color/image` 由 `text` 字段决定（`auto` 时用色值 / 图片亮度判定）。
3. `surfaceBg(surface)`：背景层三态 `native | color | image`。
4. `baseTheme()` = `surfaceTheme('calendar')`：托盘、关注列表、提醒、设置等非表面窗口跟随日历表面明暗。
5. `resolvedSurfaceState(surface)`：下发 `{type,theme,bg,color,image}`。主窗发 `{calendar,expanded}`、桌面发 `{desktop}`、浮动发 `{dock}`；非表面窗口仍走 `theme-changed(baseTheme)`。

**图片皮肤（完整实现）**

- 导入：拖入/点选，主进程 `importSkinImage` 校验扩展名 png/jpg/jpeg/gif/webp、≤20MB、最长边≤4096，不合法拒绝；合法则 `copyFileSync→renameSync` **原子复制**到 `userData/skins/`（文件名 `{surface}_{ts}.{ext}`），只存文件名（`image.file`），删原文件不影响。
- 加载：`skin://` 特权协议——模块顶层 `protocol.registerSchemesAsPrivileged`（standard+secure+supportFetchAPI+stream，须在 app ready 前），`whenReady` 里 `protocol.handle('skin', ...)` 把 `skin://{basename}` 映射到 `userData/skins/`（`sanitizeBasename` 防路径穿越 + `net.fetch(pathToFileURL(file))`）。
- 亮度：`nativeImage.resize({width:64}).toBitmap()`（BGRA）采样平均亮度 → WCAG 相对亮度 < 0.5 判深色 → `image.dark`，自动配文字明暗。
- GIF：`background-image` 走 Chromium 原生动画；隐藏/失焦时切 `image.snapshot`（导入时 `toPNG` 存的首帧 `_frame.png`）冻结，`visibilitychange`/`focus` 恢复，避免隐藏窗口持续解码 GIF 耗 CPU。

**取景数学（crop + zoom ↔ CSS background）**

- 存储 `image.crop{x,y,w,h}`（0~1）与 `image.zoom`（1~5）；权威参数为「取景中心 `crop.x+crop.w/2`」+ `zoom`，`crop.w/h` 是 zoom 的派生冗余。
- 正向（渲染层 `applySkinImage`）：全图 cover 基准 `s0 = max(VW/IW, VH/IH)` → `s = s0*zoom`；`background-size=(IW*s)px (IH*s)px`；`background-position=(VW/2 - centerX*s)px (VH/2 - centerY*s)px`（`centerX=(crop.x+crop.w/2)*IW`）。
- 反向（皮肤窗 `saveCrop`）：`vw=VW/s, vh=VH/s` → `crop.w=vw/IW, crop.h=vh/IH`，`crop.x=(center.x-vw/2)/IW`，`zoom=s/s0`。重启后任意分辨率复现一致。

**渲染层落地**

- `template.html` / `dock.html` 增加 `#skinImg` 背景层（`position:absolute; inset:0; z-index:-1`）+ `[data-skin="color"]` / `[data-skin="image"]` 规则；`app.js` / `dock.html` 收到 `skin-state` 后 `applySkinState`（设 `data-theme` + `data-skin` + `--skin-bg-solid`）+ `applySkinImage`（crop/zoom → CSS）。
- **状态色不变**：今日雅蓝 / 节假日朱砂红 / 选中深绿维持原 token，不随皮肤改变。
- **独立皮肤窗 `skin.html`**：设置页只留「皮肤设置」入口（`settings-action('open-skin')`）；皮肤窗 4 界面分段（日历/放大/桌面/浮动）+ 5 类型（浅/深/跟随系统/纯色/图片）+ 色盘 + 图片取景预览（拖入/平移/滚轮 1×~5×）+ 文字明暗 + 透明度 + 跟随开关；经 `skin-set` / `skin-action` / `skin-import` IPC 即时回写。

---

## 5. 核心行为清单（必须遵守）

| 行为 | 实现要点 |
|---|---|
| **托盘图标（v1.7.21 复活，按需创建）** | **v1.7.17~v1.7.20 停用，v1.7.21 起改为「只在桌面图标形态下创建」**：`dockMode==='icon'` 时才调 `createTray()`；切回插件形态时 `destroyTray()` 销毁图标并停掉 tooltip 看门狗定时器。`createTray()` / `scheduleTrayRetry()` / `updateTrayTooltip()` 三处开头都有 `if (dockMode !== 'icon') return;` 门控。**只绑 `click` 不绑 `double-click`**——两个都绑会互相打架（双击时 click 先触发一次、double-click 再触发一次，等于切两下 = 点了没反应）。图标形态下左键单击 = `setDockMode('dock')` 切回插件。其余形态 `tray` 恒为 `null`，`refreshTrayMenu()` 因 `if (!tray) return;` 空转。：启动流程里 `createTray()` 被移除，运行期 `tray` 恒为 `null`，右下角不再有图标，菜单/开关统一收拢到「挂件条右键 `dock-show-menu` + 主窗空白处右键 `main-show-menu`」两个入口，二者都调同一个 **`buildTrayMenu()`**（注意：代码里的函数名仍是 `buildTrayMenu`，文档曾误写为 `buildDockMenu`）。**遗留（v1.7.20 未清理）**：`makeTrayIcon` PNG 编码器、`updateTrayTooltip`、`scheduleTrayRetry`、`createTray`、`trayTooltipTimer` 等约 200 行代码仍留在 `electron-main.js` 但**永不执行**（`createTray` 无调用点，`updateTrayTooltip` 的定时器也只在 `createTray` 内启动），`refreshTrayMenu()` 因 `if (!tray) return;` 直接空转。功能无影响，后续可整块删除。`icon.ico` 仍用于 EXE/任务栏固定/开始菜单/控制面板 |
| **托盘 tooltip** | v1.7.21 随托盘一起复活，但只在图标形态运行：每秒刷新农历/节气/星期，同时充当托盘存活看门狗（Explorer 重启会抹掉图标，`setToolTip` 抛错即探测到失效并重建） |
| **挂件条左键** | 点击 → 主窗隐藏则 `showMini()`，已显示则 `hide()`（`toggleMainWindow()`）；用 `guardBlur(350)`（`blurGraceUntil` 时间戳）避免刚打开即被 blur 误关（v2.4.0 由 `suppressBlur` 布尔改为时间戳，更抗抖动） |
| **功能菜单（`buildTrayMenu`，两个入口）** | 入口①：挂件条右键 → `dock-show-menu`。入口②：**主窗空白处右键 → `main-show-menu`（v1.7.20 兜底）**——v1.7.17 移除托盘后挂件条右键一度是唯一入口，用户一旦从菜单里关掉挂件条（`dockOn:false`）就再也开不回来，只能手改 `settings.json`；现在主窗右键可调出同一份菜单，里面「🕒 任务栏挂件条」开关能恢复。渲染层 `bindMainContextMenu()` 在 `document` 上监听 `contextmenu`，排除 `.cell`（日期格走自己的关注菜单，已 `stopPropagation()` 防双重弹）、`#remindInput`、`INPUT/TEXTAREA/SELECT`（保留系统菜单可复制粘贴）。<br>菜单内容：①「本年最近节日」标题 + 3 个节日扁平列出（`节日名 · MM/DD · X 天`，点击 `goto-ym` 跳转）；② 分隔；③「📒 特别关注（N）」：**单一二级菜单** = 「📂 打开关注列表」+ 分隔 + 全部关注项（按日期升序，每项 `📅 YYYY/MM/DD · 内容摘要 · X 天`，点击 `goto-ym` 跳转）；④ 分隔；⑤ 主题（白日↔黑夜）、置顶、开机自启（开关）；⑥ 分隔；⑦「📅 显示 / 隐藏日历」（**v1.7.21 新增**：图标形态下左键被"切回插件"占用，日历改从这里开）；⑧「🕒 挂件条总开关」；⑨ 挂件条开启时额外两条：**「🗕 缩小至桌面图标」/「🖥 切回桌面插件」**（**v1.7.21 需求2**，形态切换）与**「📌 插件总在最前」**（置顶开关，默认开）；⑩ 分隔；⑪ 退出软件。<br>**v1.7.21 需求6 删除项**：「贴回任务栏上沿（重置位置）」与松手自动吸附一并移除——物理嵌入已放弃，这些功能无意义且实测从未生效。<br>**v1.7.11 修复「右键菜单无效」的历史教训仍适用**：`buildTrayMenu()` 里若 `const menu` 后又 `menu = menu.concat(...)` 会运行时抛 `TypeError` 被 `try/catch` 静默吞掉 → 菜单从未挂上。**catch 里必须写日志**，`node --check` 只查语法查不出 const 重复赋值 |
| **单实例锁** | `app.requestSingleInstanceLock()`，第二实例直接 `quit()`；`second-instance` 事件唤起已有窗口（隐藏则 `showMini`，否则 `focus`+`moveTop`） |
| **默认隐藏 / 关闭 / blur** | `show:false` 不自动弹；`close` 事件非退出时 `preventDefault()+hide()`；`blur` 事件统一走 `hideMain()` 隐藏（`blurGraceUntil` 宽限期内跳过），并经 `win-hidden` 通道通知渲染层清空区间选择 `clearRange()`（v2.4.0 A2） |
| **双窗口模式** | mini `340×430`（贴右下，`setResizable(false)`、`setAspectRatio(0)`）↔ expanded `760×959`（居中，`setResizable(true)`、`setAspectRatio(ASPECT)` 锁比例）；放大按钮经 IPC `toggle-expand` 切换（`win.isResizable()` 判断当前态）。**v1.7.11 修复「放大无效」（反复出现的老 bug）**：`showMini()`/`showExpanded()`/`toggle-expand`/`did-finish-load` 末尾各调一次 `notifyExpandState()` → `win.webContents.send('expand-changed', !!win.isResizable())`；渲染层 `window.api.onExpandChanged(cb)` 收到后执行 `widgetEl.classList.toggle('max', !!expanded)`。<br>**真因**：旧代码只在**浏览器预览的 fallback 分支**里做 `widgetEl.classList.toggle('max')`，Electron 路径下 `.max` 类**从未被添加** → OS 窗口虽然撑到 760×959，但 `#widget` 仍是 340×430，内容缩在大透明窗中间 → 看起来就是"完全没放大"。**复刻时切勿把 DOM 状态同步只写在 fallback 分支里** |
| **等比缩放** | expanded 下渲染层 resize 手柄 → IPC `resize-window`(w) → 主进程 `w = clamp(EXP_MIN_W=700 … 1400)`，`h = round(w/ASPECT)`，`setBounds` 保比例 |
| **点击外部消失** | 见「blur」；隐藏后不自动复位 mode |
| **皮肤/主题切换** | **v2.4.0**：主进程是唯一真相（per-surface 皮肤树 `skin.surfaces`，详见 4.6）。`#themeBtn` 仍是日历表面 light↔dark 快捷键 → `set-theme` → 主进程改 `calendar.type`（清 color/image/text）→ `pushSkinToAll()` 下发各表面 `skin-state`（`{calendar,expanded}`/`{desktop}`/`{dock}`）+ 非表面窗口 `theme-changed(baseTheme)`；皮肤编辑统一走独立 `skin.html` → `skin-set` / `skin-action` / `skin-import`；图片皮肤经 `skin://` 加载 |
| **区间选择** | 点一格 → `.range` 深绿；点第二格 → 两端深绿、中间 `.range-between` 浅绿 + 浮层「共计 N 天」；第三下点击 → 清空（`clearRange`）；`Esc` 或点空白 → 清空；支持跨月（端点按时间戳 `Math.min/max` + strict between 判定，跨月 other 格 `.range/.range-between` opacity 提升到 0.6）。**v1.7.12 提亮中间色**：白日 `.range-between` 背景 `rgba(34,197,94,0.08)`→`0.15`、圆角 3px，让两个端点之间连成更醒目的浅绿带；补黑夜模式覆盖（深底叠半透明绿会发暗）。**v1.7.13 修复「放大模式下中间格不变绿」**：真因是 CSS 特异性——`#widget.max .cell` 为 (1,2,0)，`#widget.max .cell { background: transparent }` 压过了 `.cell.range-between` 的 (0,2,0)，把状态底色整条吞掉；端点 `.range` 因带 `box-shadow` 描边仍可见，中间格没有描边就彻底隐形，现象恰是「端点绿、中间不绿」。解法：几何样式照给所有格子，只有 `background` 那条改用 `#widget.max .cell:not(.range):not(.range-between):not(.today):not(.selected):not(.reminder):not(:hover)`，让基础状态色重新生效；并补 `#widget.max .cell.range-between { border-radius: 12px }` 与周围大圆格保持一致 |
| **特别关注（添加）** | 右键格子 → 弹出 `#remindInput`（第一排「特别关注 日期」+ 第二排「（到日期会弹窗提醒）」+ 输入框 `maxlength="15"`、placeholder「请输入：（15字以内）」+ 确定/取消）→ 确定走 `add-reminder` → 主进程生成 `{id,y,m,d,text,createdAt,snoozeUntil:0,ackedDate:''}` 存盘、广播 → 该格 `.reminder` 金黄 + 「关」角标。**v1.7.11 双重限额**：<br>① **单条 ≤ 15 字** —— 渲染层 `maxlength` 截输入、`confirmRemindInput` 再 `.slice(0,15)`，主进程 `add-reminder` 兜底 `String(text||'').trim().slice(0,15)`；<br>② **总数 ≤ 10 条** —— `openRemindInput` 入口先判 `reminders.length >= 10` 直接 `showToast('特别关注最多 10 条，请先取消一条')` **不弹输入框**；主进程 `add-reminder` 兜底返回 `{error:'limit', max:10}`，渲染层收到后同样 toast |
| **关注列表（独立窗口，v1.7.12 改造）** | 工具栏书图标按钮 `#bookBtn`（主题与放大之间，title="关注列表"）点击 → `openReminderListWindow()` 打开**独立 `BrowserWindow`**（加载 `remindlist.html`，`RL_W=340`、`RL_H=440`、`frame:false transparent:true resizable:true alwaysOnTop skipTaskbar`）。**为什么要独立窗口**：原 `#reminderList` 是 `#widget` 内的绝对定位 DOM，无论怎么放开夹紧逻辑都渲染不到 `#widget` 之外（会被主窗口边界裁掉）→ 独立窗口是唯一干净解法，可拖到**屏幕任意位置**。窗口内容：不透明卡片 `#card`（`background:#fdfcfa` + 1px 描边 + 14px 圆角 + 阴影；dark 为 `#2b3040`）；标题栏 `#header` 用 **`-webkit-app-region: drag`**（Electron 原生拖动，比 IPC 手动 setBounds 丝滑），关闭按钮 `-webkit-app-region: no-drag` 排除；三列 `grid-template-columns: 62px 1fr 24px`——① **日期列**（点击 → `remindlist-goto-ym` 跳转+选中该日）；② **内容列** `.rl-text-wrap` `overflow-x:auto` + mouseX 驱动 `scrollLeft` 按住左右拖看长文；③ **✕ 列**（点击 → `remindlist-remove`(id) 删除，主进程写盘 + `broadcastReminders` 同步主窗黄格 + 本窗口）。数据注入：首次 `loadFile(query:{data})` 传 `{theme,reminders}`；复用窗口时 `pushDataToRemindlist()` 推 `remindlist-data`；主题切换 `pushThemeToRemindlist()` 推 `theme-changed`。**位置记忆**：`moved`/`resized` 事件 400ms 防抖写 `lastRemindlistBounds` 到 `settings.json`，下次打开恢复；越界（换显示器/分辨率变了）回落到 `center()`。关闭：`✕`/`Esc` → `remindlist-close`。空态：「还没有任何特别关注 / 右键日历上的任意日期，即可添加」。 |
| ~~**关注列表弹窗拖动**~~ | **v1.7.12 已由独立窗口取代**。旧 v1.7.11 的 `bindReminderListDrag()`（在 `#widget` 内夹紧拖动）连同 `#reminderList` DOM 全部移除。新方案：标题栏 `-webkit-app-region: drag` 交给系统原生拖动，**天然不受范围限制**，无需手写夹紧逻辑 |
| ~~**黄格 hover 2s 显示内容**~~ | **v1.7.11 已移除**。旧实现：gridEl 委托 `mouseover`/`mouseout`，进入 `.reminder` 格 2 秒后 `#remindHoverTip` 浮起（深底白字气泡 + 小三角箭头，`--tip-arrow-x` 对齐格子中心）。移除原因：直接把鼠标指向格子上「关」角标就能看到内容，更快更直观，两套提示并存反而打扰。**复刻时不要重建 `#remindHoverTip`（CSS 与 `bindReminderHover`/`showRemindHoverTip`/`hideRemindHoverTip` 已全部删除）** |
| **桌面挂件条（v1.7.11 新增 / v1.7.20 起仅浮动、去托盘、去秒 / v1.7.21 双形态 + 精确热区 + 工作区夹取 + 去吸附）** | 独立 `BrowserWindow` 加载 `dock.html`：`DOCK_W=116`、`DOCK_H=50`、`frame:false transparent:true resizable:false alwaysOnTop('screen-saver') skipTaskbar:true backgroundColor:'#00000000'`。内容：上行 24 小时制 `HH:MM`（分钟对齐 `setTimeout` 触发，仅内容变化时写 DOM，挂机 CPU/内存近乎零增长）、下行 `YYYY/MM/DD`；左键 → `dock-toggle-main` → `toggleMainWindow()`；右键 → `dock-show-menu` → `buildTrayMenu().popup()`（**托盘已停用；另一入口是主窗空白处右键 `main-show-menu`**）。开关 `dockOn` 持久化到 `settings.json`。<br>**v1.7.21 拖动 + 工作区夹取（需求3 + 需求6）**：在 `dock.html` 用 `mousedown/mousemove/mouseup` 区分点击与拖动（位移 >4px 判定拖动），拖动经 `dock-drag-move`(增量 dx,dy) IPC 实时 `clampDockToWorkArea()` 夹取后 `dockWin.setPosition`，松手 `dock-drag-end` 再夹一次并把落点写进 `dockBounds` 落库。**松手不吸附**——v1.7.20 的「距任务栏顶边 <80px 则 `positionDock()` 贴回」实测从未生效，v1.7.21 删除。<br>**v1.7.20 显示完整性 = 固定像素布局**：Chromium webContents 内部 viewport 在 transparent + 无边框 + 极小尺寸（116×40~56）组合下，首帧仍可能被错算成 ~16px（致 `#card{inset:2px}` 只剩 12px → 出现椭圆/裁切）。**v1.7.18 曾用 `setSize` 强撑 resize 来修，但这是错的**——对着已 SetParent 成 WS_CHILD 的窗口改尺寸会让 Chromium kill 渲染进程（这正是 v1.7.13~19 每隔 30~50s `render-process-gone reason=killed` 的真凶；同时也是 v1.7.20 决定彻底废除嵌入方案的原因之一）。**正确做法**：主进程 `pushDockSize()` 在 `did-finish-load`、`ready-to-show` 两处把物理窗口真实宽高经 `dock-size` 通道下发；`dock.html` 的 `applyDockSize()` 用固定 px 覆盖 `html`/`body`/`card`（统一内缩 2px，给边框阴影留位），彻底不依赖 `height:100%`。viewport 算错也照样按真实尺寸排布 → 内容完整且不触发崩溃。<br>**v1.7.19 沿用的崩溃保护（v1.7.20 仍生效）**：① `closed` 自愈条件由 `dockCrashed` 触发（浮动态崩溃也要恢复），`DOCK_RECREATE_MAX=3` 硬上限；② `render-process-gone` 回调延迟到下一 tick 安全 destroy（不在崩溃上下文里同步 destroy）；③ 移除误报率高的 `unresponsive` 监听；④ 5 分钟稳定运行清零崩溃计数（`dockStableTimer`），偶发一次不至于永久自愈失败。<br>**v1.7.13~v1.7.19 嵌入任务栏已彻底废除（v1.7.20 决策）**：做法都是 `SetWindowLong(GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD)` + `SetParent(child, ReBarWindow32)`；Chromium 渲染线程在自身 HWND 被改父为 WS_CHILD 后做 surface tree 自检，自检失败主动 kill 自己（不依赖 setSize）。这一组合 7 次尝试全部以 `render-process-gone reason=killed` 失败收尾——崩→重建→嵌入→又崩的循环让任务管理器里堆出 4~5 个同名进程、残留进程持有单实例锁让后续实例 `app.quit()` 秒退（"打开直接闪崩"）。**浮动态从未崩过**（v1.7.11 即是如此），所以 v1.7.20 彻底回退到浮动方案。`dock-attach.ps1` 一并废弃、`package.json` 删除 `extraResources` 这项、`requestSingleInstanceLock({ key: 'yg.simplecalendar.v1' })` 加自定义命名空间、`whenReady` **最开头**（建窗之前）`cleanupStaleInstances()` 按**父子关系**精准清理残留进程。<br>**位置与重定位**：`positionDock()` = 主屏 `workArea` 右端内缩 8px、`d.bounds.y + d.bounds.height - tb - b.height` 正好压在任务栏上沿；`taskbarHeight()` 用 `bounds.height - workArea.height` 推算，20~140px 外兜底 48；`screen.on('display-metrics-changed')` 触发 `clampDockToWorkArea()` 做**越界纠正**——保持用户自定义位置，只把跑出去的部分拉回来（v1.7.20 的「拽回默认位置」随吸附一并删除，那属于已废弃的复位语义）。 |
| **（已移除）托盘看门狗** | **v1.7.20 删除**。原 `updateTrayTooltip()` 每秒执行 + `tray.setToolTip` 抛错判定托盘已死 → `tray.destroy()` 重试的机制，随托盘一并移除。挂机内存项 |
| **启动唤起** | **v1.7.9 修复**：`app.whenReady` 后 `setTimeout(0)` 主动 `showMini()`，让双击桌面图标 / 开机自启后**立刻**贴右下角显示 mini 模式（之前依赖 `win.show:false` + `blur` 自动隐藏 → 某些场景用户找不到入口） |
| **内容列拖拽监听器** | **v1.7.12 改造**：内容列左右拖逻辑移入 `remindlist.html` 的 `bindTextDrag(wrap)`（每次渲染行时对每个 `.rl-text-wrap` 绑 `mousedown`，超宽才启用，`document` 一次性 mousemove/mouseup）。旧 v1.7.10 的全局 `_textDrag` + `bindTextDragGlobals` 方案随 `#reminderList` DOM 一并移除 |
| **提醒巡检** | `setInterval(checkReminders, 60000)`；触发条件 = `(y/m/d == 今天) && (ackedDate != 今天) && (snoozeUntil <= now)`；一次只弹一个（`return` 提前结束） |
| **提醒弹窗** | 独立 `BrowserWindow` 380×264 居中，`frame:false transparent:true alwaysOnTop('screen-saver') skipTaskbar:true`，加载 `reminder.html?query={id,text,date}`；HTML 内用 `#card` 不透明圆角容器规避黑块 |
| **知道了 / 稍后提醒** | `ack-reminder`：`snooze` → `snoozeUntil = now + 30min`；`dismiss`（知道了）→ `ackedDate = 今天(补零 YYYY-MM-DD)`、`snoozeUntil=0`，**保留关注项**（黄格不变），当天不再弹。真正删除由「取消特别关注」完成 |
| **退出** | 挂件条右键「退出软件」→ `requestExit()` 弹确认框（`dialog.showMessageBox` 否/是，退出）→ 确认后 `app.isQuiting=true; app.quit()` |
| **开机自启** | `app.whenReady` 调 `app.setLoginItemSettings({openAtLogin:autoLaunch, path:process.execPath})` |

> **尺寸常量（electron-main.js 顶部）**：`MINI_W=340 MINI_H=430 ASPECT=340/430 EXP_DEF_W=760 EXP_DEF_H=959 EXP_MIN_W=700`。主窗 `frame:false transparent:true resizable:false(默认) alwaysOnTop:pinned skipTaskbar:true backgroundColor:'#00000000' contextIsolation:true`。

---

## 6. 数据与规则（app.js / holidays.js）

### 6.1 农历库接口（只读 `window.Solar` / `window.Lunar`）
- `Solar.fromYmd(y,m,d)` → solar；`solar.getLunar()` → lunar
- solar：`getDayInChinese()`、`getWeek()`、`getFestivals()`（数组）、`getLunar()`
- lunar：`getMonthInChinese()`、`getDayInChinese()`、`getJieQi()`（字符串，无则为 `''`）、`getFestivals()`（数组）

### 6.2 节假日数据（**2026 年硬编码**，每年需更新）
```js
var HOLIDAYS_2026 = {
  H: { 1:[{s:1,e:3,name:'元旦'}], 2:[{s:15,e:23,name:'春节'}], 4:[{s:4,e:6,name:'清明节'}],
       5:[{s:1,e:5,name:'劳动节'}], 6:[{s:19,e:21,name:'端午节'}],
       9:[{s:25,e:27,name:'中秋节'}], 10:[{s:1,e:7,name:'国庆节'}] },
  WK: { 1:[4], 2:[14,28], 5:[9], 9:[20], 10:[10] }   // 调休补班日
};
// find(m,d) 返回 {name,idx,total,s,e} 或 null；isWork(m,d) 判断补班
```
- `find`：落在放假区间内返回段信息，`idx = d - s + 1`（第几天）。
- `isWork`：在 `WK[m]` 数组中即补班日。

### 6.3 副字优先级（每天单元格下面小字）
1. **24 节气**（`getJieQi()` 非空）→ 始终显示。
2. 放假期内**仅节首日**（`idx===1`）显示假期名。
3. 非放假日：法定 `NATIONAL`（元旦/清明/劳动/国庆）+ 白名单 `KEEP` 的阳历/农历节日。
4. 否则显示农历（每月初一显示「X月初一」，其余显示日干支如「初三」）。

### 6.4 节日白名单 `KEEP`（过滤国际/全国/行业类，只留中国传统+主流民俗）
保留：元旦、春节、元宵节、龙头节、二月二、上巳节、寒食节、清明节、端午节、七夕节、中元节、中秋节、重阳节、寒衣节、下元节、腊八节、小年、除夕、情人节、愚人节、万圣节、圣诞节、感恩节、劳动节、国庆节。
- `isKeep(name)`：精确命中或前缀命中（如「清明节」命中「清明」）。
- `ALIAS = {'万圣节前夜':'万圣节'}`（西方别名归一）。

### 6.5 单元格渲染规则（class）
- `other` 非本月（opacity 0.18；跨月节假日 `.holiday.other` 0.55；跨月区间 `.range/.range-between` 0.6）
- `holiday` 朱砂底 + 描边 + 红色 `休` chip
- `workday`（仅当月）蓝色 `班` chip
- `weekend`（仅当月）数字砖红
- `today` / `selected` 雅蓝描边（同效果）
- `range` / `range-between` 区间端点/中间（见 4.2）
- `reminder` 特别关注（金黄底 + 「注」chip，v1.7.20 改名）
- 每月固定渲染 **42 格**（6 周×7），首格偏移 `lead = startMon ? (firstWd===0?6:firstWd-1) : firstWd`

### 6.6 特别关注数据结构（electron-main.js）
```js
// 持久化到 userData/reminders.json（原子写：.tmp → rename）
[{ id: 'r_...', y, m, d, text, createdAt, snoozeUntil: 0, ackedDate: '' }]
```
- `ackedDate`：格式 `YYYY-MM-DD`（**必须补零**，与巡检 `todayKey` 格式严格一致，否则「知道了」比对永不相等）。
- 日期键拼接统一用 `pad2`（`n<10 ? '0'+n : ''+n`），全工程一致。

---

## 7. 打包 / 安装包配置（package.json `build`）

```jsonc
"build": {
  "appId": "com.yg.simplecalendar",
  "productName": "简洁桌面日历",
  "executableName": "SimpleCalendar",     // exe 文件名（ASCII，无空格），显示名另用 productName
  "copyright": "Copyright © 2026 YG",     // 根级 copyright → 写入 exe 文件属性"法律版权"
  "files": [ "app.js","template.html","lunar.min.js","build.js","preload.js","electron-main.js",
             "holidays.js","calendar.html","reminder.html","icon.ico",
             "README.md","使用说明.html","LICENSE","package.json" ],
  "win": {
    "target": ["nsis"],
    "icon": "icon.ico",
    "requestedExecutionLevel": "asInvoker"      // 无需管理员，按用户安装
  },
  "nsis": {
    "oneClick": false,                          // 显示完整向导（下一步/取消/完成）
    "perMachine": false,                        // 按当前用户装到 AppData，免 UAC
    "allowToChangeInstallationDirectory": true, // 可"浏览"改路径
    "createDesktopShortcut": "always",          // 桌面快捷方式（用 icon.ico）
    "createStartMenuShortcut": true,            // 开始菜单文件夹（含卸载）
    "shortcutName": "简洁桌面日历",
    "installerIcon": "icon.ico",
    "uninstallerIcon": "icon.ico",
    "runAfterFinish": true,                     // 完成页"立即运行"勾选
    "include": "installer.nsh"                  // 完成页"查看说明文档"勾选
  }
}
```

> ⚠️ **electron-builder 24 配置坑（实测）**：`win.legalCopyright` 与 `win.companyName` 以及根级 `legalCopyright`/`companyName` **都不是合法字段**，会导致配置校验直接失败（根本不进打包）。版本信息（版权/公司）只靠根级 `copyright`（写入 exe LegalCopyright）+ `author`（写入公司/作者）。不要再加上面两个非法字段。

- **安装路径默认**：`C:\Users\<用户>\AppData\Local\Programs\简洁桌面日历`（per-user，无需管理员）。用户可浏览改到 `C:\Program Files\`（此时会按需提权）。
- **开始菜单**：自动建「简洁桌面日历」文件夹，含「启动软件」+「卸载软件」；控制面板"程序和功能"可见，卸载清理目录/快捷方式/注册表。
- **许可证页**：electron-builder 自动检测根目录 `LICENSE` 文件并显示"许可协议"页。
- **完成页**：`runAfterFinish` 给"立即运行"勾选；`installer.nsh` 通过 `!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\使用说明.html"` 增加"查看说明文档"勾选。
- **图标**：`icon.ico`（16/32/48/256）用于 exe、安装包、卸载程序、桌面/开始菜单快捷方式、控制面板列表。**v1.7.20 起无托盘图标**（原 v1.7.9 的 `makeTrayIcon` PNG 生成器已随托盘一并删除）。

### 7.1 icon.ico 生成（make-icon.js，零依赖）
- 用 `Canvas`（RGBA float 叠加）+ `roundRect`（四角可选圆角）+ `encodePNG`（RGBA + 每行 filter0 + `zlib.deflateSync`，CRC32 拼 IHDR/IDAT/IEND）。
- 画 4 尺寸 [16,32,48,256]：雅蓝圆角磁贴 → 白色圆角卡 → 朱砂红表头(仅上半圆角) → 4×3 网格点(首点朱砂红)。
- 打包为 ICO：ICONDIR(6B) + 每图 16B 目录项（尺寸≥256 记 0，bitCount=32）+ 各图 PNG 字节。**Windows 支持 ICO 内嵌 PNG**。

---

## 8. 版本信息与作者（集中维护点）
- 软件名：`简洁桌面日历`　显示名 `productName` / exe 名 `SimpleCalendar`
- 版本号：`2.4.0`（package.json `version`；同步体现在 exe 文件版本、安装包属性、控制面板）
- **运行时文件**：`userData/reminders.json`（特别关注）、`userData/settings.json`（v1.7.11 新增：theme/pinned/autoLaunch/dockOn；v2.4.0 新增：skin{__v,surfaces{calendar,expanded,desktop,dock},opacity{calendar,desktop,dock}}/dockBoundsByDisplay/dockDisplayId；一次性迁移后旧键 skinMode/nativeSkin/skinColor 等停写）、`userData/calendar.log`（v1.7.11 新增：诊断日志，超 200KB 自动清空；打包后 stderr 不可见，**日志是唯一排查手段**）
- 作者：`YG`（`author` 字段；版本信息中的公司/版权靠根级 `copyright` 写入 exe 文件属性）
- 版权：`Copyright © 2026 YG`
- 仓库/主页：`https://github.com/kt87on/simple-desktop-calendar`（GitHub 用，可改）
- 协议：MIT

---

## 9. 已知限制与维护点
1. **节假日为 2026 硬编码**：每年国务院安排出来后，更新 `app.js` 的 `HOLIDAYS_2026.H`（放假区间）与 `HOLIDAYS_2026.WK`（补班日），以及 `holidays.js` 的节日列表（含 `HOLIDAY_RANGE` 区间表）。
2. **仅 Windows**：依赖任务栏挂件条与窗口 API。macOS/Linux 不保证。
3. **农历库为第三方**：只读接口，升级库时注意 `Solar/Lunar` API 兼容性。
4. 跨年临界点（如 12 月补班关联次年）按当年数据简单处理，不做跨年联调；挂件条右键「本年最近节日」不跨年（符合"本年"语义）。
5. **透明窗口在 Windows DWM 下原生 resize 边框失效**：放大态缩放靠渲染层 resize 手柄 + IPC `setBounds` 实现，`setAspectRatio` 锁定比例，`setAspectRatio(0)` 解除。

---

## 10. 常见修改指引（给 AI 的速查）
- **改主色**：改 `template.html` `--accent`（白日与黑夜两处），其余 `color-mix` 自动派生。
- **改窗口尺寸**：改 `electron-main.js` 顶部 `MINI_*` / `EXP_*` / `EXP_MIN_W` 常量，并同步 `template.html` `#widget` 的 `width/height` 与 `#widget.max` 字号。
- **改节日白名单**：改 `app.js` 的 `KEEP` / `ALIAS`；法定日改 `NATIONAL`。
- **改年份节假日**：改 `app.js` `HOLIDAYS_2026`（建议重命名为带年份对象并做选择逻辑）+ `holidays.js` 的节日数据与 `HOLIDAY_RANGE`。
- **改作者/版本**：改 `package.json` 的 `author`/`version`/`copyright`/`productName`；`template.html` 的 `<title>`。**不要**加 `legalCopyright`/`companyName` 字段（electron-builder 24 不合法）。
- **改图标**：改 `make-icon.js` 配色/构图后 `node make-icon.js` 重新生成 `icon.ico`。
- **改提醒弹窗样式/文案**：改 `reminder.html`（尺寸 380×264，`#card` 不透明容器不可删，否则透明 PNG 出黑块）。
- **加安装完成页选项**：改 `installer.nsh` 的 `MUI_FINISHPAGE_*` 定义。
- **重建预览页**：改 `template.html`/`app.js` 后跑 `node build.js` 生成 `calendar.html`，可直接浏览器打开核对（无挂件条/弹窗等桌面特性）。
- **排查"功能毫无反应"类 bug（v1.7.11 血泪经验，必读）**：按三步走，别再靠猜——<br>① **静态扫描 const 重复赋值**：`node --check` **只查语法**，查不出 `const x` 后又 `x = ...`（运行时才抛 `TypeError: Assignment to constant variable.`）。写脚本扫全部源文件，对每个 `const NAME` 声明行之后的同标识符赋值报警。<br>② **把所有 `catch` 从静默改为写日志**：`catch(e){ log(...) }`。静默吞异常是 bug 最好的防空洞——菜单挂不上、窗口没建成，界面上都是"点了没反应"，没有任何线索。<br>③ **mock Electron 跑主进程冒烟测试**：用 `Module._load` 拦截 `require('electron')` 返回 mock 对象（`app/BrowserWindow/Menu/ipcMain/screen/dialog/shell` 等，**v1.7.20 起不再需要 `Tray`**），真实执行 `electron-main.js`，统计"挂件条创建次数 / 菜单构建次数 / 菜单条目数 / loadFile 页面 / 注册的 IPC（含 `dock-toggle-main`/`dock-show-menu`/`dock-drag-move`/`dock-drag-end`）"，并断言日志里出现关键成功行。这能在不开窗口的情况下逼出所有只在运行时才炸的错误。<br>改完主进程必跑：`node smoke-test.js`（mock Electron 运行时冒烟）与 `verify_v1720.js`（静态改动自检，共 42 项断言，覆盖四类：① v1.7.17 十条需求回归（去托盘 / 主窗右键兜底 / 菜单合并 / 去秒 / 角标注 / 放大图标等）；② **[关键] 嵌入残留反向断言**——`attachDockToTaskbar`/`verifyDockEmbedded`/`detachDock`/`scheduleDockVerify`/`runDockScript`/`systemPrefersDark`/`pushDockEmbedded`/`dockHwnd` 等函数定义、`dockEmbedded`/`dockAttachTries`/`dockRehealCount`/`dockNoEmbed` 状态变量、`dockAttachTimer`/`dockVerifyTimer` 定时器、`dock-embedded` IPC 通道**必须全部不存在**（脚本会先完整剥离 `/* */` 与 `//` 注释再匹配，否则说明性注释里的函数名会造成误判）；③ v1.7.20 浮动方案核心：`positionDock`/`pushDockSize` 存在且在 `did-finish-load` + `ready-to-show` 被调用、单实例锁带 `MY_LOCK_KEY` 命名空间、启动时 `cleanupStaleInstances()` 清理残留进程，且**必须**① 在建窗之前调用 ② 用 CIM 取父子关系而非 `tasklist` 按名批量杀 ③ 排除自己及子孙的传递闭包 ④ 取不到父子信息就放弃清理（防回归：v1.7.20 首版曾误杀自己的渲染进程）、`dock-drag-end` 吸附只调 `positionDock()` 不再嵌入；④ v1.7.19 崩溃保护与固定像素布局仍生效（`DOCK_RECREATE_MAX` 上限、`render-process-gone` 延迟销毁、`dockStableTimer` 5 分钟清零、`dock.html` 的 `applyDockSize()` 固定 px）。另检查 `package.json` 的 `build.extraResources` 已移除）。

> 复刻校验清单：① `node build.js` 生成 calendar.html 且**不含** `/*__LUNAR_LIB__*/`/`/*__APP__*/` 占位符；② `node make-icon.js` 生成合法 icon.ico；③ `npm run build` 在 `dist/` 产出 `简洁桌面日历 Setup 1.7.22.exe`；④ 安装后桌面/开始菜单有快捷方式、控制面板可见、可卸载；⑤ 运行后任务栏上沿右端出现挂件条（**插件形态下右下角无托盘图标**；切成「桌面图标」形态后托盘才出现），左键开/隐藏日历、右键弹功能菜单（节日+特别关注二级菜单+主题/置顶/自启+「缩小至桌面图标 / 切回桌面插件」+「插件总在最前」+退出）；⑥ 右键格子可设特别关注（变金黄+**注**角标，v1.7.20 改名）、到日弹窗提醒、知道了当天不再弹；⑦ 点两个日期显示「共计 N 天」、中间浅绿、跨月可用；⑧ 白日/黑夜主题切换正常、挂件条同步反色；⑨ 点击工具栏书按钮弹三列关注列表（日期可跳转、内容可拖拽、✕ 删除），与右键菜单二级菜单共用删除路径；⑩ **（v1.7.11 已删除）** 原「鼠标停在金黄格 2 秒浮出气泡」——改为直接指向「注」角标查看；⑪ 双击桌面图标 / 开机自启后窗口**立刻**贴右下角显示 mini 模式（v1.7.9 修复启动唤起）；⑫ 关注列表弹窗多次开关后拖拽监听器**不累积**（v1.7.10 修复）。<br>**v1.7.11 必测四项**：⑬ **点「⊕」窗口与内容同步放大**（`.max` 类生效，不是只有透明窗变大）——回归 `expand-changed` 推送；⑭ **挂件条右键菜单能弹出**（v1.7.20 起为唯一菜单入口）；⑮ 关注列表弹窗可按表头拖动、内容清晰不透明、内容列已加宽；⑯ 特别关注超过 10 条会 toast 提示、单条超 15 字被截断；⑰ 挂件条上 24h 时钟（**只显时:分，无秒**）/ 下年月日，左键开隐藏日历、右键弹菜单。<br>**v1.7.20 必测**：⑱ **右下角无任何托盘图标**（托盘已彻底移除）；⑲ 点特别关注列表时主窗**不消失**（`suppressBlur` 抑制 blur 误关）；⑳ 右键「特别关注」二级菜单已合并（「打开关注列表」+ 全部关注项在同一 submenu）；㉑ 挂件条可按住拖动，**四条边被夹在屏幕工作区内**（拖不出屏幕、也压不到任务栏），松手落点被记住（下次启动与从图标模式切回来都回到原处）；㉒ 右键菜单点「🗕 缩小至桌面图标」→ 插件收起、系统托盘出现静态图标；**左键单击**该图标 → 插件回到收起前的位置（v1.7.21 需求2）。<br>㉔ **拖动不黑屏、不粘鼠标**——浮动态快速拖动时挂件条跟随流畅，在窗口外松开鼠标后回到窗口**不会**继续自动跟随；㉕ **主窗右键兜底**——主窗空白处右键能弹出功能菜单，在菜单里先关掉挂件条、再用主窗右键重新打开（验证不死锁）；日期格右键仍只弹「设/取消关注」、输入框里右键仍是系统菜单；㉖ **放大按钮新图标**（左上「大」/ 右下「小」/ 中间斜杠）清晰可辨、按钮大小不变；㉗ 特别关注格右上角标显示「注」。<br>**v1.7.20 必测（崩溃循环 + 显示裁切，务必逐项验证）**：㉜ **进程不堆积** —— 连续运行 10 分钟后，任务管理器里「简洁桌面日历」进程数应稳定在 3~4 个（主进程 + 渲染进程 + GPU/utility），**不应**随运行时间持续增长；㉝ **日志无崩溃循环** —— `calendar.log` 不应反复出现 `dock render-process-gone reason=killed`，尤其不能出现"每 30~50 秒一次 + 3 秒后自动重建 + 再次 EMBEDDED"的循环节奏；㉞ **挂件条内容完整** —— 时钟 `15:29` + 日期 `2026/9/3` 完整显示，不裁成竖条/椭圆（本版靠固定像素布局实现，日志应无任何 setSize / SetParent 操作）；㉟ **浮动态内容完整** —— 贴任务栏上沿时同样不裁切，卡片边框/圆角/阴影正常；㊱ **不再有嵌入态** —— 全代码库搜索 `attachDockToTaskbar` / `SetParent` / `dock-embedded` 应零命中；挂件条永远是独立浮动窗（卡片保留边框 / 圆角 / 阴影），不再"长进"任务栏；㊲ **多次启停不闪崩** —— 关闭后再双击图标能正常打开（验证单实例锁不再被僵尸进程占用）；㊳ **崩溃后有限自愈** —— 若确实发生崩溃，挂件条最多自动重建 3 次（`DOCK_RECREATE_MAX`）后停止，日志应出现崩溃与重建计数，而**不应**出现无上限的"崩 → 建 → 崩"循环；<br>**v1.7.21 必测（6 条外围改造，逐项验证）**：㊴ **热区精确** —— 把插件拖到桌面中间，点它**下方**（水平线以下）的透明区域，**不应**弹出日历；只有小方框内能点；日志首次移动鼠标应出现 `dock hit-test link OK (forward mousemove received)`；㊵ **形态切换** —— 右键「🗕 缩小至桌面图标」→ 插件消失、托盘出现图标；**左键单击**图标 → 插件回到收起前的位置；反复切换 5 次不残留多余进程；㊵ **拖动边界** —— 拖插件往屏幕四边怼，应被夹住不出界、不压任务栏（工作区已自动排除任务栏）；Ⓐ **日历定位（插件模式）** —— 插件分别贴屏幕四角/四边时点它，日历窗口都应**完整显示**、四周均不超界（靠 `placeMainNearDock()` 四方位择优 + 纠偏）；Ⓑ **日历定位（图标模式）** —— 沿用原逻辑，位置与 v1.7.20 一致，无回归；Ⓒ **无吸附残留** —— 全代码库搜 `贴回任务栏` / `snap` 应零命中（仅注释里可出现"已删除"的说明），右键菜单里也不再有该选项。<br>**v1.7.22 必测（3 处微调，逐项验证）**：Ⓓ **间距紧贴** —— 插件贴屏幕四边/四角时点它，弹出的日历窗口应与插件之间**无肉眼可见缝隙**（`MAIN_GAP=1`）；若下方空间不足应自动翻到上方紧贴，且四周/任务栏均不越界；Ⓔ **今日深蓝** —— 打开日历，今日日期格应为**深蓝底 `#1565C0` + 白字**；点选其它日期后选中态仍是原来的浅蓝（不被误染成深蓝），节假日/周末/区间色不变；Ⓕ **系统检测** —— 首次启动后 `%APPDATA%\simple-desktop-calendar\settings.json` 应出现 `"isWin11": true/false`（Win10 build∈[10240,19045] 为 false，Win11 build≥22000 为 true）；任务栏高度全程未硬编码、始终走 `workArea`，Win10 与 Win11 上分别拖动插件到四边、点击弹出日历，均不越界。
