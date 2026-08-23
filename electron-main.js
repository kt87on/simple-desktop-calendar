'use strict';

const { app, BrowserWindow, Tray, screen, nativeImage, nativeTheme, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const taskbar = require('./taskbar');

let win = null;        // 主日历窗口（mini / expanded 双模式）
let widgetWin = null;  // 任务栏时钟部件窗口（替换原生日历时钟）

// v1.2：移除系统托盘。退出入口改为：
//  ① 任务栏部件右键菜单「退出软件」；② 主日历窗口右上角 ✕（确认后退出）
// 退出统一走 exitApp() → 还原原生时钟 + 关闭全部窗口 + app.quit()

// ====== 窗口模式状态 ======
let mode = 'mini';
let suppressBlur = false;

const MINI_W = 430, MINI_H = 540;
const EXP_W = 820, EXP_H = 1020;

/* =====================================================================
 * 任务栏时钟替换（v1.1 新增）
 * ---------------------------------------------------------------------
 * 用户诉求：隐藏 Windows 任务栏原生时间/日历，由本程序部件在同位置同尺寸
 * 替换显示（上时间 24h、下日期 YYYY/M/D），并跟随系统深浅主题切黑/白字。
 * 实现：隐藏原生 TrayClockWClass 窗口（taskbar.js）→ 取其矩形 → 用透明
 * 无边框窗口精确重叠 → nativeTheme 决定文字颜色。
 * ===================================================================== */

function workArea() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return { width: width, height: height };
}

function showMini() {
  const wa = workArea();
  mode = 'mini';
  win.setResizable(false);
  win.setMovable(true);
  win.setBounds({
    x: wa.width - MINI_W - 8,
    y: wa.height - MINI_H - 8,
    width: MINI_W,
    height: MINI_H
  });
  setWidgetMax(false);
  win.show();
  win.focus();
}

function showExpanded() {
  const wa = workArea();
  mode = 'expanded';
  win.setResizable(false);
  win.setMovable(true);
  // 需求4：上方贴屏幕最上方(y=0)、下方贴任务栏(高度=workArea高度)，等比扩大
  const taskbarH = (screen.getPrimaryDisplay().size.height) - wa.height;
  const h = wa.height;                       // 贴顶(y=0) 到 贴任务栏底
  const w = Math.round(MINI_W * (h / MINI_H)); // 等比放大（保持 430:540 比例）
  const x = Math.max(0, Math.round((wa.width - w) / 2));
  win.setBounds({ x: x, y: 0, width: w, height: h });
  setWidgetMax(true);
  win.show();
  win.focus();
}

function setWidgetMax(on) {
  if (!win || !win.webContents) return;
  try {
    win.webContents.executeJavaScript(
      '(function(){var w=document.getElementById("widget");if(w)w.classList.' +
      (on ? 'add' : 'remove') + '("max");})();'
    );
  } catch (e) { /* 页面未就绪时忽略 */ }
}

