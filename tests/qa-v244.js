'use strict';
/* ============================================================
 * tests/qa-v244.js —— v2.4.4 独立对抗性验证（EXIF / 分区采样 / clarity）
 * ------------------------------------------------------------
 * 设计原则：
 *   1) 只读 electron-main.js 源码，绝不修改 verify_v1721.js / smoke-test.js /
 *      runtime-test_v1721.js（三脚本归工程师维护，避免撞车）。
 *   2) 裸 Node，自建 ok()/eq()/near() 计数器，process.exit(fail?1:0)。
 *   3) extractFn 从源码大括号配平抠出**真实函数体**，注入最小 mock 后在隔离作用域执行
 *      —— 断言的是「源码里那几行真实逻辑」，而非在测试里复刻一份实现。
 *   4) 全程只在 os.tmpdir() 下建临时目录读写，绝不触碰项目内文件。
 *
 * 覆盖：
 *   §1 EXIF：II/MM × 小端/大端、orient=1..8 全枚举、APP1 异常、截断、非 JPEG 头、
 *            IFD0 无 0x0112、IFD count 超大、失败一律返 1 且不中断导入。
 *   §2 导入手艺：「该交换的交换（5..8），不该交换的绝不交换（1..4）」，含扩展名大小写。
 *   §3 分区采样/complexity：上黑中白下黑 / 全透明 / 全黑 / 全白 / 左右对半分 / 透明跳过；
 *            zones 排序、complexity 单调性与 0/满量程、decideDark 迟滞边界两侧。
 *   §4 clarity：'auto' / 0 / 50 / 100 / 越界 / 非数字 / image 与 color 两种 type 下 auto 推导差异。
 *   §5 clarity 下发（resolvedSurfaceState）与持久化（applySkinSet → saveSettings）+ 跟随物化。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');

/* ================= 断言计数 ================= */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; failures.push(msg); }
}
function eq(a, b, msg) {
  ok(a === b, msg + '  (期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + ')');
}
function near(a, b, eps, msg) {
  ok(Math.abs(a - b) <= eps, msg + '  (期望≈' + b + '，实际 ' + a + ')');
}

/* ================= extractFn：大括号配平抠真实函数体 ================= */
function extractFn(src, name) {
  const key = 'function ' + name + '(';
  const idx = src.indexOf(key);
  if (idx < 0) throw new Error('qa-v244: 源码未找到函数 ' + name);
  let depth = 0, inStr = null, inBlock = false, inLine = false, esc = false;
  const start = src.indexOf('{', idx);
  for (let j = start; j < src.length; j++) {
    const ch = src[j], nx = src[j + 1];
    if (inLine) { if (ch === '\n') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; j++; } continue; }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '/' && nx === '/') { inLine = true; j++; continue; }
    if (ch === '/' && nx === '*') { inBlock = true; j++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') { depth++; }
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(idx, j + 1); }
  }
  throw new Error('qa-v244: 配平失败 ' + name);
}

/* ================= 组装被测函数（隔离作用域 + 最小 mock 注入） ================= */
const FN_NAMES = [
  // 图片/归一化
  'clamp01', 'clampZoom', 'clampImageOpacity', 'sanitizeBasename', 'validHex', 'isDarkColor',
  // 亮度 / 采样
  'wcagLum', 'decideDark', 'sampleImageStats',
  // clarity
  'clarityForConfig', 'normalizeClarity', 'normalizeImageSpec',
  // EXIF
  'parseTiffOrientation', 'readJpegOrientation', 'importSkinImage',
  // 中枢解析（v3.0.0：surfaceTheme 依赖 styleNativeTheme，须一并抽取）
  'styleNativeTheme', 'resolveSurfaceConfig', 'surfaceTheme', 'solidFallbackFor', 'surfaceBg', 'resolvedSurfaceState',
  // v3.3.0 C2：applySkinSet 的 shape 分支调用 normShape —— 不抽取会在隔离作用域 ReferenceError
  //（normShape 刻意内联白名单、不依赖 DOCK_SHAPE_KEYS，故单独抽取即可自洽）。
  'normShape',
  // v3.3.0 X4：normalizeSkinV3 / migrateSkinV2toV3 新增 normDockScale 调用
  //（同款内联白名单，只依赖 Math/Number，单独抽取即可自洽）。
  'normDockScale',
  // 写入口
  'applySkinSet'
];

let FN_SRC = '';
try {
  FN_SRC = FN_NAMES.map(function (n) { return extractFn(SRC, n); }).join('\n\n');
} catch (e) {
  console.error('qa-v244: 抽取函数失败 — ' + e.message);
  console.error('（可能 R3-T04 尚在收尾、函数签名变动，等 T04 完成再跑）');
  process.exit(1);
}

const makeApi = new Function(
  'fs', 'path', 'nativeImage', 'skinsDir', 'readGifSize', 'nativeThemeGlobal', 'hooks',
  [
    'return function skinFactory(skinObj) {',
    '  var skin = skinObj;',
    '  var nativeTheme = nativeThemeGlobal;',
    '  var recomputeTheme = hooks.recomputeTheme || function () {};',
    '  var saveSettings = hooks.saveSettings || function () {};',
    '  var pushThemeToAll = hooks.pushThemeToAll || function () {};',
    '  var pushSkinToAll = hooks.pushSkinToAll || function () {};',
    '  var refreshTrayMenu = hooks.refreshTrayMenu || function () {};',
    '  var applyOpacity = hooks.applyOpacity || function () {};',
    /* v3.3.0 C5：applySkinSet 末尾调用顶层 syncDockGeometry()（依赖 dockWin/dockW/dockH，
     * 不是本测试的被测对象）→ 注入空桩，避免隔离作用域 ReferenceError。 */
    '  var syncDockGeometry = hooks.syncDockGeometry || function () {};',
    '  var clampOpacity = hooks.clampOpacity || function (v, d) {',
    '    var n = Number(v); if (!isFinite(n)) return d; return Math.max(0.3, Math.min(1, n));',
    '  };',
    FN_SRC,
    '  return { ' + FN_NAMES.join(', ') + ' };',
    '};'
  ].join('\n')
);

