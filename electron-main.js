'use strict';

const { app, BrowserWindow, Tray, screen, nativeImage, nativeTheme, ipcMain, Menu, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const zlib = require('zlib');
const { spawn } = require('child_process');
const holidays = require('./holidays');
const holidayStore = require('./holiday-store');

/* v2.1.0：先把用户数据目录注入 holiday-store，之后所有读写都落在 userData/holidays.json。
 * holiday-store 顶层不 require('electron')（纯 Node 可加载），这里显式注入最稳妥。 */
try { holidayStore.configure({ userDataDir: app.getPath('userData') }); } catch (e) {}

// 农历库（UMD 格式，主进程可直接 require；加载失败则 tooltip 退化显示公历+星期）
let lunarLib = null;
try { lunarLib = require('./lunar.min.js'); } catch (e) { lunarLib = null; }

/* ===== v1.7.11 诊断日志 =====
 * 打包成 exe 后 process.stderr 不可见，托盘/窗口一旦在用户机器上静默失败就完全无法定位。
 * 这里把关键步骤与异常同时写一份到 userData/calendar.log，用户可直接把文件发回来排查。 */
function logPath() {
  try { return path.join(app.getPath('userData'), 'calendar.log'); } catch (e) { return null; }
}
function log(msg) {
  try {
    const f = logPath();
    if (!f) return;
    // 只保留最近 ~200KB，避免长期运行无限增长
    try {
      const st = fs.statSync(f);
      if (st.size > 200 * 1024) fs.writeFileSync(f, '', 'utf8');
    } catch (e) {}
    fs.appendFileSync(f, '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf8');
  } catch (e) {}
}

/* v2.4.0 第二轮：皮肤图片专用特权协议 skin://。
 * registerSchemesAsPrivileged 必须在 app ready **之前**调用，否则渲染层加载 userData/skins 下
 * 的图片会被同源策略 404。standard+secure+stream 让它可被 background-image / fetch 正常加载。 */
try {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'skin', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ]);
} catch (e) {
  try { process.stderr.write('[calendar] registerSchemesAsPrivileged failed: ' + (e && e.message || e) + '\n'); } catch (_) {}
}

/* ===== v1.7.11 用户设置持久化（主题 / 置顶 / 自启 / 任务栏挂件条） =====
 * 之前这些开关每次重启都会回到默认，用户改了主题下次开机又变回去。 */
function settingsFile() {
  try { return path.join(app.getPath('userData'), 'settings.json'); } catch (e) { return null; }
}
function loadSettings() {
  try {
    const f = settingsFile();
    if (!f) return;
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (o && typeof o === 'object') {
      /* v2.4.0 第二轮：皮肤 per-surface 结构 + 一次性迁移。
       * 已迁移（skin.__v===2）→ normalizeSkin 直接读新结构；否则 migrateSkin 从旧字段一次性迁移。
       * 迁移后 saveSettings 只写 skin，不再写 theme/skinMode/nativeSkin/skinColor 等旧键。 */
      if (o.skin && o.skin.__v === 2 && o.skin.surfaces) {
        skin = normalizeSkin(o.skin);
      } else {
        skin = migrateSkin(o);
      }
      pinned = o.pinned !== false;
      autoLaunch = o.autoLaunch !== false;
      dockOn = o.dockOn !== false;
      // v1.7.21 需求2：显示形态（桌面插件 / 桌面图标），持久化
      dockMode = (o.dockMode === 'icon') ? 'icon' : 'dock';
      dockPinned = o.dockPinned !== false;
      // v1.7.22 需求3：Windows 版本标记（启动时检测后写回；读旧值仅作兜底，随后会被真实检测覆盖）
      isWin11 = o.isWin11 === true;
      // v1.7.21 需求2/3：插件上次位置，切回插件模式时恢复（并在应用时夹回工作区）。
      /* v1.7.22.3 修复（"卡在半空"回归第一道防线）：校验 dockBounds 尺寸是否落在
       * 合理范围 [DOCK_W±4] × [36, 60] —— 旧版曾把窗口 bounds 错写成 350×178（疑似
       * 嵌入循环里的主窗/嵌入子窗大小），启动时直接被 setBounds 进去就会撑大窗口、压缩
       * 可拖动范围。这里丢弃异常尺寸 → positionDock() 走默认落点（工作区右下角贴任务栏）。 */
      if (o.dockBounds && typeof o.dockBounds.x === 'number' && typeof o.dockBounds.y === 'number') {
        const bw = o.dockBounds.width || DOCK_W;
        const bh = o.dockBounds.height || DOCK_H;
        const wOk = Math.abs(bw - DOCK_W) <= 4;
        const hOk = bh >= 36 && bh <= 60;
        if (wOk && hOk) {
          dockBounds = { x: o.dockBounds.x, y: o.dockBounds.y, width: bw, height: bh };
        } else {
          try { log('loadSettings: ignore invalid dockBounds size ' + bw + 'x' + bh + ' (expect ~' + DOCK_W + 'x' + DOCK_H + ')'); } catch (_) {}
          dockBounds = null;
        }
      }
      // v1.7.12：关注列表窗口上次位置
      if (o.remindlistBounds && typeof o.remindlistBounds.x === 'number') {
        lastRemindlistBounds = o.remindlistBounds;
      }
      // v2.4.0 A3：按显示器 ID 记忆插件位置（多屏各自记住，换机/ID 变化回落默认落点）
      if (o.dockBoundsByDisplay && typeof o.dockBoundsByDisplay === 'object') {
        dockBoundsByDisplay = o.dockBoundsByDisplay;
      }
      if (typeof o.dockDisplayId === 'number') dockDisplayId = o.dockDisplayId;
      else if (typeof o.dockDisplayId === 'string') dockDisplayId = Number(o.dockDisplayId) || null;
      // v2.2.0 需求4/5：桌面插件开关/锁定/位置 + 三窗口透明度
      desktopOn = o.desktopOn === true;
      desktopLocked = o.desktopLocked === true;
      if (o.desktopBounds && typeof o.desktopBounds.x === 'number') desktopBounds = o.desktopBounds;
      /* v2.1.0 节假日年度更新节流：
       *   holidayLastCheck     上次真正做过检查的 ISO 时间（7 天内不自动弹窗骚扰）
       *   holidayDismissedYear 用户点过「以后再说」的年份（该年不再自动提示） */
      holidayLastCheck = (typeof o.holidayLastCheck === 'string') ? o.holidayLastCheck : '';
      holidayDismissedYear = (typeof o.holidayDismissedYear === 'number') ? o.holidayDismissedYear : 0;
      // v2.1.0 P2-4：连续失败次数（默认 0，失败累计、成功清零）
      holidayFailCount = (typeof o.holidayFailCount === 'number' && isFinite(o.holidayFailCount) && o.holidayFailCount >= 0)
        ? Math.floor(o.holidayFailCount) : 0;
    }
  } catch (e) { /* 首次启动无文件，用默认值 */ }
}
function saveSettings() {
  try {
    const f = settingsFile();
    if (!f) return;
    fs.writeFileSync(f, JSON.stringify({
      skin: skin,                                     // v2.4.0 第二轮：皮肤唯一真相（迁移后停写 theme/skinMode 等旧键）
      pinned: pinned, autoLaunch: autoLaunch, dockOn: dockOn,
      dockMode: dockMode,                             // v1.7.21 需求2：桌面插件 / 桌面图标
      dockPinned: dockPinned,                         // v1.7.21：插件置顶开关
      dockBounds: dockBounds,                         // v1.7.21 需求3：插件上次落点
      dockBoundsByDisplay: dockBoundsByDisplay,       // v2.4.0 A3：按显示器记忆
      dockDisplayId: dockDisplayId,                   // v2.4.0 A3：上次所在显示器
      isWin11: isWin11,                               // v1.7.22 需求3：Windows 版本标记
      remindlistBounds: lastRemindlistBounds,         // v1.7.12：关注列表窗口位置
      // v2.1.0 节假日年度更新节流
      holidayLastCheck: holidayLastCheck,
      holidayDismissedYear: holidayDismissedYear,
      holidayFailCount: holidayFailCount,
      // v2.2.0 需求4/5：桌面插件
      desktopOn: desktopOn,
      desktopLocked: desktopLocked,
      desktopBounds: desktopBounds
    }, null, 2), 'utf8');
  } catch (e) {}
}

// 透明度取值夹在 [0.3, 1.0]，非法值回落到默认 def
function clampOpacity(v, def) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.max(0.3, Math.min(1, n));
}

/* v2.4.0 皮肤色值校验：合法 "#RRGGBB" 原样返回（统一大写），非法返回 null */
function validHex(v) {
  if (typeof v !== 'string') return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
  return m ? ('#' + m[1].toUpperCase()) : null;
}

/* =====================================================================
 * v2.4.0 第二轮 皮肤中枢（主进程是唯一真相）
 * ---------------------------------------------------------------------
 * - skin.surfaces{calendar,expanded,desktop,dock}：per-surface 配置树。
 * - resolveSurfaceConfig(surface)：expanded/desktop 跟随日历 → 返回 calendar 配置。
 * - surfaceTheme(surface)：per-surface 生效明暗（light/dark/system/color/image）。
 * - surfaceBg(surface)：背景层类型（native/color/image）。
 * - baseTheme()：非表面窗口 + 托盘跟随「日历表面」生效明暗。
 * - resolvedSurfaceState(surface)：下发给渲染层的 ResolvedSurfaceState。
 * ===================================================================== */
function resolveSurfaceConfig(surface) {
  var c = skin.surfaces[surface];
  if (!c) c = skin.surfaces.calendar;
  if ((surface === 'expanded' || surface === 'desktop') && c.follow === 'calendar') {
    return skin.surfaces.calendar;
  }
  return c;
}

