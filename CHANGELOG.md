# 更新日志（Changelog）

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 规范记录「简洁桌面日历」的所有正式版本变更。版本号遵循语义化版本（SemVer）。

---

## [2.4.0] - 2026-09-07

### 新增
- **皮肤系统形态重构（per-surface 皮肤树）**：主进程是唯一真相，持久化 `skin.surfaces{calendar,expanded,desktop,dock}`（每界面独立 type∈light/dark/system/color/image + color/image + text∈auto/light/dark），`expanded/desktop` 支持 `follow='calendar'`（取消跟随 = copy-on-write 快照）、`dock` 独立；透明度收敛为 `skin.opacity{calendar,desktop,dock}`。旧字段（theme/skinMode/nativeSkin/skinColor/跟随/透明度）经 `skin.__v===2` 一次性迁移（`migrateSkin`），迁移后 `saveSettings` 只写 `skin`。
- **独立皮肤设置窗口（skin.html）**：设置页只留「皮肤设置」入口；皮肤窗 4 界面分段（日历/放大/桌面/浮动）+ 5 类型（浅/深/跟随系统/纯色/图片）+ 色盘 + 文字明暗 + 透明度 + 跟随开关。
- **图片皮肤（完整实现）**：拖入/点选导入 png/jpg/jpeg/gif/webp；原子复制到 `userData/skins/` 仅存文件名；`skin://` 特权协议（`registerSchemesAsPrivileged` + `protocol.handle`）加载；亮度采样（`nativeImage.resize(64).toBitmap()` 平均亮度）自动明暗文字；GIF 动画播放（Chromium 原生，渲染层 `background-image` 保持动图）。
- **取景数学（crop + zoom）**：归一化 `crop{x,y,w,h}` + `zoom`(1~5) ↔ CSS background-size/position（全图 cover 基准），权威参数「取景中心 + zoom」，`crop.w/h` 为派生冗余；重启后任意分辨率复现一致。
- **多屏插件位置记忆（A3）**：`dockBoundsByDisplay`（显示器 ID → 落点）+ `dockDisplayId`，`pickDockRestore()` 按「原屏原位 → 存活屏回退 → 旧式单一 dockBounds → 默认落点」恢复。

### 修复
- **blur 误关主窗（A1）**：`suppressBlur` 布尔改为 `blurGraceUntil` 时间戳 + `guardBlur(ms)`，高频焦点切换更抗抖动。
- **隐藏主窗不清理区间（A2）**：统一 `hideMain()` 隐藏路径，经 `win-hidden` 通道通知渲染层 `clearRange()` 清空已选日期区间。
- **插件鼠标移出/右键后穿透失效（A4）**：`dock.html` 抽出 `resetHit()`，`blur` / `mouseleave` / `contextmenu` 三处统一恢复鼠标穿透。
- **功能栏不可拖动（A5）**：`#infoBar` 加 `-webkit-app-region: drag` + `user-select: none`，与其它窗口标题栏拖动一致。
- **插件日期/星期挤成一团（A6）**：`#dockDate` 拆为 `#dockWeek` + `#dockDateNum` 两个独立 span，`gap: 6px` 排版。
- **桌面插件 blur 不清算天数区间（A-bug1）**：`createDesktopWidget` 补 `desktopWin.on('blur')` → 下发 `win-hidden` → 渲染层 `clearRange()`。
- **主窗 blur 误判漏隐藏（A-bug2）**：删除 `BrowserWindow.getFocusedWindow()` 宽松判定（点空白桌面/任务栏会误判焦点仍在本应用），改为显式逐个 `isFocused()` 判断已知兄弟窗口（dock/desktop/settings/skin/remindlist/reminder），全部不在焦点才隐藏；保留 `guardBlur` 给菜单/唤起。
- **浮动插件自选背景出现方框边（v2.4.1）**：纯色/图片皮肤下关掉 `#card` 的硬描边 + 描边环 + 顶部高光，只保留柔光投影，边缘干净圆润。
- **取消图片大小/像素上限（v2.4.1）**：`importSkinImage` 删除 ≤20MB 与最长边 ≤4096 限制，仅保留 png/jpg/jpeg/gif/webp 格式白名单。
- **点「自选图片」窗口全透明（v2.4.1）**：`surfaceBg` 对 `type=image` 但尚未导入图片时回退纯色兜底（`solidFallbackFor`，text=light/dark 取对应底色、auto 取当前生效明暗），不再下发透明。
- **导入图片不显示（v2.4.1）**：新增 `skinUrlToName` 剥掉 `skin://` standard 协议的尾斜杠/query 后再取 basename，修复 `sanitizeBasename('file/')` 得空串导致 404 的问题。
- **图片导入后误切黑夜（v2.4.1）**：亮度采样跳过 alpha=0 的透明像素（PNG 透明区 BGRA 为黑会拉低均值），采样失败兜底浅色，不再误判深色。
- **浮动插件纯色/图片模式点击闪黑 + 方框边 + 两层堆叠（v2.4.2）**：根因是主进程把 dock 窗口 `setBackgroundColor` 成不透明色使透明窗口退化成方形色块，且 `body.hit #card:hover` 优先级高于 `[data-skin]` 把自选背景换成 `--card-hover`。改为窗口背景始终透明 + 纯色/图片复用原生 `--edge` 描边 + `--shadow` 阴影，hover 仅锁住自选背景。
- **GIF 动图无法识别（v2.4.2）**：`nativeImage` 对 GIF 支持有限，导入时跳过 nativeImage 解码/亮度采样/首帧快照，尺寸改从 GIF 文件头直接读取，`dark` 兜底 `false`，直接复制文件由渲染层 `background-image:url(skin://...)` 保持动画。
- **使用说明同步到 v2.4.0（v2.4.2）**：`使用说明.md` / `使用说明.html` 补充皮肤系统、图片皮肤与本轮修复点，版本号更新为 v2.4.0。