/** 造一份带调用计数的 api 实例。 */
function apiWith(opts) {
  opts = opts || {};
  const counters = { recompute: 0, save: 0, pushTheme: 0, pushSkin: 0, refreshTray: 0, opacity: 0 };
  const hooks = {
    recomputeTheme: function () { counters.recompute++; },
    saveSettings: function () { counters.save++; },
    pushThemeToAll: function () { counters.pushTheme++; },
    pushSkinToAll: function () { counters.pushSkin++; },
    refreshTrayMenu: function () { counters.refreshTray++; },
    applyOpacity: function () { counters.opacity++; }
  };
  const factory = makeApi(
    opts.fs || fs,
    opts.path || path,
    opts.nativeImage || { createFromPath: function () { return null; } },
    opts.skinsDir || function () { return os.tmpdir(); },
    opts.readGifSize || function () { return null; },
    opts.nativeTheme || { shouldUseDarkColors: false },
    hooks
  );
  return { api: factory(opts.skin || null), counters: counters };
}

/* ================= 临时目录（只落在 os.tmpdir） ================= */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v244-'));
const SKINS = path.join(TMP, 'skins');
fs.mkdirSync(SKINS, { recursive: true });
function tmpFile(name, buf) { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; }
let skinsSeq = 0;
function freshSkinsDir() {
  const d = path.join(SKINS, 's' + (skinsSeq++));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* ================= 二进制构造工具 ================= */
function B16(v, le) { const b = Buffer.alloc(2); if (le) b.writeUInt16LE(v >>> 0); else b.writeUInt16BE(v >>> 0); return b; }
function B32(v, le) { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(v >>> 0); else b.writeUInt32BE(v >>> 0); return b; }
function ascii(s) { return Buffer.from(s, 'ascii'); }

function tiffEntry(le, tag, type, count, val16) {
  const e = Buffer.alloc(12);
  (le ? e.writeUInt16LE : e.writeUInt16BE).call(e, tag, 0);
  (le ? e.writeUInt16LE : e.writeUInt16BE).call(e, type, 2);
  (le ? e.writeUInt32LE : e.writeUInt32BE).call(e, count, 4);
  (le ? e.writeUInt16LE : e.writeUInt16BE).call(e, val16, 8);
  return e;
}

/**
 * 构造 TIFF（IFD0 含/不含 0x0112）。
 * o: { magic, ifdOffset, ifdCount, emitEntries, noOrient }
 */
function buildTiff(le, orient, o) {
  o = o || {};
  const hdr = Buffer.concat([ascii(le ? 'II' : 'MM'), B16(o.magic !== undefined ? o.magic : 0x002A, le)]);
  const ifdOff = (o.ifdOffset !== undefined) ? o.ifdOffset : 8;
  const hdr2 = Buffer.concat([hdr, B32(ifdOff, le)]);
  // pad 仅在「诚实」的自定义 ifdOffset 场景使用（避免误建超大缓冲）；此处 idfOffset 恒为默认 8
  const pad = (ifdOff > 8 && o.allowPad) ? Buffer.alloc(ifdOff - 8) : Buffer.alloc(0);
  const countField = (o.ifdCount !== undefined) ? o.ifdCount : 1;   // 写入 IFD 的 count 字段
  const entries = [];
  if (!o.noOrient) entries.push(tiffEntry(le, 0x0112, 3, 1, orient)); // type=SHORT, count=1
  // 实际生成的条目数（默认与 count 字段一致；超大 count 用 genEntries 限制，避免爆内存）
  const gen = (o.genEntries !== undefined) ? o.genEntries : countField;
  while (entries.length < gen) entries.push(Buffer.alloc(12));      // 占位空条目（tag=0）
  const emit = (o.emitEntries !== undefined) ? o.emitEntries : entries.length;
  return Buffer.concat([hdr2, pad, B16(countField, le), Buffer.concat(entries.slice(0, emit)), B32(0, le)]);
}

/** APP1(Exif) + SOI + EOI 拼整张 JPEG。payload 默认 'Exif\0\0'+tiff。 */
function app1Jpeg(payload, app1Len) {
  const segLen = (app1Len !== undefined) ? app1Len : payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    Buffer.from([0xFF, 0xE1]), B16(segLen, false),
    payload,
    Buffer.from([0xFF, 0xD9])
  ]);
}
function buildJpeg(tiffBuf, o) {
  o = o || {};
  const pre = (o.prefix !== undefined) ? o.prefix : 'Exif\u0000\u0000';
  return app1Jpeg(Buffer.concat([ascii(pre), tiffBuf]), o.app1Len);
}

/* ================= 像素缓冲构造 ================= */
function bgraBuf(W, H, px) {                 // px(x,y) -> [R,G,B,A]
  const b = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = px(x, y), i = (y * W + x) * 4;
      b[i] = p[2]; b[i + 1] = p[1]; b[i + 2] = p[0]; b[i + 3] = p[3];
    }
  }
  return b;
}
function imgFromBuf(buf, W, H) {
  return {
    resize: function () {
      return { toBitmap: function () { return buf; }, getSize: function () { return { width: W, height: H }; } };
    }
  };
}
function nativeImgMock(w, h, buf) {
  return {
    createFromPath: function () {
      return {
        isEmpty: function () { return false; },
        getSize: function () { return { width: w, height: h }; },
        resize: function () {
          return {
            toBitmap: function () { return buf || Buffer.alloc(64 * 64 * 4, 255); },
            getSize: function () { return { width: 64, height: 64 }; }
          };
        }
      };
    }
  };
}

/* ============================================================
 * §1  EXIF 解析（readJpegOrientation / parseTiffOrientation）
 * ============================================================ */
