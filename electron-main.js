'use strict';

const { app, BrowserWindow, Tray, screen, nativeImage, nativeTheme, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const taskbar = require('./taskbar');

let win = null;        // 主日历窗口（mini / expanded 双模式）
let tray = null;       // 托盘（静态应用图标，用于打开/退出）
let widgetWin = null;  // 任务栏时钟部件窗口（替换原生日历时钟）

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
  const x = Math.max(0, Math.round((wa.width - EXP_W) / 2));
  const y = Math.max(0, Math.round((wa.height - EXP_H) / 2));
  win.setBounds({ x: x, y: y, width: EXP_W, height: EXP_H });
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

function createTray() {
  const iconPath = path.join(__dirname, 'icon.ico');
  let img;
  if (fs.existsSync(iconPath)) img = nativeImage.createFromPath(iconPath);
  else img = makeClockIcon('--', '--');     // 兜底：无 ico 时用占位图
  tray = new Tray(img);
  tray.setToolTip('简洁桌面日历');
  tray.on('click', toggleFromTray);
  const contextMenu = Menu.buildFromTemplate([
    { label: '打开日历', click: function () { showMini(); } },
    { label: '退出', click: function () { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

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
    win.hide();
    mode = 'mini';
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
  widgetWin.loadFile(path.join(__dirname, 'widget.html'));
  widgetWin.webContents.on('did-finish-load', function () { applyWidgetTheme(); });
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

let placeAttempts = 0;
function placeWidget() {
  const phys = taskbar.getClockRect();
  if (!phys) {
    if (placeAttempts++ < 20) { setTimeout(placeWidget, 400); return; }
    widgetWin.setBounds(fallbackRect());
    widgetWin.show();
    return;
  }
  widgetWin.setBounds(logicalRect(phys));
  if (!widgetWin.isVisible()) widgetWin.show();
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
ipcMain.on('set-tooltip', function (evt, str) {
  if (tray && str) tray.setToolTip(String(str));
});
// 部件点击 → 打开/关闭主日历
ipcMain.on('widget-click', function () { toggleFromTray(); });

app.whenReady().then(function () {
  try { app.setLoginItemSettings({ openAtLogin: true, path: process.execPath }); } catch (e) {}

  // 写入 HideClock 注册表策略（系统级隐藏，重启 explorer 后原生时钟仍不显示）
  try { taskbar.setHideClockPolicy(true); } catch (e) {}

  createWindow();
  createTray();
  createWidget();
  placeWidget();                 // 先定位部件窗口：此时原生时钟仍在，可取到准确矩形

  // 定位完成后再即时隐藏原生时钟（无需重启 explorer）
  try { taskbar.setClockVisible(false); } catch (e) {}

  // 主题变化（如用户在系统设置里切换深浅）→ 同步部件
  nativeTheme.on('updated', applyWidgetTheme);
  // 显示器/缩放变化 → 重新定位部件
  screen.on('display-metrics-changed', function () {
    const phys = taskbar.getClockRect();
    if (phys && widgetWin) widgetWin.setBounds(logicalRect(phys));
  });
});

// 退出前还原原生时钟（显示 + 清策略），下次重启系统原生恢复
app.on('before-quit', function () {
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