---

## [2.3.2] - 2026-09-07

### 新增
- **放大/缩小按钮重做为「放大镜」图标**：镜片内 mini 态显示「+」（点击放大）、放大态显示「-」（点击缩小），按钮悬停提示随状态在「放大 / 缩小」间切换。
- **放大模式窗口可拖动**：放大态下拖动窗口自动夹进工作区（屏幕边框 / 任务栏为界，绝不越界、显示完整），与桌面插件同一套夹取逻辑。

### 变更
- **白日模式工具栏底色由蓝改中性灰**：功能栏背景由蓝色改为 ink 系 12% 中性灰，与暖纸卡协调。
- **修复工具栏两端「漏白边」**：卡片描边 `--paper-edge` 由 9% 加深到 14%，灰色工具栏左右两端不再被半透明描边衬成白边。
- **字号加粗提升清晰度**：年/月下拉 9px/500 → 11px/600；时间栏年月日 10px → 13px；农历 8px/400 → 11px/600。

---

## [2.3.1] - 2026-09-07

### 修复
- **白日模式工具栏太浅**：功能栏背景 `accent-softer` (6% 蓝) 提到 `rgba(59, 111, 212, 0.14)`，底边线由 9% 黑提到 14% 黑；年/月下拉、翻月箭头、「今」按钮、周起始开关、主题/放大按钮在纸白卡片上不再糊成一片。
- **第六排「下月」日期看不清**：`.cell.other` 透明度 0.20 → 0.40，`.cell.other.holiday` 0.55 → 0.65；下月日期文字与节假日红框从几乎不可见提升到清晰可读，且仍明显弱于当月、保持视觉层级。

---

## [2.3.0] - 2026-09-07

### 新增
- **设置窗口可拖动**：`settings.html` 表头加 `-webkit-app-region: drag`，关闭按钮 `no-drag`，与特别关注窗口（remindlist）一致的原生拖动，可拖到屏幕任意位置。
- **解除特别关注数量限制**：移除「最多 10 条」上限（主进程 `add-reminder` 与渲染层 `openRemindInput`/`confirmRemindInput`/`localAddReminder` 三处拦截全部删除，关注列表不再显示 `x/10`），仅保留单条 15 字限制。

### 修复
- **安装完成后说明未弹出**：根因是 `使用说明.html` 只打进 asar，`$INSTDIR\使用说明.html` 不存在，`MUI_FINISHPAGE_SHOWREADME` 静默失败。现通过 `extraFiles` 把使用说明作为独立文件放进安装目录，并默认勾选「查看说明文档」。

