'use strict';
/*
 * make-icon.js —— 零依赖生成 icon.ico（16 / 32 / 48 / 256 四档）。
 *
 * 设计系统 v2.0「纸与光」图标：
 *   结构：雅蓝磁贴（带自上而下的体积渐变 + 顶部高光）
 *        → 白色日历卡（内缩，圆角）
 *        → 朱砂表头（仅上半圆角，带两枚装订环）
 *        → 网格点阵（首点朱砂 = 今天）
 *
 * 分尺寸策略（16px 下细节会糊成一团，必须减笔画）：
 *   16px  → 磁贴 + 白卡 + 红条 + 2×3 点阵（不画装订环、不加高光）
 *   32px  → 加装订环 + 高光
 *   48/256 → 全套，含卡片底部极淡的分隔感
 *
 * 运行：node make-icon.js  ->  生成 ./icon.ico
 */
const fs = require('fs');
const zlib = require('zlib');

// ---------- 颜色（与设计系统一致的色板） ----------
const BLUE_TOP  = [74, 130, 224];   // blue-400 偏亮（磁贴顶部）
const BLUE_BOT  = [53, 101, 201];   // 磁贴底部
const BLUE_EDGE = [40, 84, 178];    // 磁贴描边
const WHITE     = [255, 255, 255];
const WHITE_HI  = [255, 255, 255];  // 卡片顶部高光
const CARD_SHAD = [176, 186, 204];  // 卡片底部极淡阴影线
const CINNA     = [214, 69, 63];    // red-500 朱砂
const CINNA_DK  = [191, 51, 48];    // red-600
const GRAY      = [150, 156, 168];  // 网格点灰

// ---------- 像素画布（RGBA，预乘前用 float 叠加） ----------
function Canvas(size) {
  this.s = size;
  this.buf = new Float64Array(size * size * 4);
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

// 线性插值两色
function mix(c1, c2, t) {
  return [c1[0] + (c2[0] - c1[0]) * t,
          c1[1] + (c2[1] - c1[1]) * t,
          c1[2] + (c2[2] - c1[2]) * t];
}

// 圆角矩形覆盖度（硬边）：corners = [tl, tr, br, bl]
// fill 可为纯色数组，或函数 (y, h) => 颜色数组（用于垂直渐变）
Canvas.prototype.roundRect = function (x0, y0, w, h, r, fill, a, corners) {
  const tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];
  const grad = (typeof fill === 'function');
  for (let y = 0; y < h; y++) {
    const row = grad ? fill(y, h) : fill;
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
      if (inside) this.blend(x0 + x, y0 + y, row, a);
    }
  }
};

// 圆形（实心，带抗锯齿）
Canvas.prototype.disc = function (cx, cy, r, c, a) {
  const x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
  const y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.sqrt((x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - cy) * (y + 0.5 - cy));
      const cov = Math.max(0, Math.min(1, r + 0.5 - d));
      if (cov > 0) this.blend(x, y, c, a * cov);
    }
  }
};

Canvas.prototype.toRGBA8 = function () {
  const out = Buffer.alloc(this.s * this.s * 4);
  for (let i = 0; i < this.buf.length; i += 4) {
    out[i]     = Math.round(Math.max(0, Math.min(255, this.buf[i])));
    out[i + 1] = Math.round(Math.max(0, Math.min(255, this.buf[i + 1])));
    out[i + 2] = Math.round(Math.max(0, Math.min(255, this.buf[i + 2])));
    out[i + 3] = Math.round(Math.max(0, Math.min(255, this.buf[i + 3] * 255)));
  }
  return out;
};

// ---------- PNG 编码（RGBA + 每行 filter 0 + zlib） ----------
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
  const detailed = S >= 32;          // 装订环 + 高光只在 32px 以上画
  const m = Math.round(S * 0.055);
  const tileX = m, tileY = m, tileW = S - 2 * m, tileH = S - 2 * m;
  const tileR = Math.round(tileW * 0.235);

  // 1) 雅蓝磁贴：自上而下的体积渐变（顶部亮、底部沉）
  cv.roundRect(tileX, tileY, tileW, tileH, tileR,
    function (y, h) {
      const t = y / Math.max(1, h - 1);
      return mix(BLUE_TOP, BLUE_BOT, t * t * 0.72 + t * 0.28);
    }, 1, [true, true, true, true]);
  // 磁贴顶沿高光（1px 级，让边缘"起光"）
  const hiH = Math.max(1, Math.round(tileH * 0.055));
  cv.roundRect(tileX + 1, tileY + 1, tileW - 2, hiH, Math.max(1, Math.round(tileR * 0.7)),
    WHITE_HI, 0.26, [true, true, false, false]);
  // 磁贴外描边（把颜色压住，避免在浅色桌面上发虚）
  cv.roundRect(tileX, tileY, tileW, tileH, tileR, BLUE_EDGE, 0.0, [true, true, true, true]);

  // 2) 白色日历卡（内缩）
  const inPad = Math.max(1, Math.round(S * 0.075));
  const cX = tileX + inPad, cY = tileY + inPad;
  const cW = tileW - 2 * inPad, cH = tileH - 2 * inPad;
  const cR = Math.round(cW * 0.17);
  cv.roundRect(cX, cY, cW, cH, cR, WHITE, 1, [true, true, true, true]);
  // 卡片底部极淡的阴影线（营造"纸压在磁贴上"的厚度）
  cv.roundRect(cX, cY + cH - Math.max(1, Math.round(cH * 0.05)), cW,
    Math.max(1, Math.round(cH * 0.05)), 1, CARD_SHAD, 0.35, [false, false, true, true]);

  // 3) 朱砂表头（仅上半圆角）
  const headH = Math.round(cH * (detailed ? 0.235 : 0.26));
  const headR = Math.round(cR * 0.92);
  cv.roundRect(cX, cY, cW, headH, headR, CINNA, 1, [true, true, false, false]);
  // 表头底部一道更深的边（强化"表头"的分界）
  cv.roundRect(cX, cY + headH - Math.max(1, Math.round(headH * 0.16)), cW,
    Math.max(1, Math.round(headH * 0.16)), 1, CINNA_DK, 0.55, [false, false, false, false]);

  // 4) 装订环（仅 detailed）：表头上两枚小圆点
  if (detailed) {
    const ringR = Math.max(1, headH * 0.15);
    const ringY = cY + headH * 0.46;
    cv.disc(cX + cW * 0.30, ringY, ringR, [255, 255, 255], 0.85);
    cv.disc(cX + cW * 0.70, ringY, ringR, [255, 255, 255], 0.85);
  }

  // 5) 网格点阵：首点朱砂 = 今天
  const cols = 4;
  const rows = (S <= 16) ? 2 : 3;                 // 16px 只放 2 行，否则糊成一团
  const top = cY + headH + Math.round(cH * 0.11);
  const bottom = cY + cH - Math.round(cH * 0.10);
  const areaH = bottom - top;
  const gapX = cW * 0.09;
  const areaW = cW - 2 * gapX;
  const cellW = areaW / cols, cellH = areaH / rows;
  const dot = Math.max(1.5, Math.min(cellW, cellH) * 0.42);
  const dotR = Math.max(0.75, dot / 2);
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const cx = cX + gapX + cellW * (col + 0.5);
      const cy = top + cellH * (r + 0.5);
      const isToday = (r === 0 && col === 0);
      cv.disc(cx, cy, dot, isToday ? CINNA : GRAY, isToday ? 0.95 : 0.72);
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
  const dirEntries = [];
  let offset = 6 + count * 16;
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