(function section1_Exif() {
  const A = apiWith({}).api;

  /* --- 1.1 orient=1..8 全枚举 × 两种字节序：该返几就返几 --- */
  for (const le of [true, false]) {
    const tag = le ? 'II-LE' : 'MM-BE';
    for (let o = 1; o <= 8; o++) {
      const f = tmpFile('exif_' + tag + '_' + o + '.jpg', buildJpeg(buildTiff(le, o)));
      eq(A.readJpegOrientation(f), o, '[' + tag + '] orient=' + o + ' → 解析为 ' + o);
    }
  }

  /* --- 1.2 越界/非法 orient 值一律返回 1 --- */
  for (const bad of [0, 9, 255, 65535]) {
    const f = tmpFile('exif_bad_' + bad + '.jpg', buildJpeg(buildTiff(true, bad)));
    eq(A.readJpegOrientation(f), 1, 'orient=' + bad + '（越界）→ 兜底 1');
  }

  /* --- 1.3 不能交换：orient 1..4 必须原样（在 §2 用导入链路再证一次） --- */
  eq(A.readJpegOrientation(tmpFile('exif_1.jpg', buildJpeg(buildTiff(true, 1)))), 1, 'orient=1 不旋转');
  eq(A.readJpegOrientation(tmpFile('exif_4.jpg', buildJpeg(buildTiff(false, 4)))), 4, 'MM orient=4 解析为 4');

  /* --- 1.4 畸形输入一律返回 1，且绝不抛异常 --- */
  const validTIFF = buildTiff(true, 6);
  const malformed = {
    'APP1 段长度=0': app1Jpeg(Buffer.concat([ascii('Exif\u0000\u0000'), validTIFF]), 0),
    'APP1 段长度=1(<2)': app1Jpeg(Buffer.concat([ascii('Exif\u0000\u0000'), validTIFF]), 1),
    'APP1 非 Exif 前缀(Xxif)': buildJpeg(validTIFF, { prefix: 'Xxif\u0000\u0000' }),
    'TIFF magic 错(0x002B)': buildJpeg(buildTiff(true, 6, { magic: 0x002B })),
    'TIFF 字节序非法(XX)': buildJpeg(Buffer.concat([ascii('XX'), B16(0x002A, true), B32(8, true), B16(1, true), Buffer.alloc(12), B32(0, true)])),
    'IFD0 无 0x0112': buildJpeg(buildTiff(true, 6, { noOrient: true })),
    'IFD count 超大(0xFFFF)': buildJpeg(buildTiff(true, 6, { ifdCount: 0xFFFF, genEntries: 0, noOrient: true })),
    '整表截断(前 20 字节)': app1Jpeg(Buffer.concat([ascii('Exif\u0000\u0000'), validTIFF])).slice(0, 20),
    '仅 SOI': Buffer.from([0xFF, 0xD8]),
    '3 字节碎片': Buffer.from([0xFF, 0xD8, 0x00]),
    '空文件': Buffer.alloc(0),
    'PNG 头当 JPEG': Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32)]),
    'GIF 头当 JPEG': Buffer.concat([ascii('GIF89a'), Buffer.alloc(32)])
  };
  let i = 0;
  for (const key of Object.keys(malformed)) {
    const f = tmpFile('exif_malformed_' + (i++) + '.jpg', malformed[key]);
    let r;
    try { r = A.readJpegOrientation(f); } catch (e) { r = 'THROW:' + e.message; }
    eq(r, 1, '畸形输入[' + key + '] → 1（不抛异常）');
  }

  /* --- 1.5 空路径/不存在文件也不抛 --- */
  let r1, r2;
  try { r1 = A.readJpegOrientation(path.join(TMP, 'not_exist.jpg')); } catch (e) { r1 = 'THROW'; }
  try { r2 = A.readJpegOrientation(''); } catch (e) { r2 = 'THROW'; }
  eq(r1, 1, '不存在的文件 → 1（openSync 抛错被吞）');
  eq(r2, 1, '空路径 → 1');

  /* --- 1.6 parseTiffOrientation 直接喂 Buffer：II/MM 等价 --- */
  const tiffLE = buildTiff(true, 7), tiffBE = buildTiff(false, 7);
  eq(A.parseTiffOrientation(tiffLE, 0, tiffLE.length), 7, 'parseTiff II 小端 → 7');
  eq(A.parseTiffOrientation(tiffBE, 0, tiffBE.length), 7, 'parseTiff MM 大端 → 7');
  eq(A.parseTiffOrientation(Buffer.alloc(4), 0, 4), 1, 'parseTiff 长度不足(t+8>n) → 1');

  /* --- 1.7 IFD offset 越界 / IFD count 超大：均不崩溃 --- */
  const oobIfd = Buffer.concat([ascii('II'), B16(0x002A, true), B32(0xFFFF, true)]); // ifdOff 远越界
  eq(A.parseTiffOrientation(oobIfd, 0, oobIfd.length), 1, 'IFD offset 越界(ifdOff+2>n) → 1');
  const hugeCount = buildTiff(true, 6, { ifdCount: 0xFFFF, genEntries: 1 });          // count=65535，orient 在首条
  eq(A.parseTiffOrientation(hugeCount, 0, hugeCount.length), 6, 'IFD count 超大但 orient 在首条 → 仍读出 6（不崩溃）');
})();

/* ============================================================
 * §2  导入手艺：该交换的交换、不该交换的绝不交换
 * ============================================================ */