### 变更
- **重做使用说明**：非技术向的「软件介绍 + 功能说明 + 软件大小 + 版本更新信息」，替换原陈旧文档。
- **Win11 兼容复查**：确认 `detectWin11`（build≥22000）、任务栏高度动态获取、透明窗口、高 DPI `Math.round` 补偿等既有机制覆盖到位，无新增问题。

---

## [2.2.0] - 2026-09-07

### 新增
- **桌面插件（需求 4）**：新增「日历板块」桌面工具，复用 `calendar.html`（`mode=desktopWidget`），只显示日历板块（隐藏顶部时间信息条），像 Windows 桌面小工具一样可拖动、可锁定。
  - 拖动按屏幕坐标绝对定位 + 工作区夹取（屏幕边框 / 任务栏为界，绝不越界、显示完整），位置落盘 `settings.json`。
  - 锁定：换肤键替换为**锁定键**（锁 / 开锁图标 + 高亮态），锁定后不可拖动，其余功能（翻月 / 周起始 / 关注 / 日期区间选择）正常。
- **设置弹窗（需求 5）**：右键菜单瘦身为「最近节日 / 特别关注 / 显示·隐藏日历 / 设置 / 退出软件」，主题、置顶、自启、挂件条总开关、显示形态、插件置顶、桌面插件开关、检查节假日更新全部收进 `settings.html` 卡片弹窗。
  - 新增**三档窗口透明度**调节（浮动插件 / 日历 / 桌面插件，0.30–1.00 滑杆，实时生效并持久化）。
  - 主进程是唯一真相：弹窗只渲染 `settings-state` 推送的状态，依赖项（如挂件条关闭时形态/置顶灰显）自动禁用。
- 菜单图标新增 `lock`（挂锁）、`settings`（齿轮）两枚单色图标。

### 修复
- **放大模式内容不随窗口等比缩放**：原 `.max` 用固定字号，窗口缩小后内容被裁。现 `.max` 固定 760×961 设计尺寸，用 CSS `zoom` 随窗口物理宽等比缩放（`--uizoom = 窗口宽 / 760`），最小宽降到 420。
- **点击浮动插件无法关闭日历（需求 1）**：主窗 `blur` 自动隐藏先于插件点击触发，导致 toggle 判定"不可见"又重开。现焦点在插件 / 桌面插件上时不隐藏主窗。

### 变更
- **浮动插件显示秒 + 星期（需求 3）**：时间显示到秒（`HH:MM:SS`），日期显示星期（`周X MM/DD`），排版沿用原设计风格。
- **每次打开日历回到当前月份（需求 7）**：托盘 / 插件打开时主进程推送 `reset-month`，渲染层若翻到别月则回当前月（不影响已选日期与"跳转到某日"）。

---

## [2.1.0] - 2026-09-07

### 新增
- **节假日年度联网更新**：新增 `holiday-store.js`（数据读写 / 多源抓取 / 归一化 / 原子写）与卡片弹窗 `holidayupd.html`（confirm → updating → success / failed 四态，视觉与 `exit.html` 同源）。
  - 数据源三级兜底：jsDelivr(holiday-cn) → raw.githubusercontent(holiday-cn) → timor.tech；支持环境变量 `SIMPLE_CAL_HOLIDAY_URLS` 覆盖，支持 `file://` 本地文件（离线可用）。
  - 自动检测：启动 5 秒后查一次 + 每 6 小时轮询；国务院通常 11 月发布次年安排，故 11 月起目标年份自动 +1。
  - 不骚扰：7 天节流 + 用户点「以后再说」后该年不再自动提示；托盘右键「检查节假日更新」可随时手动触发（忽略节流）。
  - 更新成功显示明细（如「元旦 1/1–1/3 · 春节 2/15–2/23 … 共 11 天假期、5 天补班」），失败显示具体原因；支持「从文件导入」离线兜底。
  - 数据落盘 `userData/holidays.json`（原子写：`.tmp` → rename），读盘损坏自动回退出厂内置数据。
- 渲染层节假日数据改为**按年份索引**（`HOLIDAY_FALLBACK` 出厂内置 + 运行时 `HOLIDAY_YEARS`），主进程更新后经 `holiday-data-changed` 推送热替换，`applyHolidayData()` 立即重绘。
- `holidays.js` 改为从 `holiday-store` 读数据（导出签名保持兼容，新增 `rangeOf(name, year)` 与 `setData(data)`），托盘菜单节日区间文案随之走新数据。
- 测试样例 `fixtures/holiday-cn-2027.json`、`fixtures/timor-2027.json`（两种数据源格式，供离线验证）。
- 手动点「检查节假日更新」而数据已是最新时，弹窗给出「20XX 年放假安排已是最新」+ 数据来源与更新日期（原来零反馈，像失灵）。

