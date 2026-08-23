# 简洁桌面日历 · 程序规格书（可复制级 / AI 可直接复刻）

> **用途**：本文件是为「让 AI 在零上下文情况下重建该程序」而写。任何 AI 拿到本文件，都能完整还原软件的功能、视觉、行为与打包方式。修改或升级时，直接把本文件 + 源码目录交给 AI 即可。
> **版本**：1.0.0　**作者**：YG　**协议**：MIT　**平台**：Windows

---

## 1. 软件定位（务必严格遵守，不要擅自加功能）

- **一句话**：极简 Windows 桌面日历，核心只做一件事——**看日历、看放假、看上班**。
- **产品描述（原文）**：受够了 Windows 原生的日历，也实在受不了市面上第三方日历软件，明明很简单的需求，硬塞一堆没必要的功能。自己写了这款极简日历，什么功能都没有，核心只做一件事：看日历，看放假、看上班，就够了。想要更多功能，看手机不就行了。
- **硬约束**：不加账号、不加云同步、不加待办/日程/天气/记事等任何额外功能。保持"打开就是一张日历"。
- **形态**：系统托盘常驻实时时钟 + 点击唤出的无边框半透明日历小窗（非传统窗口）。

---

## 2. 技术栈与运行环境

| 项 | 值 |
|---|---|
| 桌面壳 | Electron 31（`electron` devDependency） |
| 打包 | electron-builder 24.13.3，目标 `nsis`（Windows 安装包） |
| 前端 | 纯 HTML + CSS（`color-mix` 主题派生）+ 原生 JS，无框架、无打包器 |
| 农历 | 第三方库 `lunar.min.js`（lunar-javascript 的浏览器版，仅读取其接口，**不修改**） |
| 运行系统 | Windows 10/11（依赖系统托盘与窗口 API；macOS/Linux 不保证） |
| Node | 构建机装 Node 即可（代码本身用 CommonJS，Electron 主进程） |

**构建/运行命令**
```bash
npm install          # 装 electron + electron-builder（仅打包/运行桌面端需要）
npm run dev          # electron . 开发预览
npm run build        # electron-builder --win nsis → dist/ 下生成安装包
node build.js        # 把 lunar.min.js + app.js 注入 template.html，生成 calendar.html
node make-icon.js    # 生成 icon.ico（多尺寸）
```

---

## 3. 目录结构与文件职责

```
3.0/
├── package.json      # 版本/作者/NSIS 打包配置（见第 7 节）
├── template.html     # 界面模板：含全部 CSS（设计系统）+ DOM 骨架 + 两个注入占位符
├── app.js            # 渲染层逻辑（IIFE）：日历/农历/节假日/灯效/双窗口/主题
├── electron-main.js  # 主进程：系统托盘时钟(零依赖PNG) / 双窗口 / IPC / 开机自启
├── preload.js        # contextBridge 暴露 window.api（toggleExpand/requestSnap/setTooltip）
├── lunar.min.js      # 第三方农历库（window.Solar / window.Lunar），不修改
├── build.js          # 读 lunar + app，替换占位符，写 calendar.html
├── calendar.html     # 构建产物（lunar+app 已内联），可直接浏览器打开预览
├── make-icon.js      # 零依赖生成 icon.ico（蓝磁贴+白日历卡）
├── icon.ico          # 16/32/48/256 多尺寸，exe/安装包/快捷方式/控制面板共用
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
- 运行时主进程只加载 `calendar.html`（已自包含 lunar + app）。其余源文件用于开发与重建。
- `files`（package.json）只打包运行必需文件，**不含 node_modules**（Electron 运行时由 electron-builder 自动注入）。

---

## 4. 设计系统（"纸与光"视觉语言）

### 4.1 设计 Token（CSS `:root` 变量，template.html）
| Token | 值 | 用途 |
|---|---|---|
| `--paper` | `rgba(252,251,249,0.82)` | 宣纸感半透明底 |
| `--paper-edge` | `rgba(31,35,48,0.08)` | 卡片描边 |
| `--ink` | `#1f2430` | 墨色主文字（非纯黑） |
| `--ink-soft` | `#6b7280` | 次级文字 |
| `--ink-faint` | `#9aa1ad` | 最弱/跨月文字 |
| `--accent` | `#3b6fd4` | 雅蓝主色 |
| `--accent-soft` | `color-mix(in srgb, var(--accent) 13%, transparent)` | 今日/选中淡底 |
| `--accent-line` | `color-mix(in srgb, var(--accent) 52%, transparent)` | 今日/选中描边 |
| `--accent-ink` | `color-mix(in srgb, var(--accent) 78%, #1f2430)` | 今日/选中文字 |
| `--cinnabar` | `#d6453f` | 朱砂红（节假日/休） |
| `--cinnabar-soft` | `rgba(214,69,63,0.07)` | 节假日淡底 |
| `--cinnabar-line` | `rgba(214,69,63,0.42)` | 节假日描边 |
| `--weekend` | `#c0564f` | 周末主数字（柔和砖红） |
| `--workday` | `#3b6fd4` | 补班/班 蓝 |
| `--holiday-fg` | `#cf463f` | 节假日文字 |
| `--shadow-soft` | `0 18px 44px rgba(31,35,48,0.16), inset 0 1px 0 rgba(255,255,255,0.65)` | 单层柔和阴影+内高光 |

