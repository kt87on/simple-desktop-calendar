# 更新日志（Changelog）

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 规范记录「简洁桌面日历」的所有正式版本变更。版本号遵循语义化版本（SemVer）。

---

## [3.2.0] - 2026-09-11

### 新增
- **「自选图片」升级为独立窗口**（用户要求「类似特别关注一样」）：新增渲染层 `skincustom.html` 与独立 `BrowserWindow`（`openSkinCustomWindow`）。窗内按界面（日历 / 浮窗 / 桌面插件 / 放大界面）设置：图片导入与取景、图片不透明度、文字明暗、UI 清晰度、界面透明度、「跟随主界面」开关。
- **皮肤设置主窗口精简为两个入口**：「原生皮肤」与「自选图片」。点「原生皮肤」**动画下拉**展开 6 行（`max-height` + `opacity` 过渡，尊重 `prefers-reduced-motion`）。
- **六套原生风格带真实观感的迷你预览**：每行左侧一枚 150×30 预览条，按该风格的**真实配色与材质**绘制 —— `tech` 赛博（近黑底 + 青/品红霓虹 + 网格 + 切角）、`glass` 毛玻璃（白洗 + 彩色光斑 + 斜向光泽带）、`neu` 新拟态（同底色双向挤出 + 内凹控件）、`warm` 温润（纤维斜纹 + 羊皮纸）、`minimal` 纯白极简、`default` 浅灰扁平。**风格名文字亦使用该皮肤的字色**（浅/深主题各一套，保证两种主题下都可读）。
- 新增 IPC action **`apply-native-style`**（主进程 `applyNativeStyleAll`）。

### 变更
- **点原生皮肤 = 四个界面全局统一**（用户报告的「浮窗没跟着变」根因修复）：过去点原生风格只写 `calendar`，被「手调即独立」规则置过 `follow: null` 的界面（典型场景：单独给浮窗设过图片）**不会跟随**，用户体感为「浮窗还是老样子」。现在 `apply-native-style` **单次原子写入**四个界面（`style` 统一、`bg='native'`、`image=null`，并把 `expanded/desktop/dock` 的 `follow` 写回 `'calendar'`）—— 一次存档、一次推送、无中间态闪烁。盘上图片文件**不删除**，之后仍可在「自选图片」里重新指定。
- **「自选图片」窗口删掉「背景来源」与「明暗」两项**（用户要求）：进入该窗口即等于选择自选图片，无需再确认背景来源；明暗由图片亮度自动判定。取景区因此改为**恒显示**（原按 `bg==='image'` 隐藏会形成「永远进不去导入」的死链）。
- **移除「跟随主界面时置灰」**：主进程的「手调即豁免跟随」本就会让任何一次写入自动转为独立，置灰挡掉的其实是**正确操作**，会让用户看到「点不动又不知道为什么」的死角。现保留「跟随主界面」开关本身，并把提示改为说明自动独立规则（并明确列出取景 / 文字 / 清晰度三项，**透明度为窗口级、不触发独立**）；仅保留「UI 清晰度自动档滑杆置灰」一处（与跟随无关）。
- **命名统一：「浮动插件」→「浮窗」**：覆盖 `settings.html` 分区与提示、皮肤窗口界面分段、`使用说明`（md/html）、`README.md`。历史 CHANGELOG 条目与 `.js` 源码注释按惯例**不改写**。

### 修复
- **「选择原生皮肤时浮窗没有跟着变」**：本轮用户直接报告。根因是真实数据里 `dock.follow === null`（用户曾给浮窗单独导入图片，触发「手调即独立」），而非随机缺陷。已按「点原生皮肤 = 四界面全局统一」修复，并新增 `apply-native-style` 端到端护栏用例。

### 测试
- 新增 `tests/qa-v320.js`。
- `verify_v1721.js` 中绑定旧 `skin.html` 结构的断言（4 界面分段、取景、文字明暗、透明度、跟随开关、清晰度、图片不透明度）与 `settings.html` 分区标题断言（「浮动插件区」→「浮窗区」）、`runtime-test_v1721.js` 的 `saveCrop` 断言、`tests/qa-v310.js` 的 `SKIN` 引用，全部按新结构改指向 `skincustom.html` 或反向改写。

---

## [3.1.0] - 2026-09-11