// 托盘 / 部件点击：窗口隐藏则显示 mini，已显示则隐藏
function toggleFromTray() {
  if (!win) return;
  suppressBlur = true;
  setTimeout(function () { suppressBlur = false; }, 300);
  if (win.isVisible()) {
    setWidgetMax(false);
    win.hide();
    mode = 'mini';
  } else {
    showMini();
  }
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/* =====================================================================
 * 零依赖迷你 PNG 编码器（用于托盘静态图标兜底）
 * ===================================================================== */
const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00000', '00100', '00000', '00100', '00000', '00000'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
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
function makeClockIcon(line1, line2) {
  const W = 64, H = 32;
  const rgba = Buffer.alloc(W * H * 4, 0);
  const bg = [0x20, 0x23, 0x2b, 0xff];
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = bg[0]; rgba[i * 4 + 1] = bg[1]; rgba[i * 4 + 2] = bg[2]; rgba[i * 4 + 3] = bg[3];
  }
  const fg = [0xff, 0xff, 0xff, 0xff];
  const SX = 2, SY = 2, GLYPH_W = 5, GLYPH_H = 7;
  const lines = [line1, line2];
  const lineH = GLYPH_H * SY;
  const totalH = lineH * 2 + 2;
  const y0 = Math.floor((H - totalH) / 2);
  lines.forEach(function (line, li) {
    const chars = line.split('');
    const charW = GLYPH_W * SX;
    const textW = chars.length * charW + (chars.length - 1) * 2;
    const x0 = Math.floor((W - textW) / 2);
    const baseY = y0 + li * (lineH + 2);
    let cx = x0;
    chars.forEach(function (ch) {
      const glyph = FONT[ch] || FONT[' '];
      for (let gy = 0; gy < GLYPH_H; gy++) {
        const row = glyph[gy];
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (row[gx] === '1') {
            for (let sy = 0; sy < SY; sy++) for (let sx = 0; sx < SX; sx++) {
              const px = cx + gx * SX + sx, py = baseY + gy * SY + sy;
              if (px >= 0 && px < W && py >= 0 && py < H) {
                const idx = (py * W + px) * 4;
                rgba[idx] = fg[0]; rgba[idx + 1] = fg[1]; rgba[idx + 2] = fg[2]; rgba[idx + 3] = fg[3];
              }
            }
          }
        }
      }
      cx += charW + 2;
    });
  });
  return nativeImage.createFromBuffer(encodePNG(W, H, rgba));
}

// v1.2：已移除系统托盘。打开/退出入口改为部件右键菜单与主窗口 ✕ 按钮。
function createTray() { /* 占位：托盘已取消，保留空函数避免调用处报错 */ }

