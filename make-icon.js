'use strict';
/*
 * make-icon.js —— 零依赖生成 icon.ico（含 16/32/48/256 三个尺寸）。
 * 设计：雅蓝圆角磁贴 + 白色日历卡 + 朱砂红表头 + 灰/红网格点。
 * 运行：node make-icon.js  ->  生成 ./icon.ico
 */
const fs = require('fs');
const zlib = require('zlib');

// ---------- 颜色 ----------
const ACCENT = [59, 111, 212];   // 雅蓝 #3b6fd4
const WHITE  = [255, 255, 255];
const CINNA  = [214, 69, 63];    // 朱砂 #d6453f
const GRAY   = [150, 156, 168];  // 网格点灰

// ---------- 像素画布（RGBA） ----------
function Canvas(size) {
  this.s = size;
  this.buf = new Float64Array(size * size * 4); // 用 float 做预乘前的叠加，最后转 8bit
}

Canvas.prototype.blend = function (x, y, c, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= this.s || y >= this.s) return;
  const i = (y * this.s + x) * 4;
  const er = this.buf[i], eg = this.buf[i + 1], eb = this.buf[i + 2], ea = this.buf[i + 3];
  const outA = a + ea * (1 - a);
  if (outA <= 0) { this.buf[i + 3] = 0; return; }
  this.buf[i]     = (c[0] * a + er * ea * (1 - a)) / outA;
  this.buf[i + 1] = (c[1] * a + eg * ea * (1 - a)) / outA;
  this.buf[i + 2] = (c[2] * a + eb * ea * (1 - a)) / outA;
  this.buf[i + 3] = outA;
};

// 圆角矩形覆盖度（硬边）：corners = [tl, tr, br, bl]
Canvas.prototype.roundRect = function (x0, y0, w, h, r, c, a, corners) {
  const tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x0 + x, gy = y0 + y;
      let inside = true;
      if (x < r) {
        if (y < r && tl && (x - r) * (x - r) + (y - r) * (y - r) > r * r) inside = false;
        if (y >= h - r && bl && (x - r) * (x - r) + (y - (h - r)) * (y - (h - r)) > r * r) inside = false;
      }
      if (x >= w - r) {
        if (y < r && tr && (x - (w - r)) * (x - (w - r)) + (y - r) * (y - r) > r * r) inside = false;
        if (y >= h - r && br && (x - (w - r)) * (x - (w - r)) + (y - (h - r)) * (y - (h - r)) > r * r) inside = false;
      }
      if (inside) this.blend(gx, gy, c, a);
    }
  }
};

Canvas.prototype.toRGBA8 = function () {
  const out = Buffer.alloc(this.s * this.s * 4);
  for (let i = 0; i < this.buf.length; i += 4) {
    out[i]     = Math.round(Math.min(255, this.buf[i]));
    out[i + 1] = Math.round(Math.min(255, this.buf[i + 1]));
    out[i + 2] = Math.round(Math.min(255, this.buf[i + 2]));
    out[i + 3] = Math.round(Math.min(255, this.buf[i + 3] * 255));
  }
  return out;
};

// ---------- PNG 编码（与 electron-main 同款：RGBA + 每行 filter 0 + zlib） ----------
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
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 绘制一个尺寸的日历图标 ----------
function renderIcon(S) {
  const cv = new Canvas(S);
  const m = Math.round(S * 0.06);
  const tileX = m, tileY = m, tileW = S - 2 * m, tileH = S - 2 * m;
  const tileR = Math.round(tileW * 0.22);
  // 1) 雅蓝磁贴
  cv.roundRect(tileX, tileY, tileW, tileH, tileR, ACCENT, 1, [true, true, true, true]);

  // 2) 白色日历卡（内缩）
  const inPad = Math.round(S * 0.07);
  const cX = tileX + inPad, cY = tileY + inPad, cW = tileW - 2 * inPad, cH = tileH - 2 * inPad;
  const cR = Math.round(cW * 0.18);
  cv.roundRect(cX, cY, cW, cH, cR, WHITE, 1, [true, true, true, true]);

  // 3) 朱砂红表头（仅上半圆角）
  const headH = Math.round(cH * 0.22);
  const headR = Math.round(cR * 0.92);
  cv.roundRect(cX, cY, cW, headH, headR, CINNA, 1, [true, true, false, false]);

  // 4) 网格点：4 列 x 3 行，首点用朱砂红表示"今天/节假日"
  const top = cY + headH + Math.round(cH * 0.10);
  const bottom = cY + cH - Math.round(cH * 0.10);
  const areaH = bottom - top;
  const gapX = cW * 0.07;
  const areaW = cW - 2 * gapX;
  const cols = 4, rows = 3;
  const cellW = areaW / cols, cellH = areaH / rows;
  const dot = Math.max(2, Math.round(Math.min(cellW, cellH) * 0.34));
  const dotR = Math.max(1, Math.round(dot / 2));
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const cx = cX + gapX + cellW * (col + 0.5);
      const cy = top + cellH * (r + 0.5);
      const dx = Math.round(cx - dot / 2), dy = Math.round(cy - dot / 2);
      const isToday = (r === 0 && col === 0);
      cv.roundRect(dx, dy, dot, dot, dotR, isToday ? CINNA : GRAY, 1, [true, true, true, true]);
    }
  }
  return encodePNG(S, cv.toRGBA8());
}

// ---------- 打包为 ICO ----------
function buildICO(sizes) {
  const pngs = sizes.map(renderIcon);
  const count = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type = icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + count * 16;
  const dirEntries = [];
  for (let i = 0; i < count; i++) {
    const S = sizes[i], png = pngs[i];
    const e = Buffer.alloc(16);
    e.writeUInt8(S >= 256 ? 0 : S, 0);     // width (0 => 256)
    e.writeUInt8(S >= 256 ? 0 : S, 1);     // height
    e.writeUInt8(0, 2);                    // colors
    e.writeUInt8(0, 3);                    // reserved
    e.writeUInt16LE(1, 4);                 // planes
    e.writeUInt16LE(32, 6);                // bit count
    e.writeUInt32LE(png.length, 8);        // bytes in res
    e.writeUInt32LE(offset, 12);           // offset
    dirEntries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirEntries, ...pngs]);
}

const ico = buildICO([16, 32, 48, 256]);
fs.writeFileSync('./icon.ico', ico);
console.log('已生成 icon.ico，字节数:', ico.length, '，尺寸: 16/32/48/256');