### 新增
- **关注列表新增「定时」独立列**：列序固定为 **日期 / 关注内容 / 定时 / 删除**（原先把时间拼在内容文本里）。有定时显示 `HH:MM`（补零），全天显示「全天」并做弱化处理。栅格由 `62px 1fr 24px` 改为 `62px 1fr 56px 24px`。
- **关注列表窗口新增直接录入区**：底部可折叠「＋ 新增关注」，填 年/月/日 + 时:分（留空即全天）+ 内容即可添加，**无需回到日历逐个点击**；提交走与主窗同一个 `add-reminder` IPC，成功后经 `broadcastReminders()` 同步下发，日历界面自动出现该关注。
- **单元格右键弹窗新增定时提示行**：位于「内容」输入框**下方**，随输入实时显示 `定时提醒：H时M分`，未填时显示「全天提醒」。
- **皮肤窗「自选图片」浮层**：图片导入、界面选择（日历/浮动插件/桌面插件/放大界面）、背景来源、明暗、UI 清晰度、文字深浅、低对比提示全部集中于此；点浮层外/✕ 关闭。

### 变更
- **皮肤窗主视图改为原生风格列表**：由原来的大段分区 UI 精简为 **6 行风格列表**（每行一种风格、圆角长方形、风格名居中），原生风格**固定不可调**；细调能力全部移入「自选图片」浮层，皮肤窗不再臃肿。
- **六种原生风格视觉重做**（用户反馈「太普通、和预览差得多」）：
  - `tech` 科技感 → **赛博朋克**：近黑蓝底 + 青 `#22d3ee` / 品红双霓虹光晕 + 网格 + 四角切角；浅色档改为**日间 HUD**（淡青渐变底 + 可见青色网格 + 深青文字 + 微发光），不再是一张灰白卡。
  - `glass` 玻璃拟态 → **磨砂玻璃 + 光泽**：自绘彩色光斑（半径放大、浓度下调）+ **一条边界可辨的斜向光泽带**（原来是从左上均匀衰减的整体提亮，看不出光带）。
  - `neu` 新拟态 → **真正的双向挤出**：外沿光暗差拉大，并**把凹/凸做进内嵌控件**（工具栏按钮、日期格常态微凸、选中态**内凹**），不再与 `default` 混同。
  - `warm` 温润：纤维斜纹 + 羊皮纸渐变；`minimal` 极简：直角 + 黑白强调；`default` 默认融合：中性三层景深。
- **原生风格默认「四处统一」**：**浮动插件（dock）首次纳入「跟随主界面」名单**（`resolveSurfaceConfig` 由 `expanded/desktop` 扩为含 `dock`）。设置原生风格后，**日历 / 放大窗口 / 桌面插件 / 浮动插件默认外观一致**；用户手动调整过某个界面则自动变为独立，不再跟随。

### 修复
- **提醒弹窗被置顶主窗遮挡**：复用分支原实现只 `focus()`，在「窗口已存在但被隐藏/被置顶主窗压住」时既不改层级也不显隐。现逐项重断言：`setAlwaysOnTop(true,'screen-saver')` → 不可见则 `show()` → `moveTop()` → `focus()`；`ready-to-show` 之后**再断言一次**置顶并抬到最前。
- **手动调整被静默忽略（既存缺陷）**：处于「跟随主界面」的界面被手动改字段时，`resolveSurfaceConfig` 仍返回日历配置，用户这次设置被静默丢弃。现改为 **copy-on-write 物化**：先以日历当前配置物化本面 6 项快照（`image` 深拷贝）并把 `follow` 置 `null`，再落值。**「点选导入图片」也已改走同一写入口**，与拖拽路径一致。
- **升级后浮动插件自定义配置被静默忽略**：v3.0.0 的数据里 `dock` **没有** `follow` 字段，本轮把 dock 纳入跟随名单时若一律默认「跟随日历」，会让**在 v3.0.0 里给浮动插件单独设过风格/图片的用户**升级后配置**数据还在却不生效**。现按路径分别判定：
  - v3.0.0 → v3.1.0（`__v===3`，`normalizeSurfaceV3`）：按该面是否 **pristine**（`style/bg/image/text/clarity/tone` 六项全为出厂默认）决定——pristine → 跟随，否则保留独立。
  - v2 → v3.1.0（`migrateSkinV2toV3`）：按 **`oldType`** 决定——仅 `type==='image'` 保留独立（磁盘上有独立图片文件），其余（`light/dark/system/color`）默认跟随。依据：v2 的 `migrateSkin()` 把全局 `baseType` 复制给全部四个面，故 `dock.type` 无法区分「全局复制」与「单独自定」。
  - 两条路径口径**刻意不同**，代码与测试均注明「勿统一」。
- **深色档「上下月日期」几乎不可见**：`.cell.other { opacity: 0.40 }` 与 `--ink-faint` 叠加，而 `tech`/`glass` 深色档的 `--ink-faint` **本身带 alpha**（`.42`/`.52`），乘积后有效 alpha ≈ 17% → 深底上等于没画。现为深色档改用较轻的额外衰减（浅色档不变），并同步上调 `.cell.other.holiday` 与 `.cell.other.range/.range-between` 两处特例，避免产生新的不一致。