function surfaceTheme(surface) {
  var c = resolveSurfaceConfig(surface);
  if (c.type === 'light') return 'light';
  if (c.type === 'dark') return 'dark';
  if (c.type === 'system') {
    try { return (nativeTheme && nativeTheme.shouldUseDarkColors) ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }
  if (c.text === 'light') return 'light';
  if (c.text === 'dark') return 'dark';
  var dark = false;
  if (c.type === 'color') dark = isDarkColor(c.color);
  else if (c.type === 'image') dark = !!(c.image && c.image.dark);
  return dark ? 'dark' : 'light';
}

/* image 类型但尚未导入图片时的兜底纯色（绝不透明）。
 * text=light/dark 直接取对应底色；auto 跟随该表面当前生效明暗（image 缺失时 surfaceTheme 已回退浅色）。 */
function solidFallbackFor(c, surface) {
  var theme;
  if (c.text === 'light') theme = 'light';
  else if (c.text === 'dark') theme = 'dark';
  else theme = surfaceTheme(surface);
  return (theme === 'dark') ? '#1C202C' : '#FCFBF9';
}

function surfaceBg(surface) {
  var c = resolveSurfaceConfig(surface);
  if (c.type === 'color') return { kind: 'color', color: c.color };
  if (c.type === 'image') {
    if (c.image && c.image.file) return { kind: 'image', image: c.image };
    return { kind: 'color', color: solidFallbackFor(c, surface) };
  }
  return { kind: 'native' };
}

function baseTheme() {
  return surfaceTheme('calendar');
}

/* v2.4.4：UI 清晰度生效值。手动值直接用；'auto' → image 类型按 complexity 推导
 * （clamp 20~85，保证总有基础保护），非 image（原生/纯色/无图兜底）→ 0（不引入多余灰罩）。 */
function clarityForConfig(c) {
  if (!c) return 0;
  if (typeof c.clarity === 'number' && isFinite(c.clarity)) {
    return Math.max(0, Math.min(100, Math.round(c.clarity)));
  }
  if (c.type === 'image') {
    var cx = (c.image && typeof c.image.complexity === 'number' && isFinite(c.image.complexity)) ? c.image.complexity : 0;
    return Math.max(20, Math.min(85, Math.round(cx * 100)));
  }
  return 0;
}

function resolvedSurfaceState(surface) {
  var c = resolveSurfaceConfig(surface);
  var bg = surfaceBg(surface);
  return {
    type: c.type,
    theme: surfaceTheme(surface),
    bg: bg.kind,
    color: (bg.kind === 'color') ? bg.color : null,
    image: (bg.kind === 'image') ? bg.image : null,
    clarity: clarityForConfig(c)
  };
}

function recomputeTheme() {
  themeMode = baseTheme();
  return themeMode;
}

function isDarkColor(hex) {
  try {
    const c = validHex(hex);
    if (!c) return false;
    const r = parseInt(c.slice(1, 3), 16) / 255;
    const g = parseInt(c.slice(3, 5), 16) / 255;
    const b = parseInt(c.slice(5, 7), 16) / 255;
    function chan(x) {
      x = (x <= 0.03928) ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      return x;
    }
    const lum = 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
    return lum < 0.5;
  } catch (e) { return false; }
}

/* ---- 图片/皮肤归一化辅助（sanitize 防路径穿越 / 范围夹取） ---- */
function sanitizeBasename(name) {
  if (typeof name !== 'string') return '';
  var b = name.replace(/\\/g, '/').split('/').pop() || '';
  return b.replace(/[^A-Za-z0-9._-]/g, '_');
}
/* skin:// URL → userData/skins 下的安全 basename。
 * standard 协议会把 skin://file 归一化为 skin://file/（尾斜杠），且可能带 query/fragment，
 * 必须先剥尾斜杠再取末段，否则 sanitizeBasename('file/') 会得到空串 → 404 → 图片不显示。 */
function skinUrlToName(url) {
  try {
    var rest = (url || '').replace(/^skin:\/\//i, '');
    rest = rest.split('?')[0].split('#')[0];
    rest = rest.replace(/\\/g, '/').replace(/\/+$/, '');
    var name = rest.split('/').pop() || '';
    name = decodeURIComponent(name);
    return sanitizeBasename(name);
  } catch (e) { return ''; }
}
function clamp01(v) {
  var n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function clampZoom(v) {
  var n = Number(v);
  if (!isFinite(n)) return 1;
  return Math.max(1, Math.min(5, n));
}
/* v2.4.3：图片不透明度夹在 [0.2, 1.0]，非法/缺省回落到 1.0（完全不透明）。
 * null 也按缺省处理（Number(null)===0 会误夹到 0.2，与"默认 1.0"语义不符）。 */
function clampImageOpacity(v) {
  if (v === undefined || v === null) return 1;
  var n = Number(v);
  if (!isFinite(n)) return 1;
  return Math.max(0.2, Math.min(1, n));
}
/* v2.4.4：UI 清晰度归一化 —— 'auto' | 0~100 整数；缺省/非法 → 'auto' */
function normalizeClarity(v) {
  if (v === undefined || v === null || v === 'auto') return 'auto';
  var n = Number(v);
  if (!isFinite(n)) return 'auto';
  return Math.max(0, Math.min(100, Math.round(n)));
}
function normalizeImageSpec(img) {
  if (!img || typeof img !== 'object') return null;
  var file = sanitizeBasename(img.file);
  if (!file) return null;
  var crop = { x: 0, y: 0, w: 1, h: 1 };
  if (img.crop && typeof img.crop === 'object') {
    crop.x = clamp01(img.crop.x);
    crop.y = clamp01(img.crop.y);
    crop.w = clamp01(img.crop.w);
    crop.h = clamp01(img.crop.h);
  }
  return {
    file: file,
    snapshot: img.snapshot ? sanitizeBasename(img.snapshot) : null,
    w: (typeof img.w === 'number' && img.w > 0) ? Math.round(img.w) : 0,
    h: (typeof img.h === 'number' && img.h > 0) ? Math.round(img.h) : 0,
    crop: crop,
    zoom: clampZoom(img.zoom),
    opacity: clampImageOpacity(img.opacity),
    dark: !!img.dark,
    complexity: (typeof img.complexity === 'number' && isFinite(img.complexity)) ? clamp01(img.complexity) : 0
  };
}
function normalizeSkin(raw) {
  var out = { __v: 2, surfaces: {}, opacity: { calendar: 1, desktop: 1, dock: 1 } };
  var names = ['calendar', 'expanded', 'desktop', 'dock'];
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    var s = (raw && raw.surfaces && raw.surfaces[n]) || {};
    var c = {
      type: (s.type === 'dark' || s.type === 'system' || s.type === 'color' || s.type === 'image') ? s.type : 'light',
      color: (s.type === 'color') ? validHex(s.color) : null,
      image: (s.type === 'image') ? normalizeImageSpec(s.image) : null,
      text: (s.text === 'light' || s.text === 'dark') ? s.text : 'auto',
      clarity: normalizeClarity(s.clarity)
    };
    if (n === 'expanded' || n === 'desktop') {
      c.follow = (s.follow === 'calendar') ? 'calendar' : null;
    }
    out.surfaces[n] = c;
  }
  if (raw && raw.opacity && typeof raw.opacity === 'object') {
    out.opacity.calendar = clampOpacity(raw.opacity.calendar, 1);
    out.opacity.desktop = clampOpacity(raw.opacity.desktop, 1);
    out.opacity.dock = clampOpacity(raw.opacity.dock, 1);
  }
  return out;
}
/* v2.4.0 第二轮：第一批旧字段 → per-surface 一次性迁移（严格对齐 PRD §5.4）。 */
function migrateSkin(o) {
  o = o || {};
  var baseType = 'light';
  if (o.nativeSkin === 'dark' || o.nativeSkin === 'light' || o.nativeSkin === 'system') baseType = o.nativeSkin;
  else if (o.theme === 'dark') baseType = 'dark';

  var sc = (o.skinColor && typeof o.skinColor === 'object') ? o.skinColor : {};
  var calColor = validHex(sc.calendar);
  var deskColor = validHex(sc.desktop);
  var dockColor = validHex(sc.dock);

  var calType = (o.skinMode === 'custom' && calColor) ? 'color' : baseType;

  var raw = {
    __v: 2,
    surfaces: {
      calendar: { type: calType, color: (calType === 'color') ? calColor : null, image: null, text: 'auto' },
      expanded: { follow: 'calendar', type: baseType, color: null, image: null, text: 'auto' },
      desktop: { follow: 'calendar', type: baseType, color: null, image: null, text: 'auto' },
      dock: { type: baseType, color: null, image: null, text: 'auto' }
    },
    opacity: {
      calendar: clampOpacity(o.mainOpacity, 1),
      desktop: clampOpacity(o.desktopOpacity, 1),
      dock: clampOpacity(o.dockOpacity, 1)
    }
  };
  if (deskColor && o.desktopFollowCalendar === false) {
    raw.surfaces.desktop = { follow: null, type: 'color', color: deskColor, image: null, text: 'auto' };
  }
  if (dockColor) {
    raw.surfaces.dock = { type: 'color', color: dockColor, image: null, text: 'auto' };
  }
  return normalizeSkin(raw);
}

/* 皮肤状态下发 + 窗口背景。v2.4.2：窗口背景**始终透明**（#00000000）。
 * 自选纯色/图片的圆角 + 阴影由渲染层 #widget/#card 绘制 —— 若把窗口 setBackgroundColor 成
 * 不透明色，透明窗口会退化成"方形色块"：圆角透明区被填满、投影被盖住，出现
 * "底子 + 色块"两层堆叠与"方方正正"感，且 hover 换底色会造成"闪黑"。 */
function bgColorFor(surface) {
  return '#00000000';
}
function pushSkinToRenderer() {
  if (win && win.webContents && !win.webContents.isDestroyed()) {
    try { win.webContents.send('skin-state', { calendar: resolvedSurfaceState('calendar'), expanded: resolvedSurfaceState('expanded') }); } catch (e) {}
    try { win.setBackgroundColor(bgColorFor('calendar')); } catch (e) {}
  }
}
function pushSkinToDesktop() {
  if (desktopWin && desktopWin.webContents && !desktopWin.webContents.isDestroyed()) {
    try { desktopWin.webContents.send('skin-state', { desktop: resolvedSurfaceState('desktop') }); } catch (e) {}
    try { desktopWin.setBackgroundColor(bgColorFor('desktop')); } catch (e) {}
  }
}
function pushSkinToDock() {
  if (dockWin && dockWin.webContents && !dockWin.webContents.isDestroyed()) {
    try { dockWin.webContents.send('skin-state', { dock: resolvedSurfaceState('dock') }); } catch (e) {}
    try { dockWin.setBackgroundColor(bgColorFor('dock')); } catch (e) {}
  }
}
function pushSkinToAll() {
  pushSkinToRenderer();
  pushSkinToDesktop();
  pushSkinToDock();
}

/* 皮肤窗口回显数据（完整 skin + resolved + 取景框比例表） */
function skinConfigState() {
  var resolved = {};
  var names = ['calendar', 'expanded', 'desktop', 'dock'];
  for (var i = 0; i < names.length; i++) resolved[names[i]] = resolvedSurfaceState(names[i]);
  return {
    skin: skin,
    resolved: resolved,
    viewport: { calendar: { w: 340, h: 430 }, expanded: { w: 340, h: 430 }, desktop: { w: 340, h: 370 }, dock: { w: 116, h: 50 } }
  };
}
function pushSkinConfigState() {
  if (skinWin && !skinWin.isDestroyed()) {
    try { skinWin.webContents.send('skin-config-state', skinConfigState()); } catch (e) {}
  }
}

/* 基准主题统一广播：托盘反色 + 关注列表 + 设置回推 + 皮肤窗回显（日历/桌面/浮动走 skin-state.theme） */
function pushThemeToAll() {
  pushThemeToRemindlist();
  if (tray) { try { tray.setImage(trayIconByTheme()); } catch (e) {} }
  pushSettingsState();
  pushSkinConfigState();
}

/* v2.4.0 第二轮：皮肤图片目录 userData/skins/（惰性创建） */
function skinsDir() {
  var d = path.join(app.getPath('userData'), 'skins');
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

/* v2.4.2：从 GIF 文件头直接读取尺寸（字节 6-7 宽、8-9 高，little-endian uint16）。
 * nativeImage 对 GIF 支持有限（可能解出空图 / 仅首帧），因此 GIF 导入跳过 nativeImage 解码，
 * 尺寸改用本函数读取；读取失败返回 null，渲染层按视口尺寸兜底。 */
function readGifSize(filePath) {
  try {
    var fd = fs.openSync(filePath, 'r');
    var buf = Buffer.alloc(10);
    try {
      var n = fs.readSync(fd, buf, 0, 10, 0);
      if (n < 10) return null;
      var magic = buf.toString('ascii', 0, 6);
      if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) { return null; }
}

/* ===== v2.4.4：JPEG EXIF Orientation 解析（纯本地、零依赖、只读前 64KB） =====
 * 手机竖拍 JPEG 常用 EXIF Orientation=6/8 表达"需旋转 90°/270° 观看"。nativeImage.getSize()
 * 读到的是未旋转的物理尺寸，而 Chromium 渲染 background-image 会自动应用 EXIF 旋转 →
 * 记录尺寸与显示尺寸横竖倒置 → 取景基准 s0 算错 → 竖拍图被上下压扁。
 * 这里只解析 JPEG 头部 APP1 段（Orientation 通常在此），值 ∈ {5,6,7,8} 含 90/270 旋转，
 * 调用方据此交换记录宽高；{1..4} / 缺失 / 非 JPEG / 解析失败 → 返回 1（不旋转）。 */

/* 读文件头 APP1 → TIFF → tag 0x0112(Orientation)，返回 1..8（失败→1） */
function readJpegOrientation(filePath) {
  try {
    var fd = fs.openSync(filePath, 'r');
    try {
      var buf = Buffer.alloc(65536);
      var n = fs.readSync(fd, buf, 0, 65536, 0);
      // 1) SOI：FF D8
      if (n < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return 1;
      var off = 2;
      // 2) 逐段扫描找 APP1（FF E1）
      while (off + 4 <= n) {
        if (buf[off] !== 0xFF) { off++; continue; }
        var marker = buf[off + 1];
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
        if (marker === 0xDA || marker === 0xD9) break;              // SOS/EOI：不再有 EXIF
        var segLen = buf.readUInt16BE(off + 2);
        if (segLen < 2) break;
        if (marker === 0xE1) {                                       // APP1
          var p = off + 4;
          if (p + 6 <= n && buf.toString('ascii', p, p + 6) === 'Exif\u0000\u0000') {
            return parseTiffOrientation(buf, p + 6, n);              // TIFF header 起点
          }
        }
        off += 2 + segLen;
      }
      return 1;
    } finally { fs.closeSync(fd); }
  } catch (e) { return 1; }
}

/* TIFF header → IFD0 → 找 tag 0x0112(Orientation) 的 16-bit 值（II/MM 字节序均支持） */
function parseTiffOrientation(buf, t, n) {
  try {
    if (t + 8 > n) return 1;
    var le;                                                          // 小端？
    if (buf[t] === 0x49 && buf[t + 1] === 0x49) le = true;           // 'II'
    else if (buf[t] === 0x4D && buf[t + 1] === 0x4D) le = false;     // 'MM'
    else return 1;
    var magic = le ? buf.readUInt16LE(t + 2) : buf.readUInt16BE(t + 2);
    if (magic !== 0x002A) return 1;
    var ifdOff = (le ? buf.readUInt32LE(t + 4) : buf.readUInt32BE(t + 4)) + t;
    if (ifdOff + 2 > n) return 1;
    var count = le ? buf.readUInt16LE(ifdOff) : buf.readUInt16BE(ifdOff);
    var e = ifdOff + 2;
    for (var i = 0; i < count && e + 12 <= n; i++, e += 12) {
      var tag = le ? buf.readUInt16LE(e) : buf.readUInt16BE(e);
      if (tag === 0x0112) {                                          // Orientation
        var val = le ? buf.readUInt16LE(e + 8) : buf.readUInt16BE(e + 8);
        return (val >= 1 && val <= 8) ? val : 1;
      }
    }
    return 1;
  } catch (e) { return 1; }
}

/* v2.4.4：WCAG 相对亮度（入参 r/g/b 归一到 0~1），与 isDarkColor 同口径 */
function wcagLum(r, g, b) {
  function ch(x) { x = (x <= 0.03928) ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); return x; }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/* v2.4.4：迟滞明暗判定（±0.06 带宽防抖，临界图重导入/重采样不抖动）。
 * 若上一态为 dark：L<=0.56 维持 dark，L>0.56 才切 light；
 * 若上一态为 light：L>=0.44 维持 light，L<0.44 才切 dark。 */
function decideDark(L, prevDark) {
  if (prevDark) return L <= 0.56;
  return L < 0.44;
}

/* v2.4.4：分区采样 —— 把 64px 缩略图按行分上/中/下三区（各算 WCAG 平均亮度），
 * 另算逐像素相对亮度标准差 → complexity（局部亮度不均程度，0~1，满量程 0.30）。
 * 跳过 alpha=0 透明像素（PNG 透明区 BGRA 是黑，计入会误判深色 → 误切黑夜）。 */
function sampleImageStats(img) {
  var thumb = img.resize({ width: 64 });
  var bmp = thumb.toBitmap();                 // BGRA
  var sz = thumb.getSize();
  var W = (sz && sz.width) || 64;
  var H = (sz && sz.height) || 1;
  var zoneSum = [{ r: 0, g: 0, b: 0, n: 0 }, { r: 0, g: 0, b: 0, n: 0 }, { r: 0, g: 0, b: 0, n: 0 }]; // 上/中/下
  var lumSum = 0, lumSq = 0, cnt = 0;
  for (var i = 0; i < bmp.length; i += 4) {
    if (bmp[i + 3] === 0) continue;           // 透明像素不计
    var idx = i / 4;
    var py = Math.floor(idx / W);
    var zi = (py < H / 3) ? 0 : (py < 2 * H / 3 ? 1 : 2);
    var z = zoneSum[zi];
    z.b += bmp[i]; z.g += bmp[i + 1]; z.r += bmp[i + 2]; z.n++;
    // 逐像素相对亮度（线性加权近似）用于方差
    var l = (0.2126 * bmp[i + 2] + 0.7152 * bmp[i + 1] + 0.0722 * bmp[i]) / 255;
    lumSum += l; lumSq += l * l; cnt++;
  }
  var zoneY = [0, 0, 0];
  for (var k = 0; k < 3; k++) {
    var zz = zoneSum[k];
    if (zz.n > 0) zoneY[k] = wcagLum(zz.r / zz.n / 255, zz.g / zz.n / 255, zz.b / zz.n / 255);
  }
  var mean = cnt > 0 ? lumSum / cnt : 0;
  var variance = cnt > 0 ? Math.max(0, lumSq / cnt - mean * mean) : 0;
  var std = Math.sqrt(variance);                              // 局部亮度标准差
  return {
    zones: zoneY,
    mean: mean,
    complexity: Math.max(0, Math.min(1, std / 0.30))          // 0~1，0.30 为满量程常数
  };
}

/* v2.4.0 第二轮：图片皮肤导入。
 * 校验（扩展名白名单：png/jpg/jpeg/gif/webp，不设大小/像素上限，交由用户自行取景裁剪）→
 * 原子复制到 userData/skins/ → 采样亮度（跳过透明像素，采样失败兜底浅色）。
 * v2.4.2：GIF 跳过 nativeImage 解码/亮度采样/首帧快照（nativeImage 对 GIF 支持有限），
 *        尺寸从文件头 readGifSize 读取，dark 兜底 false，直接复制文件交给渲染层
 *        background-image:url(skin://...) 保持动画播放。返回 { ok, image, error }。 */
function importSkinImage(surface, srcPath) {
  try {
    var validSurfaces = { calendar: 1, expanded: 1, desktop: 1, dock: 1 };
    if (!validSurfaces[surface]) return { ok: false, error: '无效的皮肤界面' };
    if (!srcPath || typeof srcPath !== 'string') return { ok: false, error: '未提供图片路径' };
    var ext = (path.extname(srcPath) || '').toLowerCase();
    var okExts = { '.png': 1, '.jpg': 1, '.jpeg': 1, '.gif': 1, '.webp': 1 };
    if (!okExts[ext]) return { ok: false, error: '仅支持 png/jpg/jpeg/gif/webp' };

    var isGif = (ext === '.gif');
    var img = null;
    var size = null;
    if (isGif) {
      // v2.4.2：GIF 跳过 nativeImage 解码（支持有限，可能解出空图/仅首帧），直接读文件头拿尺寸。
      size = readGifSize(srcPath) || { width: 0, height: 0 };
    } else {
      img = nativeImage.createFromPath(srcPath);
      if (!img || img.isEmpty()) return { ok: false, error: '图片解码失败' };
      size = img.getSize();
      // v2.4.4：JPEG 竖拍/旋转修正 —— EXIF Orientation ∈ {5,6,7,8} 含 90°/270° 旋转，
      // nativeImage.getSize() 读到的是未旋转物理尺寸，而 Chromium 渲染 background-image 会自动
      // 应用 EXIF 旋转 → 记录尺寸与显示尺寸横竖倒置 → 取景基准 s0 算错导致压扁。交换记录宽高对齐。
      if (ext === '.jpg' || ext === '.jpeg') {
        var orient = readJpegOrientation(srcPath);
        if (orient >= 5 && orient <= 8) size = { width: size.height, height: size.width };
      }
    }

    var ts = Date.now();
    var base = surface + '_' + ts;
    var destName = base + (ext === '.jpeg' ? '.jpg' : ext);
    var destDir = skinsDir();
    var tmp = path.join(destDir, destName + '.tmp');
    var dest = path.join(destDir, destName);
    fs.copyFileSync(srcPath, tmp);
    fs.renameSync(tmp, dest);

    // v2.4.4：分区采样（上/中/下三区）+ 权重合成 + 迟滞，输出 dark 与 complexity（局部亮度方差）。
    // 旧「整图均值 lum<0.5」扛不住局部亮暗不均；中区（日期网格）权重最高，临界图重导入不抖动。
    var dark = false;
    var complexity = 0;
    if (!isGif && img) {
      try {
        var stats = sampleImageStats(img);
        if (stats) {
          // 中区权重最高（0.55），上/下区 0.25/0.20；迟滞 ±0.06 防抖
          var L = 0.25 * stats.zones[0] + 0.55 * stats.zones[1] + 0.20 * stats.zones[2];
          var prevDark = false;
          try {
            var pc = skin.surfaces[surface];
            if (pc && pc.image && typeof pc.image.dark === 'boolean') prevDark = pc.image.dark;
          } catch (e2) {}
          dark = decideDark(L, prevDark);
          complexity = stats.complexity;
        }
        // stats 为空（解码/采样异常）→ dark=false + complexity=0（浅色兜底，绝不硬切黑夜）
      } catch (e) {}
    }

    // v2.4.2：GIF 不再生成首帧冻结帧（nativeImage 对 GIF 支持有限，toPNG 首帧不可靠），
    // 直接由渲染层 background-image:url(skin://...gif) 保持动画播放。
    var snapshot = null;

    var image = {
      file: destName,
      snapshot: snapshot,
      w: size.width,
      h: size.height,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      zoom: 1,
      opacity: 1,
      dark: dark,
      complexity: complexity
    };
    return { ok: true, image: image, error: null };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '导入失败' };
  }
}

/* v2.4.0 第二轮：皮肤写操作统一入口（skin.html → skin-set）。
 * field ∈ type/color/text/follow/opacity/image。处理 follow 取消时的 copy-on-write 物化。 */
function applySkinSet(payload) {
  var surface = payload && payload.surface;
  var field = payload && payload.field;
  var value = payload && payload.value;
  var validSurfaces = { calendar: 1, expanded: 1, desktop: 1, dock: 1 };
  if (!validSurfaces[surface]) return;
  var c = skin.surfaces[surface];
  if (!c) return;

  if (field === 'type') {
    var t = (value === 'dark' || value === 'system' || value === 'color' || value === 'image') ? value : 'light';
    c.type = t;
    if (t !== 'color') c.color = null;
    if (t !== 'image') c.image = null;
    if (t === 'light' || t === 'dark' || t === 'system') c.text = 'auto';
  } else if (field === 'color') {
    c.color = validHex(value);
    if (c.color) { c.type = 'color'; c.image = null; }
  } else if (field === 'text') {
    c.text = (value === 'light' || value === 'dark') ? value : 'auto';
  } else if (field === 'follow') {
    if (surface === 'expanded' || surface === 'desktop') {
      if (value === 'calendar') {
        c.follow = 'calendar';
      } else {
        // 取消跟随 = copy-on-write：以日历当前配置为初始快照
        var cal = skin.surfaces.calendar;
        c.follow = null;
        c.type = cal.type;
        c.color = cal.color;
        c.image = cal.image ? JSON.parse(JSON.stringify(cal.image)) : null;
        c.text = cal.text;
        c.clarity = cal.clarity;   // v2.4.4：清晰度一并物化快照
      }
    }
  } else if (field === 'clarity') {
    // v2.4.4：UI 清晰度（'auto' | 0~100）。写入后推 skin-state（resolved.clarity 供渲染层）。
    c.clarity = (value === 'auto') ? 'auto'
      : Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  } else if (field === 'opacity') {
    var key = (surface === 'calendar' || surface === 'expanded') ? 'calendar' : surface;
    if (key === 'desktop' || key === 'dock' || key === 'calendar') {
      skin.opacity[key] = clampOpacity(value, 1);
      applyOpacity(key);
    }
  } else if (field === 'image') {
    // value = ImageSpec（皮肤窗取景后回写 file/crop/zoom）。渲染层回写的字段覆盖，
    // 缺失的 w/h/dark/snapshot 保留既有值（导入时主进程已算好），避免取景回写丢失亮度/冻结帧。
    if (value && typeof value === 'object' && value.file) {
      var prev = c.image || {};
      c.image = normalizeImageSpec({
        file: value.file || prev.file,
        snapshot: (value.snapshot !== undefined) ? value.snapshot : prev.snapshot,
        w: (value.w !== undefined) ? value.w : prev.w,
        h: (value.h !== undefined) ? value.h : prev.h,
        crop: value.crop || prev.crop,
        zoom: (value.zoom !== undefined) ? value.zoom : prev.zoom,
        opacity: (value.opacity !== undefined) ? value.opacity : prev.opacity,
        dark: (value.dark !== undefined) ? value.dark : prev.dark
      });
      c.type = 'image';
      c.color = null;
    }
  }
  recomputeTheme();
  saveSettings();
  pushThemeToAll();     // baseTheme 可能变化：托盘反色 + 关注列表 + 设置窗主题跟随
  pushSkinToAll();
  refreshTrayMenu();
}

/* 透明度窗口级应用（opacity.calendar 作用于主窗；desktop/dock 各自独立） */
function applyOpacity(key) {
  var v = skin.opacity[key] || 1;
  if (key === 'calendar' && win && !win.isDestroyed()) { try { win.setOpacity(v); } catch (e) {} }
  if (key === 'desktop' && desktopWin && !desktopWin.isDestroyed()) { try { desktopWin.setOpacity(v); } catch (e) {} }
  if (key === 'dock' && dockWin && !dockWin.isDestroyed()) { try { dockWin.setOpacity(v); } catch (e) {} }
}

/* ===== v1.7.22 需求3：Windows 版本检测 =====
 * 用 os.release() 的内核 build 号判断系统版本，等价于 C# 的 Environment.OSVersion.Version.Build。
 *   - Windows 10：build ∈ [10240, 19045]
 *   - Windows 11：build ≥ 22000
 * 不硬编码任务栏高度 / 屏幕尺寸 —— 那些继续由 display.workArea 动态给出（Win10/Win11 自动适配）。 */
function detectWin11() {
  try {
    const rel = os.release();                        // 形如 "10.0.22621"
    const m = /^10\.0\.(\d+)/.exec(rel);
    if (m) return parseInt(m[1], 10) >= 22000;
    return false;
  } catch (e) { return false; }
}

/* ===== v1.6.1：单实例锁（防止双击 exe 开两实例 + 两窗口） =====
 * 第二个实例启动时直接 quit，已开实例的窗口被唤起到前台。
 * v1.7.20 强化：旧实例若处于「进程还在但窗口已毁」的残废状态（典型场景：上一版
 * 调试留下的、或 v1.7.13~19 嵌入循环遗留的 4-5 个僵尸进程），这里必须能重建窗口。
 * 同时启动时主动 taskkill 同 user 下其它『简洁桌面日历 / SimpleCalendar』残留副本，
 * 否则 Electron 单实例锁只能拦"之后启动的实例"，拦不了"先就在跑的僵尸"。 */
const MY_LOCK_KEY = 'yg.simplecalendar.v1';
const gotLock = app.requestSingleInstanceLock({ key: MY_LOCK_KEY });
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function (event, argv, cwd, additionalData) {
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) showMini();
      try { win.focus(); win.moveTop(); } catch (e) {}
      return;
    }
    log('second-instance: main window missing, recreate');
    try { createWindow(); } catch (e) { log('second-instance recreate failed: ' + (e && e.message || e)); }
  });
}

/* ===== v2.1.0 节假日年度更新状态 =====
 * holidayLastCheck：上次检查时间（ISO），7 天内不自动弹窗；
 * holidayDismissedYear：用户点「以后再说」的年份，该年不再自动提示。 */
let holidayLastCheck = '';
let holidayDismissedYear = 0;
let holidayWin = null;          // 更新弹窗（holidayupd.html）
let holidayCheckTimer = null;   // 周期性检查定时器
let holidayBusy = false;        // 正在联网更新，避免重入
let holidayLastState = '';      // 最近一次推给弹窗的状态（关闭时据此判定是否算一次失败）
let holidayFailCounted = false; // 本次弹窗会话是否已计过失败（防 close + closed 重复计数）
/* v2.1.0 P2-4：连续失败计数。长期离线用户若每 7 天被弹一次会烦，
 * 累计失败 2 次起把自动提示窗口拉长到 28 天；成功一次即清零。 */
let holidayFailCount = 0;
const HOLIDAY_CHECK_THROTTLE_MS = 7 * 24 * 3600 * 1000;   // 自动提示 7 天节流

/* ===== 状态 ===== */
let win = null;
let tray = null;
let myProcessPid = process.pid;   // v1.7.20：记下自己的 PID，残留清理时跳过自己
let themeMode = 'light';      // 'light' 白日 | 'dark' 黑夜
let pinned = true;             // 主窗置顶
let autoLaunch = true;         // 开机自启

/* ===== v2.4.0 第二轮 皮肤（per-surface 配置树，主进程唯一真相） =====
 * skin.surfaces{calendar,expanded,desktop,dock}：每界面独立 type(light|dark|system|color|image)
 *   + color/image/text(auto|light|dark)；expanded/desktop 带 follow('calendar'|null)。
 * skin.opacity{calendar,desktop,dock}：透明度（opacity.calendar 同时作用于 mini/max 同一窗口）。 */
let skin = {
  __v: 2,
  surfaces: {
    calendar: { type: 'light', color: null, image: null, text: 'auto', clarity: 'auto' },
    expanded: { follow: 'calendar', type: 'light', color: null, image: null, text: 'auto', clarity: 'auto' },
    desktop:  { follow: 'calendar', type: 'light', color: null, image: null, text: 'auto', clarity: 'auto' },
    dock:     { type: 'light', color: null, image: null, text: 'auto', clarity: 'auto' }
  },
  opacity: { calendar: 1, desktop: 1, dock: 1 }
};

/* ===== v1.7.20 任务栏挂件条（dock） =====
 * 用户要的"任务栏插件"：贴任务栏上沿右侧、始终可见的一个小条，
 * 上排 24 小时制时间、下排年月日；左键=开/关日历主窗，右键=弹出与托盘完全相同的菜单。
 *
 * ========== 关于"真嵌入"为什么被废除 ==========
 * Windows 10 1809 起废弃 DeskBands（IDeskBand），Win11 彻底移除任务栏工具栏扩展点，
 * 真正的"任务栏插件"已无官方接口。v1.7.13~v1.7.19 一共尝试过 7 次用
 *   SetWindowLong(GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD) + SetParent(ReBarWindow32)
 * "真嵌入"任务栏，每次都被 Chromium 用 render-process-gone reason=killed 反噬 —— 因为
 *   Chromium 渲染线程在自身 HWND 被改父为 WS_CHILD 后做 surface tree 自检，自检失败就
 *   主动 kill 自己；这套崩溃跟「嵌入后是否 setSize」无关，是 SetParent 本身带的稳定性问题。
 * v1.7.20 决策：彻底回退到 v1.7.11 的浮动方案 —— 贴任务栏上沿的置顶 topmost 无边框窗，
 *   用 v1.7.19 引入的 pushDockSize + applyDockSize 固定像素布局保证内容显示完整。
 * 经验证 v1.7.11 + 固定像素布局 = 显示完整 + 永不崩溃，是最稳的方案。
 * ================================================== */
let dockWin = null;
let dockOn = true;             // 挂件条总开关：false = 插件和托盘图标都不显示
const DOCK_W = 116, DOCK_H = 50;
/* v1.7.22.7【关键】插件的「意图尺寸」—— 全局唯一真值，所有布局/夹取都必须用它，
 * 严禁再用 dockWin.getBounds() 的 width/height 参与计算。
 *
 * 背景（实测取证，见 calendar.log）：日志里 `dock dropped at 1208,756` 反推出窗口尺寸是
 * 232×164（1440-1208=232、920-756=164），而代码请求的是 116×H(H≤56)。同一次运行内还从
 * 230×152 变成 232×164 —— 说明物理窗口被 Windows/Chromium 撑大过，且尺寸会变。
 * 后果：clampDockToWorkArea 按被撑大的矩形算 maxX/maxY，可活动范围被严重压缩
 * （卡片贴不到右边、贴不到任务栏），且 pushDockSize 会把这个错误尺寸发给页面，
 * 卡片本身也被渲染成 232×164 的大方块 —— 正是用户反复反馈的"卡在半空、过不去"。
 *
 * 对策：dockW/dockH 是唯一真值。
 *   - 卡片渲染尺寸用它 → 卡片永远是 116×dockH
 *   - 边界夹取用它   → maxX/maxY 按 116×dockH 算，卡片能真正贴到屏幕右沿/任务栏上沿
 *   - 即使物理窗口被 OS 撑大，多出来的只是**透明区域**，会自然溢出屏幕外，视觉无感，
 *     且窗口本身是 click-through 的，不会挡住任何东西。 */