### 修复
- **日历不能跨天**：`app.js` 的 `var now = new Date()` 只在启动时算一次，`isToday()` 用它判定 → 过了午夜仍高亮昨天，且 9/30→10/1、12/31→1/1 连月/年都不跟随。
  - 新增 `todayParts()` / `refreshNow()`，`isToday()`、`gotoToday()`、`fillSelectors()` 一律改用实时时间。
  - 新增 `onDayRollover()`：正在看"旧今天所在的月"时跟随滚到新月/新年，选中日同步跟随，并重绘 + 刷新信息条 + 强制刷新托盘 tooltip + 同步天数浮层。
  - 触发改为**日期键比较 + 三重保险**（每秒 `updateClock` 比较、`visibilitychange`、`focus`），不再依赖"恰好跑到 00:00:00 那一秒"——系统休眠或定时器被节流时会整个跳过。
- **节假日数据不区分年份**：`info()` 与 `infoBarLunar()` 原来无论看 2025 还是 2027 都拿 2026 的表去套，导致别的年份出现莫名的"休/班"标记。现在按年份取表，该年无数据则既不放假也不补班。
- **跨月节日的托盘区间文案丢后半段**：放假期段跨月时（如春节 1/28–2/4）被裁到起始月月末，菜单显示成「01/28-31」。现在区间两端都带月份，输出「1/28-2/4」。
- **长期离线用户每 7 天被弹一次更新**：新增 `holidayFailCount`，累计失败 2 次起自动提示窗口由 7 天拉长到 28 天，更新成功即清零。
- 节假日更新弹窗高度 252 → 300（成功态明细不再被裁切），明细文案最多 3 行后省略。

---

## [2.0.0] - 2026-09-06

### 新增
- **全套 UI 视觉重构**（只动视觉，功能与交互零改动）
  - 建立设计 Token 体系：5 色族（中性/雅蓝/朱砂/金/绿）+ 8 级字阶 + 4pt 间距网格 + 5 级圆角 + 5 级 elevation + 4 档动效 + 3 套缓动，全部收敛在 L1 基础层，组件层禁止硬编码色值/圆角/阴影。
  - 重绘应用图标 `icon.ico`（16/32/48/256 四尺寸，日历+挂环+网格点风格）。
  - 任务栏托盘与右键菜单图标：用 `menuIcon()` 单色图标系统（Canvas/PNG 编码 + 超采样抗锯齿）替代全部 emoji，图标跟随系统深浅色。
  - 黑夜模式整组补齐：日历主体、悬浮插件、提醒弹窗、退出弹窗全部支持白/夜双主题。
- **退出确认弹窗 UI 化**：由 Electron 原生 `dialog.showMessageBox`（系统消息框）改为与整体设计一致的卡片弹窗 `exit.html`（雅蓝语义、白/夜双主题、Esc 取消）。
- 设计规范文档 `UI_DESIGN_SYSTEM.md` 与 `DESIGN_SPEC.md`。

### 修复
- 日历主体在 Electron mini（340×430）/ expanded（760×959）窗口下的**卡片边缘裁切**：`body` 新增显式 `body.electron { padding: 0; display: block }`，`#widget` 用 `width/height: 100%` 精确填满窗口，不再依赖 `app.js` 内联兜底；透明窗口圆角 = 卡片圆角，桌面从四角透出。

### 变更
- 今日单元格颜色由硬编码 `#1976D2` 改为 Token 链 `--blue-600 → --accent-strong` 派生（渲染结果不变）。

---

## [1.7.22] - 2026-09-04