(function section2_Import() {
  const A = apiWith({ nativeImage: nativeImgMock(100, 200) }).api;  // 物理尺寸固定 100×200

  const swap = {};
  for (let o = 1; o <= 8; o++) {
    const f = tmpFile('imp_' + o + '.jpg', buildJpeg(buildTiff(true, o)));
    const r = A.importSkinImage('calendar', f);
    ok(r && r.ok === true, 'importSkinImage orient=' + o + ' 成功');
    if (r && r.image) swap[o] = [r.image.w, r.image.h];
  }
  for (let o = 1; o <= 4; o++) {
    eq((swap[o] || []).join('x'), '100x200', 'orient=' + o + '（无 90/270）→ 不交换，记录 100×200');
  }
  for (let o = 5; o <= 8; o++) {
    eq((swap[o] || []).join('x'), '200x100', 'orient=' + o + '（含 90/270）→ 交换，记录 200×100');
  }

  /* --- 2.1 扩展名大小写与 jpeg 分支 --- */
  const rJpeg = A.importSkinImage('calendar', tmpFile('imp_a.jpeg', buildJpeg(buildTiff(true, 6))));
  eq((rJpeg.image || {}).w, 200, '.jpeg 扩展名同样走 EXIF 检测 → 交换');
  const rUpper = A.importSkinImage('calendar', tmpFile('imp_b.JPG', buildJpeg(buildTiff(true, 6))));
  eq((rUpper.image || {}).w, 200, '.JPG 大写扩展名（内部 lower）→ 交换');

  /* --- 2.2 扩展名与内容不符：PNG 扩展名即便内容是 JPEG 也不读 EXIF（不该交换绝不交换） --- */
  const rPng = A.importSkinImage('calendar', tmpFile('imp_c.png', buildJpeg(buildTiff(true, 6))));
  eq((rPng.image || {}).w, 100, '.png 扩展名（内容实为 JPEG）→ 不走 EXIF，不交换');

  /* --- 2.3 GIF 分支：跳过 EXIF、尺寸来自文件头、dark 兜底 false --- */
  const Agif = apiWith({
    nativeImage: nativeImgMock(0, 0),
    readGifSize: function () { return { width: 50, height: 50 }; }
  }).api;
  const rGif = Agif.importSkinImage('calendar', tmpFile('imp_d.gif', Buffer.concat([ascii('GIF89a'), Buffer.alloc(16)])));
  ok(rGif && rGif.ok === true, 'GIF 导入成功');
  eq((rGif.image || {}).w, 50, 'GIF 用 readGifSize 的宽');
  eq((rGif.image || {}).h, 50, 'GIF 用 readGifSize 的高');
  eq((rGif.image || {}).dark, false, 'GIF dark 兜底 false');
  eq((rGif.image || {}).complexity, 0, 'GIF 不做复杂度采样 → 0');

  /* --- 2.4 参数校验：失败统一 {ok:false}，不抛 --- */
  const rSurf = A.importSkinImage('nope', tmpFile('imp_e.jpg', buildJpeg(buildTiff(true, 6))));
  eq(rSurf.ok, false, '无效 surface → ok:false');
  eq(A.importSkinImage('calendar', null).ok, false, '未提供路径 → ok:false');
  eq(A.importSkinImage('calendar', tmpFile('imp_f.bmp', Buffer.alloc(16))).ok, false, '不支持的扩展名(.bmp) → ok:false');
  let rMiss;
  try { rMiss = A.importSkinImage('calendar', path.join(TMP, 'ghost.jpg')); } catch (e) { rMiss = { ok: 'THROW' }; }
  eq(rMiss.ok, false, '文件不存在 → ok:false（copyFileSync 抛错被吞，不中断）');

  /* --- 2.5 解析失败不阻断导入：EXIF 畸形仍应导入成功且尺寸不交换 --- */
  const rBad = A.importSkinImage('calendar', tmpFile('imp_g.jpg', buildJpeg(buildTiff(true, 6, { noOrient: true }))));
  ok(rBad && rBad.ok === true, 'EXIF 无 Orientation → 仍导入成功（解析失败不停流程）');
  eq((rBad.image || {}).w, 100, '解析失败→返 1→不交换，记录 100×200');
})();

/* ============================================================
 * §3  分区采样 / complexity / decideDark
 * ============================================================ */
(function section3_Sampling() {
  const A = apiWith({}).api;

  /* --- 3.1 全黑 --- */
  const sBlack = A.sampleImageStats(imgFromBuf(bgraBuf(3, 3, function () { return [0, 0, 0, 255]; }), 3, 3));
  eq(sBlack.zones[0], 0, '全黑 上区亮度=0');
  eq(sBlack.zones[1], 0, '全黑 中区亮度=0');
  eq(sBlack.zones[2], 0, '全黑 下区亮度=0');
  eq(sBlack.mean, 0, '全黑 mean=0');
  eq(sBlack.complexity, 0, '全黑 complexity=0（下界）');

  /* --- 3.2 全白 --- */
  const sWhite = A.sampleImageStats(imgFromBuf(bgraBuf(3, 3, function () { return [255, 255, 255, 255]; }), 3, 3));
  eq(sWhite.zones[0], 1, '全白 上区亮度=1');
  eq(sWhite.zones[1], 1, '全白 中区亮度=1');
  eq(sWhite.zones[2], 1, '全白 下区亮度=1');
  near(sWhite.complexity, 0, 1e-6, '全白 complexity≈0（均匀→无局部不均）');

  /* --- 3.3 上黑 / 中白 / 下黑：zones 竖直结构被捕捉 --- */
  const tbmwb = bgraBuf(3, 3, function (x, y) { return y === 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]; });
  const s3 = A.sampleImageStats(imgFromBuf(tbmwb, 3, 3));
  eq(s3.zones[0], 0, '上黑中白下黑 上区=0');
  eq(s3.zones[1], 1, '上黑中白下黑 中区=1（最亮）');
  eq(s3.zones[2], 0, '上黑中白下黑 下区=0');
  ok(s3.zones[1] > s3.zones[0] && s3.zones[1] > s3.zones[2], 'zones 排序关系：中区 > 上区且 > 下区');
  near(s3.zones[0], s3.zones[2], 1e-9, '上区 == 下区（对称）');
  ok(s3.complexity > 0, '上黑中白下黑 complexity>0');

  /* --- 3.4 全透明：alpha=0 不计入，zones 全 0、complexity 0 --- */
  const sTr = A.sampleImageStats(imgFromBuf(bgraBuf(4, 4, function () { return [0, 0, 0, 0]; }), 4, 4));
  eq(sTr.zones[0], 0, '全透明 上区=0（透明被跳过）');
  eq(sTr.zones[1], 0, '全透明 中区=0');
  eq(sTr.zones[2], 0, '全透明 下区=0');
  eq(sTr.complexity, 0, '全透明 complexity=0');

  /* --- 3.5 半边透明半边白：透明像素必须被排除（否则会把白图误算成灰） --- */
  const half = bgraBuf(4, 4, function (x) { return x < 2 ? [0, 0, 0, 0] : [255, 255, 255, 255]; });
  const sHalf = A.sampleImageStats(imgFromBuf(half, 4, 4));
  eq(sHalf.zones[0], 1, '半透明半白 上区=1（只统计不透明白像素）');
  eq(sHalf.zones[1], 1, '半透明半白 中区=1');
  eq(sHalf.zones[2], 1, '半透明半白 下区=1');
  near(sHalf.mean, 1, 1e-9, '半透明半白 mean≈1');
  near(sHalf.complexity, 0, 1e-6, '半透明半白 complexity≈0（剩余像素均匀）');

  /* --- 3.6 左右对半分：三个 zone 均含黑白 → zones 相等，complexity 满量程 --- */
  const lr = bgraBuf(10, 10, function (x) { return x < 5 ? [0, 0, 0, 255] : [255, 255, 255, 255]; });
  const sLR = A.sampleImageStats(imgFromBuf(lr, 10, 10));
  const midGray = A.wcagLum(0.5, 0.5, 0.5);
  near(sLR.zones[0], midGray, 0.01, '左黑右白 上区≈中灰(0.5 混合均值)');
  near(sLR.zones[1], midGray, 0.01, '左黑右白 中区≈中灰');
  near(sLR.zones[2], midGray, 0.01, '左黑右白 下区≈中灰');
  near(sLR.zones[0], sLR.zones[2], 1e-9, '左黑右白 上区 == 下区');
  eq(sLR.complexity, 1, '左黑右白 complexity=1（满量程饱和）');

  /* --- 3.7 complexity 单调性 + 0/满量程 --- */
  const cA = A.sampleImageStats(imgFromBuf(bgraBuf(10, 10, function () { return [128, 128, 128, 255]; }), 10, 10)).complexity;
  const cC = A.sampleImageStats(imgFromBuf(bgraBuf(10, 10, function (x, y) {
    return (y * 10 + x) < 10 ? [255, 255, 255, 255] : [128, 128, 128, 255];   // 10% 白 + 90% 灰
  }), 10, 10)).complexity;
  near(cA, 0, 1e-6, '均匀灰 complexity≈0（下界）');
  eq(sLR.complexity, 1, '半黑半白 complexity=1（上界）');
  ok(cA < cC && cC < 1, 'complexity 单调：均匀(0) < 局部不均(' + cC.toFixed(3) + ') < 半黑半白(1)');

  /* --- 3.8 decideDark 迟滞边界两侧（±0.06 带宽） --- */
  eq(A.decideDark(0.56, true), true, 'decideDark(L=0.56, prev=dark) → 维持 dark（边界含）');
  eq(A.decideDark(0.5601, true), false, 'decideDark(L=0.5601, prev=dark) → 切 light（边界外）');
  eq(A.decideDark(0.44, false), false, 'decideDark(L=0.44, prev=light) → 维持 light（边界含）');
  eq(A.decideDark(0.4399, false), true, 'decideDark(L=0.4399, prev=light) → 切 dark（边界外）');
  eq(A.decideDark(0.5, false), false, 'decideDark 迟滞带内 prev=light → 保持 light');
  eq(A.decideDark(0.5, true), true, 'decideDark 迟滞带内 prev=dark → 保持 dark（不抖动）');
  eq(A.decideDark(0.44, true), true, 'decideDark(L=0.44, prev=dark) → 维持 dark');
  eq(A.decideDark(0.57, false), false, 'decideDark(L=0.57, prev=light) → 维持 light');
})();