let dockW = DOCK_W;
let dockH = DOCK_H;
/* v1.7.21 需求2：两种显示形态，二选一
 *   'dock' 桌面插件 —— 可拖动的浮动小方框（默认）
 *   'icon' 桌面图标 —— 隐藏插件，只在系统托盘保留一个静态图标；左键单击图标切回插件 */
let dockMode = 'dock';
/* v1.7.22 需求3：Windows 版本检测。用内核 build 号判断（os.release() 返回 "10.0.xxxxx"）：
 *   Win10 build ∈ [10240, 19045]，Win11 build ≥ 22000。只写一个 isWin11 布尔配置项，
 *   不切两套 UI；若日后发现 Win11 下弹出定位有极个别像素偏移，用下方补偿常量微调即可。
 * 任务栏高度/屏幕尺寸一律不硬编码，始终用 display.workArea 动态获取（见 taskbarHeight/workArea）。 */
let isWin11 = false;
/* Win11 弹出定位像素补偿（默认 0 = 当前无偏移）。若 Win11 下日历与插件/屏幕边界
 * 有 1~2px 偏差，改这里即可，不影响 Win10。 */
const WIN11_POS_COMP_X = 0;
const WIN11_POS_COMP_Y = 0;
/* v1.7.21 需求3：拖动的落点限制在「屏幕工作区」内（工作区已自动排除任务栏）。
 * 记录插件上次位置，切到图标模式再切回来时自动回到原处。 */
let dockBounds = null;
/* v2.4.0 A3：按显示器 ID 记忆插件位置。dockBoundsByDisplay[displayId] → 矩形，
 * dockDisplayId = 上次所在屏。display-removed 回落、display-added 还原、越界夹取。 */
let dockBoundsByDisplay = {};
let dockDisplayId = null;
/* v1.7.21：插件置顶开关。默认开，但置顶等级用 'floating'（低于 'screen-saver'），
 * 不跟全屏游戏/视频抢最高层；用户看全屏视频时可在这里手动关掉。 */
let dockPinned = true;

/* ===== v2.2.0 需求4：桌面插件（日历板块独立桌面工具） =====
 * 与浮动挂件条（dock）是两码事：dock 是一枚只显示时间的小方框，桌面插件是
 * 把「日历板块」（不含顶部时间那一排）作为一块桌面工具，可拖动、可锁定。
 * 复用 calendar.html，靠 query `mode=desktopWidget` 让渲染层进入桌面模式。
 * 尺寸 340×370（= mini 宽，去掉 62px 信息条后的自然高度）。 */
let desktopWin = null;
let desktopOn = false;             // 桌面插件开关（默认关，避免和现有形态抢桌面）
let desktopLocked = false;         // 锁定：锁定后不可拖动，其余功能正常
let desktopBounds = null;          // 上次位置
let _desktopSaveTimer = null;      // 拖动结束位置落盘防抖
const DESKTOP_W = 340, DESKTOP_H = 370;
// 透明度已并入 skin.opacity.*（v2.4.0 第二轮，见皮肤中枢）

let quitting = false;          // 退出中，禁止窗口自动重建
/* v1.7.20：浮动态下的渲染进程崩溃保护。浮动态也偶发 crash（GPU/驱动/D3D），但不会"嵌入崩溃循环"，
 * 这里保留有限重建次数：偶发一次 OK，连续多次就放弃重建避免堆进程。 */
let dockRecreateCount = 0;
const DOCK_RECREATE_MAX = 3;
let dockCrashed = false;
let dockStableTimer = null;

/* ===== v1.7.11 特别关注字数限制 ===== */
const MAX_REMINDER_TEXT = 15;  // 单条内容最多 15 字（v2.3.0：移除「最多 10 条」数量上限）

/* v2.4.0 A1：托盘/菜单唤起后的短暂 blur 保护，改用时间戳 + guardBlur(ms)，
 * 不再用裸布尔 + 多处 setTimeout 复位（旧实现存在竞态，导致"点外部不消失"偶发）。 */
let blurGraceUntil = 0;
function guardBlur(ms) {
  blurGraceUntil = Date.now() + (ms || 350);
}

/* ===== v1.6.2 特别关注（reminder） =====
 * 数据结构：
 *   [{ id, y, m, d, text, createdAt, snoozeUntil, ackedDate }]
 * 持久化：userData/reminders.json（原子写：先写 .tmp 再 rename）
 * 到期检查：每 60s 跑一次；触发条件 = (y/m/d == 今天) && (ackedDate != 今天) && (snoozeUntil <= now)
 * 触发：弹独立 BrowserWindow（屏幕中央、置顶、半小时可重复弹）
 * ackedDate：用户点"知道了"后写入"今天"，用于当天不再弹但保留关注项（黄色格子） */
let reminders = [];              // 内存列表
let reminderWin = null;          // 当前提醒弹窗（已存在则复用 .focus()）
/* v1.7.12：关注列表独立窗口。
 * 原先是 #widget 内的 DOM 浮层，拖动被夹在日历窗口可视区内（用户需求：想拖到窗口外）。
 * 改成独立 BrowserWindow 后，表头用 -webkit-app-region: drag 交给 Electron 原生拖动，
 * 可拖到屏幕任意位置，不受主窗口裁剪。窗口位置持久化到 settings.json。 */
let remindlistWin = null;
const RL_W = 340, RL_H = 440;    // 关注列表窗口默认尺寸
let lastRemindlistBounds = null; // 上次位置（持久化到 settings.json）
let _rlSaveTimer = null;         // 位置保存防抖
let reminderFor = null;          // 当前弹窗对应哪个提醒 id（防重复弹）
let reminderCheckTimer = null;   // 60s 巡检句柄
const REMINDER_FILE = () => path.join(app.getPath('userData'), 'reminders.json');

/* ===== 窗口尺寸（v1.7.2：mini 紧凑卡 + expanded 大屏重画） ===== */
const MINI_W = 340, MINI_H = 430;
// 放大模式：默认按 mini 的 2.24x 比例开（760×959），让"放大"看起来图真的变大
const ASPECT = MINI_W / MINI_H;
const EXP_DEF_W = 760, EXP_DEF_H = Math.round(EXP_DEF_W / ASPECT);   // 等比 760×959
const EXP_MIN_W = 420;   // v2.2.0：降到 420 —— 内容已用 zoom 等比缩放，不再靠固定字号兜底

/* ===== 工作区 ===== */
function workArea() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  return { width: wa.width, height: wa.height };
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/* =====================================================================
 * 零依赖迷你 PNG 编码器（托盘图标静态绘制）
 * ===================================================================== */
const FONT = {
  '今': ['01110', '10001', '10101', '10011', '10001', '10001', '01110']
};
const CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* =====================================================================
 * 托盘图标：日历 logo（与 icon.ico 同款设计）
 * ---------------------------------------------------------------------
 * v1.6.2 需求 2：替换原"今"字图标为雅蓝日历磁贴 + 白卡片 + 朱砂表头 + 网格点。
 * - light 模式：雅蓝磁贴 + 白卡片
 * - dark  模式：白磁贴 + 蓝卡片（反色）
 * 不透明设计 → 永远避免 Windows GDI 透明 PNG 黑块。
 * ===================================================================== */
function _setPx(rgba, W, x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 4;
  rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = c[3];
}
function _fillRR(rgba, W, x0, y0, w, h, r, c, corners) {
  const tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = true;
      if (x < r) {
        if (y < r && tl && (x - r) * (x - r) + (y - r) * (y - r) > r * r) inside = false;
        if (y >= h - r && bl && (x - r) * (x - r) + (y - (h - r)) * (y - (h - r)) > r * r) inside = false;
      }
      if (x >= w - r) {
        if (y < r && tr && (x - (w - r)) * (x - (w - r)) + (y - r) * (y - r) > r * r) inside = false;
        if (y >= h - r && br && (x - (w - r)) * (x - (w - r)) + (y - (h - r)) * (y - (h - r)) > r * r) inside = false;
      }
      if (inside) _setPx(rgba, W, x0 + x, y0 + y, c);
    }
  }
}
function makeTrayIcon(mode) {
  const S = 32;
  const rgba = Buffer.alloc(S * S * 4, 0);
  const TILE = mode === 'dark' ? [0xff, 0xff, 0xff, 0xff] : [0x3b, 0x6f, 0xd4, 0xff];
  const CARD = mode === 'dark' ? [0x3b, 0x6f, 0xd4, 0xff] : [0xff, 0xff, 0xff, 0xff];
  const HEAD = [0xd6, 0x45, 0x3f, 0xff];
  const DOT  = mode === 'dark' ? [0xff, 0xff, 0xff, 0xff] : [0x96, 0x9c, 0xa8, 0xff];
  const DOT_HL = [0xd6, 0x45, 0x3f, 0xff];
  // 1) 雅蓝磁贴
  const m = Math.round(S * 0.06);
  const tileR = Math.round((S - 2 * m) * 0.22);
  _fillRR(rgba, S, m, m, S - 2 * m, S - 2 * m, tileR, TILE, [true, true, true, true]);
  // 2) 白色日历卡
  const inPad = Math.round(S * 0.09);
  const cX = m + inPad, cY = m + inPad, cW = S - 2 * m - 2 * inPad, cH = S - 2 * m - 2 * inPad;
  const cR = Math.round(cW * 0.18);
  _fillRR(rgba, S, cX, cY, cW, cH, cR, CARD, [true, true, true, true]);
  // 3) 朱砂红表头
  const headH = Math.round(cH * 0.24);
  const headR = Math.round(cR * 0.92);
  _fillRR(rgba, S, cX, cY, cW, headH, headR, HEAD, [true, true, false, false]);
  // 4) 网格点 4×3，首点朱砂红
  const top = cY + headH + Math.round(cH * 0.10);
  const bottom = cY + cH - Math.round(cH * 0.10);
  const areaH = bottom - top;
  const gapX = cW * 0.07;
  const areaW = cW - 2 * gapX;
  const cols = 4, rows = 3;
  const cellW = areaW / cols, cellH = areaH / rows;
  const dot = Math.max(2, Math.round(Math.min(cellW, cellH) * 0.40));
  const dotR = Math.max(1, Math.round(dot / 2));
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const cx = Math.round(cX + gapX + cellW * (col + 0.5) - dot / 2);
      const cy = Math.round(top + cellH * (r + 0.5) - dot / 2);
      const isToday = (r === 0 && col === 0);
      _fillRR(rgba, S, cx, cy, dot, dot, dotR, isToday ? DOT_HL : DOT, [true, true, true, true]);
    }
  }
  return nativeImage.createFromBuffer(encodePNG(S, S, rgba));
}

/* =====================================================================
 * v2.0 视觉：右键菜单单色图标系统
 * ---------------------------------------------------------------------
 * 原先菜单用 emoji（📅☀🌙📌…）点缀，问题有三个：
 *   1) 跨系统渲染不一致（Win10/Win11 字形差别大，部分环境退化为方框）；
 *   2) 彩色 emoji 在菜单这类"工具性"界面里过于跳脱，破坏了单色、克制的调性；
 *   3) emoji 自带左右边距，导致菜单项文字基线无法对齐。
 * 这里改为运行时生成的 16px 单色图标，与托盘图标同一套造型语言
 * （圆角矩形 + 圆环 + 网格点），白日/黑夜自动取反色。
 *
 * 实现：在 64×64 设计画布上用 SDF 画硬边图形，再 4× 盒式降采样到 16×16，
 * 等效 16 级抗锯齿 —— 16px 下不会糊成一团。全部内联，不增加任何外部资源。
 * ===================================================================== */
const GLYPH_SS = 64;    // 超采样画布边长
const GLYPH_OUT = 16;   // 输出边长（Win32 菜单规范的逻辑尺寸）

/* 生成指定图形的覆盖率掩码（Float32，>0.5 视为实心）。
 * 设计坐标系固定 64×64，内部按 GLYPH_SS 缩放，方便换采样率。 */
function _glyphMask(name) {
  const N = GLYPH_SS;
  const m = new Float32Array(N * N);
  const S = N / 64;

  /* --- 图元：统一带权重 w（+1 绘制 / -1 挖空），支持布尔运算 --- */
  function rr(x0, y0, x1, y1, r, t, mode, w) {
    w = (w === undefined) ? 1 : w;
    const cx = (x0 + x1) / 2 * S, cy = (y0 + y1) / 2 * S;
    const hw = (x1 - x0) / 2 * S, hh = (y1 - y0) / 2 * S;
    const rad = r * S, th = t * S, bx = hw - rad, by = hh - rad;
    const xa = Math.max(0, Math.floor(cx - hw - 2)), xb = Math.min(N - 1, Math.ceil(cx + hw + 2));
    const ya = Math.max(0, Math.floor(cy - hh - 2)), yb = Math.min(N - 1, Math.ceil(cy + hh + 2));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const qx = Math.abs(x + 0.5 - cx) - bx;
        const qy = Math.abs(y + 0.5 - cy) - by;
        const ax = qx > 0 ? qx : 0, ay = qy > 0 ? qy : 0;
        const d = Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - rad;
        const hit = (mode === 'fill') ? (d <= 0) : (Math.abs(d) <= th / 2);
        if (hit) m[y * N + x] += w;
      }
    }
  }
  function circle(cx, cy, r, mode, t, w) {
    w = (w === undefined) ? 1 : w;
    const Cx = cx * S, Cy = cy * S, R = r * S, T = (t || 0) * S;
    const xa = Math.max(0, Math.floor(Cx - R - 2)), xb = Math.min(N - 1, Math.ceil(Cx + R + 2));
    const ya = Math.max(0, Math.floor(Cy - R - 2)), yb = Math.min(N - 1, Math.ceil(Cy + R + 2));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const dx = x + 0.5 - Cx, dy = y + 0.5 - Cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const hit = (mode === 'fill') ? (d <= R) : (Math.abs(d - R) <= T / 2);
        if (hit) m[y * N + x] += w;
      }
    }
  }
  function line(x0, y0, x1, y1, t, w) {
    w = (w === undefined) ? 1 : w;
    const steps = Math.ceil(Math.hypot((x1 - x0) * S, (y1 - y0) * S) * 2) + 1;
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      circle(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, t / 2, 'fill', 0, w);
    }
  }
  /* 任意多边形（射线法，支持凹凸） */
  function poly(pts, w) {
    w = (w === undefined) ? 1 : w;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    const xa = Math.max(0, Math.floor(minX * S) - 2), xb = Math.min(N - 1, Math.ceil(maxX * S) + 2);
    const ya = Math.max(0, Math.floor(minY * S) - 2), yb = Math.min(N - 1, Math.ceil(maxY * S) + 2);
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const px = (x + 0.5) / S, py = (y + 0.5) / S;
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
          if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
        }
        if (inside) m[y * N + x] += w;
      }
    }
  }
  /* 圆环的一段：角度制，90° 为正上方，顺时针增大；a1 可超过 360 表示跨圈 */
  function ring(cx, cy, r, t, a0, a1, w) {
    w = (w === undefined) ? 1 : w;
    const Cx = cx * S, Cy = cy * S, R = r * S, T = t * S;
    const xa = Math.max(0, Math.floor(Cx - R - 2)), xb = Math.min(N - 1, Math.ceil(Cx + R + 2));
    const ya = Math.max(0, Math.floor(Cy - R - 2)), yb = Math.min(N - 1, Math.ceil(Cy + R + 2));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const dx = x + 0.5 - Cx, dy = y + 0.5 - Cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (Math.abs(d - R) > T / 2) continue;
        let a = Math.atan2(-dy, dx) * 180 / Math.PI;   // 屏幕 y 向下 → 取负得到"上为正"
        while (a < a0) a += 360;
        if (a <= a1) m[y * N + x] += w;
      }
    }
  }

  const T = 6;   // 统一的描边粗细（64 空间 → 16 输出约 1.5px）

  switch (name) {
    /* 日历：外框 + 表头 + 网格点（与托盘图标同源）。
     * 外框必须是描边不是填充 —— 全填充在 16px 下就是一坨黑。 */
    case 'calendar':
      rr(8, 12, 56, 58, 8, T, 'stroke');
      rr(8, 12, 56, 26, 8, 0, 'fill');
      circle(20, 38, 3.2, 'fill'); circle(32, 38, 3.2, 'fill'); circle(44, 38, 3.2, 'fill');
      circle(20, 49, 3.2, 'fill'); circle(32, 49, 3.2, 'fill');
      break;
    /* 白日：日轮 + 八道光芒 */
    case 'sun':
      circle(32, 32, 9, 'stroke', T);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        line(32 + Math.cos(a) * 14, 32 + Math.sin(a) * 14,
             32 + Math.cos(a) * 21, 32 + Math.sin(a) * 21, 5);
      }
      break;
    /* 黑夜：满月挖去偏移圆形成月牙 */
    case 'moon':
      circle(35, 33, 16, 'fill'); circle(43, 26, 15, 'fill', 0, -1);
      break;
    /* 置顶：向上箭头顶到基准线 */
    case 'pinTop':
      rr(9, 8, 55, 17, 3, 0, 'fill');
      poly([[32, 20], [50, 54], [14, 54]]);
      break;
    /* 开机自启 / 退出：电源符号（顶部开口的圆环 + 竖杠） */
    case 'power':
      ring(32, 36, 15, T, 112, 428);
      rr(27, 9, 37, 34, 2, 0, 'fill');
      break;
    /* 挂件条：一枚浮动的小卡片 */
    case 'dock':
      rr(5, 21, 59, 43, 9, T, 'stroke');
      circle(17, 32, 3.4, 'fill');
      rr(26, 29, 48, 35, 3, 0, 'fill');
      break;
    /* 缩小至桌面图标：向下收拢 */
    case 'minimize':
      rr(9, 47, 55, 56, 3, 0, 'fill');
      poly([[32, 43], [14, 10], [50, 10]]);
      break;
    /* 切回桌面插件：前后两枚窗口 */
    case 'restore':
      rr(11, 11, 45, 39, 5, T, 'stroke');
      rr(21, 25, 55, 55, 5, 0, 'fill');
      break;
    /* 特别关注：书签 */
    case 'bookmark':
      rr(18, 7, 46, 57, 3, 0, 'fill');
      poly([[18, 57], [46, 57], [32, 40]], -1);
      break;
    /* 查看 / 管理：三行列表 */
    case 'list':
      rr(9, 13, 55, 21, 3, 0, 'fill');
      rr(9, 28, 48, 36, 3, 0, 'fill');
      rr(9, 43, 43, 51, 3, 0, 'fill');
      break;
    /* 打开管理窗口：带标题栏的窗 */
    case 'window':
      rr(9, 13, 55, 53, 5, 0, 'fill');
      rr(9, 13, 55, 25, 5, 0, 'fill', -1);
      rr(9, 19, 55, 27, 0, 0, 'fill');
      break;
    /* 本年最近节日：四芒星 */
    case 'sparkle':
      poly([[32, 4], [38, 26], [60, 32], [38, 38], [32, 60], [26, 38], [4, 32], [26, 26]]);
      break;
    /* 时间：表盘 + 时针分针 */
    case 'clock':
      circle(32, 32, 16, 'stroke', T);
      line(32, 32, 32, 19, 5);
      line(32, 32, 43, 32, 5);
      break;
    /* 跳转：向右的箭头（关注项 / 节日项）。杆加粗、头加大，16px 下才立得住 */
    case 'goto':
      line(8, 32, 42, 32, 7);
      poly([[38, 17], [57, 32], [38, 47]]);
      break;
    /* 锁定：闭合挂锁（锁梁 + 锁体 + 锁孔） */
    case 'lock':
      ring(32, 23, 9, T, 180, 360);          // 锁梁：上半圆环
      rr(16, 26, 48, 50, 6, 0, 'fill');      // 锁体
      circle(32, 34, 3.4, 'fill', 0, -1);    // 锁孔（挖空）
      break;
    /* 设置：齿轮（外环 + 8 齿 + 中心孔） */
    case 'settings':
      circle(32, 32, 11, 'stroke', T);       // 外环
      for (var gi = 0; gi < 8; gi++) {
        var ga = gi * Math.PI / 4;
        line(32 + Math.cos(ga) * 15, 32 + Math.sin(ga) * 15,
             32 + Math.cos(ga) * 19, 32 + Math.sin(ga) * 19, 5);
      }
      circle(32, 32, 4.5, 'fill', 0, -1);    // 中心孔（挖空）
      break;
  }
  return m;
}

/* 掩码 → 16×16 抗锯齿 RGBA → nativeImage。结果按 (图形, 配色) 缓存。 */
const _menuIconCache = Object.create(null);
function menuIcon(name) {
  try {
    /* 菜单由系统绘制，跟随的是**系统**深浅色而非软件主题：
     * 系统浅色（菜单白底）→ 深墨色图标；系统深色 → 浅色图标。
     * nativeTheme 拿不到时才退回软件自己的主题，避免出现"白底白字"。 */
    const sysDark = (nativeTheme && typeof nativeTheme.shouldUseDarkColors === 'boolean')
      ? nativeTheme.shouldUseDarkColors
      : (themeMode === 'dark');
    const rgb = sysDark ? [0xE8, 0xEB, 0xF2] : [0x2A, 0x2F, 0x3A];
    const key = name + (sysDark ? '@d' : '@l');
    if (_menuIconCache[key]) return _menuIconCache[key];

    const N = GLYPH_SS, O = GLYPH_OUT, k = N / O;
    const m = _glyphMask(name);
    const rgba = Buffer.alloc(O * O * 4, 0);
    for (let y = 0; y < O; y++) {
      for (let x = 0; x < O; x++) {
        let acc = 0;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            if (m[(y * k + dy) * N + (x * k + dx)] > 0.5) acc++;
          }
        }
        const i = (y * O + x) * 4;
        rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2];
        rgba[i + 3] = Math.round(255 * acc / (k * k));
      }
    }
    const img = nativeImage.createFromBuffer(encodePNG(O, O, rgba));
    _menuIconCache[key] = img;
    return img;
  } catch (e) {
    log('menuIcon("' + name + '") failed: ' + (e && e.message || e));
    return null;   // 图标失败不应影响菜单可用性
  }
}