/* ===== 主日历窗口：无边框 + 透明 + 置顶 ===== */
function createWindow() {
  win = new BrowserWindow({
    width: MINI_W, height: MINI_H,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#00000000', titleBarStyle: 'hidden', show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile(path.join(__dirname, 'calendar.html'));

  win.webContents.on('did-finish-load', function () {
    try {
      const { systemPreferences } = require('electron');
      const bgr = systemPreferences.getAccentColor();
      const hex = bgr.replace('#', '');
      const rgb = '#' + hex.substr(4, 2) + hex.substr(2, 2) + hex.substr(0, 2);
      win.webContents.executeJavaScript('window.__ACCENT__=' + JSON.stringify(rgb) + ';');
    } catch (e) { /* 非 Windows 或不支持时忽略 */ }
  });

  win.on('close', function (e) {
    if (app.isQuiting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('blur', function () {
    if (suppressBlur) return;
    // 需求5：点击软件范围外 → 取消日期选中（窗口不消失）
    try { win.webContents.executeJavaScript('window.__clearRange && window.__clearRange();'); } catch (e) {}
    // 注意：不再隐藏窗口，保持常驻（符合用户"窗口不会消失"诉求）
  });
  win.on('closed', function () { win = null; });
}

/* ===== 任务栏部件窗口：透明无边框，重叠原生时钟位置 ===== */
function createWidget() {
  widgetWin = new BrowserWindow({
    width: 84, height: 40,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#00000000', show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  // 层级用 'taskbar'（而非 'screen-saver'）：在 Win10 上与任务栏同层、稳定盖住原生时钟，
  // 且不会像 screen-saver 那样被 DWM 处理成“全屏置顶”导致闪烁/被任务栏盖
  try { widgetWin.setAlwaysOnTop(true, 'taskbar'); } catch (e) {}
  widgetWin.loadFile(path.join(__dirname, 'widget.html'));
  widgetWin.webContents.on('did-finish-load', function () {
    applyWidgetTheme();
    if (widgetWin.isVisible()) try { widgetWin.moveTop(); } catch (e) {}
  });
  // 部件常驻任务栏，点击外部不隐藏（与日历窗口区分）
}

// 物理像素矩形 → 逻辑像素（按所在显示器缩放换算）
function logicalRect(phys) {
  const cx = phys.x + phys.width / 2;
  const cy = phys.y + phys.height / 2;
  const disp = screen.getDisplayNearestPoint({ x: cx, y: cy });
  const sf = (disp && disp.scaleFactor) || 1;
  return {
    x: Math.round(phys.x / sf), y: Math.round(phys.y / sf),
    width: Math.round(phys.width / sf), height: Math.round(phys.height / sf)
  };
}

// 兜底位置：取不到原生时钟矩形时，贴右下角任务栏
function fallbackRect() {
  const d = screen.getPrimaryDisplay();
  const wa = d.workAreaSize;
  return { x: wa.width - 90, y: d.size.height - 40, width: 84, height: 40 };
}

/*
 * v1.4 隐藏策略重构（修复 B.1 + 修复 C）：
 *   - 彻底消灭"每 8s 冷启动 PowerShell"的卡顿元凶：主隐藏路径改为事件驱动，
 *     仅在以下时机重新隐藏：启动一次 / 显示器变化 / 系统从睡眠恢复 / 30s 轻量可见性检查。
 *   - 30s 检查只用 IsWindowVisible（极轻量，不遍历树、不创建进程），只有发现
 *     原生时钟又被 explorer 重绘显示出来时才重新隐藏。
 *   - 若 ffi 不可用（极少数环境连原生模块都禁），启用 FALLBACK_COVER：不隐藏
 *     原生时钟，而是把部件窗口设为与任务栏同色的不透明覆盖层，物理盖住原生时钟。
 */

// 是否启用"同色覆盖兜底"（FFI 不可用时自动开启）
let FALLBACK_COVER = false;

let placeAttempts = 0;
let hideGuardTimer = null;
function startHideGuard() {
  if (hideGuardTimer) return;
  // 30s 轻量检查：仅判断原生时钟是否又可见，是才重新隐藏（不再每 8s 全量遍历）
  hideGuardTimer = setInterval(function () {
    if (FALLBACK_COVER) return;       // 覆盖模式下不隐藏，无需检查
    try { taskbar.setClockVisible(false); } catch (e) {}
  }, 30000);
}

// 事件驱动：显示器/分辨率变化
function onDisplayChange() {
  taskbar.resetCache();
  const phys = taskbar.getClockRect();
  if (phys && widgetWin) {
    widgetWin.setBounds(logicalRect(phys));
    if (widgetWin.isVisible()) try { widgetWin.moveTop(); } catch (e) {}
    try { taskbar.setClockVisible(false); } catch (e) {}
  } else if (widgetWin) {
    widgetWin.setBounds(fallbackRect());
    if (widgetWin.isVisible()) try { widgetWin.moveTop(); } catch (e) {}
  }
}

// 事件驱动：系统从睡眠恢复（explorer 可能重绘复原原生时钟）
function onResume() {
  setTimeout(function () {
    taskbar.resetCache();
    try { taskbar.setClockVisible(false); } catch (e) {}
    onDisplayChange();
  }, 2000);
}

function placeWidget() {
  if (!taskbar.ffiAvailable()) {
    // FFI 不可用：进入同色覆盖兜底模式（不依赖隐藏原生时钟）
    FALLBACK_COVER = true;
    enterCoverMode();
    return;
  }
  const phys = taskbar.getClockRect();
  if (!phys) {
    if (placeAttempts++ < 8) { setTimeout(placeWidget, 300); return; }
    // 找不到原生时钟矩形也尝试隐藏一次（可能矩形取不到但 hwnd 能找到）
    try { taskbar.setClockVisible(false); } catch (e) {}
    widgetWin.setBounds(fallbackRect());
    widgetWin.show();
    try { widgetWin.moveTop(); } catch (e) {}
    startHideGuard();
    return;
  }
  widgetWin.setBounds(logicalRect(phys));
  if (!widgetWin.isVisible()) widgetWin.show();
  try { widgetWin.moveTop(); } catch (e) {}
  // 定位完成后立即隐藏原生时钟
  try { taskbar.setClockVisible(false); } catch (e) {}
  startHideGuard();
}

// 同色覆盖兜底：部件窗口设为与任务栏同色的不透明覆盖层，物理盖住原生时钟
function enterCoverMode() {
  if (!widgetWin) return;
  const rect = fallbackRect();
  widgetWin.setBounds(rect);
  if (!widgetWin.isVisible()) widgetWin.show();
  try { widgetWin.moveTop(); } catch (e) {}
  // 通知 widget 渲染层进入"覆盖模式"（不透明 + 跟随任务栏颜色）
  try { widgetWin.webContents.executeJavaScript('window.__coverMode && window.__coverMode(true);'); } catch (e) {}
  // 覆盖模式下仍需定时 moveTop，防止被任务栏其他元素盖住（低频，5s 一次且零进程）
  if (hideGuardTimer) clearInterval(hideGuardTimer);
  hideGuardTimer = setInterval(function () {
    if (widgetWin && widgetWin.isVisible()) try { widgetWin.moveTop(); } catch (e) {}
  }, 5000);
}

// nativeTheme → 部件文字黑/白
function applyWidgetTheme() {
  if (!widgetWin || !widgetWin.webContents) return;
  const dark = nativeTheme.shouldUseDarkColors;
  widgetWin.webContents.executeJavaScript('window.__applyTheme && window.__applyTheme(' + dark + ');');
}

/* ===== IPC ===== */
ipcMain.on('toggle-expand', function () {
  if (!win) return;
  if (mode === 'expanded') showMini(); else showExpanded();
});
ipcMain.on('request-snap', function () {
  if (!win || mode !== 'expanded') return;
  const b = win.getBounds();
  const wa = workArea();
  const TH = 24;
  let nx = b.x, ny = b.y;
  if (b.x <= TH) nx = 0; else if (b.x + b.width >= wa.width - TH) nx = wa.width - b.width;
  if (b.y <= TH) ny = 0; else if (b.y + b.height >= wa.height - TH) ny = wa.height - b.height;
  win.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
});
// 部件点击 → 打开/关闭主日历
ipcMain.on('widget-click', function () { toggleFromTray(); });

// v1.2：退出软件（X 关闭按钮 / 右键菜单「退出」共用）→ 先弹原生确认框
const { dialog } = require('electron');
ipcMain.on('exit-app', function (evt) {
  const w = evt.sender ? evt.sender.getOwnerBrowserWindow() : null;
  const opts = {
    type: 'question',
    buttons: ['否', '是，退出'],
    defaultId: 0,
    cancelId: 0,
    title: '退出软件',
    message: '是否退出软件？\n（退出后将恢复系统原生时间日历）'
  };
  dialog.showMessageBox(w || win, opts).then(function (res) {
    if (res.response === 1) {
      app.isQuiting = true;
      app.quit();
    }
  });
});

app.whenReady().then(function () {
  try { app.setLoginItemSettings({ openAtLogin: true, path: process.execPath }); } catch (e) {}

  createWindow();
  createWidget();
  placeWidget();                 // 先定位部件窗口：FFI 可用则隐藏原生时钟并重叠；不可用则进入覆盖兜底

  // 主题变化（如用户在系统设置里切换深浅）→ 同步部件
  nativeTheme.on('updated', applyWidgetTheme);
  // 显示器/缩放变化 → 重新定位部件 + 重新隐藏（事件驱动，非轮询）
  screen.on('display-metrics-changed', onDisplayChange);
  // 系统从睡眠恢复 → 重新隐藏（explorer 可能重绘复原原生时钟）
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('resume', onResume);
  } catch (e) {}
});

// 退出前还原原生时钟（显示 + 清策略）；覆盖模式无需还原（原生时钟从未被隐藏）
app.on('before-quit', function () {
  if (FALLBACK_COVER) return;
  try {
    taskbar.setClockVisible(true);
    taskbar.setHideClockPolicy(false);
  } catch (e) {}
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (win) win.show();
});