### 测试
- 新增 `tests/qa-v310.js`（v3.1.0 新行为对抗性用例），并把 `qa-v300.js` 中「dock 不可跟随」的过期表述修正为覆盖新语义。
- `npm run check` / `prebuild` 闸门链已接入 `tests/qa-v310.js`（此前新增测试不会被构建闸门执行）。

---

## [3.0.0] - 2026-09-11

### 变更（破坏性：皮肤数据结构 v2 → v3）
- **皮肤模型拆为正交双维度 + 独立明暗轴**：旧的单一 `type`（light/dark/system/color/image）拆成 **`style`（风格材质）`{default,minimal,glass,neu,tech,warm}`** × **`bg`（背景来源）`{native,image}`**，并新增 **`tone`（明暗轴）`{auto,light,dark,system}`**。每面结构变为 `{style,bg,image,text,clarity,tone}`（`expanded/desktop` 另带 `follow`），`settings.json` 的 `skin.__v` 升级为 `3`。
- **文字轴与整窗明暗解耦**：`text`（`auto|light|dark`）今后**只**控制文字深浅，整窗 `data-theme` 由 `tone` 推导，彻底修复 v2 时代「一调深浅字、整窗跟着变黑/白」的根因（文字轴不再退化）。
- **`color` 类型删除**：纯色皮肤从用户可选集移除（自定义色值不再保留）；`bg=image` 但无图时仍是内部 `color` 兜底态（绝不白屏）。

### 新增
- **风格自带原生明暗（`styleNativeTheme`）**：`tech` → 深色，其余风格 → 浅色；`tone='auto'` 时按风格取明暗。
- **明暗优先级链（`surfaceTheme`）**：① `bg=image` 且有图 → 按照片亮暗（`image.dark`，压过 `tone`）→ ② `tone='light'` → ③ `tone='dark'` → ④ `tone='system'`（跟随系统深浅）→ ⑤ `tone='auto'`（风格自带）。
- **低对比组合标记（`warn`）**：浅底配浅字 / 深底配深字时，下发 `warn=true`（皮肤窗提示），渲染层据此把清晰度下限抬到 35（`effectiveClarity`），保证可读。
- **皮肤窗新增明暗段（`tone`）× 6 风格选择器**：`skin.html` 由 v2 的「5 类型」升级为「4 界面分段 + 6 风格 + 明暗段」。
- **`cleanupStaleInstances` 残留清理加固（dev 隔离）**：dev 形态（`!app.isPackaged`）**直接短路**、不再做生产清理；进程名改用 `path.basename(process.execPath)` 不再硬编码；新增安全网——若「自己」不在候选集则记日志后放弃，绝不 `taskkill`（杜绝 dev 误杀真实 `SimpleCalendar.exe` 实例）。

### 迁移
- **v2 → v3 一次性迁移（`migrateSkinV2toV3`）**：`light`→`minimal`/tone:light、`dark`→`minimal`/tone:dark、`system`→`minimal`/tone:system、`color`→`default`/tone:auto（丢色值）、`image`→`default`/tone:auto + `bg:image`（图片与 `text`/`clarity`/`follow` 原样保留），写 `__v=3`；已是 v3 的数据走 `normalizeSkinV3` 补齐兜底。旧键（`type`/`color`/`skinMode`/`nativeSkin`/`skinColor` 等）迁移后停写。

---

## [2.4.4] - 2026-09-07

### 新增
- **可读性三层结构（自选纯色/图片皮肤）**：单值 `clarity`（`skin.surfaces[].clarity`，`'auto'`|0~100）联动三层——① 文字柔和光晕（`--ink-glow`）+ 兜底极细描边（`--stroke-color`，随 clarity 增大而**变淡**）；② 局部背景保护遮罩（顶部信息栏 `--protect-top` 渐变 / 日历网格 `#calendar::before` `--protect-mid` / 底部工具栏 `--protect-bot`）；③ 状态元素轻微保护晕环（`--protect-state`，今日/节假日/选中/区间/提醒外环），保证图片背景上边界清晰。原生皮肤不介入。
- **「UI 清晰度」滑杆（skin.html）**：仅在纯色/图片界面显示（与「文字明暗」同步显隐）；默认「自动」（按背景复杂度推导 20~85），拖动滑杆实时生效并切手动，`auto` 档下滑杆置灰但拖动即可切手动；值持久化到 `settings.json` 的 `skin.surfaces[x].clarity`，重启复现。
- **自动明暗：分区采样 + 迟滞**：图片导入改用上/中/下三区（权重 0.25/0.55/0.20）合成亮度 + `decideDark` 迟滞（±0.06 防抖），临界图反复重导入不再抖动；样张逐像素相对亮度标准差归一（`std/0.30`）得 `complexity`(0~1)，缓存于 `skin.surfaces[].image.complexity`。