const WEEK_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/* ===== tooltip：农历 · 节气/节日 · 星期X（v1.7.2 需求 3：节气/节日合并为一组） ===== */
function trayTooltip(now) {
  const parts = [];
  let lObj = null;
  if (lunarLib && lunarLib.Solar) {
    try {
      const s = lunarLib.Solar.fromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
      lObj = s.getLunar();
      parts.push('农历' + lObj.getMonthInChinese() + '月' + lObj.getDayInChinese());
      const jq = lObj.getJieQi && lObj.getJieQi();
      const lF = lObj.getFestivals() || [];
      const sF = s.getFestivals() || [];
      const f = lF[0] || sF[0];
      // 合并"节气/节日"为一个标签：节气优先，节日次之，都有时合并显示
      const tagPieces = [];
      if (jq) tagPieces.push(jq);
      if (f) tagPieces.push(f);
      if (tagPieces.length) parts.push(tagPieces.join('·'));
    } catch (e) {}
  }
  parts.push(WEEK_CN[now.getDay()]);
  return parts.join(' · ');
}

function updateTrayTooltip() {
  // v1.7.21：托盘只在「桌面图标」形态下存在；插件形态 tray 恒为 null，直接空转
  if (!tray || dockMode !== 'icon') return;
  try {
    tray.setToolTip(trayTooltip(new Date()));
  } catch (e) {
    /* v1.7.11：托盘失效自动重建。
     * 常见场景：开机自启时 Explorer 的托盘区还没就绪、或 Explorer 中途重启，
     * 此时 Tray 对象在本进程里还在，但系统侧已经没有这个图标了，setToolTip 会抛错。
     * 每秒都会跑一次本函数，正好当看门狗用 —— 探测到失效就销毁重建。 */
    log('tray appears dead, recreating: ' + (e && e.message || e));
    try { tray.destroy(); } catch (_) {}
    tray = null;
    scheduleTrayRetry(2000);
  }
}

/* v1.7.11：托盘创建重试。首次创建失败 / 运行中被系统抹掉时按退避重试若干次。 */
let trayRetries = 0;
function scheduleTrayRetry(delay) {
  if (tray) return;
  if (dockMode !== 'icon') return;   // v1.7.21：插件形态不需要托盘图标，别再重试创建
  if (trayRetries >= 6) return;
  trayRetries++;
  setTimeout(function () {
    if (tray) return;
    log('tray retry #' + trayRetries);
    createTray();
  }, delay || 3000);
}

/* =====================================================================
 * 窗口行为
 * ---------------------------------------------------------------------
 * mini（默认）：右侧贴右沿、底部贴任务栏上沿 → 自然填在任务栏时钟正上方
 * expanded：屏幕中央、resizable=true、保持比例；blur 同样隐藏
 * ===================================================================== */
/* ===== v1.7.21 需求4：日历弹出定位（插件模式专用） =====
 * 以插件小方框自身为基准点，从「右 / 左 / 下 / 上」四个方位里挑一个能让日历**整体矩形
 * 完整落进屏幕工作区**的位置：优先选完全不需要纠偏的方位；四个方位都放不下（屏幕特别小、
 * 或插件贴在角落）时，退回"纠偏位移最小"的那个 —— 也就是自动纠偏到反方向或靠边。
 * 【工作区 = 屏幕减任务栏】Electron 的 display.workArea 已排除任务栏，
 * 所以"不压任务栏、四周不出血"这两条硬约束用同一套夹取就都满足了。 */
/* v1.7.22 需求1：日历与插件的间距改为 1px —— 视觉上紧贴无缝隙，留 1px 只是防止
 * 极少数 GPU 在无缝拼接处渲染出 1px 撕裂线。紧贴后仍走下方四方位择优 + 工作区夹取，
 * 下方空间不够时自动翻到上方紧贴（见 placeMainNearDock）。 */
const MAIN_GAP = 1;          // 日历与插件之间的留白（1px 防撕裂，视觉紧贴）
function placeMainNearDock(dockRect) {
  if (!win || win.isDestroyed() || !dockRect) return false;
  try {
    const W = MINI_W, H = MINI_H;
    const wa = screen.getDisplayMatching(dockRect).workArea;
    const maxX = wa.x + Math.max(0, wa.width - W);
    const maxY = wa.y + Math.max(0, wa.height - H);
    const cand = [
      // right / left：日历与插件**上对齐**（y 同），贴在插件左/右侧
      { n: 'right', x: dockRect.x + dockRect.width + MAIN_GAP, y: dockRect.y },
      { n: 'left',  x: dockRect.x - MAIN_GAP - W,               y: dockRect.y },
      // below / above：日历与插件**右对齐**（右边贴齐），贴在插件下/上方
      /* v1.7.22.4 修复（"弹窗没挨着插件"）：原来 below/above 用 x=dockRect.x（左对齐），
       * 插件在右下角时日历右边超界 216px 被迫左移 → 弹窗和插件水平错位一大截。
       * 改成右对齐 x=dockRect.x+dockRect.width-W，让日历右边与插件右边贴齐，
       * 插件贴右下角时弹窗能精确正上方对齐（shift=0，日志从 216 → 0）。 */
      { n: 'below', x: dockRect.x + dockRect.width - W, y: dockRect.y + dockRect.height + MAIN_GAP },
      { n: 'above', x: dockRect.x + dockRect.width - W, y: dockRect.y - MAIN_GAP - H }
    ];
    let best = null;
    for (let i = 0; i < cand.length; i++) {
      const c = cand[i];
      // 先按该方位的理想位置算，再夹回工作区；两者之差就是这个方位需要纠偏的位移
      const cx = Math.max(wa.x, Math.min(c.x, maxX));
      const cy = Math.max(wa.y, Math.min(c.y, maxY));
      const shift = Math.abs(cx - c.x) + Math.abs(cy - c.y);
      if (!best || shift < best.shift) best = { x: cx, y: cy, shift: shift, n: c.n };
      if (best.shift === 0) break;       // 这个方位完全放得下，直接用它
    }
    if (!best) return false;
    /* v1.7.22 需求3：Win11 像素补偿（默认 0）。补偿后再夹一次工作区，绝不越界。
     * v1.7.22.6 加固（Win11 高 DPI 125%/150% 的 1px 白边）：
     *   补偿值给 Math.round —— workArea 返回的 width/height 在部分高分屏上是浮点
     *   （如 1440×960 @150% 时 workArea.height 可能算出 919.999…），best.x 与其相加后
     *   直接 setBounds 会落出子像素坐标，视觉上就是"紧贴但差 1 像素白边"。
     *   另外 setBounds 也只接受整数，绕一层 Math.round 后位置确定、可复现。 */
    const compX = isWin11 ? WIN11_POS_COMP_X : 0;
    const compY = isWin11 ? WIN11_POS_COMP_Y : 0;
    const fx = Math.max(wa.x, Math.min(Math.round(best.x + compX), maxX));
    const fy = Math.max(wa.y, Math.min(Math.round(best.y + compY), maxY));
    win.setBounds({ x: fx, y: fy, width: W, height: H });
    log('main placed near dock: side=' + best.n + ' shift=' + best.shift + ' os=' + (isWin11 ? 'win11' : 'win10'));
    return true;
  } catch (e) { log('placeMainNearDock failed: ' + (e && e.message || e)); return false; }
}

function showMini() {
  if (!win) return;
  const wa = workArea();
  win.setResizable(false);
  win.setAspectRatio(0);                 // 解除比例锁定（mini 强制尺寸）
  /* v1.7.21 需求4：按显示形态分流定位
   *   插件模式 → 以插件方框为基准四方位择优（见 placeMainNearDock）
   *   图标模式 → 沿用原有逻辑（右下角、贴任务栏上沿），不做任何改变 */
  let placed = false;
  if (dockMode === 'dock' && dockOn && dockWin && !dockWin.isDestroyed() && dockWin.isVisible()) {
    /* v1.7.22.7【关键修复】：传**意图矩形**而非 getBounds()。
     * 物理窗口可能被 OS 撑大（实测 232×164 vs 意图 116×40），撑大后按 dockRect.width
     * 做右对齐会把日历推到卡片右边 100+px 之外 —— 就是"弹窗没挨着插件"。
     * 卡片渲染在窗口左上角、尺寸恒为 dockW×dockH，所以这里必须同尺寸对齐。 */
    const db = dockWin.getBounds();
    placed = placeMainNearDock({ x: db.x, y: db.y, width: dockW, height: dockH });
  }
  if (!placed) {
    win.setBounds({
      x: wa.width - MINI_W,                // 右边缘贴屏幕右沿
      y: wa.height - MINI_H,               // 底部贴任务栏上沿（wa.height = workArea 底 = 任务栏顶）
      width: MINI_W,
      height: MINI_H
    });
  }
  if (!win.isVisible()) win.show();
  win.focus();
  notifyExpandState();       // v1.7.11：告诉渲染层"现在是 mini"
  pushWinSize();             // v2.2.0：mini 宽 340 → zoom 复位
}

/* v1.7.11 严重 bug 修复（放大一直无效的真因）：
 * 点击放大按钮时，主进程确实把 OS 窗口从 340×430 撑到了 760×959，
 * 但渲染层的 #widget 始终没有被加上 `.max` 类（那段 toggle 只写在浏览器预览的 fallback 分支里），
 * 于是 #widget 仍是死死的 340×430 —— 用户看到的就是"小日历浮在大透明窗中间"，等于没放大。
 * 现在由主进程在尺寸状态变化后主动推送，渲染层只负责同步类名。 */
function notifyExpandState() {
  if (!win || !win.webContents || win.webContents.isDestroyed()) return;
  try { win.webContents.send('expand-changed', !!win.isResizable()); } catch (e) {}
}

function showExpanded() {
  if (!win) return;
  const wa = workArea();
  win.setResizable(true);
  win.setAspectRatio(ASPECT);            // 锁定宽高比（用户拖拽时保持）
  const b = win.getBounds();
  // 若当前尺寸明显小于默认 expanded，按默认居中展开；否则保留当前位置
  if (b.width < EXP_DEF_W - 40 || b.height < EXP_DEF_H - 40) {
    const x = Math.round((wa.width - EXP_DEF_W) / 2);
    const y = Math.round((wa.height - EXP_DEF_H) / 2);
    win.setBounds({ x: x, y: y, width: EXP_DEF_W, height: EXP_DEF_H });
  } else {
    // 仍校正到工作区内
    const x = Math.max(0, Math.min(b.x, wa.width - b.width));
    const y = Math.max(0, Math.min(b.y, wa.height - b.height));
    win.setBounds({ x: x, y: y, width: b.width, height: b.height });
  }
  if (!win.isVisible()) win.show();
  win.focus();
  notifyExpandState();       // v1.7.11：告诉渲染层"现在是 expanded"
  pushWinSize();             // v2.2.0：下发当前窗口宽，驱动等比缩放
}

// 托盘左键 / IPC 切换：已显示就隐藏，未显示就 mini 唤起
function toggleFromTray() {
  if (!win) return;
  guardBlur(350);
  if (win.isVisible()) {
    win.hide();
  } else {
    showMini();
    // v2.2.0 需求7：每次打开日历都回到「当前月份」（之前是停留在上次关闭时翻到的月份）。
    // 只在"手动打开"这里重置，trayGotoYm / 关注跳转走的是指定日期，不重置。
    try { setTimeout(function () { if (win && !win.isDestroyed()) win.webContents.send('reset-month'); }, 60); } catch (e) {}
  }
}

/* =====================================================================
 * 右键菜单（v1.6.2 需求 4 + 7）：
 *   1) 「本年最近节日」（标题，不可点）
 *   2) 三个节日直接列在主菜单（不再嵌子菜单）；格式：节日名  ·  MM/DD  ·  X 天
 *   3) 分隔
 *   4) 「距离特别关注 X 天」：无 → 显示「无」；有 → 显示最近一个的天数
 *   5) 主题 / 置顶 / 开机自启 / 退出
 * ===================================================================== */
function trayGotoYm(y, m, d) {
  if (win && !win.isVisible()) showMini();
  if (win) {
    win.focus();
    guardBlur(350);
    setTimeout(function () { try { win.webContents.send('goto-ym', y, m, d); } catch (e) {} }, 120);
  }
}

// 计算从 today 到 (y,m,d) 的天数差（0=今天，1=明天，-1=昨天）
function diffDaysFromToday(y, m, d) {
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(y, m - 1, d).getTime();
  return Math.round((t - today0) / 86400000);
}

// 节日日期区间文案（如 "10/1-10/7"）；holidayDateRange 表：name -> { s, e, m }
const HOLIDAY_RANGE = {
  '元旦':   { m: 1,  s: 1,  e: 3 },
  '春节':   { m: 2,  s: 15, e: 23 },
  '清明节': { m: 4,  s: 4,  e: 6 },
  '劳动节': { m: 5,  s: 1,  e: 5 },
  '端午节': { m: 6,  s: 19, e: 21 },
  '中秋节': { m: 9,  s: 25, e: 27 },
  '国庆节': { m: 10, s: 1,  e: 7 }
};

function holidayRangeLabel(h) {
  /* v2.1.0：优先查运行时的 holidays.json（联网更新后就是新数据），
   * 查不到再回退内置常量表（旧版本行为）。否则更新完日历变了、菜单文案还是旧的。 */
  let r = null;
  try { r = holidays.rangeOf(h.name, h.y); } catch (e) { r = null; }
  if (!r) r = HOLIDAY_RANGE[h.name];
  if (!r) return pad2(h.m) + '/' + pad2(h.d);
  /* v2.1.0 P2-3：跨月段（如春节 1/28–2/4）两端都要带月份，
   * 否则会退化成「01/28-31」把后半段吞掉。旧内置常量没有 em 字段 → 按同月处理。 */
  const em = (typeof r.em === 'number') ? r.em : r.m;
  if (em !== r.m) return r.m + '/' + pad2(r.s) + '-' + em + '/' + pad2(r.e);
  if (r.s === r.e) return pad2(r.m) + '/' + pad2(r.s);
  return pad2(r.m) + '/' + pad2(r.s) + '-' + pad2(r.e);
}

function buildHolidaysMenuItems() {
  const list = holidays.nextHolidaysThisYear(new Date(), 3);
  const items = [];
  // 标题（不可点）
  items.push({ label: '本年最近节日', icon: menuIcon('sparkle'), enabled: false });
  if (list.length === 0) {
    items.push({ label: '　无', enabled: false });
    return items;
  }
  for (const h of list) {
    const lead = h.diffDays === 0 ? '今天'
              : h.diffDays === 1 ? '明天'
              : h.diffDays + ' 天';
    items.push({
      label: '　' + h.name + ' · ' + holidayRangeLabel(h) + '  ·  ' + lead,
      icon: menuIcon('goto'),
      click: function () { trayGotoYm(h.y, h.m, h.d); }
    });
  }
  return items;
}

// "特别关注" 一级 + 二级列表（v1.7.9 需求 5：改为二级菜单模式）
// 一级：标题 "📒 特别关注 (N)" + "查看/管理 (N)..."（弹主窗的关注列表弹窗）
// 二级：每项 = 日期 · 内容摘要 · 距离天数，点击 = 跳到该日（删除走主窗的弹窗）
function buildReminderMenuItems() {
  const items = [];
  const today = new Date();
  const todayKey = today.getFullYear() + '-' + pad2(today.getMonth() + 1) + '-' + pad2(today.getDate());
  if (reminders.length === 0) {
    items.push({ label: '特别关注（无）', icon: menuIcon('bookmark'), enabled: false });
    return items;
  }
  const sorted = reminders.slice().sort(function (a, b) {
    const ka = (a.y - today.getFullYear()) * 10000 + (a.m - today.getMonth() - 1) * 100 + a.d;
    const kb = (b.y - today.getFullYear()) * 10000 + (b.m - today.getMonth() - 1) * 100 + b.d;
    return ka - kb;
  });
  // 找最近的未来一个（用于顶部概览）
  const future = sorted.filter(function (r) {
    return (r.y + '-' + pad2(r.m) + '-' + pad2(r.d)) >= todayKey;
  });
  let headLine = '特别关注（' + reminders.length + '）';
  if (future.length > 0) {
    const near = future[0];
    const diff = diffDaysFromToday(near.y, near.m, near.d);
    const distText = diff === 0 ? '今天' : diff === 1 ? '明天' : diff + ' 天';
    headLine += ' · 最近 ' + near.y + '/' + pad2(near.m) + '/' + pad2(near.d) +
                '（' + distText + '）';
  }
  // 一级标题
  items.push({ label: headLine, icon: menuIcon('bookmark'), enabled: false });
  // v1.7.17 需求3：合并「查看/管理」与「查看/跳转」为单一父项，
  // 二级菜单 = 打开管理窗口 + 全部关注项（点击跳转到该日）
  items.push({
    label: '查看 / 管理特别关注（' + reminders.length + '）',
    icon: menuIcon('list'),
    submenu: (function () {
      const sub = [];
      sub.push({ label: '打开管理窗口', icon: menuIcon('window'), click: function () { openReminderListWindow(); } });
      sub.push({ type: 'separator' });
      sorted.forEach(function (r) {
        const dd = diffDaysFromToday(r.y, r.m, r.d);
        const k = r.y + '-' + pad2(r.m) + '-' + pad2(r.d);
        const isPast = k < todayKey;
        const dist = isPast ? '已过 ' + (-dd) + ' 天' : dd === 0 ? '今天' : dd === 1 ? '明天' : dd + ' 天';
        sub.push({
          label: r.y + '/' + pad2(r.m) + '/' + pad2(r.d) +
                 '  ·  ' + r.text.slice(0, 18) + (r.text.length > 18 ? '…' : '') +
                 '  ·  ' + dist,
          icon: menuIcon('goto'),
          click: function () { trayGotoYm(r.y, r.m, r.d); }
        });
      });
      return sub;
    })()
  });
  return items;
}

function toggleTheme() {
  // v2.4.0 第二轮：托盘菜单「主题」= 日历表面 native light↔dark 快捷切换。
  var cal = skin.surfaces.calendar;
  if (cal.type === 'system') cal.type = (themeMode === 'dark') ? 'light' : 'dark';
  else cal.type = (cal.type === 'dark') ? 'light' : 'dark';
  cal.color = null; cal.image = null; cal.text = 'auto';
  recomputeTheme();
  pushThemeToAll();
  pushSkinToAll();
  saveSettings();
  refreshTrayMenu();
}
function togglePinned() {
  pinned = !pinned;
  if (win) win.setAlwaysOnTop(pinned);
  saveSettings();
  refreshTrayMenu();
}
function toggleAutoLaunch() {
  autoLaunch = !autoLaunch;
  try { app.setLoginItemSettings({ openAtLogin: autoLaunch, path: process.execPath }); } catch (e) {}
  saveSettings();
  refreshTrayMenu();
}
/* ===== v1.7.21 需求2：显示形态切换（桌面插件 ⇄ 桌面图标） =====
 *   'dock' 桌面插件 —— 可拖动的浮动小方框（默认）
 *   'icon' 桌面图标 —— 关闭并隐藏插件，只在系统托盘留一个静态图标；
 *                      左键单击该图标 → 销毁托盘图标 + 插件回到之前的位置重新显示
 * 说明：两种形态互斥，同一时刻只会有一个在显示。 */
function setDockMode(mode) {
  if (mode !== 'dock' && mode !== 'icon') return;
  if (dockMode === mode) return;
  const prev = dockMode;
  dockMode = mode;
  saveSettings();
  log('dock mode: ' + prev + ' -> ' + mode);
  applyDockMode();
  refreshTrayMenu();
}

function applyDockMode() {
  if (dockMode === 'icon') {
    // 收起插件 → 显示托盘静态图标
    if (dockWin && !dockWin.isDestroyed()) { try { dockWin.hide(); } catch (e) {} }
    createTray();
  } else {
    // 显示插件 → 收起托盘静态图标
    destroyTray();
    if (!dockWin) {
      dockRecreateCount = 0;
      dockCrashed = false;
      createDock();
    }
    if (dockWin && !dockWin.isDestroyed()) {
      // v1.7.21 需求2：回到之前的位置（有记录就恢复，没有就用默认位置）。
      /* v1.7.22.3 修复（与 ready-to-show 同源）：只取 x/y，尺寸强制用窗口真实宽高，
       * 防止旧版错写的非 116×50 尺寸（典型如 350×178）再次把窗口撑大。 */
      const restoreRect = pickDockRestore(
        (typeof screen.getAllDisplays === 'function') ? screen.getAllDisplays() : [],
        dockBoundsByDisplay, dockDisplayId, dockBounds);
      if (restoreRect) {
        try {
          dockWin.setBounds(dockClamped(restoreRect.x, restoreRect.y));
        } catch (e) {}
      } else {
        positionDock();
      }
      try { dockWin.show(); } catch (e) {}
    }
  }
}

/* 销毁托盘图标并停掉它的 tooltip 看门狗定时器（切回插件模式时调用）。 */
function destroyTray() {
  if (trayTooltipTimer) { clearInterval(trayTooltipTimer); trayTooltipTimer = null; }
  if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
  trayRetries = 0;
}

