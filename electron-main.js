'use strict';

const { app, BrowserWindow, Tray, screen, nativeImage, ipcMain, Menu } = require('electron');
const path = require('path');
const zlib = require('zlib');

let win = null;
let tray = null;

// ====== 窗口模式状态 ======
// mode: 'mini'（右下小窗）| 'expanded'（居中大窗，可拖拽吸附）
// suppressBlur: 从托盘唤出窗口瞬间，抑制 blur 误关（避免打开即被关掉）
let mode = 'mini';
let suppressBlur = false;

const MINI_W = 430, MINI_H = 540;     // 右下小窗：与模板 widget 尺寸一致
const EXP_W = 820, EXP_H = 1020;       // 居中大窗：与 .max 放大字号设计尺寸一致

/* =====================================================================
 * R2. 关于"占住原生日历的位子"
 * ---------------------------------------------------------------------
 * 我们无法（也不应）删除或替换 Windows 任务栏通知区右侧的原生时钟——
 * 那需要向 explorer.exe 注入代码，行为不稳定且极易触发杀毒软件拦截。
 * 经与用户确认，采用最贴近原生体验的方案：在通知区放置一个【实时时钟
 * 托盘图标】，紧贴原生时钟左侧。点击该图标即可唤出/隐藏日历窗口，
 * 视觉与交互都最接近"系统原生日历"的占位效果。
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
  setWidgetMax(false);   // 回到缩小态：移除 widget 的 .max 放大 class
  win.show();
  win.focus();
}

function showExpanded() {
  const wa = workArea();
  mode = 'expanded';
  win.setResizable(false);
  win.setMovable(true);
  // 居中并 clamp 到屏幕内（避免小屏下 y 为负导致窗口顶部出屏）
  const x = Math.max(0, Math.round((wa.width - EXP_W) / 2));
  const y = Math.max(0, Math.round((wa.height - EXP_H) / 2));
  win.setBounds({ x: x, y: y, width: EXP_W, height: EXP_H });
  setWidgetMax(true);    // 放大态：给 widget 加 .max，使其填满 760×900 窗口并放大字号
  win.show();
  win.focus();
}

// R4. 让渲染进程里的 #widget 同步加/去 .max class（放大模式下填满 expanded 窗口）
function setWidgetMax(on) {
  if (!win || !win.webContents) return;
  try {
    win.webContents.executeJavaScript(
      '(function(){var w=document.getElementById("widget");if(w)w.classList.' +
      (on ? 'add' : 'remove') + '("max");})();'
    );
  } catch (e) { /* 页面未就绪时忽略 */ }
}