- **主题跟随系统**：仅把 `--accent` 覆盖为 Windows 强调色（BGR→RGB），其余全部由 `color-mix` 自动派生，整体联动。

### 4.2 排版
- 字体栈：`"Segoe UI Variable","Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif`
- 时钟 `40px/600`（放大态 `72px`）· 日期 `13px/700`（放大 `26px`）· 农历 `11px/400`（放大 `22px`）
- 表头 `9px/600` 字距 2px · 单元格主数字 `16px/700`（放大 `32px`）· 副数字 `9px/500`（放大 `19px`）

### 4.3 布局（竖长方形 widget，430×540）
1. `#infoBar`（78px）：左时钟 + 右(日期/农历)
2. `#dragBar`（42px，可拖拽 `-webkit-app-region:drag`）：左(年/月选择+箭头+今) / 右(周起始开关+主题+放大)
3. `#body > #calendar`：表头 + 6×7 网格；含 `#bgMonth`(月份水印) + `#litGlow`(灯效层)
- 圆角 16px（widget）/ 8px（单元格）· 网格 gap 3px

### 4.4 微交互
- 单元格 hover：轻微抬升 `translateY(-1px)` + 墨色细描边
- **灯效**：淡蓝径向光晕跟随鼠标，以所指单元格为中心覆盖「中心格+上下左右4格」，中心亮向外渐隐（`rgba(120,160,240,...)`）
- 今日/选中：雅蓝透明描边+极淡底（同效果）
- 周起始开关：真 toggle（轨道+滑块+一/日标签，平滑过渡）
- 月份切换：仅网格淡入，无缩放抖动

---

## 5. 核心行为清单（必须遵守）

| 行为 | 实现要点 |
|---|---|
| **R3 托盘实时时钟** | 主进程零依赖把 `HH:MM`+`MM-DD` 光栅化为 64×32 PNG（内置 5×7 点阵字体），`tray.setImage` 每秒刷新；悬停 tooltip 由渲染层推送「农历+星期」 |
| **R3 托盘点击唤出/隐藏** | 点击托盘 → 窗口隐藏则显示 mini，已显示则隐藏；用 `suppressBlur` 避免刚打开即被 blur 误关 |
| **默认隐藏** | `BrowserWindow` `show:false`，不自动弹窗，由托盘点击唤出 |
| **双窗口模式** | mini `430×540`（贴右下）↔ expanded `820×1020`（居中）；放大按钮经 IPC `toggle-expand` 切换；expanded 下 `#widget` 加 `.max` 填满并放大字号 |
| **R4 点击外部消失** | 窗口 `blur` 事件 `win.hide()`（suppressBlur 时跳过）；隐藏后 `mode` 复位为 mini |
| **R4 拖拽吸附** | 放大态拖动松手 → IPC `request-snap` → 距屏幕边 ≤24px 吸附 |
| **周起始切换** | `#wkSwitch` 点击切换 `startMon`；渲染表头与首格偏移随之变；开关需 `mousedown` `stopPropagation` 防止被拖拽条吞掉 |
| **主题切换** | `#themeBtn` 在 default/system 间切；system 时写入 `window.__ACCENT__`（主进程从 `systemPreferences.getAccentColor()` 读，BGR→RGB） |
| **开机自启** | `app.whenReady` 调 `app.setLoginItemSettings({openAtLogin:true})`（幂等） |
| **关闭=隐藏** | `win.on('close')` 非退出时 `preventDefault()+hide()`，常驻后台 |
| **右键菜单** | 托盘右键「退出」→ `app.isQuiting=true; app.quit()` |

> **尺寸常量（electron-main.js 顶部）**：`MINI_W=430 MINI_H=540 EXP_W=820 EXP_H=1020`。窗口 `frame:false transparent:true resizable:false alwaysOnTop:true skipTaskbar:true`。

---

## 6. 数据与规则（app.js）

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
- `other` 非本月（opacity 0.18；跨月节假日 `.holiday.other` opacity 0.55）
- `holiday` 朱砂底 + 描边 + 红色 `休` chip
- `workday`（仅当月）蓝色 `班` chip
- `weekend`（仅当月）数字砖红
- `today` / `selected` 雅蓝描边（同效果）
- 每月固定渲染 **42 格**（6 周×7），首格偏移 `lead = startMon ? (firstWd===0?6:firstWd-1) : firstWd`

---

## 7. 打包 / 安装包配置（package.json `build`）