/* ===== v1.7.21 需求3：把插件矩形夹进「屏幕工作区」 =====
 * workArea = 屏幕可用区域（Electron 已自动减去任务栏），
 * 所以任意一条边都不可能越出屏幕或压到任务栏。多显示器时按插件当前所在那块屏取工作区。 */
function clampDockToWorkArea(b) {
  try {
    const wa = screen.getDisplayMatching(b).workArea;
    const maxX = wa.x + Math.max(0, wa.width - b.width);
    const maxY = wa.y + Math.max(0, wa.height - b.height);
    return {
      x: Math.max(wa.x, Math.min(b.x, maxX)),
      y: Math.max(wa.y, Math.min(b.y, maxY)),
      width: b.width,
      height: b.height
    };
  } catch (e) { return b; }
}

/* v1.7.22.7：插件定位的唯一入口 —— 给定左上角 (x,y)，按**意图尺寸** dockW×dockH 夹进
 * 工作区，返回可直接交给 setBounds 的对象。
 * 所有插件定位都必须走这里，禁止再手写 `width: getBounds().width`：物理窗口可能被 OS
 * 撑大（实测 232×164 vs 意图 116×40），一旦用撑大的尺寸算 maxX/maxY，可拖动范围就被
 * 压缩一大截，表现为"拖不到底 / 拖不到右 / 卡在半空"。 */
function dockClamped(x, y) {
  return clampDockToWorkArea({ x: x, y: y, width: dockW, height: dockH });
}

/* v2.4.0 A3：按显示器 ID 选择要恢复的插件落点（纯函数，便于运行时单测）。
 * 优先级：① dockDisplayId 对应屏还有记录且屏仍存活 → 原屏原位；
 *         ② 任一存活屏上有记录 → 按屏顺序回退（换机/ID 变化）；
 *         ③ 旧式单一 dockBounds；都无 → null（调用方走 positionDock 默认落点）。 */
function pickDockRestore(displays, map, displayId, fallbackRect) {
  let rect = null;
  if (displays && map) {
    if (displayId !== null && displayId !== undefined && map[String(displayId)]) {
      let alive = false;
      for (let i = 0; i < displays.length; i++) {
        if (String(displays[i].id) === String(displayId)) { alive = true; break; }
      }
      if (alive) rect = map[String(displayId)];
    }
    if (!rect) {
      for (let j = 0; j < displays.length; j++) {
        const k = String(displays[j].id);
        if (map[k]) { rect = map[k]; break; }
      }
    }
  }
  if (!rect) rect = fallbackRect;
  return rect;
}

/* 挂件条总开关：关闭后插件与托盘图标都不显示。仅 hide 不销毁；
 * 重新开启时若窗口没了就重建，并清零崩溃计数让配额重置。 */
function toggleDock() {
  dockOn = !dockOn;
  saveSettings();
  if (dockOn) {
    applyDockMode();
  } else {
    if (dockWin && !dockWin.isDestroyed()) { try { dockWin.hide(); } catch (e) {} }
    destroyTray();
  }
  refreshTrayMenu();
}

/* v1.7.21：插件置顶开关。置顶等级固定用 'floating'（低于 'screen-saver'），
 * 不会跟全屏游戏/视频抢最高层；真遇到被挡的情况用户可在这里一键关掉置顶。 */
function toggleDockPinned() {
  dockPinned = !dockPinned;
  saveSettings();
  if (dockWin && !dockWin.isDestroyed()) {
    try { dockWin.setAlwaysOnTop(dockPinned, 'floating'); } catch (e) {}
  }
  refreshTrayMenu();
  pushSettingsState();
}

/* ===== v2.2.0 需求4：桌面插件（日历板块桌面工具） ===== */
function desktopClamped(x, y) {
  return clampDockToWorkArea({ x: x, y: y, width: DESKTOP_W, height: DESKTOP_H });
}
// 锁定状态 → 渲染层（锁图标 / 是否可拖）
function pushDesktopState() {
  if (desktopWin && desktopWin.webContents && !desktopWin.webContents.isDestroyed()) {
    try { desktopWin.webContents.send('desktop-locked', desktopLocked); } catch (e) {}
  }
}
function createDesktopWidget() {
  if (desktopWin) return;
  try {
    desktopWin = new BrowserWindow({
      width: DESKTOP_W, height: DESKTOP_H,
      frame: false, transparent: true, resizable: false,
      alwaysOnTop: false, skipTaskbar: true,
      backgroundColor: '#00000000', show: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
    });
    desktopWin.loadFile(path.join(__dirname, 'calendar.html'), { query: { mode: 'desktopWidget' } });
    desktopWin.webContents.on('did-finish-load', function () {
      pushSkinToDesktop();   // v2.4.0 第二轮：桌面插件皮肤（skin-state 含 theme + 背景层）
      pushDesktopState();
    });
    desktopWin.once('ready-to-show', function () {
      try {
        if (desktopBounds) desktopWin.setBounds(desktopClamped(desktopBounds.x, desktopBounds.y));
        else desktopWin.center();
        desktopWin.setOpacity(skin.opacity.desktop);   // v2.4.0 第二轮：透明度读 skin.opacity
        desktopWin.show();
      } catch (e) {}
    });
    // v2.4.0 A-bug1：桌面插件窗口外点击 → 下发 win-hidden → 渲染层 clearRange（只清 range、不隐藏）。
    desktopWin.on('blur', function () {
      try {
        if (desktopWin && desktopWin.webContents && !desktopWin.webContents.isDestroyed()) desktopWin.webContents.send('win-hidden');
      } catch (e) {}
    });
    // 拖动结束记位置（防抖写 settings）
    desktopWin.on('moved', function () {
      clearTimeout(_desktopSaveTimer);
      _desktopSaveTimer = setTimeout(function () {
        if (!desktopWin || desktopWin.isDestroyed()) return;
        try { desktopBounds = desktopWin.getBounds(); saveSettings(); } catch (e) {}
      }, 400);
    });
    desktopWin.on('closed', function () { desktopWin = null; });
    log('desktop widget created OK');
  } catch (e) {
    log('desktop widget FAILED: ' + (e && e.stack || e));
    desktopWin = null;
  }
}
function toggleDesktop() {
  desktopOn = !desktopOn;
  saveSettings();
  if (desktopOn) {
    createDesktopWidget();
  } else {
    if (desktopWin && !desktopWin.isDestroyed()) { try { desktopWin.destroy(); } catch (e) {} }
    desktopWin = null;
  }
  refreshTrayMenu();
  pushSettingsState();
}

/* ===== v2.2.0 需求5：设置弹窗 =====
 * 菜单瘦身后，主题/置顶/自启/挂件条开关/形态/插件置顶/桌面插件/检查更新/透明度
 * 全部收进这个独立卡片弹窗。主进程是唯一真相：每个操作执行完 pushSettingsState()，
 * 弹窗只渲染收到的状态，保证与菜单、主窗实时一致。 */
let settingsWin = null;
let skinWin = null;             // v2.4.0 第二轮：独立皮肤设置窗口
function settingsSnapshot() {
  return {
    theme: baseTheme(),        // 设置窗自身主题跟随日历表面基准
    pinned: pinned,
    autoLaunch: autoLaunch,
    dockOn: dockOn,
    dockMode: dockMode,
    dockPinned: dockPinned,
    desktopOn: desktopOn,
    desktopLocked: desktopLocked,
    mainVisible: !!(win && win.isVisible())
  };
}
function pushSettingsState() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    try { settingsWin.webContents.send('settings-state', settingsSnapshot()); } catch (e) {}
  }
}
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    try { settingsWin.focus(); } catch (e) {}
    pushSettingsState();
    return;
  }
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const W = 360, H = 600;
  settingsWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round((wa.width - W) / 2),
    y: Math.round((wa.height - H) / 2),
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#00000000', show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  settingsWin.setAlwaysOnTop(true, 'screen-saver');
  settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { theme: themeMode } });
  settingsWin.once('ready-to-show', function () {
    try { settingsWin.show(); pushSettingsState(); } catch (e) {}
  });
  settingsWin.on('closed', function () { settingsWin = null; });
}

/* v2.4.0 第二轮：独立皮肤设置窗口（skin.html）。复用 settings.html 的卡片窗范式，
 * 自身不应用皮肤背景，只跟随基准主题 baseTheme()。 */
function openSkinWindow() {
  if (skinWin && !skinWin.isDestroyed()) {
    try { skinWin.focus(); } catch (e) {}
    pushSkinConfigState();
    return;
  }
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const W = 520, H = 620;
  skinWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round((wa.width - W) / 2),
    y: Math.round((wa.height - H) / 2),
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#00000000', show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  skinWin.setAlwaysOnTop(true, 'screen-saver');
  skinWin.loadFile(path.join(__dirname, 'skin.html'), { query: { theme: baseTheme() } });
  skinWin.once('ready-to-show', function () {
    try { skinWin.show(); pushSkinConfigState(); } catch (e) {}
  });
  skinWin.on('closed', function () { skinWin = null; });
}

function buildTrayMenu() {
  /* v1.7.11 严重 bug 修复（托盘右键菜单两轮都没修好的真因）：
   * 这里原来写成 `const menu = []` 后又 `menu = menu.concat(...)` 重新赋值，
   * 运行时抛 "TypeError: Assignment to constant variable."，
   * 而调用方 createTray() / refreshTrayMenu() 都把它包在 try/catch 里静默吞掉，
   * 结果 = 托盘对象建好了，但**右键菜单从来没有设置成功过** → 右键点击毫无反应。
   * node --check 只做语法检查，查不出 const 重复赋值（属运行时错误），所以一直漏网。
   * 必须改成 let（或 push 展开）。 */
  let menu = [];
  // 节气（标题 + 三个节日扁平）
  menu = menu.concat(buildHolidaysMenuItems());
  menu.push({ type: 'separator' });
  // 关注
  menu = menu.concat(buildReminderMenuItems());
  menu.push({ type: 'separator' });
  /* v2.2.0 需求5：右键菜单瘦身 —— 只保留「最近节日 / 特别关注 / 显示隐藏日历 / 设置 / 退出」，
   * 主题/置顶/自启/挂件条开关/形态/插件置顶/桌面插件/检查更新/透明度 全部收进「设置」弹窗。 */
  menu.push({ label: '显示 / 隐藏日历', icon: menuIcon('calendar'), click: function () { toggleFromTray(); } });
  menu.push({ label: '设置…', icon: menuIcon('settings'), click: function () { openSettingsWindow(); } });
  menu.push({ type: 'separator' });
  menu.push({ label: '退出软件', icon: menuIcon('power'), click: function () { requestExit(); } });
  return Menu.buildFromTemplate(menu);
}

function refreshTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(buildTrayMenu());
  } catch (e) {
    // v1.7.11：不再静默吞掉，写日志
    log('refreshTrayMenu failed: ' + (e && e.stack || e));
  }
}

/* v1.7.2 需求 2：icon.ico 仍用于 EXE 图标、任务栏固定图标、控制面板图标（皆同一份）。
 * 但托盘图标改用 makeTrayIcon('light'/'dark') 程序生成的 PNG：，
 *   1) ICO 多分辨率在 Windows nativeImage 上解析可能失败 → DEFAULT_TRAY=null → new Tray(null) 静默抛错，
 *      导致托盘"创建后无效"（左右键点击都没反应，这是用户 2026-09-02 报告的严重 bug）；
 *   2) 程序生成的 32×32 PNG 渲染稳定，且能按 themeMode 自动反色，保持黑夜任务栏可读。 */
const LOGO_ICO = path.join(__dirname, 'icon.ico');
let DEFAULT_TRAY = null;
try {
  const buf = fs.readFileSync(LOGO_ICO);
  DEFAULT_TRAY = nativeImage.createFromBuffer(buf);
  if (DEFAULT_TRAY.isEmpty()) DEFAULT_TRAY = null;
} catch (e) { DEFAULT_TRAY = null; }

/* ⚠️ 请勿删除 makeTrayIcon / encodePNG（v1.7.22.6 复核结论：不是冗余代码）
 * ---------------------------------------------------------------------------
 * 曾有人建议"托盘直接用 nativeImage.createFromPath('icon.ico')，删掉这个 PNG 编码器"。
 * 实测不可行 —— 这里的代码**正在被使用**（见下方 trayIconByTheme 的 makeTrayIcon 调用
 * 与 DEFAULT_TRAY 的 createFromBuffer）。之所以不用 ICO 直读：
 *   1) ICO 内含多分辨率，Windows nativeImage 解析时可能整体失败 → DEFAULT_TRAY=null
 *      → new Tray(null) 静默抛错 → 托盘"创建成功但点击无反应"（用户 2026-09-02 报的严重 bug）；
 *   2) 程序生成的 32×32 PNG 渲染稳定，且能按 themeMode 自动反色，黑夜任务栏下仍可读。
 * 删除它 = 把已经修过的托盘崩溃 bug 原样请回来。要动必须先改 trayIconByTheme 的实现。 */
function trayIconByTheme() {
  // v1.7.9（修复严重 bug）：托盘图标统一走程序生成的 PNG，
  // 不再依赖 icon.ico 的 nativeImage 解析。轻量 fallback：若 makeTrayIcon 抛错，
  // 才退回到 ICO 解出的 nativeImage（此时不一定可靠，但比抛 null 强）。
  try {
    const png = makeTrayIcon(themeMode === 'dark' ? 'dark' : 'light');
    if (png && !png.isEmpty()) return png;
  } catch (e) {}
  if (DEFAULT_TRAY && !DEFAULT_TRAY.isEmpty()) return DEFAULT_TRAY;
  // 兜底：返回一个 1×1 不透明图，至少不让 Tray() 抛 null
  return nativeImage.createFromBuffer(encodePNG(1, 1, Buffer.from([0, 0, 0, 0xff])));
}

function createTray() {
  if (tray) return;
  if (dockMode !== 'icon') return;   // v1.7.21：只有「桌面图标」形态才需要托盘图标
  try {
    tray = new Tray(trayIconByTheme());
    log('tray created OK');
  } catch (e) {
    // v1.7.11：既写 stderr（开发期可见）也写日志（打包后可见），并排重试
    log('tray create FAILED: ' + (e && e.stack || e));
    try { process.stderr.write('[calendar] tray create failed: ' + (e && e.message || e) + '\n'); } catch (_) {}
    tray = null;
    scheduleTrayRetry(3000);
    return;   // 不退出应用 —— 主窗与任务栏挂件条仍可用
  }
  try {
    tray.setToolTip(trayTooltip(new Date()));
    tray.setContextMenu(buildTrayMenu());
    log('tray menu attached OK');
  } catch (e) {
    log('tray setup FAILED: ' + (e && e.stack || e));
    try { process.stderr.write('[calendar] tray setup failed: ' + (e && e.message || e) + '\n'); } catch (_) {}
  }
  /* v1.7.21 需求2：**只绑 click，不再同时绑 double-click** —— 两个事件一起绑会互相打架：
   * 双击时 click 先触发一次、double-click 再触发一次，等于切换两下 = 看起来点了没反应。
   * 图标模式下：左键单击 = 销毁托盘图标 + 插件回到之前的位置重新显示（见 setDockMode）。 */
  try {
    tray.on('click', function () {
      if (dockMode === 'icon') setDockMode('dock');
      else toggleFromTray();
    });
  } catch (e) {}
  // tooltip 每秒刷新（日期/农历/星期变化）；同时充当托盘存活看门狗（见 updateTrayTooltip）
  if (!trayTooltipTimer) trayTooltipTimer = setInterval(updateTrayTooltip, 1000);
}
let trayTooltipTimer = null;

/* =====================================================================
 * 主窗
 * ===================================================================== */
let mainClampLock = false;   // v2.3.2：放大模式拖动夹取防重入标志（move→setBounds→move 短路）
/* v2.4.0 A1/A2：隐藏主窗的唯一收口。blur / 插件 toggle / 关闭 都走这里；win-hidden 由 'hide' 事件统一下发。 */
function hideMain() {
  if (!win || win.isDestroyed()) return;
  try { win.hide(); } catch (e) {}
}
function createWindow() {
  win = new BrowserWindow({
    width: MINI_W, height: MINI_H,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: pinned, skipTaskbar: true,
    backgroundColor: '#00000000', titleBarStyle: 'hidden', show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile(path.join(__dirname, 'calendar.html'));
  try { win.setOpacity(skin.opacity.calendar); } catch (e) {}   // v2.4.0 第二轮：日历透明度读 skin.opacity

  win.webContents.on('did-finish-load', function () {
    pushSkinToRenderer();   // v2.4.0 第二轮：首帧应用皮肤（skin-state 含 theme + 背景层）
    // v1.7.11：页面就绪时同步一次尺寸状态（mini / expanded），
    // 否则渲染层可能错过启动时那次 notifyExpandState，导致 .max 类不同步。
    setTimeout(notifyExpandState, 60);
  });

  // 关闭 = 隐藏（除非 isQuiting 已设置）
  win.on('close', function (e) {
    if (app.isQuiting) return;
    e.preventDefault();
    win.hide();
  });
  // v2.4.0 A2：窗口隐藏统一下发 win-hidden（渲染层收到即 clearRange 清除算天数残留）。
  // 统一挂在 'hide' 事件上，覆盖 blur 隐藏 / close 隐藏 / 插件 toggle 隐藏所有路径。
  win.on('hide', function () {
    try {
      if (win && win.webContents && !win.webContents.isDestroyed()) win.webContents.send('win-hidden');
    } catch (e) {}
  });
  // v2.4.0 A1：窗口显示时清空 blur grace（显示即已获得焦点，此后真实 blur 应正常隐藏）
  win.on('show', function () { blurGraceUntil = 0; });
  // 需求 2 / 3：blur = 隐藏（点击主体外消失；放大后点击外面也消失）
  /* v2.4.0 A-bug2 修复：删除 BrowserWindow.getFocusedWindow() 这条过于宽松的判断（点空白桌面/
   * 任务栏时它仍会返回陈旧/自身/置顶 dock 窗口 → 误判"焦点仍在本应用"而漏 hideMain）。
   * 改为显式逐个 isFocused() 判定已知兄弟窗口，全部不在焦点才隐藏。guardBlur 保留给菜单/唤起。 */
  win.on('blur', function () {
    if (Date.now() < blurGraceUntil) return;
    try {
      if (dockWin && !dockWin.isDestroyed() && dockWin.isFocused()) return;
      if (desktopWin && !desktopWin.isDestroyed() && desktopWin.isFocused()) return;
      if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused()) return;
      if (skinWin && !skinWin.isDestroyed() && skinWin.isFocused()) return;
      if (remindlistWin && !remindlistWin.isDestroyed() && remindlistWin.isFocused()) return;
      if (reminderWin && !reminderWin.isDestroyed() && reminderWin.isFocused()) return;
    } catch (e) {}
    hideMain();
  });
  // v2.2.0 需求2：系统拖拽窗口边框（resizable）时实时下发新宽，内容等比缩放跟随
  win.on('resize', function () {
    try { pushWinSize(); } catch (e) {}
  });
  // v2.3.2 需求2：放大模式（resizable）拖动窗口时夹进工作区 —— 不越屏幕/任务栏。
  // 复用 clampDockToWorkArea（按窗口所在屏取 workArea，多显示器自动适配）。
  // move 在拖动中连续触发，mainClampLock 防重入；setBounds 回写会再触发一次 move，靠标志位短路。
  win.on('move', function () {
    if (mainClampLock) return;
    if (!win.isResizable()) return;   // 仅放大模式夹取，mini 保持原生拖动行为
    try {
      const b = win.getBounds();
      const c = clampDockToWorkArea(b);
      if (c.x !== b.x || c.y !== b.y) {
        mainClampLock = true;
        try { win.setBounds({ x: c.x, y: c.y, width: b.width, height: b.height }); } catch (e) {}
        mainClampLock = false;
      }
    } catch (e) {}
  });
  win.on('closed', function () { win = null; });
}

/* v2.2.0 需求2：把主窗物理宽高下发渲染层，驱动放大模式的 CSS zoom 等比缩放。
 * getBounds() 拿到的是物理窗口尺寸（不受页面 zoom 影响），渲染层据此算 --uizoom。 */
function pushWinSize() {
  if (win && win.webContents && !win.webContents.isDestroyed()) {
    try {
      const b = win.getBounds();
      win.webContents.send('win-size', { width: b.width, height: b.height });
    } catch (e) {}
  }
}

/* =====================================================================
 * v1.7.11 任务栏挂件条（dock）
 * ---------------------------------------------------------------------
 * 关于"能不能做成真正的任务栏插件"：
 *   - Windows 10 1809 起废弃 DeskBands（IDeskBand），Win11 彻底移除任务栏工具栏扩展点；
 *   - 现存的第三方方案（ExplorerPatcher 等）都是注入 Explorer 进程，不可能作为独立软件分发；
 *   - 所以这里用"贴着任务栏上沿右侧的置顶无边框窗口"做到视觉与交互上的等价：
 *     高度对齐任务栏、始终在最前、不进任务栏、左键开/关日历、右键弹与托盘同一份菜单。
 * ===================================================================== */
/* ===== v1.7.20：启动时清理残留的多份进程 =====
 * 历史版本（v1.7.13~19）的崩溃循环可能在用户机器上留下 4~5 个「早就挂着」的旧实例；
 * Electron 单实例锁只对新启动的实例生效，对它们无可奈何，所以这里主动扫一次。
 *
 * 【v1.7.20 首版的严重 bug —— 勿重犯，血的教训】
 *   首版写法：tasklist 列出所有 SimpleCalendar.exe → 跳过自己 → 其余全部 taskkill。
 *   错在哪：tasklist 是**异步**的，等它返回（实测 ~400ms）时，Electron 早已 fork 出
 *   渲染进程 / GPU 进程 / utility 进程，而这些子进程的可执行文件**同样叫 SimpleCalendar.exe**，
 *   于是被当成"残留"全部杀掉 —— 表现为挂件条刚建好就白屏、或拖一下就消失。
 *   日志铁证（v1.7.20 首次打包实测）：
 *     [..43.571] dock created OK
 *     [..43.972] cleanup: killing 4 stale peer(s): 19460,21956,12580,17152
 *                 ↑ 这 4 个全是自己刚生的子进程，杀完主进程也随之退出
 *   推论：**任何"按进程名批量清理"的写法在本程序上都是错的**，因为 Electron 一进程多实例。
 *
 * 【正确做法】按父子关系过滤：Electron 的所有子进程都是主进程（自己）的直接/间接子进程，
 *   先求"自己 + 自己的子孙"的传递闭包，只杀闭包之外的同名进程。
 *   残留的旧实例其 PPID 是 explorer.exe（或已失效的 PID），天然落在闭包之外 → 精准命中。
 * 安全网：拿不到父子关系（PowerShell/CIM 不可用）就**放弃清理**——宁可留着旧进程，
 *   也绝不能误杀自己的渲染进程。 */
function cleanupStaleInstances() {
  try {
    // 用 CIM 拿 PID + 父 PID（tasklist 不给父 PID，所以不能用它）
    const args = ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'SimpleCalendar.exe\'" | ' +
      'ForEach-Object { Write-Output ($_.ProcessId.ToString() + \' \' + $_.ParentProcessId.ToString()) }'];
    const ps = spawn('powershell.exe', args, { windowsHide: true, timeout: 15000 });
    let out = '';
    ps.stdout.on('data', function (d) { out += d.toString(); });
    ps.on('error', function (e) {
      log('cleanup: powershell unavailable, skip cleanup: ' + (e && e.message || e));
    });
    ps.on('close', function (code) {
      const rows = out.split(/\r?\n/)
        .map(function (l) { return l.trim(); })
        .filter(Boolean)
        .map(function (l) { const m = /^(\d+)\s+(\d+)$/.exec(l); return m ? { pid: m[1], ppid: m[2] } : null; })
        .filter(Boolean);
      // 拿不到任何 PID/PPID 就放弃清理（绝不冒险误杀）
      if (rows.length === 0) {
        log('cleanup: no process info, skip (exit=' + code + ')');
        return;
      }

      // 以自己为根求子孙传递闭包
      const childrenOf = {};
      rows.forEach(function (r) { (childrenOf[r.ppid] = childrenOf[r.ppid] || []).push(r.pid); });
      const mine = {};
      mine[String(myProcessPid)] = true;
      const queue = [String(myProcessPid)];
      while (queue.length) {
        const cur = queue.shift();
        (childrenOf[cur] || []).forEach(function (c) {
          if (!mine[c]) { mine[c] = true; queue.push(c); }
        });
      }

      const stale = rows
        .map(function (r) { return r.pid; })
        .filter(function (p) { return !mine[p]; });
      if (stale.length === 0) { log('cleanup: no stale peers (self tree only)'); return; }
      log('cleanup: killing ' + stale.length + ' stale peer(s): ' + stale.join(','));
      try {
        spawn('taskkill.exe', ['/F', '/PID'].concat(stale), { windowsHide: true, timeout: 8000 });
      } catch (e) { log('cleanup: taskkill spawn failed: ' + (e && e.message || e)); }
    });
  } catch (e) {
    log('cleanup: failed: ' + (e && e.message || e));
  }
}