/* ============================================================
 * §4  clarity 归一化与推导
 * ============================================================ */
(function section4_Clarity() {
  const A = apiWith({}).api;

  /* --- 4.1 normalizeClarity --- */
  eq(A.normalizeClarity('auto'), 'auto', "normalizeClarity('auto') → 'auto'");
  eq(A.normalizeClarity(undefined), 'auto', 'normalizeClarity(undefined) → auto');
  eq(A.normalizeClarity(null), 'auto', 'normalizeClarity(null) → auto');
  eq(A.normalizeClarity('abc'), 'auto', "normalizeClarity('abc') → auto（非数字）");
  eq(A.normalizeClarity(NaN), 'auto', 'normalizeClarity(NaN) → auto');
  eq(A.normalizeClarity(Infinity), 'auto', 'normalizeClarity(Infinity) → auto');
  eq(A.normalizeClarity(-10), 0, 'normalizeClarity(-10) → 0（越界下限）');
  eq(A.normalizeClarity(999), 100, 'normalizeClarity(999) → 100（越界上限）');
  eq(A.normalizeClarity(50), 50, 'normalizeClarity(50) → 50');
  eq(A.normalizeClarity(0), 0, 'normalizeClarity(0) → 0');
  eq(A.normalizeClarity(100), 100, 'normalizeClarity(100) → 100');
  eq(A.normalizeClarity(49.6), 50, 'normalizeClarity(49.6) → 50（四舍五入）');
  eq(A.normalizeClarity('75'), 75, "normalizeClarity('75') → 75（数字字符串）");

  /* --- 4.2 clarityForConfig：手动值优先 --- */
  eq(A.clarityForConfig(null), 0, 'clarityForConfig(null) → 0');
  eq(A.clarityForConfig({ clarity: 50 }), 50, '手动 clarity=50 → 50');
  eq(A.clarityForConfig({ clarity: 0 }), 0, '手动 clarity=0 → 0');
  eq(A.clarityForConfig({ clarity: 100 }), 100, '手动 clarity=100 → 100');
  eq(A.clarityForConfig({ clarity: -10 }), 0, '手动 clarity=-10 → 夹到 0');
  eq(A.clarityForConfig({ clarity: 999 }), 100, '手动 clarity=999 → 夹到 100');

  /* --- 4.3 clarityForConfig：'auto' 按 bg 推导（v3.0.0：判据由 type 改为 bg） --- */
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0.5 } }), 50, "bg=image+auto → 按 complexity(0.5)→50");
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0 } }), 20, 'bg=image+auto complexity=0 → 下限 20');
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0.1 } }), 20, 'bg=image+auto 低复杂度 → 下限 20');
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 1 } }), 85, 'bg=image+auto 高复杂度 → 上限 85');
  eq(A.clarityForConfig({ bg: 'image', image: {} }), 20, 'bg=image 无 complexity → 20');
  eq(A.clarityForConfig({ bg: 'image' }), 20, 'bg=image 无 image → 20（基础保护）');
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'native' }), 0, "bg=native+auto → 0（不引入灰罩）");
  eq(A.clarityForConfig({ clarity: 'auto', tone: 'system' }), 0, 'tone=system（native 背景）→ 0');
  eq(A.clarityForConfig({ clarity: 'abc', bg: 'native' }), 0, 'native + 非数字 clarity → 0');

  /* --- 4.4 bg=image 与 bg=native 在 auto 下的差异（核心契约） --- */
  const cImage = A.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0.3 } });
  const cNative = A.clarityForConfig({ clarity: 'auto', bg: 'native' });
  ok(cImage > cNative, "auto 推导差异：bg=image(" + cImage + ") > bg=native(" + cNative + ')');
  ok(cImage >= 20 && cImage <= 85, 'bg=image+auto 推导值始终落在 [20,85] 基础保护区间');

  /* --- 4.5 normalizeImageSpec：complexity 归一 + 既有字段夹取 --- */
  eq(A.normalizeImageSpec({ file: 'a.jpg', complexity: 0.4 }).complexity, 0.4, 'complexity=0.4 原样');
  eq(A.normalizeImageSpec({ file: 'a.jpg', complexity: 5 }).complexity, 1, 'complexity=5 → 夹到 1');
  eq(A.normalizeImageSpec({ file: 'a.jpg', complexity: -1 }).complexity, 0, 'complexity=-1 → 夹到 0');
  eq(A.normalizeImageSpec({ file: 'a.jpg', complexity: 'x' }).complexity, 0, 'complexity 非数字 → 0');
  eq(A.normalizeImageSpec({ file: 'a.jpg' }).complexity, 0, 'complexity 缺省 → 0');
  eq(A.normalizeImageSpec({ file: 'a.jpg', w: 100.6, h: 50.4 }).w, 101, 'w 四舍五入 → 101');
  eq(A.normalizeImageSpec({ file: 'a.jpg', zoom: 99 }).zoom, 5, 'zoom=99 → 夹到 5');
  eq(A.normalizeImageSpec({ file: 'a.jpg', opacity: 0 }).opacity, 0.2, 'opacity=0 → 夹到 0.2');
  eq(A.normalizeImageSpec({ file: 'a.jpg', opacity: null }).opacity, 1, 'opacity=null → 1（缺省完全不透明）');
  eq(A.normalizeImageSpec({ file: 'a.jpg' }).w, 0, 'w 缺省 → 0');
  eq(A.normalizeImageSpec({ file: '../x/evil.jpg' }).file, 'evil.jpg', 'sanitize 防路径穿越（取末段）');
  eq(A.normalizeImageSpec({ file: '' }), null, '空文件名 → null');
})();

