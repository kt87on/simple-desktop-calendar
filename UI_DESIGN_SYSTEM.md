# 简洁桌面日历 · UI 设计系统 v2.0

> 设计语言：**「纸与光」** —— 东方暖纸质地 × 雅蓝墨色 × 朱砂点睛。
> 本文档是全部界面的视觉真值来源。实现位于 `_newstyle_*.css`（已注入各 HTML）。

---

## 0. 适用范围与硬约束

| 界面 | 文件 | 本轮改动 |
|---|---|---|
| 日历主体（mini + 放大） | `template.html` | 全量重设 |
| 悬浮插件 | `dock.html` | 全量重设 |
| 关注列表弹窗 | `remindlist.html` | 全量重设 |
| 提醒弹窗 | `reminder.html` | 全量重设 + **补齐黑夜模式** |
| 右键菜单 | `electron-main.js` | emoji → 运行时生成的单色 16px 图标 |
| 托盘图标 | `electron-main.js makeTrayIcon` | 与新图标语言对齐 |
| 桌面图标 | `icon.ico`（make-icon.js 重绘） | 4 尺寸（16/32/48/256） |

**禁止触碰**（用户明确要求）：窗口定位/拖拽/热区/IPC/菜单行为/任何 JS 业务逻辑。
唯一的 JS 新增：`reminder.html` 读取 `?theme=` 给 `<html>` 打 `data-theme` 标记（纯视觉）；`electron-main.js` 新增 `menuIcon()` 图标生成 + 菜单项 `icon` 字段（不改任何点击行为）。

**继承不可回退的约束**：
- `dock.html` 的 `padR = 0 / padB = 0`（贴任务栏修复，v1.7.22.4）
- 卡片固定像素布局（`applyDockSize`，Chromium 透明小窗首帧 bug 的解法）
- 今日蓝 `#1976D2`（用户确认的色值）

---

## 1. 三层 Token 架构

```
L1 基础层   色板 · 字阶 · 间距 · 圆角 · 阴影 · 动效 —— 只有这里允许出现字面量
L2 语义层   paper / ink / accent / cinnabar / focus / range —— 随主题切换
L3 组件层   只写 var(--xxx)，一个字面量都不许有
```

### 1.1 色板 · 中性（暖纸 / 墨）

| Token | 值 | 用途 |
|---|---|---|
| `--ink-900` | `#14181f` | 最深墨（黑夜模式底） |
| `--ink-800` | `#1f2430` | 主文字 |
| `--ink-700` | `#333a48` | 强调文字 |
| `--ink-600` | `#4b5563` | 次强调 |
| `--ink-500` | `#6b7280` | 次要文字 |
| `--ink-400` | `#9aa1ad` | 弱化文字 |
| `--ink-300` | `#c2c8d2` | 强描边 |
| `--ink-200` | `#e2e6ec` | 描边 |
| `--ink-100` | `#f0f2f5` | 微填充 |
| `--ink-50` | `#f7f8fa` | 浅底 |
| `--ink-25` | `#fcfbf9` | **纸白**（白日卡片底色基调） |

### 1.2 色板 · 四色族

| 族 | 主值 | 语义 |
|---|---|---|
| **雅蓝** `--blue-500` `#3b6fd4` | 选中 / 主按钮 / 控件激活 | `--blue-600 #1976d2` 专用于今日格 |
| **朱砂** `--red-500` `#d6453f` | 节假日 / 周末 / 危险操作 | 源自印泥朱砂，偏暖不刺眼 |
| **琥珀** `--amber-500` `#f59e0b` | 特别关注日 | 黄底 + 琥珀描边双层 |
| **青竹** `--green-500` `#22c55e` | 日期区间选择 | 与今日蓝形成"两段式"区分 |

每个族 9 档（50→900），组件只允许用语义变量，不允许直接引族内色值。

### 1.3 语义层 · 白日（Warm Paper）

```
--paper        rgba(252,251,249,.84)   卡片底（84% 不透明度，透出壁纸）
--paper-solid  #fcfbf9                 弹窗等需要实底处
--accent       #3b6fd4                 选中 / 激活
--accent-strong #1976d2                今日（用户指定）
--cinnabar     #d6453f                 节假日文字
--focus-amber  #f59e0b                 特别关注
--range        #22c55e                 区间
--ctl-bg       #ffffff                 按钮 / 下拉 / 输入框底
--scrim        rgba(31,35,48,.92)      toast / 浮层深底
```

### 1.4 语义层 · 黑夜（Deep Ink）

```
--paper        rgba(28,32,44,.88)      深墨蓝，非纯黑
文字           #e8ebf2 级别（不做纯白，降低刺眼感）
阴影           纯黑，alpha 约为白日 2 倍；内高光保留但极弱
```

原则：**黑夜不是反色**。所有色值在 L2 层整组替换，L3 组件零感知。

---

## 2. 排版

### 2.1 字体栈

```
"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI",
"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC",
"Hiragino Sans GB", system-ui, -apple-system, sans-serif
```

数字一律启用 `font-variant-numeric: tnum lnum ss01`（等宽数字），时钟/日期跳动时不抖动。

### 2.2 字阶（14 级）

| 级 | 值 | 用途 |
|---|---|---|
| `--fs-3xs` | 8px | 角标 chip / 农历副标 |
| `--fs-2xs` | 9px | 微标签 / 开关字 |
| `--fs-xs` | 10px | 辅助文字 |
| `--fs-sm` | 11px | 正文小 / 输入 |
| `--fs-md` | 13px | 按钮文字 / 弹窗正文 |
| `--fs-lg` | 14px | mini 单元格数字 |
| `--fs-xl` | 15px | 弹窗小标题 |
| `--fs-2xl` | 17px | 挂件时钟 |
| `--fs-3xl`~`--fs-5xl` | 18/20/24px | 放大模式星期/农历/日期 |
| `--fs-6xl` | 30px | mini 主时钟 |
| `--fs-7xl` | 42px | 放大模式单元格 |
| `--fs-8xl` | 76px | 放大模式主时钟 |