function taskbarHeight() {
  try {
    const d = screen.getPrimaryDisplay();
    const diff = d.bounds.height - d.workArea.height;
    // 任务栏在底部时高度差即任务栏高度；异常值（任务栏隐藏/在侧边/自动隐藏）回落 48
    return (diff > 20 && diff < 140) ? diff : 48;
  } catch (e) { return 48; }
}

/* 插件的**默认位置**：工作区右下角、紧贴任务栏上沿（v1.7.11 浮动方案的核心落点）。
 * 注意这是"默认/复位"，不是"吸附" —— v1.7.21 需求6 已删除松手自动吸附，
 * 用户拖到哪就停在哪（只受需求3 的工作区边界约束）。 */
function positionDock() {
  if (!dockWin || dockWin.isDestroyed()) return;
  try {
    const d = screen.getPrimaryDisplay();
    const wa = d.workArea;
    // v1.7.21 需求3：算完再夹一次工作区，多显示器/任务栏在侧边时也不会跑出屏幕
    /* v1.7.22.4 修复：右边距 8 → 0（完全贴屏幕右边，与拖动边界 clamp 的 maxX 一致，
     * 消除"没吸附"感）。卡片阴影向右被屏幕边缘裁掉即可接受；底部 y 仍 = workArea 底 -
     * 插件高 = 正好压任务栏上沿。
     * v1.7.22.7：宽高改用 dockW/dockH（意图尺寸）。若用 getBounds()，物理窗口被 OS 撑大后
     * 算出的落点会让卡片离右沿/任务栏差一大截。 */
    const next = dockClamped(
      Math.round(wa.x + wa.width - dockW),                                // 完全贴工作区右沿
      Math.round(wa.y + wa.height - dockH)                                // 正好压在任务栏上沿
    );
    dockWin.setBounds(next);
  } catch (e) { log('positionDock failed: ' + (e && e.message || e)); }
}

/* ===== "嵌入任务栏"方案已于 v1.7.20 彻底废除，v1.7.21 起相关代码全部不存在 =====
 * 历史教训（别再走回头路）：v1.7.13~19 共 7 次尝试 SetWindowLong(...|WS_CHILD) + SetParent(ReBarWindow32)
 * 真嵌入任务栏，每次都被 Chromium 反噬 —— 渲染线程在自身 HWND 被改父为 WS_CHILD 后做 surface tree
 * 自检，失败就主动 kill 自己（render-process-gone reason=killed，v1.7.19 已删 setSize 仍照崩）。
 * 结论：只要嵌入就必崩，与 setSize 无关。现方案 = v1.7.11 浮动窗 + 固定像素布局，永不自杀。
 * 已删除：attachDockToTaskbar / verifyDockEmbedded / detachDock / scheduleDockVerify /
 *         runDockScript / dockAttachScriptPath / systemPrefersDark / pushDockEmbedded / dockHwnd，
 *         状态 dockEmbedded / dockAttachTries / dockRehealCount / dockNoEmbed，IPC dock-embedded，
 *         脚本文件 dock-attach.ps1（package.json 的 extraResources 同步移除）。 */

/* v1.7.20：把物理窗口的真实宽高告诉 dock.html，让它用「固定像素」布局。
 * 浮动方案下 Chromium viewport 不再被 SetParent 错算，但 transparent + 无边框 + 极小尺寸
 * （116×40）这套组合仍有可能让首帧按 16px viewport 渲染出椭圆/被裁 —— 因此固定像素布局在
 * 浮动态依然必要，作为任何情况下的兜底。did-finish-load / ready-to-show / size-changed
 * 三处补发，确保第一次和后续尺寸变化都覆盖到。 */
function pushDockSize() {
  if (!dockWin || dockWin.isDestroyed() || !dockWin.webContents) return;
  try {
    /* v1.7.22.7【关键修复】：下发 dockW/dockH（意图尺寸），不再用 dockWin.getBounds()。
     * 物理窗口若被 OS 撑大（实测 232×164），旧写法会把这个错误尺寸发给页面，
     * 卡片本身也被渲染成大方块 —— 这是"插件看着不对"的直接原因。
     * 卡片始终按 116×dockH 渲染，多出来的物理窗口部分只是透明区。 */
    dockWin.webContents.send('dock-size', { w: dockW, h: dockH });
  } catch (e) { log('pushDockSize failed: ' + (e && e.message || e)); }
}

function createDock() {
  if (dockWin) return;
  try {
    // 高度对齐任务栏（夹在 40~56 之间），让它看起来像任务栏的一部分而不是悬浮块
    const tb = taskbarHeight();
    dockH = Math.max(40, Math.min(tb, 56));
    dockW = DOCK_W;
    dockWin = new BrowserWindow({
      width: dockW, height: dockH,
      frame: false, transparent: true, resizable: false,
      alwaysOnTop: dockPinned, skipTaskbar: true,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
    });
    /* v1.7.22.7 自诊断：把「请求尺寸 vs 实际尺寸」写进日志。
     * 若实际被撑大（实测出现过 232×164），日志会明确记录下来，后续可据此定位。 */
    try {
      const real = dockWin.getBounds();
      if (real.width !== dockW || real.height !== dockH) {
        log('dock size INFLATED by OS: requested ' + dockW + 'x' + dockH +
            ' but got ' + real.width + 'x' + real.height +
            ' (transparent overhang is harmless; layout/clamp still use ' + dockW + 'x' + dockH + ')');
      }
    } catch (e) {}
    /* v1.7.22.7：任何非预期的尺寸变化都记一笔，便于定位"尺寸漂移"。
     * 不做强制回弹 —— 回弹会和 OS 的最小尺寸限制打架，触发 resize 死循环。 */
    dockWin.on('resize', function () {
      try {
        const r = dockWin.getBounds();
        if (r.width !== dockW || r.height !== dockH) {
          log('dock resized to ' + r.width + 'x' + r.height + ' (intended ' + dockW + 'x' + dockH + ')');
        }
      } catch (e) {}
    });
    dockWin.loadFile(path.join(__dirname, 'dock.html'));
    try { dockWin.setOpacity(skin.opacity.dock); } catch (e) {}   // v2.4.0 第二轮：浮动透明度读 skin.opacity
    /* v1.7.21：置顶等级用 'floating'，不再用 'screen-saver'。
     * 'screen-saver' 是 Electron 的最高置顶层，会盖在全屏视频 / 游戏 / 投屏之上很碍事；
     * 'floating' 依然是最顶层（普通窗口盖不住插件），但不再跟全屏应用抢最高层。
     * 若用户在看无边框全屏视频仍觉得挡事，菜单里「插件总在最前」可一键关掉。 */
    dockWin.setAlwaysOnTop(dockPinned, 'floating');
    /* v1.7.21 需求1（点击热区）：默认让整个插件窗口「鼠标穿透」。
     * 无边框 + transparent 窗口的点击热区是**整个窗口矩形**，而插件可视的小方框比窗口
     * 小一圈（四周留了 2px 给边框/阴影，圆角外也是透明的），于是点方框外的透明区域
     * 也会弹出日历 —— 就是用户反馈的"点水平线以下也能弹"。
     * 解法用 Electron 官方的 click-through 模式：
     *   setIgnoreMouseEvents(true, { forward: true }) → 鼠标事件穿透到下面的窗口，
     *   但 mousemove 仍会转发进页面；页面按坐标判断"在不在卡片矩形内"，
     *   在 → 调 setIgnoreMouseEvents(false) 收回响应，不在 → 继续穿透。
     * 于是不管窗口多留了多少透明边，真正能点的永远只有那张可见的小卡片。 */
    try { dockWin.setIgnoreMouseEvents(true, { forward: true }); } catch (e) {}
    dockWin.webContents.on('did-finish-load', function () {
      pushSkinToDock();   // v2.4.0 第二轮：浮动插件皮肤（skin-state 含 theme + 背景层）
      pushDockSize();
    });
    /* v1.7.20：渲染进程崩溃（浮动态偶发 GPU/D3D 崩溃）兜底。只记日志 + 延迟到下个 tick
     * 安全销毁，绝不在回调里同步 destroy。重建次数上限 DOCK_RECREATE_MAX=3，
     * 超限彻底放弃并保持浮动（窗口留白屏），杜绝崩溃永动机。 */
    dockWin.webContents.on('render-process-gone', function (evt, details) {
      try { log('dock render-process-gone reason=' + details.reason + ' exitCode=' + details.exitCode); } catch (e) {}
      if (quitting || !dockOn) return;
      if (dockRecreateCount >= DOCK_RECREATE_MAX) {
        log('dock recreate limit reached (' + dockRecreateCount + '), give up and stay floating');
        return;
      }
      dockCrashed = true;
      const target = dockWin;
      setTimeout(function () {
        if (quitting || !dockOn) return;
        try { if (target && !target.isDestroyed()) target.destroy(); } catch (e) {}
      }, 0);
    });
    dockWin.once('ready-to-show', function () {
      pushDockSize();
      // v1.7.21 需求2：图标形态下插件窗口只创建不显示（托盘图标才是它的"脸"）
      if (dockMode === 'icon') { try { dockWin.hide(); } catch (e) {} return; }
      // 有上次位置就恢复（并夹回工作区），没有才用默认位置。
      /* v1.7.22.3 重要修复（"卡在半空"回归）：只取 dockBounds 的 x/y，width/height 强制
       * 用当前 dockWin 的真实尺寸 —— 即使磁盘上的 dockBounds 被旧版错写成了异常尺寸
       * （实测有用户残留 350×178，疑似早期嵌入循环里的主窗/嵌入子窗 bounds），也不能再把
       * 物理窗口撑大：撑大后 clampDockToWorkArea 按大矩形算 maxX/maxY，挂件条的可活动范围
       * 被严重压缩 → 卡片看着"卡在半空、过不去"。
       * v2.4.0 A3：恢复优先走按显示器 ID 记忆（pickDockRestore），多屏各自回到原位。 */
      const restoreRect = pickDockRestore(
        (typeof screen.getAllDisplays === 'function') ? screen.getAllDisplays() : [],
        dockBoundsByDisplay, dockDisplayId, dockBounds);
      if (restoreRect) {
        try {
          dockWin.setBounds(dockClamped(restoreRect.x, restoreRect.y));
        } catch (e) {}
      } else {
        positionDock();
      }
      try { dockWin.show(); } catch (e) {}
    });
    dockWin.on('closed', function () {
      dockWin = null;
      /* v1.7.20：浮动态崩了也要自愈（GPU/D3D 偶发），但要限次数。
       *   - dockCrashed=true：渲染进程被杀（计入自愈）
       *   - 其它原因关闭（如 dockOn=false 触发）不重建 */
      if (!quitting && dockOn && dockCrashed && dockRecreateCount < DOCK_RECREATE_MAX) {
        dockCrashed = false;
        dockRecreateCount++;
        setTimeout(function () { if (!quitting && dockOn && !dockWin) createDock(); }, 3000);
      }
    });
    /* v1.7.21 需求3：分辨率 / 任务栏高度 / 显示器插拔变化后的「越界纠正」，
     * 统一在 app.whenReady 里注册一次（不放在这里 —— createDock 崩溃重建会被多次调用，
     * 每次都 register 一个 listener 会越积越多）。 */
    // 偶发崩溃保护：5 分钟安稳运行就清零崩溃计数。
    if (dockStableTimer) clearTimeout(dockStableTimer);
    dockStableTimer = setTimeout(function () {
      if (dockRecreateCount > 0) {
        log('dock stable 5min, reset recreate count from ' + dockRecreateCount + ' to 0');
        dockRecreateCount = 0;
      }
    }, 5 * 60 * 1000);
    log('dock created OK');
  } catch (e) {
    log('dock create FAILED: ' + (e && e.stack || e));
    dockWin = null;
  }
}

/* =====================================================================
 * v1.7.12 关注列表 —— 独立窗口
 * ---------------------------------------------------------------------
 * 为什么要独立窗口：原先 #reminderList 是 #widget 内的绝对定位 DOM，
 * 不管怎么放开夹紧逻辑，都不可能渲染到 #widget 之外（会被主窗口边界裁掉）。
 * 独立 BrowserWindow 是唯一干净解法：表头 -webkit-app-region: drag 由 Electron
 * 原生处理拖动，可拖到屏幕任意位置，且比 IPC 手动 setBounds 丝滑得多。
 * ===================================================================== */
function pushThemeToRemindlist() {
  if (remindlistWin && remindlistWin.webContents && !remindlistWin.webContents.isDestroyed()) {
    try { remindlistWin.webContents.send('theme-changed', themeMode); } catch (e) {}
  }
}
function pushDataToRemindlist() {
  if (remindlistWin && remindlistWin.webContents && !remindlistWin.webContents.isDestroyed()) {
    try {
      remindlistWin.webContents.send('remindlist-data', { theme: themeMode, reminders: reminders.slice() });
    } catch (e) {}
  }
}
function openReminderListWindow() {
  try {
    if (remindlistWin && !remindlistWin.isDestroyed()) {
      pushDataToRemindlist();          // 复用已有窗口，先刷新数据
      if (remindlistWin.isMinimized()) remindlistWin.restore();
      remindlistWin.focus();
      remindlistWin.moveTop();
      return;
    }
    remindlistWin = new BrowserWindow({
      width: RL_W, height: RL_H,
      frame: false, transparent: true, resizable: true,
      alwaysOnTop: true, skipTaskbar: true,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
    });

    // v1.7.12：恢复上次位置；越界（换显示器/分辨率变了）则回落到居中
    let placed = false;
    try {
      const last = lastRemindlistBounds;
      if (last && typeof last.x === 'number') {
        const ds = screen.getAllDisplays();
        const inAny = ds.some(function (d) {
          const b = d.bounds;
          return last.x < b.x + b.width - 40 && last.x + last.width > b.x + 40 &&
                 last.y < b.y + b.height - 40 && last.y + last.height > b.y + 40;
        });
        if (inAny) { remindlistWin.setBounds(last); placed = true; }
      }
    } catch (e) {}
    if (!placed) remindlistWin.center();

    // 数据经 query 传入（与 reminder.html 同构）
    remindlistWin.loadFile(path.join(__dirname, 'remindlist.html'), {
      query: { data: JSON.stringify({ theme: themeMode, reminders: reminders.slice() }) }
    });
    remindlistWin.setAlwaysOnTop(true, 'screen-saver');

    // 记住位置（拖动结束后写 settings.json）
    remindlistWin.on('moved', function () {
      clearTimeout(_rlSaveTimer);
      _rlSaveTimer = setTimeout(function () {
        if (!remindlistWin || remindlistWin.isDestroyed()) return;
        try { lastRemindlistBounds = remindlistWin.getBounds(); saveSettings(); } catch (e) {}
      }, 400);
    });
    remindlistWin.on('resized', function () {
      clearTimeout(_rlSaveTimer);
      _rlSaveTimer = setTimeout(function () {
        if (!remindlistWin || remindlistWin.isDestroyed()) return;
        try { lastRemindlistBounds = remindlistWin.getBounds(); saveSettings(); } catch (e) {}
      }, 400);
    });

    remindlistWin.once('ready-to-show', function () {
      try { remindlistWin.show(); } catch (e) {}
    });
    remindlistWin.on('closed', function () { remindlistWin = null; });

    log('remindlist window created OK');
  } catch (e) {
    log('remindlist window FAILED: ' + (e && e.stack || e));
    remindlistWin = null;
  }
}

/* ===== IPC ===== */
ipcMain.on('toggle-expand', function () {
  if (!win) return;
  if (win.isResizable()) showMini(); else showExpanded();
  notifyExpandState();   // v1.7.11
});
/* v1.7.11 任务栏挂件条 → 主进程 */
ipcMain.on('dock-toggle-main', function () { toggleFromTray(); });
ipcMain.on('dock-show-menu', function () {
  // v1.7.17 需求1：弹菜单期间抑制主窗 blur 隐藏（原生菜单抢焦点会触发主窗 hide）
  guardBlur(800);
  try { buildTrayMenu().popup(); } catch (e) { log('dock menu popup failed: ' + (e && e.message || e)); }
});
// v1.7.17 需求8：主窗右键菜单（去托盘后的菜单入口）
ipcMain.on('main-show-menu', function () {
  guardBlur(800);
  try { buildTrayMenu().popup(); } catch (e) { log('main menu popup failed: ' + (e && e.message || e)); }
});
/* v1.7.22.5 拖拽改写 —— 绝对定位，禁止累加漂移（用户给的标准模板）。
 *
 *   - dock-drag-start(mouseX, mouseY)：mousedown 时记录 `offset = mousePos - windowPos`
 *     偏移量（屏幕坐标）。这一偏移量在 mouseup 前不变，与窗口是否被 clamp 无关。
 *   - dock-drag-move(mouseX, mouseY)：绝对定位算 `newPos = mousePos - offset`，
 *     **不依赖 dockWin.getBounds() 做累加** —— 这是关键，杜绝 clamp 后累加漂移。
 *     然后实时获取 workArea，clampDockToWorkArea 后 setBounds。
 *   - dock-drag-end：最后一次 clamp + 持久化落点 + 写 settings。 */
var dragOffsetX = 0, dragOffsetY = 0;
ipcMain.on('dock-drag-start', function (evt, mouseX, mouseY) {
  if (!dockWin || dockWin.isDestroyed()) return;
  try {
    const b = dockWin.getBounds();
    // 屏幕坐标：offset = 鼠标位置 - 窗口左上角位置（恒定不变）
    dragOffsetX = Math.round(mouseX) - b.x;
    dragOffsetY = Math.round(mouseY) - b.y;
  } catch (e) { log('dock drag-start failed: ' + (e && e.message || e)); }
});
ipcMain.on('dock-drag-move', function (evt, mouseX, mouseY) {
  if (!dockWin || dockWin.isDestroyed()) return;
  try {
    // 绝对定位：newPos = 当前鼠标位置 - 固定 offset（与 dockWin.getBounds() 无关，杜绝累加漂移）
    const newX = Math.round(mouseX) - dragOffsetX;
    const newY = Math.round(mouseY) - dragOffsetY;
    // 拖动中强制收回鼠标响应，否则拖到卡片外的透明区会"掉手"（事件穿透走了）
    try { dockWin.setIgnoreMouseEvents(false); } catch (e) {}
    /* v1.7.22.7：宽高用 dockW/dockH。若沿用 getBounds() 的被撑大尺寸，clamp 算出的
     * maxX/maxY 会小一大截 —— 那就是"拖不到底、拖不到右"的根源。 */
    dockWin.setBounds(dockClamped(newX, newY));
  } catch (e) { log('dock drag-move failed: ' + (e && e.message || e)); }
});
/* v1.7.21 需求6：松手后**不再有任何吸附** —— "自动吸附任务栏上方"整段逻辑已删除
 * （物理嵌入已放弃，吸附到任务栏上方没有意义，实测也从未真正生效过）。
 * 松手只做两件事：① 最后夹一次工作区 ② 记下落点，下次启动 / 从图标形态切回来时回到原位。 */