### 修复
- **拖拽卡死 / 卡半空 / 拖不到边**（连续多轮）：浮动插件物理窗口会被引擎/OS 撑大（请求 116×40，实测落到 232×164），旧代码拿 `getBounds()` 的宽高算边界导致夹取范围被压缩。引入 `dockW`/`dockH` **意图尺寸唯一真值** + `dockClamped(x,y)`，所有定位/夹取不再采信 `getBounds()` 宽高。
- 拖拽漂移：重写为绝对定位（mousedown 记 `offset = mousePos - windowPos`，mousemove 算 `newPos = mousePos - offset`），禁止 `+=` 累加。
- 脏 `dockBounds` 尺寸越界：启动时校验丢弃，回落到默认落点。
- Win11 下个别像素偏移：`WIN11_POS_COMP_X/Y` 补偿常量 + `Math.round` 取整。
- 拖完立即退出丢落点：`dock-drag-end` 加 500ms 防抖 + `before-quit` 兜底 `flushDockBounds()`。

### 变更
- 日历窗口与插件间距紧贴（`MAIN_GAP = 1`，防撕裂）。
- 今日单元格深蓝强调（独立于选中态）。
- Win10/Win11 自动检测（读内核 build 号写 `isWin11`，任务栏高度始终用 `workArea` 动态获取）。

---

## [1.7.21] - 2026-09-02

### 新增
- **双显示形态**：桌面插件（可拖动小方框）↔ 桌面图标（系统托盘静态图标），菜单「缩小至桌面图标 / 切回桌面插件」一键切换，状态持久化。

### 修复
- 点击热区：透明区域彻底穿透（`setIgnoreMouseEvents` + 页面按坐标判 `#card` 矩形）。
- 拖拽限制在屏幕工作区内（`clampDockToWorkArea`），拖不出屏幕、压不到任务栏。
- 日历弹出定位区分两种模式（插件模式以方框为基准四方位择优）。
- 移除无效吸附与"贴回任务栏上沿"。

---

## [1.7.20] - 2026-09-01

### 变更（关键回滚）
- **彻底废除任务栏嵌入方案**：v1.7.13~v1.7.19 共 7 次用 `SetParent(ReBarWindow32)` 真嵌入任务栏，全部被 Chromium 以 `render-process-gone reason=killed` 反噬（根因：SetParent 改父为 `WS_CHILD` 后渲染线程 surface tree 自检失败主动自杀），且崩溃循环造成进程堆积、单实例锁误杀新实例。回退到 v1.7.11 浮动方案（置顶无边框窗，视觉紧贴任务栏上沿）。
- `dock-attach.ps1` 废弃、`extraResources` 删除。

### 修复
- 启动残留清理按**父子关系**过滤（不再按进程名批量杀，避免误杀渲染/GPU 子进程）。

---

## [1.7.13] - 2026-08-31

### 新增
- 真正嵌入任务栏（`SetParent` 前先手动 `WS_CHILD` 化 + `GetParent()` 回读校验）。

### 修复
- 放大模式下区间中间格不变绿（`#widget.max .cell` 特异性压过 `.cell.range-between`）。
- `dock-attach.ps1` 必须带 UTF-8 BOM（否则 GBK 解码吞换行符）。

---

## [1.7.12] - 2026-08-30

### 新增
- 关注列表改为独立窗口 `remindlist.html`（表头原生拖动，可拖到屏幕任意位置）。
- 任务栏挂件条优先尝试真正嵌入任务栏。

### 修复
- 区间天数中间格绿色提亮（连成更醒目的色带）。

---

## [1.7.11] - 2026-08-29

### 新增
- 任务栏挂件条 `dock.html`（24 小时制实时时钟 + 年月日）。

### 修复
- 托盘右键菜单无效（`const menu` 被重新赋值 → 抛错被静默吞掉）。
- 放大无效（`.max` 类只在浏览器 fallback 分支 toggle，Electron 路径没同步）。
- 特别关注限 15 字 / 10 条。

---

## [1.4.0] 及更早 - 2026-08 中旬

- v1.4.0：任务栏接管改为 Node 原生 FFI（koffi），消灭卡顿根因。
- v1.3.0：任务栏接管 Win10 兼容 + 稳健隐藏 + 性能优化。
- v1.2.0：稳定隐藏原生时钟 + 部件去模糊 + 每周起始文字。
- v1.1.0：任务栏时钟替换 + 白/夜主题。
- v1.0.0：初始发布。

---

> 更完整的开发过程、技术决策与踩坑复盘见 [`开发历程.md`](./开发历程.md)；权威功能/行为规格见 [`PROGRAM_SPEC.md`](./PROGRAM_SPEC.md)。