```jsonc
"build": {
  "appId": "com.yg.simplecalendar",
  "productName": "简洁桌面日历",
  "executableName": "SimpleCalendar",     // exe 文件名（ASCII，无空格），显示名另用 productName
  "copyright": "Copyright © 2026 YG",
  "files": [ "app.js","template.html","lunar.min.js","build.js","preload.js",
             "electron-main.js","calendar.html","icon.ico","README.md","使用说明.html","LICENSE","package.json" ],
  "win": {
    "target": ["nsis"],
    "icon": "icon.ico",
    "legalCopyright": "Copyright © 2026 YG",   // 文件属性→版权
    "companyName": "YG",                        // 文件属性→公司
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

- **安装路径默认**：`C:\Users\<用户>\AppData\Local\Programs\简洁桌面日历`（per-user，无需管理员）。用户可浏览改到 `C:\Program Files\`（此时会按需提权）。
- **开始菜单**：自动建「简洁桌面日历」文件夹，含「启动软件」+「卸载软件」；控制面板"程序和功能"可见，卸载清理目录/快捷方式/注册表。
- **许可证页**：electron-builder 自动检测根目录 `LICENSE` 文件并显示"许可协议"页。
- **完成页**：`runAfterFinish` 给"立即运行"勾选；`installer.nsh` 通过 `!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\使用说明.html"` 增加"查看说明文档"勾选。
- **图标**：`icon.ico`（16/32/48/256）同时用于 exe、安装包、卸载程序、桌面/开始菜单快捷方式、控制面板列表。

### 7.1 icon.ico 生成（make-icon.js，零依赖）
- 用 `Canvas`（RGBA float 叠加）+ `roundRect`（四角可选圆角）+ `encodePNG`（RGBA + 每行 filter0 + `zlib.deflateSync`，CRC32 拼 IHDR/IDAT/IEND）。
- 画 4 尺寸 [16,32,48,256]：雅蓝圆角磁贴 → 白色圆角卡 → 朱砂红表头(仅上半圆角) → 4×3 网格点(首点朱砂红)。
- 打包为 ICO：ICONDIR(6B) + 每图 16B 目录项（尺寸≥256 记 0，bitCount=32）+ 各图 PNG 字节。**Windows 支持 ICO 内嵌 PNG**。

---

## 8. 版本信息与作者（集中维护点）
- 软件名：`简洁桌面日历`　显示名 `productName` / exe 名 `SimpleCalendar`
- 版本号：`1.0.0`（package.json `version`；同步体现在 exe 文件版本、安装包属性、控制面板）
- 作者：`YG`（`author` / `companyName` / `legalCopyright`）
- 版权：`Copyright © 2026 YG`
- 仓库/主页：`https://github.com/YG/simple-desktop-calendar`（GitHub 用，可改）
- 协议：MIT

---

## 9. 已知限制与维护点
1. **节假日为 2026 硬编码**：每年国务院安排出来后，更新 `app.js` 的 `HOLIDAYS_2026.H`（放假区间）与 `HOLIDAYS_2026.WK`（补班日）。后续可改为内置多年份或联网更新。
2. **仅 Windows**：依赖托盘与窗口 API。
3. **农历库为第三方**：只读接口，升级库时注意 `Solar/Lunar` API 兼容性。
4. 跨年临界点（如 12 月补班关联次年）按当年数据简单处理，不做跨年联调。

---

## 10. 常见修改指引（给 AI 的速查）
- **改主色**：改 `template.html` `--accent` 即可，其余 `color-mix` 自动派生；托盘时钟底色在 `electron-main.js` `makeClockIcon` 的 `bg`。
- **改窗口尺寸**：改 `electron-main.js` 顶部 `MINI_*` / `EXP_*` 常量，并同步 `template.html` `#widget` 的 `width/height` 与 `#widget.max` 字号。
- **改节日白名单**：改 `app.js` 的 `KEEP` / `ALIAS`；法定日改 `NATIONAL`。
- **改年份节假日**：改 `app.js` `HOLIDAYS_2026`（建议重命名为带年份对象并做选择逻辑）。
- **改作者/版本**：改 `package.json` 的 `author`/`version`/`copyright`/`companyName`/`productName`；`template.html` 的 `<title>`；`electron-main.js` `tray.setToolTip`。
- **改图标**：改 `make-icon.js` 配色/构图后 `node make-icon.js` 重新生成 `icon.ico`。
- **加安装完成页选项**：改 `installer.nsh` 的 `MUI_FINISHPAGE_*` 定义。
- **重建预览页**：改 `template.html`/`app.js` 后跑 `node build.js` 生成 `calendar.html`，可直接浏览器打开核对。

> 复刻校验清单：① `node build.js` 生成 calendar.html 且**不含** `/*__LUNAR_LIB__*/`/`/*__APP__*/` 占位符；② `node make-icon.js` 生成合法 icon.ico；③ `npm run build` 在 `dist/` 产出 `简洁桌面日历 Setup 1.0.0.exe`；④ 安装后桌面/开始菜单有快捷方式、控制面板可见、可卸载。