### 修复
- **手机竖拍 JPEG 被上下压扁（EXIF 方向）**：`importSkinImage` 新增纯本地零依赖的 JPEG EXIF 解析（`readJpegOrientation`：SOI/APP1 段扫描 + `parseTiffOrientation`：II/MM 字节序 + tag `0x0112`），`Orientation ∈ {5,6,7,8}`（含 90°/270° 旋转）时交换记录宽高，使记录尺寸与 Chromium 渲染尺寸一致，取景基准不再横竖倒置。
- **图片尺寸兜底**：渲染层新增 `layoutSkin`/`dockLayoutSkin` 纯函数 + `realImageSize`（`HTMLImageElement.naturalWidth/naturalHeight`，Chromium 已应用 EXIF）运行时纠偏，命中缓存即用、不一致才重排一次；覆盖 WebP EXIF / EXIF 解析失败 / 老数据（bug 前导入）场景，重启后首帧自动纠正。

### 变更
- **clarity=0 保护层归零**：纯色 auto 档 `clarity=0` → `--protect-*` 与 `--ink-glow` 全部置 `transparent`（不引入多余灰罩），仅保留 `--stroke-color` 主题兜底描边；image auto 档已被夹进 [20,85]（p≥0.2）自带基础保护，故不再需要 base 偏移。
- **文字描边由重影改为真描边 + 光晕**：v2.4.3 的 `--shadow-extra` 柔和阴影升级为 `--ink-glow` 光晕；`app.js`/`dock.html` 的 `applyTextStroke`/`clearTextStroke`（`dockSetStroke`/`dockClearStroke`）重构为随 clarity 联动的 `applyClarity`/`clearReadability`（`dockApplyClarity`/`dockClearReadability`）。

---

## [2.4.0] - 2026-09-07

### 新增
- **皮肤系统形态重构（per-surface 皮肤树）**：主进程是唯一真相，持久化 `skin.surfaces{calendar,expanded,desktop,dock}`（每界面独立 type∈light/dark/system/color/image + color/image + text∈auto/light/dark），`expanded/desktop` 支持 `follow='calendar'`（取消跟随 = copy-on-write 快照）、`dock` 独立；透明度收敛为 `skin.opacity{calendar,desktop,dock}`。旧字段（theme/skinMode/nativeSkin/skinColor/跟随/透明度）经 `skin.__v===2` 一次性迁移（`migrateSkin`），迁移后 `saveSettings` 只写 `skin`。
- **独立皮肤设置窗口（skin.html）**：设置页只留「皮肤设置」入口；皮肤窗 4 界面分段（日历/放大/桌面/浮动）+ 5 类型（浅/深/跟随系统/纯色/图片）+ 色盘 + 文字明暗 + 透明度 + 跟随开关。
- **图片皮肤（完整实现）**：拖入/点选导入 png/jpg/jpeg/gif/webp；原子复制到 `userData/skins/` 仅存文件名；`skin://` 特权协议（`registerSchemesAsPrivileged` + `protocol.handle`）加载；亮度采样（`nativeImage.resize(64).toBitmap()` 平均亮度）自动明暗文字；GIF 动画播放（Chromium 原生，渲染层 `background-image` 保持动图）。
- **取景数学（crop + zoom）**：归一化 `crop{x,y,w,h}` + `zoom`(1~5) ↔ CSS background-size/position（全图 cover 基准），权威参数「取景中心 + zoom」，`crop.w/h` 为派生冗余；重启后任意分辨率复现一致。
- **图片皮肤文字可读性 + 图片不透明度（v2.4.3）**：自选纯色/图片皮肤下给文字加 `-webkit-text-stroke` 居中真描边（替代 text-shadow 4 方向重影克隆）+ 单一柔和阴影，描边/阴影色随文字明暗切换（dark→深描边、light→浅描边），原生皮肤不描边；新增「图片不透明度」滑块（20%~100%，默认 100%），持久化 `skin.surfaces[].image.opacity`，渲染层直接写元素 `style.opacity`。
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
- **自选皮肤功能栏按钮更低调（v2.4.3）**：功能栏按钮（年/月下拉、翻月箭头、主题/放大）玻璃化，底色 0.16→0.10、描边 0.22→0.16（对齐 v4 预览 `.fn-btn`），hover 提亮；「今」按钮保持主色实底突出主操作。

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