/* v1.7.22.6：落盘防抖 500ms（对齐 remindlist 窗口的 _rlSaveTimer 写法）。
 * 疯狂拖拽时每次都 saveSettings() 会反复重写 settings.json（无谓的磁盘 I/O），
 * 但**内存里的 dockBounds 必须立刻更新**（不防抖）——否则这 500ms 内若发生
 * 形态切换 / 重启，读到的就是旧落点。退出前由 flushDockBounds() 兜底立即写盘。 */
let _dockSaveTimer = null;
function flushDockBounds() {
  if (_dockSaveTimer) { clearTimeout(_dockSaveTimer); _dockSaveTimer = null; }
  try { saveSettings(); } catch (e) {}
}
ipcMain.on('dock-drag-end', function () {
  if (!dockWin || dockWin.isDestroyed()) return;
  try {
    /* v1.7.22.7：只取当前 x/y，尺寸强制意图值（getBounds() 可能是被 OS 撑大的）。 */
    const cur = dockWin.getBounds();
    const nb = dockClamped(cur.x, cur.y);
    dockWin.setBounds(nb);
    dockBounds = { x: nb.x, y: nb.y, width: dockW, height: dockH };  // 内存立即更新
    /* v2.4.0 A3：按显示器 ID 记忆（多屏各自记住落点）。display.id 换机可能变化，
     * 以"当前运行时 ID 表"为准；键统一字符串化，JSON 持久化安全。 */
    try {
      const disp = screen.getDisplayMatching(nb);
      if (disp && disp.id !== null && disp.id !== undefined) {
        dockDisplayId = disp.id;
        dockBoundsByDisplay[String(disp.id)] = { x: nb.x, y: nb.y, width: dockW, height: dockH };
      }
    } catch (e) {}
    clearTimeout(_dockSaveTimer);
    _dockSaveTimer = setTimeout(function () {
      _dockSaveTimer = null;
      saveSettings();
      log('dock dropped at ' + nb.x + ',' + nb.y);
    }, 500);
  } catch (e) { log('dock drag-end failed: ' + (e && e.message || e)); }
});
/* v1.7.21 需求1：由页面按鼠标坐标动态开关「鼠标穿透」，从而把点击热区精确限制在
 * 插件可视的小方框内（详见 createDock 里 setIgnoreMouseEvents 的注释）。
 *   ignore=true  → 事件穿透到下面的窗口（点在卡片外的透明区域）
 *   ignore=false → 窗口收回响应（点在卡片里，可点击 / 拖动 / 右键） */
/* 自检探针：页面在"鼠标穿透"状态下收到了 forward 过来的 mousemove 就上报一次。
 * 这条日志是需求1 的运行时证据 —— 没有它说明 forward 失效，插件会彻底点不动。 */
ipcMain.on('dock-hit-ready', function () { log('dock hit-test link OK (forward mousemove received)'); });
ipcMain.on('dock-set-mouse', function (evt, ignore) {
  if (!dockWin || dockWin.isDestroyed()) return;
  try {
    if (ignore) dockWin.setIgnoreMouseEvents(true, { forward: true });
    else dockWin.setIgnoreMouseEvents(false);
  } catch (e) { log('dock set-mouse failed: ' + (e && e.message || e)); }
});
ipcMain.on('exit-app', function () { requestExit(); });

/* v1.7.12 关注列表独立窗口 → 主进程 */
ipcMain.on('remindlist-open', function () { openReminderListWindow(); });
ipcMain.on('remindlist-close', function () {
  if (remindlistWin) { try { remindlistWin.close(); } catch (e) {} remindlistWin = null; }
});
ipcMain.on('remindlist-goto-ym', function (evt, y, m, d) {
  // 跳到该日：复用与托盘「特别关注」二级菜单完全相同的路径
  if (win) {
    try {
      if (!win.isVisible()) showMini();
      guardBlur(350);
      win.focus(); win.moveTop();
      win.webContents.send('goto-ym', y, m, d);
    } catch (e) { log('remindlist goto failed: ' + (e && e.message || e)); }
  }
});
ipcMain.on('remindlist-remove', function (evt, id) {
  const idx = reminders.findIndex(function (r) { return r.id === id; });
  if (idx >= 0) {
    reminders.splice(idx, 1);
    saveReminders();
    broadcastReminders();      // 会同时刷新主窗黄格 + 本窗口列表
    refreshTrayMenu();
    if (reminderFor === id && reminderWin) {
      try { reminderWin.close(); } catch (e) {}
    }
  }
});
// 主窗 themeBtn 点击 → 原生皮肤 light↔dark 快捷切换（v2.4.0 主题→皮肤语义变更）
ipcMain.on('set-theme', function (evt, mode) {
  // v2.4.0 第二轮：主窗 themeBtn = 日历表面 native light↔dark 快捷切换（不动 follow/其它表面）。
  var cal = skin.surfaces.calendar;
  if (cal.type === 'system') {
    cal.type = (themeMode === 'dark') ? 'light' : 'dark';
  } else {
    cal.type = (mode === 'dark') ? 'dark' : 'light';
  }
  cal.color = null; cal.image = null; cal.text = 'auto';
  recomputeTheme();
  pushThemeToAll();
  pushSkinToAll();
  saveSettings();
  refreshTrayMenu();
});
// v1.6：渲染层 resize 手柄 → 主进程按宽度统一算高度，比例永锁
ipcMain.on('resize-window', function (evt, w) {
  if (!win || !win.isResizable()) return;
  w = Math.max(EXP_MIN_W, Math.min(Math.round(w || EXP_DEF_W), 1400));
  var h = Math.round(w / ASPECT);
  h = Math.max(MINI_H, h);
  var b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width: w, height: h });
  pushWinSize();             // v2.2.0：resize 后立刻下发新宽，缩放实时跟随
});

/* =====================================================================
 * v2.2.0 需求4：桌面插件（日历板块桌面工具）拖动 / 锁定 / 开关
 * ---------------------------------------------------------------------
 * 拖动复用 dock 的「绝对定位 + 零累加漂移」范式：mousedown 记 offset =
 * 鼠标屏幕坐标 - 窗口左上角，移动时 newPos = 鼠标 - offset，绝不读 getBounds()
 * 累加，杜绝 clamp 后漂移。锁定状态下主进程直接拒绝拖动（双保险，渲染层也拦）。
 * ===================================================================== */
var desktopDragOX = 0, desktopDragOY = 0;
ipcMain.on('desktop-drag-start', function (evt, mouseX, mouseY) {
  if (!desktopWin || desktopWin.isDestroyed() || desktopLocked) return;
  try {
    var b = desktopWin.getBounds();
    desktopDragOX = Math.round(mouseX) - b.x;
    desktopDragOY = Math.round(mouseY) - b.y;
  } catch (e) { log('desktop drag-start failed: ' + (e && e.message || e)); }
});
ipcMain.on('desktop-drag-move', function (evt, mouseX, mouseY) {
  if (!desktopWin || desktopWin.isDestroyed() || desktopLocked) return;
  try {
    var nx = Math.round(mouseX) - desktopDragOX;
    var ny = Math.round(mouseY) - desktopDragOY;
    desktopWin.setBounds(desktopClamped(nx, ny));
  } catch (e) { log('desktop drag-move failed: ' + (e && e.message || e)); }
});
ipcMain.on('desktop-drag-end', function () {
  if (!desktopWin || desktopWin.isDestroyed()) return;
  try {
    var cur = desktopWin.getBounds();
    var nb = desktopClamped(cur.x, cur.y);
    desktopWin.setBounds(nb);
    desktopBounds = { x: nb.x, y: nb.y, width: DESKTOP_W, height: DESKTOP_H };  // 内存立即更新
    clearTimeout(_desktopSaveTimer);
    _desktopSaveTimer = setTimeout(function () { _desktopSaveTimer = null; saveSettings(); }, 400);
  } catch (e) { log('desktop drag-end failed: ' + (e && e.message || e)); }
});
ipcMain.on('desktop-lock-toggle', function () {
  desktopLocked = !desktopLocked;
  saveSettings();
  pushDesktopState();
  pushSettingsState();
});
ipcMain.on('desktop-toggle', function () { toggleDesktop(); });

/* =====================================================================
 * v2.2.0 需求5：设置弹窗 IPC
 * ---------------------------------------------------------------------
 * 统一用一个 settings-set(key, value) 通道写入所有状态；瞬时动作（检查更新 /
 * 关闭弹窗）走 settings-action(action)。每个操作执行完 pushSettingsState()，
 * 让弹窗始终渲染主进程这一唯一真相。setDockMode / toggleDesktop 内部已 saveSettings
 * + refreshTrayMenu，故这里不再重复。
 * ===================================================================== */
ipcMain.on('settings-set', function (evt, key, value) {
  switch (key) {
    case 'theme':                 // 兼容旧调用：日历表面 native light↔dark（与 set-theme 等价）
      (function () {
        var cal = skin.surfaces.calendar;
        cal.type = (value === 'dark') ? 'dark' : 'light';
        cal.color = null; cal.image = null; cal.text = 'auto';
        recomputeTheme();
        pushThemeToAll();
        pushSkinToAll();
      })();
      break;
    case 'pinned':
      pinned = !!value;
      if (win) win.setAlwaysOnTop(pinned);
      break;
    case 'autoLaunch':
      autoLaunch = !!value;
      try { app.setLoginItemSettings({ openAtLogin: autoLaunch, path: process.execPath }); } catch (e) {}
      break;
    case 'dockOn':
      dockOn = !!value;
      if (dockOn) applyDockMode();
      else {
        if (dockWin && !dockWin.isDestroyed()) { try { dockWin.hide(); } catch (e) {} }
        destroyTray();
      }
      break;
    case 'dockMode':
      setDockMode(value === 'icon' ? 'icon' : 'dock');
      pushSettingsState();
      return;   // setDockMode 内部已 saveSettings + refreshTrayMenu
    case 'dockPinned':
      dockPinned = !!value;
      if (dockWin && !dockWin.isDestroyed()) { try { dockWin.setAlwaysOnTop(dockPinned, 'floating'); } catch (e) {} }
      break;
    case 'desktopOn':
      toggleDesktop();
      return;   // toggleDesktop 内部已 saveSettings + refreshTrayMenu + pushSettingsState
    case 'desktopLocked':
      desktopLocked = !!value;
      pushDesktopState();
      break;
    default:
      return;
  }
  saveSettings();
  refreshTrayMenu();
  pushSettingsState();
});
ipcMain.on('settings-action', function (evt, action) {
  if (action === 'check-holiday') {
    try { maybeHolidayUpdate(true); } catch (e) { log('settings check-holiday failed: ' + (e && e.stack || e)); }
  } else if (action === 'close') {
    if (settingsWin && !settingsWin.isDestroyed()) { try { settingsWin.close(); } catch (e) {} }
  } else if (action === 'open-skin') {
    try { openSkinWindow(); } catch (e) { log('open-skin failed: ' + (e && e.stack || e)); }
  }
});

/* =====================================================================
 * v2.4.0 第二轮：皮肤窗口 IPC
 * ---------------------------------------------------------------------
 * skin-set(surface, field, value)：皮肤写操作（主进程唯一真相，处理后推回）。
 * skin-action(action, payload)：close（关皮肤窗）/ choose-file（主进程文件对话框）。
 * skin-import(surface, srcPath) [invoke]：拖入路径导入图片，返回 { ok, image, error }。
 * ===================================================================== */
ipcMain.on('skin-set', function (evt, surface, field, value) {
  try { applySkinSet({ surface: surface, field: field, value: value }); }
  catch (e) { log('skin-set failed: ' + (e && e.stack || e)); }
});
ipcMain.on('skin-action', function (evt, action, payload) {
  try {
    if (action === 'close') {
      if (skinWin && !skinWin.isDestroyed()) { try { skinWin.close(); } catch (e) {} }
    } else if (action === 'choose-file') {
      var surface = (payload && payload.surface) || 'calendar';
      dialog.showOpenDialog({
        title: '选择皮肤图片',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
      }).then(function (r) {
        if (r && !r.canceled && r.filePaths && r.filePaths[0]) {
          var res = importSkinImage(surface, r.filePaths[0]);
          if (res && res.ok) {
            skin.surfaces[surface].type = 'image';
            skin.surfaces[surface].image = res.image;
            skin.surfaces[surface].color = null;
            recomputeTheme();
            saveSettings();
            pushThemeToAll();     // baseTheme 可能变化：托盘/关注列表/设置窗主题跟随
            pushSkinToAll();
            refreshTrayMenu();
          }
          if (skinWin && !skinWin.isDestroyed()) {
            try { skinWin.webContents.send('skin-import-result', res); } catch (e) {}
          }
        }
      });
    }
  } catch (e) { log('skin-action failed: ' + (e && e.stack || e)); }
});
ipcMain.handle('skin-import', function (evt, surface, srcPath) {
  return importSkinImage(surface, srcPath);
});

/* =====================================================================
 * v1.6.2 特别关注 IPC + 弹窗
 * ===================================================================== */
function loadReminders() {
  try {
    const raw = fs.readFileSync(REMINDER_FILE(), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) reminders = arr.filter(function (r) {
      return r && typeof r.id === 'string' && typeof r.y === 'number' &&
        typeof r.m === 'number' && typeof r.d === 'number' &&
        typeof r.text === 'string';
    });
  } catch (e) { reminders = []; }
}
function saveReminders() {
  try {
    const file = REMINDER_FILE();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reminders, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {}
}
function genReminderId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}
function broadcastReminders() {
  if (win && win.webContents && !win.webContents.isDestroyed()) {
    try { win.webContents.send('reminders-changed', reminders); } catch (e) {}
  }
  pushDataToRemindlist();   // v1.7.12：关注列表独立窗口同步刷新
}
ipcMain.handle('list-reminders', function () { return reminders.slice(); });
ipcMain.handle('add-reminder', function (evt, item) {
  if (!item || typeof item.y !== 'number') return null;
  // v2.3.0：解除「最多 10 条」数量限制（用户要求不限制），仅保留单条 15 字兜底截断。
  const txt = String(item.text || '').trim().slice(0, MAX_REMINDER_TEXT);
  if (!txt) return null;
  const r = {
    id: genReminderId(),
    y: item.y, m: item.m, d: item.d,
    text: txt,
    createdAt: Date.now(),
    snoozeUntil: 0,
    ackedDate: ''            // v1.7.1：今天已点"知道了"的日期（空 = 未确认，仍会提醒）
  };
  reminders.push(r);
  saveReminders();
  broadcastReminders();
  refreshTrayMenu();
  // 立刻巡检一次（避免要等下一次 60s tick）
  setTimeout(checkReminders, 200);
  return r;
});
ipcMain.handle('remove-reminder', function (evt, id) {
  const idx = reminders.findIndex(function (r) { return r.id === id; });
  if (idx >= 0) {
    reminders.splice(idx, 1);
    saveReminders();
    broadcastReminders();
    refreshTrayMenu();
    // 关闭可能正在显示的弹窗
    if (reminderFor === id && reminderWin) {
      try { reminderWin.close(); } catch (e) {}
    }
  }
  return idx >= 0;
});
ipcMain.on('ack-reminder', function (evt, id, action) {
  const r = reminders.find(function (x) { return x.id === id; });
  if (!r) return;
  if (action === 'snooze') {
    r.snoozeUntil = Date.now() + 30 * 60 * 1000;
    saveReminders();
  } else {
    // dismiss（知道了）：v1.7.1 只标记"今天已确认"，保留关注项（黄色格子不变），
    // 今天不再弹；真正"取消关注"由右键该单元格删除（remove-reminder）完成。
    const now = new Date();
    r.ackedDate = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    r.snoozeUntil = 0;
    saveReminders();
  }
  if (reminderWin) {
    try { reminderWin.close(); } catch (e) {}
    reminderWin = null;
    reminderFor = null;
  }
});

// 60s 巡检：今天日期 + snoozeUntil 已过 → 触发
function isSameYMD(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}
function checkReminders() {
  if (reminders.length === 0) return;
  const now = new Date();
  // v1.7.5：补零，与 ack-reminder 写入的 ackedDate（pad2）格式一致，否则「知道了」比对永不相等
  const todayKey = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  for (let i = 0; i < reminders.length; i++) {
    const r = reminders[i];
    const target = new Date(r.y, r.m - 1, r.d);
    if (!isSameYMD(target, now)) continue;          // 不是今天
    if (r.ackedDate === todayKey) continue;          // v1.7.1：今天已点"知道了"，不再弹
    if (r.snoozeUntil && r.snoozeUntil > Date.now()) continue;  // 还没到再弹时间
    showReminderWindow(r);
    return;                                          // 一次只弹一个，避免重叠
  }
}

function showReminderWindow(r) {
  reminderFor = r.id;
  if (reminderWin) {
    try { reminderWin.focus(); } catch (e) {}
    return;
  }
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const W = 380, H = 264;
  reminderWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round((wa.width - W) / 2),
    y: Math.round((wa.height - H) / 2),
    frame: false,
    transparent: true,           // HTML 内部用 #card 不透明圆角容器
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  reminderWin.setAlwaysOnTop(true, 'screen-saver');
  reminderWin.loadFile(path.join(__dirname, 'reminder.html'), {
    query: {
      id: r.id,
      text: r.text,
      date: r.y + ' 年 ' + pad2(r.m) + ' 月 ' + pad2(r.d) + ' 日',
      /* v2.0 视觉：把当前主题透传给弹窗（此前提醒弹窗恒为白底，黑夜模式下刺眼）。
       * 仅多传一个渲染用的状态量，不改变任何功能与交互行为。 */
      theme: themeMode
    }
  });
  reminderWin.once('ready-to-show', function () { try { reminderWin.show(); } catch (e) {} });
  reminderWin.on('closed', function () {
    reminderWin = null;
    reminderFor = null;
  });
}

function requestExit() {
  /* v2.0 视觉：原生 dialog.showMessageBox（系统消息框）改为与整体设计体系一致的
   * 卡片弹窗（exit.html）。功能与交互不变：确认则退出，取消则留在原处。 */
  showExitDialog();
}

/* v2.0 退出确认卡片弹窗：复刻 reminder.html 的透明无边框 + #card 不透明圆角容器 */
let exitWin = null;
function showExitDialog() {
  if (exitWin && !exitWin.isDestroyed()) {
    try { exitWin.focus(); } catch (e) {}
    return;
  }
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const W = 320, H = 172;
  exitWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round((wa.width - W) / 2),
    y: Math.round((wa.height - H) / 2),
    frame: false,
    transparent: true,           // HTML 内部用 #card 不透明圆角容器
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  exitWin.setAlwaysOnTop(true, 'screen-saver');
  exitWin.loadFile(path.join(__dirname, 'exit.html'), {
    query: { theme: themeMode }
  });
  exitWin.once('ready-to-show', function () { try { exitWin.show(); } catch (e) {} });
  exitWin.on('closed', function () { exitWin = null; });
}

ipcMain.on('exit-confirm', function () {
  app.isQuiting = true;
  app.quit();
});
ipcMain.on('exit-cancel', function () {
  if (exitWin && !exitWin.isDestroyed()) { try { exitWin.close(); } catch (e) {} }
});

/* =====================================================================
 * v2.1.0 节假日年度联网更新
 * ---------------------------------------------------------------------
 * 背景：国务院每年 11 月左右发布次年放假安排，硬编码的 2026 表过完年就是废数据。
 * 机制：每年自动检测一次 → 弹窗确认 → 联网更新 → 成功显示明细 / 失败显示原因。
 *   自动：启动 5s 后查一次 + 每 6 小时轮询（7 天节流 + 用户可"以后再说"）
 *   手动：托盘右键「检查节假日更新」（忽略节流）
 * 数据：userData/holidays.json（holiday-store.js 负责读写 / 抓取 / 归一化）
 * ===================================================================== */

/** 写回"上次检查时间"（自动与手动都记，避免重复骚扰） */
function markHolidayChecked() {
  holidayLastCheck = new Date().toISOString();
  saveSettings();
}

/**
 * 当前自动提示的节流窗口。
 * v2.1.0 P2-4：首次失败仍 7 天；累计失败 ≥2 次（典型：长期离线）拉长到 28 天，
 * 否则用户每 7 天就要被弹一次。
 */
function holidayThrottleWindowMs() {
  return HOLIDAY_CHECK_THROTTLE_MS * (holidayFailCount >= 2 ? 4 : 1);
}

/** 距上次检查是否已超过节流窗口 */
function holidayThrottlePassed(now) {
  if (!holidayLastCheck) return true;
  try {
    const t = new Date(holidayLastCheck).getTime();
    if (!isFinite(t)) return true;
    return (now.getTime() - t) >= holidayThrottleWindowMs();
  } catch (e) { return true; }
}

/**
 * 记一次失败。
 * holidayFailCounted 的语义是「当前这次「尝试 / 弹窗状态」是否已计过数」：
 *   - 每次进入 updating（新一次尝试）或 confirm（新一轮询问）时清零；
 *   - 计过之后，同一状态下的重复收尾（IPC close + 窗口 closed 事件）不会双记。
 * 这样「点了 立即更新 失败 → 再点 重试 又失败」会如实记 2 次，
 * 而「失败一次 → 关窗」只记 1 次。
 */
function bumpHolidayFail() {
  if (holidayFailCounted) return;
  holidayFailCounted = true;
  holidayFailCount = Math.min((holidayFailCount || 0) + 1, 5);
  saveSettings();
  log('holiday: fail count -> ' + holidayFailCount);
}