/* ============================================================
 * §5  clarity 下发（resolvedSurfaceState）+ 持久化（applySkinSet）
 * ============================================================ */
function skinFixture() {
  return {
    __v: 3,
    surfaces: {
      calendar: { style: 'default', bg: 'image', image: { file: 'a.jpg', complexity: 0.5, dark: false }, text: 'auto', clarity: 'auto', tone: 'auto' },
      expanded: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
      desktop: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
      dock: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' }
    },
    opacity: { calendar: 1, desktop: 1, dock: 1 }
  };
}

(function section5_ResolveAndWrite() {
  /* --- 5.1 resolvedSurfaceState 下发（v3.0.0：style/tone/bg，无 type 字段） --- */
  const A = apiWith({ skin: skinFixture() }).api;
  const rs = A.resolvedSurfaceState('calendar');
  eq(rs.style, 'default', 'resolved.style=default');
  eq(rs.bg, 'image', 'resolved.bg=image（有 file）');
  eq(rs.theme, 'light', 'resolved.theme=light（图片 dark:false）');
  eq(rs.tone, 'auto', 'resolved.tone=auto');
  eq(rs.warn, false, 'resolved.warn=false（浅底 + auto 字）');
  eq(rs.clarity, 50, 'resolved.clarity 下发 auto 派生值 50');
  eq(A.resolvedSurfaceState('expanded').clarity, 50, 'expanded 跟随日历 → clarity 同步 50');
  eq(A.resolvedSurfaceState('desktop').clarity, 50, 'desktop 跟随日历 → clarity 同步 50');

  /* --- 5.2 手动 clarity 原样下发 --- */
  const s2 = skinFixture();
  s2.surfaces.calendar.clarity = 30;
  const A2 = apiWith({ skin: s2 }).api;
  eq(A2.resolvedSurfaceState('calendar').clarity, 30, '手动 clarity=30 原样下发');
  eq(A2.resolvedSurfaceState('desktop').clarity, 30, 'desktop 跟随 → 同步 30');

  /* --- 5.3 原生背景 auto → 0（v3.0.0：无 color 轴，改用 bg=native） --- */
  const s3 = skinFixture();
  s3.surfaces.calendar = { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' };
  const A3 = apiWith({ skin: s3 }).api;
  eq(A3.resolvedSurfaceState('calendar').clarity, 0, 'bg=native+auto 下发 clarity=0（不引入灰罩）');

  /* --- 5.4 applySkinSet(field=clarity) 写入 + 触发持久化/下发 --- */
  const sk = skinFixture();
  const built = apiWith({ skin: sk });
  const A4 = built.api;
  A4.applySkinSet({ surface: 'calendar', field: 'clarity', value: 'auto' });
  eq(sk.surfaces.calendar.clarity, 'auto', "applySkinSet clarity='auto' → 存 'auto'");
  A4.applySkinSet({ surface: 'calendar', field: 'clarity', value: 50 });
  eq(sk.surfaces.calendar.clarity, 50, 'applySkinSet clarity=50 → 50');
  A4.applySkinSet({ surface: 'calendar', field: 'clarity', value: 999 });
  eq(sk.surfaces.calendar.clarity, 100, 'applySkinSet clarity=999 → 夹到 100');
  A4.applySkinSet({ surface: 'calendar', field: 'clarity', value: -5 });
  eq(sk.surfaces.calendar.clarity, 0, 'applySkinSet clarity=-5 → 夹到 0');
  A4.applySkinSet({ surface: 'calendar', field: 'clarity', value: 'abc' });
  eq(sk.surfaces.calendar.clarity, 0, "applySkinSet clarity='abc' → 0（Number 兜底）");
  ok(built.counters.save >= 5, 'clarity 写入触发 saveSettings（持久化）次数=' + built.counters.save);
  ok(built.counters.pushSkin >= 5, 'clarity 写入触发 pushSkinToAll（下发）次数=' + built.counters.pushSkin);
  ok(built.counters.refreshTray >= 5, 'clarity 写入触发 refreshTrayMenu 次数=' + built.counters.refreshTray);
  ok(JSON.parse(JSON.stringify(sk.surfaces.calendar)).clarity === 0, 'clarity 可 JSON 序列化（能落盘）');

  /* --- 5.5 v3.0.0：取消跟随 copy-on-write 时 clarity + tone 一并物化 --- */
  const sk2 = skinFixture();
  sk2.surfaces.calendar.clarity = 40;
  sk2.surfaces.calendar.tone = 'dark';
  sk2.surfaces.calendar.style = 'glass';
  const A5 = apiWith({ skin: sk2 }).api;
  A5.applySkinSet({ surface: 'desktop', field: 'follow', value: null });
  eq(sk2.surfaces.desktop.follow, null, '取消跟随 → desktop.follow=null');
  eq(sk2.surfaces.desktop.clarity, 40, '取消跟随 → desktop 物化日历 clarity=40');
  eq(sk2.surfaces.desktop.tone, 'dark', 'v3.0.0 取消跟随 → desktop 物化日历 tone=dark');
  eq(sk2.surfaces.desktop.style, 'glass', '取消跟随 → desktop 物化日历 style=glass');

  /* --- 5.6 v3.3.0 C2：applySkinSet 的 shape 分支走 normShape 白名单（隔离 eval 护栏） --- */
  const skShape = skinFixture();
  const A6 = apiWith({ skin: skShape }).api;
  A6.applySkinSet({ surface: 'dock', field: 'shape', value: 'toon' });
  eq(skShape.surfaces.dock.shape, 'toon', "applySkinSet dock shape='toon' → toon（合法值原样）");
  A6.applySkinSet({ surface: 'dock', field: 'shape', value: 'bogus' });
  eq(skShape.surfaces.dock.shape, 'rect', "applySkinSet dock shape='bogus' → rect（normShape 白名单生效）");
  A6.applySkinSet({ surface: 'dock', field: 'shape', value: null });
  eq(skShape.surfaces.dock.shape, 'rect', 'applySkinSet dock shape=null → rect');
  // shape 纳入 followableFields：对跟随中的面写 shape 先物化再写
  const skShape2 = skinFixture();
  skShape2.surfaces.dock.follow = 'calendar';
  const A7 = apiWith({ skin: skShape2 }).api;
  A7.applySkinSet({ surface: 'dock', field: 'shape', value: 'ring' });
  eq(skShape2.surfaces.dock.follow, null, 'v3.3.0 对跟随中的 dock 写 shape → 先豁免跟随');
  eq(skShape2.surfaces.dock.shape, 'ring', 'v3.3.0 写 shape=ring 生效');

  /* --- 5.7 v3.3.0 C4：取消跟随不再继承日历的图片/背景来源（R3 缺陷回归护栏） --- */
  const sk3b = skinFixture();          // calendar: bg='image' + image a.jpg
  const A8 = apiWith({ skin: sk3b }).api;
  eq(sk3b.surfaces.calendar.bg, 'image', '前置：日历 bg=image');
  A8.applySkinSet({ surface: 'desktop', field: 'follow', value: null });
  eq(sk3b.surfaces.desktop.bg, 'native', 'v3.3.0 取消跟随 → desktop.bg=native（不继承图片背景）');
  eq(sk3b.surfaces.desktop.image, null, 'v3.3.0 取消跟随 → desktop.image=null（图片框回空态）');
  eq(sk3b.surfaces.desktop.style, 'default', 'v3.3.0 取消跟随 → 仍继承日历 style');
})();

/* ============================================================
 * §6  渲染层三层可读性（app.js applyClarity / dock.html dockApplyClarity）
 *     —— 本轮最后一处改动，独立验证 clarity=0 归零、p=0 连续性、50/100 公式。
 * ============================================================ */
(function section6_Readability() {
  const APPSRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const DOCKSRC = fs.readFileSync(path.join(ROOT, 'dock.html'), 'utf8');
  const applyClarity = new Function(extractFn(APPSRC, 'applyClarity') + '\nreturn applyClarity;')();
  const dockApplyClarity = new Function(extractFn(DOCKSRC, 'dockApplyClarity') + '\nreturn dockApplyClarity;')();

  function fakeRoot() {
    const store = {};
    return {
      store: store,
      style: {
        setProperty: function (k, v) { store[k] = String(v); },
        removeProperty: function (k) { delete store[k]; }
      }
    };
  }
  const FULL = ['--protect-top', '--protect-mid', '--protect-bot', '--protect-edge', '--protect-state'];
  function strokeAlpha(s) {
    const m = /rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\s*\)/.exec(String(s));
    return m ? parseFloat(m[1]) : NaN;
  }

  /* --- 6.1 clarity=0 归零（p<=0 分支）：0 / undefined / 'auto' / -5 / NaN --- */
  [['0', 0], ['undefined', undefined], ["'auto'", 'auto'], ['-5', -5], ['NaN', NaN]].forEach(function (pair) {
    const label = pair[0], val = pair[1];
    const rd = fakeRoot(); applyClarity(rd, 'dark', val);
    FULL.forEach(function (k) { eq(rd.store[k], 'transparent', 'clarity=' + label + ' [dark] ' + k + ' 归零'); });
    eq(rd.store['--ink-glow'], '0 0 0 transparent', 'clarity=' + label + ' [dark] --ink-glow 归零');
    eq(rd.store['--stroke-color'], 'rgba(0,0,0,0.550)', 'clarity=' + label + ' [dark] stroke=兜底 0.550');
    const rl = fakeRoot(); applyClarity(rl, 'light', val);
    FULL.forEach(function (k) { eq(rl.store[k], 'transparent', 'clarity=' + label + ' [light] ' + k + ' 归零'); });
    eq(rl.store['--stroke-color'], 'rgba(255,255,255,0.700)', 'clarity=' + label + ' [light] stroke=兜底 0.700');
  });

  /* --- 6.2 clarity=50 (p=0.5) --- */
  (function () {
    const rd = fakeRoot(); applyClarity(rd, 'dark', 50);
    eq(rd.store['--protect-top'], 'rgba(0,0,0,0.210)', 'p=0.5 top 0.210');
    eq(rd.store['--protect-mid'], 'rgba(0,0,0,0.130)', 'p=0.5 mid 0.130');
    eq(rd.store['--protect-bot'], 'rgba(0,0,0,0.190)', 'p=0.5 bot 0.190');
    eq(rd.store['--protect-edge'], 'rgba(0,0,0,0.210)', 'p=0.5 edge 0.210');
    eq(rd.store['--protect-state'], 'rgba(0,0,0,0.325)', 'p=0.5 state 0.325');
    eq(rd.store['--ink-glow'], '0 0 2.5px rgba(0,0,0,0.525)', 'p=0.5 glow blur 2.5px / alpha 0.525');
    eq(rd.store['--stroke-color'], 'rgba(0,0,0,0.425)', 'p=0.5 [dark] stroke 0.425');
    const rl = fakeRoot(); applyClarity(rl, 'light', 50);
    eq(rl.store['--protect-mid'], 'rgba(255,255,255,0.130)', 'p=0.5 [light] mid 0.130');
    eq(rl.store['--stroke-color'], 'rgba(255,255,255,0.550)', 'p=0.5 [light] stroke 0.550');
  })();

  /* --- 6.3 clarity=100 (p=1) --- */
  (function () {
    const rd = fakeRoot(); applyClarity(rd, 'dark', 100);
    eq(rd.store['--protect-top'], 'rgba(0,0,0,0.360)', 'p=1 top 0.360');
    eq(rd.store['--protect-mid'], 'rgba(0,0,0,0.230)', 'p=1 mid 0.230');
    eq(rd.store['--protect-bot'], 'rgba(0,0,0,0.320)', 'p=1 bot 0.320');
    eq(rd.store['--protect-edge'], 'rgba(0,0,0,0.320)', 'p=1 edge 0.320');
    eq(rd.store['--protect-state'], 'rgba(0,0,0,0.500)', 'p=1 state 0.500');
    eq(rd.store['--ink-glow'], '0 0 4.0px rgba(0,0,0,0.700)', 'p=1 glow blur 4.0px / alpha 0.700');
    eq(rd.store['--stroke-color'], 'rgba(0,0,0,0.300)', 'p=1 [dark] stroke 0.300');
    const rl = fakeRoot(); applyClarity(rl, 'light', 100);
    eq(rl.store['--stroke-color'], 'rgba(255,255,255,0.400)', 'p=1 [light] stroke 0.400');
  })();

  /* --- 6.4 p→0 连续性：p=0 与 p=极小 的 stroke 需平滑衔接 --- */
  (function () {
    const rd0 = fakeRoot(); applyClarity(rd0, 'dark', 0);
    const rd1 = fakeRoot(); applyClarity(rd1, 'dark', 1);    // p=0.01
    const rl0 = fakeRoot(); applyClarity(rl0, 'light', 0);
    const rl1 = fakeRoot(); applyClarity(rl1, 'light', 1);
    const d0 = strokeAlpha(rd0.store['--stroke-color']);
    const d1 = strokeAlpha(rd1.store['--stroke-color']);
    const l0 = strokeAlpha(rl0.store['--stroke-color']);
    const l1 = strokeAlpha(rl1.store['--stroke-color']);
    eq(d0, 0.55, 'p=0 [dark] stroke 极限 0.550');
    eq(l0, 0.70, 'p=0 [light] stroke 极限 0.700');
    ok(Math.abs(d1 - 0.55) <= 0.01 && d1 <= d0, 'p=0.01 [dark] stroke=' + d1 + ' ≈0.550（连续、单调不增）');
    ok(Math.abs(l1 - 0.70) <= 0.01 && l1 <= l0, 'p=0.01 [light] stroke=' + l1 + ' ≈0.700（连续、单调不增）');
  })();

  /* --- 6.5 dock.html dockApplyClarity：仅 --protect-mid + --ink-glow + --stroke-color --- */
  (function () {
    const rd0 = fakeRoot(); dockApplyClarity(rd0, 'dark', 0);
    eq(rd0.store['--protect-mid'], 'transparent', 'dock clarity=0 mid 归零');
    eq(rd0.store['--ink-glow'], '0 0 0 transparent', 'dock clarity=0 glow 归零');
    eq(rd0.store['--stroke-color'], 'rgba(0,0,0,0.550)', 'dock clarity=0 [dark] stroke 0.550');
    const rl0 = fakeRoot(); dockApplyClarity(rl0, 'light', 0);
    eq(rl0.store['--stroke-color'], 'rgba(255,255,255,0.700)', 'dock clarity=0 [light] stroke 0.700');

    const rd5 = fakeRoot(); dockApplyClarity(rd5, 'dark', 50);
    eq(rd5.store['--protect-mid'], 'rgba(0,0,0,0.130)', 'dock p=0.5 mid 0.130');
    eq(rd5.store['--ink-glow'], '0 0 2.5px rgba(0,0,0,0.525)', 'dock p=0.5 glow 2.5px / 0.525');
    eq(rd5.store['--stroke-color'], 'rgba(0,0,0,0.425)', 'dock p=0.5 [dark] stroke 0.425');

    const rd10 = fakeRoot(); dockApplyClarity(rd10, 'dark', 100);
    eq(rd10.store['--protect-mid'], 'rgba(0,0,0,0.230)', 'dock p=1 mid 0.230');
    eq(rd10.store['--ink-glow'], '0 0 4.0px rgba(0,0,0,0.700)', 'dock p=1 glow 4.0px / 0.700');
    eq(rd10.store['--stroke-color'], 'rgba(0,0,0,0.300)', 'dock p=1 [dark] stroke 0.300');
  })();

  /* --- 6.6 null root 直接 return，不抛 --- */
  let threw = false;
  try { applyClarity(null, 'dark', 50); dockApplyClarity(null, 'dark', 50); } catch (e) { threw = true; }
  ok(!threw, 'root=null → 直接 return，不抛异常');
})();

/* ================= 收尾 ================= */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log('\n===== qa-v244 独立对抗性验证（EXIF / 采样 / clarity）=====');
if (failures.length) {
  failures.forEach(function (t) { console.log('  ✗ ' + t); });
  console.log('\n[qa-v244] FAIL — 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(1);
}
console.log('  ✓ 全部 ' + pass + ' 项断言通过');
console.log('\n[qa-v244] PASS');
process.exit(0);