// R3. 托盘图标点击：窗口隐藏则显示 mini（缩小态），已显示则隐藏
function toggleFromTray() {
  if (!win) return;
  // 维护 suppressBlur，避免窗口刚打开就被随后的 blur 事件误关
  suppressBlur = true;
  setTimeout(function () { suppressBlur = false; }, 300);
  if (win.isVisible()) {
    setWidgetMax(false);
    win.hide();
    mode = 'mini';
  } else {
    // 始终回到 mini（缩小）状态：保证下次托盘点击永远显示缩小态
    showMini();
  }
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/* =====================================================================
 * 零依赖迷你 PNG 编码器（R3：把实时时间光栅化为托盘图标）
 * ---------------------------------------------------------------------
 * Windows 托盘只显示图标图像、不显示文字，必须把时间画成 PNG。
 * 约束：不能用 node-canvas 等原生依赖。这里纯 JS 实现：
 *   RGBA Buffer -> zlib.deflateSync -> 拼 PNG 块(IHDR/IDAT/IEND) -> CRC32
 *   -> nativeImage.createFromBuffer -> tray.setImage
 * ===================================================================== */

// 内置 5x7 像素字体：'0'-'9'、':'、'-'、'/'、' '（每行 5 字符宽，共 7 行）
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

// CRC32 查表
const CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深 8
  ihdr[9] = 6;   // 色彩类型 RGBA
  ihdr[10] = 0;  // 压缩
  ihdr[11] = 0;  // 滤波
  ihdr[12] = 0;  // 交错

  // IDAT：每行前置 1 字节 filter(0)，再 zlib deflate
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// 把两行文字（HH:MM / MM-DD）光栅化为 64x32 的托盘图标（深色底 + 白字）
function makeClockIcon(line1, line2) {
  const W = 64, H = 32;
  const rgba = Buffer.alloc(W * H * 4, 0);
  const bg = [0x20, 0x23, 0x2b, 0xff];           // 不透明深色底，保证任何任务栏都可读
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = bg[0]; rgba[i * 4 + 1] = bg[1]; rgba[i * 4 + 2] = bg[2]; rgba[i * 4 + 3] = bg[3];
  }
  const fg = [0xff, 0xff, 0xff, 0xff];
  const SX = 2, SY = 2;                           // 每个字体像素放大 2x，提升可读性
  const GLYPH_W = 5, GLYPH_H = 7;
  const lines = [line1, line2];
  const lineH = GLYPH_H * SY;
  const totalH = lineH * 2 + 2;                   // 两行 + 中间 2px 间隔
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
            for (let sy = 0; sy < SY; sy++) {
              for (let sx = 0; sx < SX; sx++) {
                const px = cx + gx * SX + sx;
                const py = baseY + gy * SY + sy;
                if (px >= 0 && px < W && py >= 0 && py < H) {
                  const idx = (py * W + px) * 4;
                  rgba[idx] = fg[0]; rgba[idx + 1] = fg[1]; rgba[idx + 2] = fg[2]; rgba[idx + 3] = fg[3];
                }
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

let lastClockStr = '';
function updateTrayClock() {
  const t = new Date();
  const line1 = pad2(t.getHours()) + ':' + pad2(t.getMinutes());   // HH:MM（24 小时制）
  const line2 = pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());  // MM-DD
  const key = line1 + '|' + line2;
  if (key === lastClockStr) return;          // 仅当字符串变化才重绘（最多每秒一次）
  lastClockStr = key;
  if (tray) tray.setImage(makeClockIcon(line1, line2));
}

function createTray() {
  tray = new Tray(makeClockIcon('--:--', '--:--'));
  tray.setToolTip('简洁桌面日历');
  tray.on('click', toggleFromTray);
  updateTrayClock();
  setInterval(updateTrayClock, 1000);

  // 右键菜单：提供"退出"，否则只能靠任务管理器结束进程
  const contextMenu = Menu.buildFromTemplate([
    { label: '退出', click: function () { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

/* ===== 创建主窗口：无边框 + 透明 + 置顶 + 隐藏标题栏 ===== */
function createWindow() {
  win = new BrowserWindow({
    width: MINI_W,
    height: MINI_H,
    frame: false,
    transparent: true,
    resizable: false,           // 尺寸由 mini/expanded 模式控制，禁止用户自由缩放
    alwaysOnTop: true,
    skipTaskbar: true,          // 常驻托盘，不占用任务栏按钮
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    show: false,                // 默认隐藏，由托盘点击唤出
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'calendar.html'));

  // 跟随系统：读取 Windows 个性化强调色，注入 window.__ACCENT__（BGR→RGB）
  win.webContents.on('did-finish-load', function () {
    try {
      const { systemPreferences } = require('electron');
      const bgr = systemPreferences.getAccentColor();   // 形如 'FF7F50'（BGR 顺序）
      const hex = bgr.replace('#', '');
      const r = hex.substr(4, 2), g = hex.substr(2, 2), b = hex.substr(0, 2);
      const rgb = '#' + r + g + b;
      win.webContents.executeJavaScript('window.__ACCENT__=' + JSON.stringify(rgb) + ';');
    } catch (e) { /* 非 Windows 或不支持时忽略，主题按钮仍可按默认工作 */ }
  });

  // 关闭改为隐藏（常驻后台），而非真正退出进程
  win.on('close', function (e) {
    if (app.isQuiting) return;
    e.preventDefault();
    win.hide();
  });

  // R4. 点击外部消失（mini 与 expanded 两种模式都生效）
  win.on('blur', function () {
    if (suppressBlur) return;     // 从托盘刚唤出时抑制，避免打开瞬间误关
    win.hide();
    mode = 'mini';                // 复位：保证下次托盘点击永远回到 mini（缩小）状态
  });

  win.on('closed', function () {
    win = null;
  });
}

/* ===== IPC：渲染进程 -> 主进程 ===== */
// R4. 切换 mini / expanded
ipcMain.on('toggle-expand', function () {
  if (!win) return;
  if (mode === 'expanded') showMini(); else showExpanded();
});
// R4. 拖拽结束后，expanded 模式下吸附到最近屏幕边（阈值 24px）
ipcMain.on('request-snap', function () {
  if (!win || mode !== 'expanded') return;
  const b = win.getBounds();
  const wa = workArea();
  const TH = 24;
  let nx = b.x, ny = b.y;
  if (b.x <= TH) nx = 0;
  else if (b.x + b.width >= wa.width - TH) nx = wa.width - b.width;
  if (b.y <= TH) ny = 0;
  else if (b.y + b.height >= wa.height - TH) ny = wa.height - b.height;
  win.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
});
// R3. 接收渲染进程推送的农历+星期 tooltip 字符串
ipcMain.on('set-tooltip', function (evt, str) {
  if (tray && str) tray.setToolTip(String(str));
});

app.whenReady().then(function () {
  // R2. 开机自启（幂等：每次启动调用即可，无需判断是否已设置）
  try {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  } catch (e) { /* 不支持的平台忽略 */ }

  createWindow();
  createTray();

  // R3. 默认隐藏，由【点击托盘图标】唤出界面（符合需求：点击托盘 → 右下角出现，
  // 鼠标点别处 → 界面消失）。因此这里不再自动 showMini()，窗口静静驻留后台。
});

// Windows / Linux：所有窗口关闭后退出（本应用窗口仅隐藏，通常不触发）
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (win) {
    win.show();
  }
});