/** 更新成功 → 失败计数清零（下次回归 7 天节流） */
function resetHolidayFail() {
  holidayFailCounted = true;      // 本会话已定论，不再倒扣
  if (holidayFailCount === 0) return;
  holidayFailCount = 0;
  saveSettings();
  log('holiday: fail count reset');
}

/**
 * 数据来源文案，用于「已是最新」态的副行：
 *   「已联网获取 · 2026-09-07（来源 cdn.jsdelivr.net）」
 *   「本地文件导入 · 2026-09-07」
 *   「软件内置数据 · 2026-01-01」（兜底：needsUpdate 见内置必返回 need，uptodate 态走不到）
 */
function holidaySourceLabel() {
  try {
    const d = holidayStore.getData();
    const src = (d && d.source) || '内置';
    let when = '';
    if (d && d.updatedAt) {
      const t = new Date(d.updatedAt);
      if (!isNaN(t.getTime())) {
        when = t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
      }
    }
    if (src === '内置' || src === '未知') return '软件内置数据' + (when ? ' · ' + when : '');
    /* v2.1.0 P3-1：本地导入的数据不能说成「已联网获取」——
     * 原来会输出「已联网获取 · 2026-09-07（来源 本地文件）」，自己打自己脸。 */
    if (src === '本地文件' || src.indexOf('本地文件') === 0) {
      return '本地文件导入' + (when ? ' · ' + when : '');
    }
    let host = src;
    try {
      const m = /^https?:\/\/([^/]+)/.exec(src);
      if (m) host = m[1];
    } catch (e) {}
    return '已联网获取' + (when ? ' · ' + when : '') + '（来源 ' + host + '）';
  } catch (e) {
    return '';
  }
}

/** 把某年数据压成一句人话明细，如「元旦 1/1–1/3 · 春节 2/15–2/23 … 共 11 天假期、5 天补班」 */
function summarizeHolidayYear(yearPayload) {
  try {
    const segs = (yearPayload && yearPayload.holidays) || [];
    const parts = [];
    let days = 0;
    for (let i = 0; i < segs.length; i++) {
      const a = holidayStore.parseYmd(segs[i].s);
      const b = holidayStore.parseYmd(segs[i].e) || holidayStore.parseYmd(segs[i].s);
      if (!a || !b) continue;
      days += Math.max(1, Math.round((new Date(b.y, b.m - 1, b.d) - new Date(a.y, a.m - 1, a.d)) / 86400000) + 1);
      parts.push(segs[i].name + ' ' + a.m + '/' + a.d + '–' + b.m + '/' + b.d);
    }
    const wd = ((yearPayload && yearPayload.workdays) || []).length;
    const head = parts.slice(0, 4).join(' · ') + (parts.length > 4 ? ' …' : '');
    return (head ? head + '；' : '') + '共 ' + days + ' 天假期、' + wd + ' 天补班';
  } catch (e) {
    return '';
  }
}

/** 主进程 → 更新弹窗：推送状态机状态 */
function pushHolidayDialog(payload) {
  const p = payload || {};
  if (p.state) holidayLastState = p.state;
  // 新一轮尝试（updating）或新一轮询问（confirm）→ 允许再记一次失败
  if (p.state === 'updating' || p.state === 'confirm') holidayFailCounted = false;
  if (holidayWin && holidayWin.webContents && !holidayWin.webContents.isDestroyed()) {
    try { holidayWin.webContents.send('holiday-dialog', p); } catch (e) {}
  }
}

/** 屏幕工作区尺寸（对 mock/异常环境做兜底，避免弹窗定位时整段失败） */
function holidayWorkArea() {
  try {
    const d = screen.getPrimaryDisplay();
    if (d && d.workAreaSize && d.workAreaSize.width > 0) return d.workAreaSize;
    if (d && d.workArea && d.workArea.width > 0) return { width: d.workArea.width, height: d.workArea.height };
  } catch (e) {}
  return { width: 1280, height: 720 };
}

/** 打开（或复用）holidayupd.html 卡片弹窗，复刻 showExitDialog() 的窗口范式 */
function showHolidayDialog(payload) {
  try {
    if (holidayWin && !holidayWin.isDestroyed()) {
      pushHolidayDialog(payload);
      try { holidayWin.focus(); } catch (e) {}
      return;
    }
    const wa = holidayWorkArea();
    /* v2.1.0 P2-1：原来 252 放不下 success 态的明细（7 个假期段会被裁掉），加高到 300。 */
    const W = 400, H = 300;
    holidayWin = new BrowserWindow({
      width: W, height: H,
      x: Math.round((wa.width - W) / 2),
      y: Math.round((wa.height - H) / 2),
      frame: false,
      transparent: true,           // HTML 内部用 #card 不透明圆角容器
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    holidayWin.setAlwaysOnTop(true, 'screen-saver');
    holidayLastState = (payload && payload.state) || '';
    holidayWin.loadFile(path.join(__dirname, 'holidayupd.html'), {
      query: { theme: themeMode }
    });
    // 页面 load 完成后再推状态（否则 onHolidayDialog 还没订阅上就发完了）
    holidayWin.webContents.once('did-finish-load', function () { pushHolidayDialog(payload); });
    holidayWin.once('ready-to-show', function () { try { holidayWin.show(); } catch (e) {} });
    holidayWin.on('closed', function () {
      // 没拿到数据就关窗（× / Esc / 关闭）也算一次失败，避免长期离线用户每 7 天被弹一次
      if (holidayLastState === 'failed' || holidayLastState === 'confirm') bumpHolidayFail();
      holidayWin = null;
      holidayBusy = false;
    });
  } catch (e) {
    log('showHolidayDialog failed: ' + (e && e.stack || e));
  }
}

function closeHolidayDialog() {
  if (holidayLastState === 'failed' || holidayLastState === 'confirm') bumpHolidayFail();
  if (holidayWin && !holidayWin.isDestroyed()) { try { holidayWin.close(); } catch (e) {} }
  holidayWin = null;
  holidayBusy = false;
}

/** 更新成功后把新数据推给日历主窗（渲染层 applyHolidayData → renderAll） */
function broadcastHolidayData() {
  try {
    const payload = { data: holidayStore.getData() };
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('holiday-data-changed', payload);
    }
  } catch (e) { log('broadcastHolidayData failed: ' + (e && e.message || e)); }
}

/** 真正执行联网更新（confirm → updating → success / failed） */
function doHolidayUpdate(year) {
  const y = Number(year) || holidayStore.targetYear(new Date());
  if (holidayBusy) return;
  holidayBusy = true;
  pushHolidayDialog({ state: 'updating', year: y });
  log('holiday: start update year=' + y);
  let p;
  try {
    p = Promise.resolve(holidayStore.fetchYear(y));
  } catch (e) {
    p = Promise.resolve({ ok: false, reason: '联网请求异常：' + ((e && e.message) || e) });
  }
  p.then(function (res) {
    if (!res || !res.ok) {
      const reason = (res && res.reason) || '网络不可用，请检查网络后重试';
      log('holiday: fetch failed year=' + y + ' reason=' + reason);
      holidayBusy = false;
      bumpHolidayFail();
      pushHolidayDialog({ state: 'failed', year: y, detail: reason });
      return;
    }
    const applied = holidayStore.applyYear({
      holidays: res.data.holidays,
      workdays: res.data.workdays,
      source: res.source
    }, y);
    if (!applied || !applied.ok) {
      const reason = (applied && applied.reason) || '写入本地数据失败';
      log('holiday: apply failed year=' + y + ' reason=' + reason);
      holidayBusy = false;
      bumpHolidayFail();
      pushHolidayDialog({ state: 'failed', year: y, detail: reason });
      return;
    }
    // holidays.js 缓存清掉重算 → 托盘「本年最近节日」菜单立即用上新数据
    holidays.setData(holidayStore.getData());
    markHolidayChecked();
    resetHolidayFail();
    broadcastHolidayData();
    refreshTrayMenu();
    holidayBusy = false;
    log('holiday: update OK year=' + y + ' source=' + res.source);
    pushHolidayDialog({
      state: 'success',
      year: y,
      detail: summarizeHolidayYear(res.data)
    });
  }, function (err) {
    holidayBusy = false;
    bumpHolidayFail();
    log('holiday: update crashed year=' + y + ' ' + (err && err.stack || err));
    pushHolidayDialog({ state: 'failed', year: y, detail: '联网请求异常：' + ((err && err.message) || err) });
  });
}

/** 从本地 JSON 文件导入（离线兜底），复用 holiday-store 的 normalize() */
function importHolidayFile() {
  try {
    if (!dialog || typeof dialog.showOpenDialog !== 'function') {
      bumpHolidayFail();
      pushHolidayDialog({ state: 'failed', detail: '当前环境不支持打开文件对话框' });
      return;
    }
    const y = holidayStore.targetYear(new Date());
    const opts = {
      title: '选择节假日数据文件（JSON）',
      filters: [{ name: 'JSON 数据', extensions: ['json'] }],
      properties: ['openFile']
    };
    const parent = (holidayWin && !holidayWin.isDestroyed()) ? holidayWin : undefined;
    Promise.resolve(dialog.showOpenDialog(parent, opts))
      .then(function (r) {
        if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return;   // 取消 → 留在 failed 态
        return holidayStore.importFromFile(r.filePaths[0]).then(function (res) {
          if (!res || !res.ok) {
            bumpHolidayFail();
            pushHolidayDialog({ state: 'failed', year: y, detail: (res && res.reason) || '文件内容无效' });
            return;
          }
          const applied = holidayStore.applyYear({
            holidays: res.data.holidays, workdays: res.data.workdays, source: res.source
          }, res.year || y);
          if (!applied || !applied.ok) {
            bumpHolidayFail();
            pushHolidayDialog({ state: 'failed', year: res.year || y, detail: (applied && applied.reason) || '写入本地数据失败' });
            return;
          }
          holidays.setData(holidayStore.getData());
          markHolidayChecked();
          resetHolidayFail();
          broadcastHolidayData();
          refreshTrayMenu();
          log('holiday: import OK year=' + (res.year || y) + ' file=' + r.filePaths[0]);
          pushHolidayDialog({ state: 'success', year: res.year || y, detail: summarizeHolidayYear(res.data) });
        });
      })
      .catch(function (e) {
        bumpHolidayFail();
        log('holiday: import crashed ' + (e && e.stack || e));
        pushHolidayDialog({ state: 'failed', year: y, detail: '导入失败：' + ((e && e.message) || e) });
      });
  } catch (e) {
    log('holiday: importHolidayFile failed: ' + (e && e.stack || e));
    try {
      bumpHolidayFail();
      pushHolidayDialog({ state: 'failed', detail: '打开文件对话框失败：' + ((e && e.message) || e) });
    } catch (_) {}
  }
}

/**
 * 检查是否需要更新。
 * @param {boolean} manual true = 用户手动点菜单（忽略 7 天节流与被推迟标记）
 */
function maybeHolidayUpdate(manual) {
  try {
    const now = new Date();
    const st = holidayStore.needsUpdate(now);
    const y = st.year;
    if (!st.need) {
      /* v2.1.0 P2-2：手动点「检查节假日更新」时若已是最新，原来什么都不做，
       * 用户会以为菜单失灵。现在给一个明确的「已是最新」态 + 数据来源。 */
      log('holiday: ' + y + ' 年数据已是最新，无需更新');
      if (manual) {
        markHolidayChecked();
        resetHolidayFail();
        showHolidayDialog({ state: 'uptodate', year: y, detail: holidaySourceLabel() });
      }
      return;
    }
    if (!manual) {
      if (holidayDismissedYear === y) { log('holiday: ' + y + ' 用户已选「以后再说」，跳过自动提示'); return; }
      if (!holidayThrottlePassed(now)) {
        log('holiday: 距上次检查不足 ' + Math.round(holidayThrottleWindowMs() / 86400000) + ' 天，跳过自动提示');
        return;
      }
    }
    markHolidayChecked();
    log('holiday: prompt update year=' + y + ' reason=' + st.reason);
    // reason: missing / partial / builtin —— 弹窗按原因给不同正文；missing 兼容旧字段
    showHolidayDialog({
      state: 'confirm',
      year: y,
      reason: st.reason,
      missing: (st.reason === 'missing')
    });
  } catch (e) {
    log('maybeHolidayUpdate failed: ' + (e && e.stack || e));
  }
}

/* ---- IPC ---- */
ipcMain.handle('holiday-get-data', function () {
  try {
    const data = holidayStore.getData();
    const st = holidayStore.needsUpdate(new Date());
    return { data: data, meta: { targetYear: st.year, need: st.need, reason: st.reason } };
  } catch (e) {
    log('holiday-get-data failed: ' + (e && e.message || e));
    return { data: null, meta: null };
  }
});
ipcMain.on('holiday-check-update', function () {
  try { maybeHolidayUpdate(true); } catch (e) { log('holiday-check-update failed: ' + (e && e.stack || e)); }
});
ipcMain.on('holiday-do-update', function (evt, year) {
  try { doHolidayUpdate(year); } catch (e) { log('holiday-do-update failed: ' + (e && e.stack || e)); }
});
ipcMain.on('holiday-postpone', function (evt, year) {
  try {
    holidayDismissedYear = Number(year) || 0;
    saveSettings();
    log('holiday: user postponed year=' + holidayDismissedYear);
  } catch (e) { log('holiday-postpone failed: ' + (e && e.stack || e)); }
  /* v2.1.0 P3-2：「以后再说」是用户主动推迟，不是更新失败，不该计入 holidayFailCount。
   * 复用防重复计数标记，让随后的 closeHolidayDialog() 不再 bumpHolidayFail()。
   * 关窗路径（× / 关闭按钮）保持原语义：只有真失败才计数。 */
  holidayFailCounted = true;
  closeHolidayDialog();
});
ipcMain.on('holiday-import-file', function () {
  try { importHolidayFile(); } catch (e) { log('holiday-import-file failed: ' + (e && e.stack || e)); }
});
ipcMain.on('holiday-dialog-close', function () {
  closeHolidayDialog();
});

app.whenReady().then(function () {
  log('=========== app start v' + app.getVersion() + ' ===========');
  // v2.4.0 第二轮：skin:// 特权协议 handler —— 把 skin://{basename} 映射到 userData/skins/{basename}。
  // registerSchemesAsPrivileged 已在模块顶层（app ready 前）注册；handle 必须在 ready 后注册。
  try {
    protocol.handle('skin', function (request) {
      return new Promise(function (resolve) {
        try {
          var name = skinUrlToName(request && request.url);
          var file = name ? path.join(skinsDir(), name) : '';
          if (name && fs.existsSync(file)) {
            net.fetch(pathToFileURL(file).toString()).then(resolve, function () {
              resolve(new Response('', { status: 404 }));
            });
            return;
          }
        } catch (e) {}
        resolve(new Response('', { status: 404 }));
      });
    });
  } catch (e) { log('skin protocol.handle failed: ' + (e && e.message || e)); }
  // v1.7.20：必须在建任何窗口之前先清残留（越早越好，此时 Electron 还没 fork 渲染/GPU 进程）。
  // 且函数内部按「父子关系」过滤，只杀不是自己子孙的同名进程 —— 见函数上方注释的事故记录。
  cleanupStaleInstances();
  loadSettings();          // v1.7.11：先读设置，再按设置建窗口
  recomputeTheme();        // v2.4.0 第二轮：baseTheme() = surfaceTheme('calendar')（唯一入口）
  /* v1.7.22 需求3：启动时检测系统版本并写回配置项 isWin11（供后续像素补偿微调用） */
  isWin11 = detectWin11();
  try { log('OS: ' + (isWin11 ? 'Windows 11' : 'Windows 10') + ' (build ' + os.release() + ')'); } catch (e) {}
  saveSettings();
  try { app.setLoginItemSettings({ openAtLogin: autoLaunch, path: process.execPath }); } catch (e) {}
  loadReminders();
  createWindow();
  /* v1.7.21 需求2：按持久化的显示形态启动。
   *   'dock' → 显示桌面插件（落点由 createDock 的 ready-to-show 恢复/定位）
   *   'icon' → 只显示托盘静态图标；插件窗口照样建好（只是不 show），
   *            这样左键点托盘切回插件时无需重建窗口，零延迟。
   * 菜单入口始终是「主窗右键 + 挂件条右键 + 托盘右键」三处（tray 只在 icon 形态存在）。 */
  createDock();
  if (dockOn && dockMode === 'icon') createTray();
  /* v2.2.0 需求4：桌面插件开关持久化 —— 启动时若上次开着就恢复显示。 */
  if (desktopOn) createDesktopWidget();
  /* v1.7.21 需求3：显示器 / 分辨率 / 任务栏高度变化后，插件可能落到工作区之外。
   * 只做「越界纠正」——保留用户自定义位置，仅把跑出去的部分拉回来；
   * 不再拽回默认位置（那属于已删除的"贴回任务栏"行为）。不调 setSize，避免触发崩溃。 */
  try {
    screen.on('display-metrics-changed', function () {
      if (!dockWin || dockWin.isDestroyed()) return;
      try {
        const cur = dockWin.getBounds();
        dockWin.setBounds(dockClamped(cur.x, cur.y));
      } catch (e) {}
    });
    /* v2.4.0 A3：显示器断开 → 回落到剩余存活工作区（越界夹取，不漂移不丢失） */
    screen.on('display-removed', function () {
      if (!dockWin || dockWin.isDestroyed()) return;
      try {
        const cur = dockWin.getBounds();
        dockWin.setBounds(dockClamped(cur.x, cur.y));
      } catch (e) {}
    });
    /* v2.4.0 A3：显示器重新连接 → 若该屏有记忆位置则还原到原屏原位 */
    screen.on('display-added', function (evt, display) {
      if (!dockWin || dockWin.isDestroyed() || dockMode !== 'dock') return;
      try {
        const rect = pickDockRestore(
          (typeof screen.getAllDisplays === 'function') ? screen.getAllDisplays() : [],
          dockBoundsByDisplay, (display && display.id), null);
        if (rect) dockWin.setBounds(dockClamped(rect.x, rect.y));
      } catch (e) {}
    });
  } catch (e) {}
  /* v2.4.0 第二轮：跟随系统实时深浅色。system 表面在系统切换时重算；color/image/text 手动的表面
   * 由 surfaceTheme 的 text 字段决定，不受系统深浅影响。基准主题变化时广播托盘/关注列表/设置。 */
  try {
    nativeTheme.on('updated', function () {
      var prev = themeMode;
      recomputeTheme();
      if (themeMode !== prev) {
        pushThemeToAll();
      }
      pushSkinToAll();   // 各表面 system 型明暗实时刷新（skin-state.theme 更新）
    });
  } catch (e) {}
  process.on('uncaughtException', function (e) {
    log('UNCAUGHT: ' + (e && e.stack || e));
  });
  // v1.7.9（修复）：用户双击桌面图标 / 开机自启后，必须主动 showMini 把窗口贴右下角，
  // 否则 createWindow 里 show:false + blur 自动隐藏会让用户以为"窗口不存在"。
  // setTimeout 0 是为了让 did-finish-load 先跑完（pushSkinToRenderer），再定位窗口。
  setTimeout(function () { try { showMini(); } catch (e) {} }, 120);
  // v1.6.2：每 60s 巡检到期关注；启动时先跑一次避免重启后错过今天
  reminderCheckTimer = setInterval(checkReminders, 60 * 1000);
  setTimeout(checkReminders, 500);
  /* v2.1.0 节假日年度更新：启动 5s 后查一次（让主窗先渲染完，别一开机就弹窗），
   * 之后每 6 小时轮询一次。真正的自动提示还受「7 天节流 + 用户已推迟」双重约束。 */
  setTimeout(function () { try { maybeHolidayUpdate(false); } catch (e) { log('holiday: auto check failed ' + (e && e.stack || e)); } }, 5000);
  holidayCheckTimer = setInterval(function () {
    try { maybeHolidayUpdate(false); } catch (e) { log('holiday: periodic check failed ' + (e && e.stack || e)); }
  }, 6 * 3600 * 1000);
});

app.on('before-quit', function () {
  log('app before-quit');
  quitting = true;              // 退出期间禁止 dock 自动重建
  // v1.7.20：清掉挂件条稳定计时器，避免残留定时器吊住主进程导致退出后仍有进程赖着不走
  if (dockStableTimer) { clearTimeout(dockStableTimer); dockStableTimer = null; }
  try { if (tray) tray.destroy(); tray = null; } catch (e) {}
  if (trayTooltipTimer) { clearInterval(trayTooltipTimer); trayTooltipTimer = null; }
  if (reminderCheckTimer) { clearInterval(reminderCheckTimer); reminderCheckTimer = null; }
  if (holidayCheckTimer) { clearInterval(holidayCheckTimer); holidayCheckTimer = null; }
  if (holidayWin) { try { holidayWin.destroy(); } catch (e) {} holidayWin = null; }
  if (reminderWin) { try { reminderWin.close(); } catch (e) {} reminderWin = null; }
  if (dockWin) { try { dockWin.destroy(); } catch (e) {} dockWin = null; }
  if (desktopWin) { try { desktopWin.destroy(); } catch (e) {} desktopWin = null; }
  if (settingsWin) { try { settingsWin.destroy(); } catch (e) {} settingsWin = null; }
  if (skinWin) { try { skinWin.destroy(); } catch (e) {} skinWin = null; }
  if (remindlistWin) { try { remindlistWin.destroy(); } catch (e) {} remindlistWin = null; }
  if (_rlSaveTimer) { clearTimeout(_rlSaveTimer); _rlSaveTimer = null; }
  if (_desktopSaveTimer) { clearTimeout(_desktopSaveTimer); _desktopSaveTimer = null; }
  /* v1.7.22.6：dock 落点防抖的兜底 —— 退出前必须立即 flush。
   * 否则用户拖完插件 500ms 内就退出的话，最后一次落点会因为防抖丢掉，
   * 下次启动回到上一次的位置（看起来像"位置记不住"）。 */
  flushDockBounds();
});
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (win) win.show();
});