字重四档：400 / 500 / 600 / 700。

---

## 3. 几何

### 3.1 间距（4pt 网格）

`--s-1:4px · --s-2:8px · --s-3:12px · --s-4:16px · --s-5:20px · --s-6:24px · --s-8:32px · --s-10:40px`

### 3.2 圆角（5 级 + 胶囊）

| Token | 值 | 用途 |
|---|---|---|
| `--r-xs` | 4px | 角标 chip |
| `--r-sm` | 6px | 按钮 / 输入框 |
| `--r-md` | 10px | 单元格 / 弹层 |
| `--r-lg` | 14px | mini 卡片 |
| `--r-xl` | 24px | 放大模式卡片 |
| `--r-pill` | 999px | 胶囊（开关/标签） |

### 3.3 阴影（5 级 elevation）

```
--e-1  贴面     0 1px 2px + 1px 描边光环
--e-2  浮起     0 2px 8px
--e-3  卡片     0 10px 28px + 顶部 1px 内高光
--e-4  弹层     0 18px 44px（默认 --shadow-soft）
--e-5  模态     0 32px 80px
```

内高光 `inset 0 1px 0 rgba(255,255,255,.55~.70)` 是"纸的厚度"——黑夜模式保留但降到 `.06`。
悬浮插件阴影**必须对称 y=0**（`0 0 6px`），任何 y 偏移都会造成"没贴任务栏"的视觉断裂。

### 3.4 模糊

`--blur-card: 18px`（卡片背板）· `--blur-pop: 24px`（弹层背板）

---

## 4. 动效

| Token | 时长 | 用途 |
|---|---|---|
| `--dur-instant` | 80ms | 色彩/透明度反馈 |
| `--dur-fast` | 140ms | hover / 按压 |
| `--dur-normal` | 220ms | 弹层出入场 |
| `--dur-slow` | 340ms | 模式切换 / 卡片形变 |

缓动三件套：
- `--ease-out` `cubic-bezier(.22,.61,.36,1)` — 入场
- `--ease-in-out` `cubic-bezier(.4,0,.2,1)` — 状态切换
- `--ease-spring` `cubic-bezier(.34,1.46,.64,1)` — 带一点回弹的强调（仅按钮/toast）

---

## 5. 组件规范

### 5.1 日历单元格状态矩阵

| 状态 | 底 | 文字 | 描边 | 备注 |
|---|---|---|---|---|
| 默认 | 透明 | `--ink` | — | hover 出 `--cell-hover` |
| 今日 | `--accent-strong #1976d2` | `#fff` | `inset 0 0 0 1.5px #1565c0` | 唯一蓝底白字 |
| 选中 | `--accent` | `#fff` | — | 单击态 |
| 区间端点 | `--range` | `#fff` | — | |
| 区间中间 | `--range-softer` | `--range-ink` | — | |
| 节假日/周末 | — | `--holiday-fg` | — | 农历副标同步变红 |
| 调休上班 | — | `--workday` | — | 附"班"chip |
| 特别关注 | `--focus-soft` | `--focus-ink` | `--focus-line` | 左下角圆点 |
| 非本月 | `--ink-faint` 40% | — | — | 整体压暗 |

### 5.2 按钮

```
默认    --ctl-bg + --ctl-edge 1px + --r-sm
hover   --ctl-bg-hover 洗色，140ms
active  scale(.96)，80ms，--ease-out
主按钮  --accent 底白字，hover 提亮至 --blue-400
危险    --cinnabar 文字，hover 出 --red-50 底
```

### 5.3 右键菜单图标

运行时生成，16px，单色：
- 造型语言与托盘图标同源（圆角矩形 + 圆环 + 网格点）
- 64×64 SDF 绘制 → 4× 盒式降采样 → 16 级抗锯齿
- 颜色跟随**系统**深浅色（`nativeTheme.shouldUseDarkColors`），浅色系统 → `#2a2f3a`，深色 → `#e8ebf2`——菜单底色由系统绘制，图标必须跟系统走而不是跟软件主题走，否则会出现白底白字
- 全部缓存在 `_menuIconCache`，重复构建菜单零开销
- 图标生成失败返回 `null`，菜单仍然可用（降级为纯文字）

---

## 6. 图标资产

| 资产 | 生成方式 | 尺寸 |
|---|---|---|
| `icon.ico` | `make-icon.js`（纯 Node PNG 编码 + ICO 打包） | 16/32/48/256 |
| 托盘 PNG | `makeTrayIcon()`（RGBA 直绘，深浅两态） | 32 |
| 菜单 PNG | `menuIcon(name)`（SDF 掩码，13 种字形） | 16 |

造型语言统一为：**圆角矩形卡片 + 朱砂表头 + 网格点**。
`makeTrayIcon` 标注了「请勿删除」（v1.7.22.6 复核结论：托盘直接用它返回的 nativeImage，
删掉会导致 `new Tray(null)` 静默崩溃）。

---

## 7. 无障碍

- 正文对比度 ≥ 4.5:1（`--ink-800` on `--paper` ≈ 12.9:1）
- 弱化文字最低 `--ink-400`（≈ 3.4:1），仅用于装饰性副标
- 今日白字 on `#1976d2` ≈ 4.6:1，达标
- 黑夜模式文字 `#e8ebf2` on `#1c202c` ≈ 13.8:1
- 所有交互区 hover/active 双反馈（色变 + 形变），不依赖单一通道
