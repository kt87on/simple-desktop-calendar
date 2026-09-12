'use strict';
/* ============================================================
 * tests/qa-v340.js —— v3.4.0 独立对抗性验证（MP4 动图）
 * ------------------------------------------------------------
 * 覆盖：
 *   §1  readMp4Size 纯函数（真身抽取 + 合成 ISO-BMFF buffer）：
 *         v0/v1 tkhd 全枚举、无 moov → null、宽或高为 0 → null、截断 → null、
 *         **mdat 在前且体积较大时仍能找到其后的 moov**（验证「跳过而不读」）、
 *         音频轨在前（0×0）仍能取到视频轨。
 *   §2  normalizeImageSpec 的 kind 归一分派（video / 缺省 / 脏值）。
 *   §3  importSkinImage 的 MP4 分支全链路（真复制进临时 userData）：
 *         ok===true、kind==='video'、snapshot===null、dark===false、complexity===0、w/h 与合成头一致。
 *   §4  源码文本断言：主进程白名单 / 对话框 extensions / readMp4Size 存在；
 *        渲染层 #skinVidWrap / #skinVid / el.tagName === 'VIDEO'；
 *        template.html 与 dock.html 均含 id="skinVid"；
 *        dock.html 非 rect 隐藏规则同时覆盖 #skinVidWrap；
 *        skincustom.html 含 id="cropVid"；**calendar.html 含 skinVidWrap（重建证据）**。
 *   §5  负向断言：electron-main.js 里 toPNG() / _frame.png 仍零命中（不踩坏既有约束）。
 *   §6  ★ 端到端回归：importSkinImage → applySkinSet 的 kind 传递（QA 反馈的主用户路径盲区）——
 *         对话框回值经 applySkinSet 显式字段重建后 kind 仍为 'video'；渲染层无 kind 回写继承 prev.kind；
 *         普通图片仍 'image'；脏 file 清洗为 null 时既有视频引用原样保留。
 *   §7  ★ 连点合并（#2 缺陷）：toggleFromTray 的重入窗口 —— 时间可控的两次点击：
 *         连点(100ms) 最终可见、窗口外正常 hide、边界 <窗口 忽略 / =窗口 放行、单次点击立即生效。
 *         连点数值从源码 TOGGLE_DEBOUNCE_MS 读取，不写死。
 *   §8  package.json 自检：check 与 prebuild 逐字相同且都含 node tests/qa-v340.js。
 *   §9  ★ 今日恒白字守卫（v3.4.0 缺陷#5）：扫雷「不存在能压过今日白字的 .d/.sub 颜色规则」
 *         —— 解析器跨行选择器归并自测 + 锚点唯一 + 系统性扫雷 + :where 特异性不变 + 3 个反向自测。
 *   §10 ★ 中性纸面完全不透明（v3.4.0 用户选定 1.00）：4 处中性 --paper 无 alpha 形态、
 *         刻意材质档（minimal/glass/neu/tech/warm）不越界、产物证据 + 反向自测。
 *   §11 ★ 今日格半透明 + 光影（v3.4.0 第 2 轮）：原生档 + image 档同款 color-mix + 顶部内高光、
 *         纯色档不被命中、--today-fill-alpha 等值 68% + 反向自测 + 今日恒白字不变量。
 *   §12 ★ 自选图片窗 blur 豁免（v3.4.0 #1 缺陷）：win.on('blur') 的兄弟窗豁免名单必须含
 *         skinCustomWin（逐个命中）+ 反向自测（删守卫必判红）+ openSkinCustomWindow 含 guardBlur(350)。
 *   §13 ★ MP4 身份随行 + 存量扩展名自证（v3.4.0 第二轮 #2）：无 kind 的 .mp4 存量配置经
 *         normalizeImageSpec 推断为 'video'（.png 反向为 'image'）；渲染层只回写 {file,opacity} 或
 *         取景 {file,crop,zoom} 时 kind 不得回退、bg 不得被写回 native、image 不得置 null；
 *         kind 在 skincustom 的 setField() **唯一收口点**补齐（调用点保持原字面量）+ applySkinSet 对 image/bg/style 打诊断日志。
 *   §14 ★ 媒体层空白底衬 + skin:// Range（v3.4.0 第三轮）：data-media-blank 属性门底衬（媒体正常时观感零变化、
 *         :671 逐字保留）+ skin:// 自实现 206（Content-Range / Accept-Ranges）+ 反向自测删 Accept-Ranges 必红。
 *
 * 设计原则（与 tests/qa-v244.js / qa-v330.js 同源）：
 *   1) 只读源码，绝不修改任何产品文件；发现 bug 只回报。
 *   2) 裸 Node，自建 ok()/eq() 计数器，process.exit(fail?1:0)。
 *   3) extractFn 抠真实函数体，注入最小 mock 后执行 —— 断言的是源码里那几行真实逻辑。
 *   4) 全程只在 os.tmpdir() 下建临时目录读写，绝不触碰项目内文件。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
function readRoot(f) {
  try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
  catch (e) { return ''; }
}
const MAIN = readRoot('electron-main.js');
const APP = readRoot('app.js');
const TPL = readRoot('template.html');
const DOCK = readRoot('dock.html');
const SKINCUSTOM = readRoot('skincustom.html');
const CAL = readRoot('calendar.html');

/* ================= 断言计数 ================= */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; failures.push(msg); } }
function eq(a, b, msg) {
  ok(a === b, msg + '  (期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + ')');
}

/* ================= 注释剥离 ================= */
function codeOnly(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/* ================= extractFn：大括号配平抠真实函数体 ================= */
function extractFn(src, name) {
  const key = 'function ' + name + '(';
  const idx = src.indexOf(key);
  if (idx < 0) throw new Error('qa-v340: 源码未找到函数 ' + name);
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
  throw new Error('qa-v340: 配平失败 ' + name);
}

/* ================= 临时目录 ================= */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v340-'));
const SKINS = path.join(TMP, 'skins');
fs.mkdirSync(SKINS, { recursive: true });
function tmpFile(name, buf) { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; }

/* ================= ISO-BMFF 合成工具 =================
 * 关键口径：tkhd 的宽高偏移是相对 **box 起始**（含 8 字节头），不是内容起始；
 * v0 → w@84/h@88（box 全长 92），v1 → w@96/h@100（box 全长 104）。 */
function box(type, content) {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + content.length, 0);
  h.write(type, 4, 'ascii');
  return Buffer.concat([h, content]);
}
function tkhd(version, w, h) {
  const total = (version === 1) ? 104 : 92;
  const b = Buffer.alloc(total - 8);
  b[0] = version;
  const wOff = (version === 1) ? 96 : 84;
  const hOff = (version === 1) ? 100 : 88;
  b.writeUInt32BE(w * 65536, wOff - 8);   // 16.16 定点
  b.writeUInt32BE(h * 65536, hOff - 8);
  return box('tkhd', b);
}
function makeMp4(trakList, opts) {
  opts = opts || {};
  const parts = [box('ftyp', Buffer.from('isomiso2avc1mp41', 'ascii'))];
  if (opts.bigMdat) parts.push(box('mdat', Buffer.alloc(opts.bigMdat, 7)));
  const moov = box('moov', Buffer.concat(trakList.map(function (t) { return box('trak', t); })));
  parts.push(moov);
  let buf = Buffer.concat(parts);
  if (opts.truncate) buf = buf.slice(0, opts.truncate);
  return buf;
}

/* ================= readMp4Size 真身抽取 ================= */
let readMp4Size = null;
try {
  readMp4Size = new Function('fs', extractFn(MAIN, 'readMp4Size') + '\nreturn readMp4Size;')(fs);
} catch (e) {
  console.error('qa-v340: 抽取 readMp4Size 失败 — ' + e.message);
  console.error('（可能 MP4 改动尚未落地）');
  process.exit(1);
}

/* ============================================================
 * §1  readMp4Size —— 合成 buffer 全覆盖
 * ============================================================ */
(function section1_readMp4Size() {
  /* --- 1.1 v0：1920×1080 --- */
  const f0 = tmpFile('v0.mp4', makeMp4([tkhd(0, 1920, 1080)]));
  const r0 = readMp4Size(f0);
  ok(r0 && r0.width === 1920 && r0.height === 1080,
    '§1 v0 tkhd 1920×1080 → ' + JSON.stringify(r0));

  /* --- 1.2 v1：1280×720 --- */
  const f1 = tmpFile('v1.mp4', makeMp4([tkhd(1, 1280, 720)]));
  const r1 = readMp4Size(f1);
  ok(r1 && r1.width === 1280 && r1.height === 720,
    '§1 v1 tkhd 1280×720 → ' + JSON.stringify(r1));

  /* --- 1.3 无 moov → null --- */
  const noMoov = Buffer.concat([box('ftyp', Buffer.from('isom', 'ascii')), box('mdat', Buffer.alloc(24))]);
  eq(readMp4Size(tmpFile('nomoov.mp4', noMoov)), null, '§1 无 moov → null');

  /* --- 1.4 宽或高为 0 → null --- */
  eq(readMp4Size(tmpFile('zero.mp4', makeMp4([tkhd(0, 0, 0)]))), null, '§1 宽高均为 0 → null');
  eq(readMp4Size(tmpFile('zerow.mp4', makeMp4([tkhd(0, 0, 480)]))), null, '§1 宽为 0 → null');
  eq(readMp4Size(tmpFile('zeroh.mp4', makeMp4([tkhd(0, 640, 0)]))), null, '§1 高为 0 → null');

  /* --- 1.5 截断 buffer → null --- */
  const trunc = makeMp4([tkhd(0, 640, 480)], { truncate: 40 });
  eq(readMp4Size(tmpFile('trunc.mp4', trunc)), null, '§1 截断（moov 不完整）→ null');

  /* --- 1.6 ★ mdat 在前且体积较大时仍找到其后的 moov（验证「跳过而不读」） --- */
  const big = makeMp4([tkhd(0, 800, 600)], { bigMdat: 5 * 1024 * 1024 });
  const rBig = readMp4Size(tmpFile('bigmdat.mp4', big));
  ok(rBig && rBig.width === 800 && rBig.height === 600,
    '§1★ mdat(5MB) 在前、moov 在后 → 仍读到 800×600（' + JSON.stringify(rBig) + '；说明 mdat 被跳过而非读入内存）');

  /* --- 1.7 音频轨（0×0）在前、视频轨在后 → 取视频轨 --- */
  const fA = tmpFile('audiofirst.mp4', makeMp4([tkhd(0, 0, 0), tkhd(0, 320, 240)]));
  const rA = readMp4Size(fA);
  ok(rA && rA.width === 320 && rA.height === 240,
    '§1 音频轨(0×0)在前 → 取到视频轨 320×240（' + JSON.stringify(rA) + '）');

  /* --- 1.8 空文件 / 不存在文件 → null（不抛） --- */
  eq(readMp4Size(tmpFile('empty.mp4', Buffer.alloc(0))), null, '§1 空文件 → null');
  eq(readMp4Size(path.join(TMP, 'ghost.mp4')), null, '§1 文件不存在 → null（openSync 抛错被吞）');
})();

/* ============================================================
 * §2  normalizeImageSpec 的 kind 归一分派
 * ============================================================ */
(function section2_KindSpec() {
  const DEPS = ['clamp01', 'clampZoom', 'clampImageOpacity', 'sanitizeBasename', 'normalizeImageSpec'];
  let api = null;
  try {
    const src = DEPS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
    api = new Function(src + '\nreturn { normalizeImageSpec: normalizeImageSpec };')();
  } catch (e) {
    ok(false, '§2 抽取 normalizeImageSpec 失败 — ' + e.message);
  }
  if (api) {
    eq(api.normalizeImageSpec({ file: 'a.mp4', kind: 'video' }).kind, 'video',
      "§2 {kind:'video'} → 'video'");
    eq(api.normalizeImageSpec({ file: 'a.png' }).kind, 'image',
      "§2 缺省 kind → 'image'（旧数据兼容）");
    eq(api.normalizeImageSpec({ file: 'a.png', kind: 'bogus' }).kind, 'image',
      "§2 {kind:'bogus'} → 'image'（脏值回落）");
    eq(api.normalizeImageSpec({ file: 'a.png', kind: 'image' }).kind, 'image',
      "§2 {kind:'image'} → 'image'");
    eq(api.normalizeImageSpec({ file: 'a.mp4', kind: 'VIDEO' }).kind, 'image',
      "§2 大小写敏感：{kind:'VIDEO'} → 'image'");
  }
})();

/* ============================================================
 * §3  importSkinImage 的 MP4 分支全链路（真复制进临时 skins 目录）
 * ============================================================ */
(function section3_ImportMp4() {
  const FN = ['clamp01', 'clampZoom', 'clampImageOpacity', 'sanitizeBasename',
    'readMp4Size', 'readGifSize', 'importSkinImage'];
  let makeApi = null;
  try {
    const src = FN.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
    /* readJpegOrientation / sampleImageStats / decideDark 非本段被测对象（各自的既有闸门已覆盖），
     * 在此注入最小桩避免隔离作用域 ReferenceError 与多余的真实依赖。 */
    makeApi = new Function('fs', 'path', 'nativeImage', 'skinsDir', 'skin',
      'readJpegOrientation', 'sampleImageStats', 'decideDark', [
        src,
        'return { importSkinImage: importSkinImage };'
      ].join('\n'));
  } catch (e) {
    ok(false, '§3 抽取 importSkinImage 依赖失败 — ' + e.message);
  }
  const noProbe = { createFromPath: function () { throw new Error('MP4/GIF 分支不应触碰 nativeImage'); } };
  const pngStub = {
    createFromPath: function () {
      return {
        isEmpty: function () { return false; },
        getSize: function () { return { width: 10, height: 10 }; }
      };
    }
  };
  if (makeApi) {
    function build(nativeImage) {
      return makeApi(fs, path, nativeImage, function () { return SKINS; }, { surfaces: {} },
        function () { return 1; }, function () { return null; }, function () { return false; });
    }

    /* --- 3.1 MP4 全链路（真复制进临时 skins 目录） --- */
    const mp4 = makeMp4([tkhd(0, 1920, 1080)]);
    const r = build(noProbe).importSkinImage('calendar', tmpFile('skin_ok.mp4', mp4));
    ok(r && r.ok === true, '§3 importSkinImage(.mp4) → ok===true  ' + JSON.stringify(r && r.error));
    if (r && r.image) {
      eq(r.image.kind, 'video', "§3 image.kind === 'video'");
      eq(r.image.snapshot, null, '§3 image.snapshot === null（视频不做静态快照）');
      eq(r.image.dark, false, '§3 image.dark === false（不采样，浅色兜底）');
      eq(r.image.complexity, 0, '§3 image.complexity === 0');
      eq(r.image.w, 1920, '§3 image.w === 1920（与合成 tkhd 一致）');
      eq(r.image.h, 1080, '§3 image.h === 1080');
      ok(!!r.image.file && /\.mp4$/.test(r.image.file), '§3 image.file 以 .mp4 落盘：' + r.image.file);
      ok(fs.existsSync(path.join(SKINS, r.image.file)), '§3 文件确已原子复制进临时 skins 目录');
    }

    /* --- 3.2 反向对照：.png 仍走图片分支（kind==='image'），未被 MP4 分支误伤 --- */
    const rp = build(pngStub).importSkinImage('calendar', tmpFile('skin_ok.png', Buffer.alloc(32)));
    ok(rp && rp.ok === true && rp.image && rp.image.kind === 'image',
      "§3 反向：.png → kind==='image'（未被 MP4 分支误伤）");
    if (rp && rp.image) { eq(rp.image.w, 10, '§3 PNG w 取自 nativeImage（10）'); }

    /* --- 3.3 反向对照：.gif 仍走 gif 分支且 kind==='image'，尺寸取自 readGifSize --- */
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'),
      (function () { const b = Buffer.alloc(4); b.writeUInt16LE(50, 0); b.writeUInt16LE(60, 2); return b; })()]);
    const rg = build(noProbe).importSkinImage('calendar', tmpFile('skin_ok.gif', gif));
    ok(rg && rg.ok === true && rg.image && rg.image.kind === 'image',
      "§3 反向：.gif → kind==='image'");
    if (rg && rg.image) {
      eq(rg.image.w, 50, '§3 GIF w=50（readGifSize）');
      eq(rg.image.h, 60, '§3 GIF h=60（readGifSize）');
      eq(rg.image.dark, false, '§3 GIF dark=false（与视频同口径）');
    }
  }
})();

/* ============================================================
 * §4  源码文本断言（含构建产物重建证据）
 * ============================================================ */
(function section4_Source() {
  /* --- 4.1 主进程 --- */
  ok(/'\.mp4'\s*:\s*1/.test(MAIN), "§4 electron-main.js okExts 含 '.mp4': 1");
  ok(/extensions:\s*\[[^\]]*'mp4'[^\]]*\]/.test(MAIN), "§4 文件对话框 extensions 含 'mp4'");
  ok(/function readMp4Size\(/.test(MAIN), '§4 electron-main.js 含 function readMp4Size(');
  ok(/var isVideo = \(ext === '\.mp4'\)/.test(MAIN), "§4 electron-main.js 含 var isVideo = (ext === '.mp4')");

  /* --- 4.2 渲染层 app.js --- */
  ok(APP.indexOf('skinVidWrap') >= 0, '§4 app.js 含 skinVidWrap');
  ok(APP.indexOf('skinVid') >= 0, '§4 app.js 含 skinVid');
  ok(/el\.tagName === 'VIDEO'/.test(APP), "§4 app.js 含 el.tagName === 'VIDEO'（typeof 无关，字符串相等）");

  /* --- 4.3 template.html / dock.html 都含视频层 --- */
  ok(TPL.indexOf('id="skinVid"') >= 0, '§4 template.html 含 id="skinVid"');
  ok(DOCK.indexOf('id="skinVid"') >= 0, '§4 dock.html 含 id="skinVid"');

  /* --- 4.4 dock.html 非 rect 隐藏规则同时覆盖 #skinVidWrap --- */
  ok(/html:not\(\[data-shape="rect"\]\)\s*#skinImg[^{]*#skinVidWrap[^{]*\{[^}]*display:\s*none/.test(codeOnly(DOCK)),
    '§4 dock.html `:not([data-shape="rect"])` 隐藏规则同时覆盖 #skinImg 与 #skinVidWrap');

  /* --- 4.5 skincustom.html 含 id="cropVid" --- */
  ok(SKINCUSTOM.indexOf('id="cropVid"') >= 0, '§4 skincustom.html 含 id="cropVid"');

  /* --- 4.6 ★ 产物重建证据：calendar.html 含 skinVidWrap --- */
  ok(CAL.length > 0, '§4 calendar.html 可读（build 产物）');
  ok(CAL.indexOf('skinVidWrap') >= 0,
    '§4★ 产物重建证据：calendar.html 含 skinVidWrap（即 build.js 确实跑过）');
})();

/* ============================================================
 * §5  负向断言：既有约束未被踩坏
 * ============================================================ */
(function section5_Negative() {
  const mainCode = codeOnly(MAIN);
  ok(!/toPNG\(\)/.test(mainCode), '§5★ 负向：electron-main.js 仍无 toPNG()（v2.4.2 约束保持）');
  ok(!/_frame\.png/.test(mainCode), '§5★ 负向：electron-main.js 仍无 _frame.png');
  ok(/var snapshot = null/.test(mainCode), '§5 electron-main.js 仍保留 var snapshot = null（视频同样不做首帧快照）');
  ok(/var isGif = \(ext === '\.gif'\)/.test(mainCode),
    "§5 既有契约：var isGif = (ext === '.gif') 原样保留（闸门 1 精确匹配）");
})();

/* ============================================================
 * §6  ★ 端到端回归：importSkinImage → applySkinSet 的 kind 传递
 * ------------------------------------------------------------
 * 为什么单独立这一节（QA 反馈的主用户路径盲区）：
 *   §3 只证明了 importSkinImage 返回值的 kind 正确，§4 只证明渲染层节点存在 ——
 *   但**没人把两者串起来**。而用户唯一能选到 MP4 的入口是对话框：
 *     importSkinImage 回值 → skincustom setField → IPC → applySkinSet。
 *   applySkinSet 的 image 分支是**显式字段列表**重建 ImageSpec：漏掉 kind 就会被
 *   normalizeImageSpec echo 成 'image' → 渲染层当普通图片塞进 background-image →
 *   .mp4 背景空白、无动画。本节把这条链路钉死，防止再次回归。
 * ============================================================ */
(function section6_KindEndToEnd() {
  /* 依赖名单与 qa-v244 孤立 eval applySkinSet 的口径一致（含 image 分支实际执行到的全部依赖） */
  const DEPS = ['clamp01', 'clampZoom', 'clampImageOpacity', 'sanitizeBasename',
    'normalizeImageSpec', 'normStyle', 'normShape', 'normBg', 'normTone',
    'normalizeClarity', 'normDockScale', 'applySkinSet'];
  let makeApi = null;
  try {
    const src = DEPS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
    /* 被替换的宿主函数（saveSettings / pushThemeToAll / syncDockGeometry …）全部注入空桩：
     * 本节只关心 applySkinSet 对 skin.surfaces 的写入结果，不关心副作用广播。 */
    makeApi = new Function('skin', 'saveSettings', 'recomputeTheme', 'pushThemeToAll',
      'syncDockGeometry', 'pushSkinToAll', 'refreshTrayMenu', 'applyOpacity',
      src + '\nreturn { applySkinSet: applySkinSet };');
  } catch (e) {
    ok(false, '§6 抽取 applySkinSet 依赖失败 — ' + e.message);
  }
  function freshSkin() {
    return { surfaces: {
      calendar: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect' },
      expanded: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect', follow: null },
      desktop: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect', follow: null },
      dock: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect', follow: null }
    } };
  }
  function blankStubs8(skin) {
    return makeApi(skin, function () {}, function () {}, function () {}, function () {},
      function () {}, function () {}, function () {});
  }
  /* importSkinImage(§3) 对 .mp4 的返回值形状（kind:'video'、不做快照、不采样亮度） */
  const videoSpec = { file: 'calendar_x.mp4', snapshot: null, w: 2560, h: 1440,
    crop: { x: 0, y: 0, w: 1, h: 1 }, zoom: 1, opacity: 1, dark: false, complexity: 0, kind: 'video' };

  if (makeApi) {
    /* --- 6.1 对话框主路径：import 回值原样喂 applySkinSet → kind 必须仍是 'video' --- */
    const skin1 = freshSkin();
    const api1 = blankStubs8(skin1);
    api1.applySkinSet({ surface: 'calendar', field: 'image', value: videoSpec });
    eq(skin1.surfaces.calendar.image && skin1.surfaces.calendar.image.kind, 'video',
      "§6★ 对话框路径：importSkinImage(kind:'video') 经 applySkinSet 后 kind 仍为 'video'");
    eq(skin1.surfaces.calendar.bg, 'image',
      "§6★ 且 bg 切到 'image'（否则渲染层不给视频层留位）");

    /* --- 6.2 渲染层尺寸纠偏回写（只发 {file,w,h}、刻意不带 kind）→ 必须继承 prev.kind --- */
    const skin2 = freshSkin();
    const api2 = blankStubs8(skin2);
    api2.applySkinSet({ surface: 'calendar', field: 'image', value: videoSpec });
    api2.applySkinSet({ surface: 'calendar', field: 'image',
      value: { file: 'calendar_x.mp4', w: 1920, h: 1080 } });
    eq(skin2.surfaces.calendar.image && skin2.surfaces.calendar.image.kind, 'video',
      "§6★ 渲染层回写({file,w,h}) 未带 kind → 继承 prev.kind='video'（不降级为图片）");
    eq(skin2.surfaces.calendar.image && skin2.surfaces.calendar.image.w, 1920,
      '§6 回写仍生效：w 被纠偏为 1920（不是整条丢弃）');

    /* --- 6.3 脏值防线：显式传 kind:'image' 的普通图片仍落 'image'（视频分支不越界） --- */
    const skin3 = freshSkin();
    const api3 = blankStubs8(skin3);
    api3.applySkinSet({ surface: 'calendar', field: 'image',
      value: { file: 'calendar_y.png', w: 100, h: 100, kind: 'image' } });
    eq(skin3.surfaces.calendar.image && skin3.surfaces.calendar.image.kind, 'image',
      "§6 对照：普通图片 kind==='image'（未被视频分支误伤）");

    /* --- 6.4 脏 file 防线仍在：{file:'/'} 被清洗 → nimg=null → 整分支零副作用 --- */
    const skin4 = freshSkin();
    const api4 = blankStubs8(skin4);
    api4.applySkinSet({ surface: 'calendar', field: 'image', value: videoSpec });   // 先立起视频
    const keep = JSON.stringify(skin4.surfaces.calendar.image);
    api4.applySkinSet({ surface: 'calendar', field: 'image', value: { file: '/', kind: 'video' } });
    eq(JSON.stringify(skin4.surfaces.calendar.image), keep,
      '§6 脏 file 清洗为 null 时，既有视频引用原样保留（X3 不变量未被 kind 改动破坏）');
  }
})();

/* ============================================================
 * §7  ★ 连点合并（v3.4.0 #2 缺陷）：toggleFromTray 的重入窗口
 * ------------------------------------------------------------
 * 为什么必须被闸门覆盖：这是本轮「同类缺陷再次漏掉」的教训所在 ——
 *   #2 的机理「第二下把刚弹出的窗口又 hide 了」是纯时序逻辑，只有把它固化成
 *   「时间可控的两次点击 → 断言最终可见性」的断言，下次改动才不会再漏。
 * 手法：extractFn 抠真实 toggleFromTray，把 Date.now() 换成可控 clock，
 *   win/showMini/guardBlur 注入最小桩；连点数值一律从源码里的 TOGGLE_DEBOUNCE_MS 读，
 *   不写死 350 —— 这样取值调整（350/250…）时断言语义不变。
 * ============================================================ */
(function section7_ToggleDebounce() {
  const fnSrc = extractFn(MAIN, 'toggleFromTray');
  ok(/Date\.now\(\)/.test(fnSrc), '§7 toggleFromTray 用 Date.now() 计时（可被 clock 替换）');
  const dm = /const TOGGLE_DEBOUNCE_MS\s*=\s*(\d+)\s*;/.exec(MAIN);
  const DEB = dm ? Number(dm[1]) : 0;
  ok(DEB > 0, '§7 源码定义 TOGGLE_DEBOUNCE_MS（值 ' + DEB + '）');
  ok(/now - lastToggleAt\s*<\s*TOGGLE_DEBOUNCE_MS/.test(fnSrc),
    '§7 toggleFromTray 内含「距上次 toggle 不足窗口则 return」的守卫');

  /* 每个场景用独立实例（lastToggleAt 是闭包内状态）。 */
  function mkToggle() {
    let clockNow = 0, vis = false;
    const fn = new Function('win', 'showMini', 'guardBlur', 'clock',
      'var lastToggleAt = 0; var TOGGLE_DEBOUNCE_MS = ' + DEB + ';\n' +
      fnSrc.replace(/Date\.now\(\)/g, 'clock()') +
      '\nreturn toggleFromTray;');
    const win = {
      isVisible: function () { return vis; },
      hide: function () { vis = false; },
      isDestroyed: function () { return false; },
      webContents: { send: function () {} }
    };
    const toggle = fn(win, function () { vis = true; }, function () {}, function () { return clockNow; });
    return {
      toggle: toggle,
      setNow: function (t) { clockNow = t; },
      getVis: function () { return vis; },
      setVis: function (v) { vis = v; }
    };
  }

  /* 7.1 连点（间隔 << 窗口）→ 第二次被合并，最终仍可见 */
  const a = mkToggle();
  a.setVis(false); a.setNow(1000); a.toggle();          // 打开
  a.setNow(1000 + 100); a.toggle();                     // 100ms 后 → 应被忽略
  ok(a.getVis() === true, '§7★ 连点(100ms)：第二次被合并 → 最终「可见」（不弹出缺陷已修）');

  /* 7.2 对照（间隔 > 窗口）→ 第二次正常 hide（证明不是「把 hide 全吞了」） */
  const b = mkToggle();
  b.setVis(false); b.setNow(2000); b.toggle();          // 打开
  b.setNow(2000 + DEB + 150); b.toggle();               // 窗口外 → 应 hide
  ok(b.getVis() === false, '§7 对照(窗口外 +' + (DEB + 150) + 'ms)：第二次正常 hide（未误伤关闭意图）');

  /* 7.3 边界：正好差 1ms 忽略、正好等于窗口放行 */
  const c = mkToggle();
  c.setVis(false); c.setNow(3000); c.toggle();          // 打开
  c.setNow(3000 + DEB - 1); c.toggle();                 // 窗口内 → 忽略
  const edgeIn = c.getVis();
  c.setNow(3000 + DEB); c.toggle();                     // 窗口边界 → 放行 → hide
  ok(edgeIn === true && c.getVis() === false,
    '§7 边界：<' + DEB + 'ms 忽略、=' + DEB + 'ms 放行');

  /* 7.4 单次点击仍立即生效（不能把正常 toggle 也吞掉） */
  const d = mkToggle();
  d.setVis(false); d.setNow(5000); d.toggle();
  ok(d.getVis() === true, '§7 单次点击 → 立即打开（未误伤正常操作）');
})();

/* ============================================================
 * §8  package.json 闸门串自检（check / prebuild 必须逐字同且含 qa-v340）
 * ============================================================ */
(function section8_PkgScripts() {
  let pkg = {};
  try { pkg = JSON.parse(readRoot('package.json')); } catch (e) {}
  const chk = pkg.scripts && pkg.scripts.check;
  const pre = pkg.scripts && pkg.scripts.prebuild;
  ok(!!chk && !!pre, '§8 package.json 同时含 check 与 prebuild 脚本');
  eq(chk, pre, '§8 check 与 prebuild 两条命令串逐字相同');
  ok(/node tests\/qa-v340\.js/.test(chk || ''), '§8 check 串含 node tests/qa-v340.js');
  ok(/node tests\/qa-v340\.js/.test(pre || ''), '§8 prebuild 串含 node tests/qa-v340.js');
})();

/* ============================================================
 * §9  ★ 今日恒白字守卫（v3.4.0 缺陷#5）：任何 .d/.sub 颜色规则都不得压过「今日」白字
 * ------------------------------------------------------------
 * 缺陷事实：今天为周六，`.cell.weekend:not(.other):not(.workday):not(.holiday) .d`
 *   是 6 个类 (0,6,0) > 今日白字 (0,4,0) ⇒ 今日格里的日期数字被 --weekend 染红、几乎不可见。
 * 修法：给全部状态色规则加今日守卫 `:where(:not(.today))`（:where 特异性贡献为 0，
 *   故改后特异性逐位不变、非今日格零行为变化；由本节 9.4 机器校验）。
 * 本节把「今日恒白字」固化成机器可校验的不变量，并用反向自测证明闸门真会红
 *   ——「一个从没红过的闸门不算闸门」。
 * 读的是**重建后的产物 calendar.html**（不是模板），确保 build 真把守卫带进了运行时。
 * 解析器要点：先只取 <style> 块（产物含 <script>，其花括号不可被当规则），
 *   再把**跨行选择器列表归并成一条规则**（:1044-1045 就是一条规则的两行选择器）。
 * ============================================================ */
(function section9_TodayWhiteText() {
  /* 只取 <style>…</style> 内的 CSS（产物含 <script>，其 {} 不可被当规则） */
  function styleBlocks(html) {
    var out = '', re = /<style[^>]*>([\s\S]*?)<\/style>/gi, m;
    while ((m = re.exec(String(html)))) out += '\n' + m[1];
    return out;
  }
  /* 把 `选择器 { 声明 }` 切成规则；@ 块整体跳过；选择器跨行先归并为单行 */
  function scanRules(css) {
    var s = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
    var out = [], i = 0, n = s.length, buf = '';
    while (i < n) {
      var ch = s[i];
      if (ch === '{') {
        var sel = buf.replace(/\s+/g, ' ').trim();
        if (sel.charAt(0) === '@') {
          var d0 = 1; i++;
          while (i < n && d0 > 0) { if (s[i] === '{') d0++; else if (s[i] === '}') d0--; i++; }
          buf = ''; continue;
        }
        var j = i + 1, dd = 1;
        while (j < n && dd > 0) { if (s[j] === '{') dd++; else if (s[j] === '}') dd--; if (dd === 0) break; j++; }
        out.push({ sel: sel, decl: s.slice(i + 1, j) });
        i = j + 1; buf = ''; continue;
      }
      if (ch === '}') { buf = ''; i++; continue; }
      buf += ch; i++;
    }
    return out;
  }
  /* 选择器列表：逗号拆分，括号内的逗号不算分隔 */
  function splitSel(sel) {
    var out = [], depth = 0, cur = '';
    for (var k = 0; k < sel.length; k++) {
      var ch = sel[k];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  /* 去掉每个 :where(...) 整组（其特异性贡献为 0） */
  function stripWhere(sel) {
    var res = '', i = 0;
    while (i < sel.length) {
      if (sel.substr(i, 7) === ':where(') {
        var d = 1, j = i + 7;
        while (j < sel.length && d > 0) { if (sel[j] === '(') d++; else if (sel[j] === ')') d--; j++; }
        i = j; continue;
      }
      res += sel[i]; i++;
    }
    return res;
  }
  /* 特异性简化为可比较整数 a*1e6 + b*1e3 + c（本文件颜色选择器无 id / 元素，c 恒 0） */
  function specificity(sel) {
    var s = stripWhere(sel).replace(/:(not|is|matches|any)\(/g, ' (');
    var a = (s.match(/#[A-Za-z0-9_-]+/g) || []).length;
    var b = (s.match(/\.[A-Za-z0-9_-]+/g) || []).length;
    return a * 1000000 + b * 1000;
  }
  function specStr(v) { return '(' + Math.floor(v / 1000000) + ',' + Math.floor(v % 1000000 / 1000) + ',' + (v % 1000) + ')'; }
  var HAS_COLOR = /(^|[;{\n])\s*color\s*:/;              // 只认 color 属性本身（排除 background-color / border-color）
  var TEXT_CELL = /\.cell\b[^,{}]*\s+\.(d|sub)\b/;       // 经 .cell 指向 .d / .sub
  /* 该选择器是否**可能命中今日格**：带今日守卫、或要求 .other（今日恒非 other）→ 否 */
  function canMatchToday(one) {
    if (/:where\(:not\(\.today\)\)/.test(one)) return false;
    if (/:not\(\.today\)/.test(one)) return false;
    if (/\.cell\.other\b/.test(one)) return false;
    return true;
  }
  /* 抽出「经 .cell 指向 .d/.sub 且声明设置 color:」的全部选择器（读取 HTML 的 style 块） */
  function coloringSelectors(html) {
    var res = [];
    scanRules(styleBlocks(html)).forEach(function (r) {
      if (!HAS_COLOR.test(r.decl)) return;
      splitSel(r.sel).forEach(function (one) {
        if (TEXT_CELL.test(one)) res.push({ sel: one, spec: specificity(one) });
      });
    });
    return res;
  }
  var ANCHOR = 4000;   // 今日白字锚点 .cell.today:not(.other) .d/.sub 的特异性 (0,4,0)
  /* 扫雷：返回违例列表（空 = 今日恒白字成立） */
  function scanTodayGuard(html) {
    var viol = [];
    coloringSelectors(html).forEach(function (it) {
      if (/\.cell\.today\b/.test(it.sel)) return;                              // 今日锚点自身放行
      if (/:not\(\.today\)/.test(it.sel) && !/:where\(:not\(\.today\)\)/.test(it.sel)) {
        viol.push(it.sel + ' → 裸 :not(.today) 会改特异性，必须用 :where(:not(.today))');
        return;
      }
      if (canMatchToday(it.sel) && it.spec >= ANCHOR) {
        viol.push(it.sel + ' → 可命中今日且特异性 ' + specStr(it.spec) + ' ≥ 锚点 ' + specStr(ANCHOR));
      }
    });
    return viol;
  }
  /* 统计「今日白字锚点」规则条数（按规则，不按选择器） */
  function anchorRuleCount(html) {
    var n = 0;
    scanRules(styleBlocks(html)).forEach(function (r) {
      if (!HAS_COLOR.test(r.decl) || !/#fff\b|#ffffff\b|white/i.test(r.decl)) return;
      if (splitSel(r.sel).some(function (one) { return /\.cell\.today\b/.test(one) && TEXT_CELL.test(one); })) n++;
    });
    return n;
  }
  /* 注入：把一段 CSS 塞进第一个 </style> 之前（保持文本扫描有效） */
  function inject(html, css) { return String(html).replace('</style>', css + '</style>'); }

  /* --- 9.1 ★ 跨行选择器列表必须归并为 1 条规则（解析器自测） --- */
  var sr = scanRules('.cell.a,\n.cell.b {\n color: #fff;\n}');
  ok(sr.length === 1 && splitSel(sr[0].sel).length === 2,
    '§9★ 解析器：跨行选择器列表归并为 1 条规则（选择器 2 个）—— 防 :1044-1045 被数成两条');

  /* --- 9.2 今日白字锚点存在且唯一 --- */
  ok(anchorRuleCount(CAL) === 1,
    '§9 今日白字锚点存在且唯一（.cell.today:not(.other) .d/.sub → #fff；实际 ' + anchorRuleCount(CAL) + ' 条）');

  /* --- 9.3 系统性扫雷：不存在能压过今日白字的 .d/.sub 颜色规则 --- */
  var v0 = scanTodayGuard(CAL);
  ok(v0.length === 0,
    '§9 今日恒白字：全部 .d/.sub 颜色规则或为基色、或有 :where(:not(.today)) 守卫、或要求 .other —— 无一条可压过今日白字（违例 ' + v0.length + ' 条 ' + JSON.stringify(v0) + '）');

  /* --- 9.4 :where 守卫不改特异性：11 条守卫、逐条 特异性(带守卫)===特异性(去守卫) --- */
  var guarded = coloringSelectors(TPL).filter(function (it) { return /:where\(:not\(\.today\)\)/.test(it.sel); });
  var specBad = guarded.filter(function (it) { return specificity(it.sel) !== specificity(it.sel.replace(':where(:not(.today))', '')); });
  ok(guarded.length === 11 && specBad.length === 0,
    '§9 :where(:not(.today)) 守卫不移特异性：恰 11 条守卫、逐条相等（守卫 ' + guarded.length + ' 条，不等 ' + specBad.length + ' 条）');

  /* --- 9.5 ★ 反向自测①：删掉周末规则的 :where 守卫（还原缺陷）→ 必须判红 --- */
  var g1003 = '.cell.weekend:not(.other):not(.workday):not(.holiday):where(:not(.today)) .d';
  var vDel = scanTodayGuard(CAL.split(g1003).join(g1003.replace(':where(:not(.today))', '')));
  ok(vDel.length >= 1,
    '§9★ 反向自测①：删掉周末规则的 :where(:not(.today)) 守卫后必须判红（实际违例 ' + vDel.length + ' 条）');

  /* --- 9.6 ★ 反向自测②：注入一条 (0,7,0) 无守卫规则 → 必须判红 --- */
  var vHigh = scanTodayGuard(inject(CAL,
    '\n.cell.weekend:not(.other):not(.workday):not(.holiday).injected7 .d { color: #ff0000; }\n'));
  ok(vHigh.length >= 1,
    '§9★ 反向自测②：注入 (0,7,0) 无守卫规则后必须判红（证明会咬住「特异性压过」；实际违例 ' + vHigh.length + ' 条）');

  /* --- 9.7 ★ 反向自测③（对照）：注入带守卫的红字 → 不得判红 --- */
  var vCtl = scanTodayGuard(inject(CAL,
    '\n.cell.holiday:where(:not(.today)) .d { color: #ff0000; }\n'));
  ok(vCtl.length === v0.length,
    '§9★ 反向自测③（对照）：注入带 :where(:not(.today)) 守卫的红字不得判红（证明判定认「守卫」而非「见红就报」；违例 ' + vCtl.length + ' 条）');
})();

/* ============================================================
 * §10 ★ 中性纸面「完全不透明」（v3.4.0 用户选定 1.00）：4 处中性 --paper → rgb(…)（无 alpha 段）
 * ------------------------------------------------------------
 * 依据：用户拍板的最终选择「確定 1.00 版本」（经 lead 转达）；0.95 只是先前的中间档。
 *   浮窗卡面 dock.html 仍为 0.95，本次只改主窗、不动浮窗。
 * 修法：只把 4 处中性档（:root 白/夜 + default 白/夜）写成无 alpha 的 rgb(r,g,b)；刻意材质档不动。
 * 安全前提：`--paper` 唯一消费者是 `#widget { background: var(--paper) }`，且只在 native 态生效。
 * 本节锁「完全不透明」这一**绝对口径**（不含 alpha 段，或 alpha==1）—— 故 0.95/0.88 一律判红；
 *   同时保留「不越界改多」防护（glass ≤0.42、材质档 8 个 hex 原值），并锁建构产物 calendar.html。
 * ============================================================ */
(function section10_PaperOpacity() {
  /* 所有 `--paper:` 声明值（正则要求 `--paper` 紧跟 `:` ⇒ 不会误取 --paper-solid/-hi/-edge） */
  function paperDecls(text) {
    var res = [], re = /--paper:\s*([^;}]+?)\s*[;}]/g, m;
    while ((m = re.exec(text))) res.push(m[1].trim());
    return res;
  }
  /* 中性档 --paper 行（rgb(252,251,249) / rgba(252,251,249,a) 或 28,32,44 同构）：
   *   a = null 表示无 alpha 段（rgb() ⇒ 完全不透明）；有 alpha 段则为数值。带行号与原始行。 */
  function neutralDecls(text) {
    var out = [], lines = String(text).split('\n');
    lines.forEach(function (ln, i) {
      var m = /^\s*--paper:\s*rgba?\(\s*(?:252,\s*251,\s*249|28,\s*32,\s*44)\s*(?:,\s*([0-9.]+)\s*)?\)/.exec(ln);
      if (m) out.push({ n: i + 1, raw: ln.trim(), a: (m[1] === undefined ? null : parseFloat(m[1])) });
    });
    return out;
  }
  function isOpaque(d) { return d.a === null || d.a === 1; }
  /* 非完全不透明（含 alpha 段且 < 1）的违例行；rgb() 无第 4 段 ⇒ 天然完全不透明。 */
  function notOpaque(text) {
    return neutralDecls(text).filter(function (d) { return !isOpaque(d); })
      .map(function (d) { return 'L' + d.n + ': ' + d.raw + '  (含 alpha ' + d.a + ' ≠ 完全不透明)'; });
  }

  /* --- 10.1 4 处中性 --paper 均为完全不透明（无 alpha 段 / alpha==1） --- */
  var nd = neutralDecls(TPL), bad = notOpaque(TPL);
  ok(nd.length === 4 && bad.length === 0,
    '§10 中性 --paper 4 处均为完全不透明（实际 ' + nd.length + ' 处 alpha=[' + nd.map(function (d) { return (d.a === null ? 'none' : d.a); }).join(', ') + ']，非不透明 ' + bad.length + ' 处 ' + JSON.stringify(bad) + '）');

  /* --- 10.2 glass 两处仍 ≤ 0.42（防越界改多） --- */
  var dl = paperDecls(TPL);
  var glassOk = dl.indexOf('rgba(255, 255, 255, 0.42)') >= 0 && dl.indexOf('rgba(30, 20, 60, 0.38)') >= 0;
  ok(glassOk,
    '§10 glass 两处 --paper 仍为 0.42 / 0.38（≤0.42，未越界）：' + JSON.stringify(dl.filter(function (v) { return /^rgba\(/.test(v); })));

  /* --- 10.3 minimal/neu/tech/warm 仍为不透明原值（8 个 hex）且声明总数未变 --- */
  var HEXX = ['#ffffff', '#161619', '#dfe6f0', '#232a36', '#eef7fb', '#060a12', '#fffdf7', '#2c2419'];
  var missing = HEXX.filter(function (h) { return dl.indexOf(h) < 0; });
  ok(dl.length === 14 && missing.length === 0,
    '§10 minimal/neu/tech/warm 的 --paper 仍为不透明原值（声明共 ' + dl.length + ' 条；缺失 ' + JSON.stringify(missing) + '）');

  /* --- 10.4 产物证据：build 后 calendar.html 的 4 处中性档同为无 alpha 形态 --- */
  var cOpaque = (CAL.match(/--paper:\s*rgb\(\s*(?:252,\s*251,\s*249|28,\s*32,\s*44)\s*\)/g) || []).length;
  var cLegacy = (CAL.match(/--paper:\s*rgba\(\s*(?:252,\s*251,\s*249|28,\s*32,\s*44)\s*,/g) || []).length;
  ok(cOpaque === 4 && cLegacy === 0,
    '§10 产物 calendar.html 的中性 --paper 4 处亦为无 alpha 形态（rgb() ' + cOpaque + ' 处；旧 rgba() 遗留 ' + cLegacy + ' 处）');

  /* --- 10.5 ★ 反向自测①：注入旧值 rgba(...,0.95) → 必须判红，并给出报错行 --- */
  var p95 = TPL.replace('rgb(252, 251, 249)', 'rgba(252, 251, 249, 0.95)');
  var v95 = notOpaque(p95);
  ok(v95.length >= 1,
    '§10★ 反向自测①：把中性档改回 rgba(...,0.95) 后必须判红（报错行：' + JSON.stringify(v95) + '）');

  /* --- 10.6 ★ 反向自测②：注入更实值 rgba(...,0.88) → 也必须判红（证明锁的是「完全不透明」绝对口径） --- */
  var p88 = TPL.replace('rgb(252, 251, 249)', 'rgba(252, 251, 249, 0.88)');
  var v88 = notOpaque(p88);
  ok(v88.length >= 1,
    '§10★ 反向自测②：把中性档改回 rgba(...,0.88) 后也必须判红（报错行：' + JSON.stringify(v88) + '）');
})();

/* ============================================================
 * §11 ★ 今日格「半透明填充 + 光影」（v3.4.0 第 2 轮）：原生档 + 自选图片档同款，纯色档不动
 * ------------------------------------------------------------
 * 用户原话：「今日的颜色再透明一点点 + 加一点光影，更突出今天，又不会影响周边单元格、
 *   不严重影响背景图，仅限原生皮肤默认和自选图片模式」。
 * 锁法（吸取 §10 教训：绝对口径用**等值断言**，不用阈值）：
 *   ① --today-fill-alpha **等于** 68%（等值）；
 *   ② 原生档 html:not([data-skin]) 与 image 档 html[data-skin="image"] 的今日格**都**走
 *      color-mix 半透明填充 + 顶部内高光（inset 0 1px 0）；
 *   ③ 纯色档 [data-skin="color"] **未被**任何 color-mix 今日规则命中（逐字不动）；
 *   ④ 反向自测：把 68% 改回 80% → 必须判红；
 *   ⑤ §9「今日恒白字」不变量继续成立（今日 .d/.sub 仍 #fff）。
 * 读 template.html（改动源）；产物侧由既有 §9/§10 覆盖。
 * ============================================================ */
(function section11_TodayTranslucentLight() {
  function cssOf(html) { var out = '', re = /<style[^>]*>([\s\S]*?)<\/style>/gi, m; while ((m = re.exec(String(html)))) out += '\n' + m[1]; return out; }
  function rulesOf(css) {
    var s = String(css).replace(/\/\*[\s\S]*?\*\//g, ''); var out = [], i = 0, n = s.length, buf = '';
    while (i < n) {
      var ch = s[i];
      if (ch === '{') {
        var sel = buf.replace(/\s+/g, ' ').trim();
        if (sel.charAt(0) === '@') { var d0 = 1; i++; while (i < n && d0 > 0) { if (s[i] === '{') d0++; else if (s[i] === '}') d0--; i++; } buf = ''; continue; }
        var j = i + 1, dd = 1; while (j < n && dd > 0) { if (s[j] === '{') dd++; else if (s[j] === '}') dd--; if (dd === 0) break; j++; }
        out.push({ sel: sel, decl: s.slice(i + 1, j) }); i = j + 1; buf = ''; continue;
      }
      if (ch === '}') { buf = ''; i++; continue; }
      buf += ch; i++;
    }
    return out;
  }
  function selList(sel) { var out = [], depth = 0, cur = ''; for (var k = 0; k < sel.length; k++) { var ch = sel[k]; if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
  /* 「今日格填充」规则：声明含 color-mix 且选择器含 .cell.today */
  function todayFillRules(html) {
    return rulesOf(cssOf(html)).filter(function (r) {
      return /color-mix\(/.test(r.decl) && selList(r.sel).some(function (one) { return /\.cell\.today\b/.test(one); });
    });
  }

  /* --- 11.1 等值：--today-fill-alpha === 68% --- */
  var m = /--today-fill-alpha:\s*([^;]+);/.exec(cssOf(TPL));
  var curAlpha = m ? m[1].trim() : '(未找到)';
  eq(curAlpha, '68%', '§11 --today-fill-alpha 等值 68%（用户「再透明一点点」档，绝对口径）');

  /* --- 11.2 原生档今日格走 color-mix 半透明 + 顶部内高光 --- */
  var nat = todayFillRules(TPL).filter(function (r) { return selList(r.sel).some(function (one) { return /html:not\(\[data-skin\]\)/.test(one) && /\.cell\.today/.test(one); }); });
  var natOK = nat.length > 0 && nat.some(function (r) { return /var\(--today-fill-alpha/.test(r.decl) && /inset 0 1px 0/.test(r.decl); });
  ok(natOK, '§11 原生档 html:not([data-skin]) 今日格走 color-mix(var(--today-fill-alpha)) + 顶部内高光（命中 ' + nat.length + ' 条）');

  /* --- 11.3 自选图片档同款 --- */
  var img = todayFillRules(TPL).filter(function (r) { return selList(r.sel).some(function (one) { return /html\[data-skin="image"\]/.test(one) && /\.cell\.today/.test(one); }); });
  var imgOK = img.length > 0 && img.some(function (r) { return /var\(--today-fill-alpha/.test(r.decl) && /inset 0 1px 0/.test(r.decl); });
  ok(imgOK, '§11 自选图片档 html[data-skin="image"] 今日格同款 color-mix + 顶部内高光（命中 ' + img.length + ' 条）');

  /* --- 11.4 纯色档未被命中（逐字不动） --- */
  var colorHit = todayFillRules(TPL).filter(function (r) { return selList(r.sel).some(function (one) { return /\[data-skin="color"\]/.test(one); }); });
  ok(colorHit.length === 0, '§11 纯色档 [data-skin="color"] 未被任何 color-mix 今日规则命中（命中 ' + colorHit.length + ' 条，应为 0）');

  /* --- 11.5 ★ 反向自测：把 68% 改回 80% → 必须判红 --- */
  var tpl80 = TPL.replace('--today-fill-alpha: 68%', '--today-fill-alpha: 80%');
  var m80 = /--today-fill-alpha:\s*([^;]+);/.exec(cssOf(tpl80));
  var a80 = m80 ? m80[1].trim() : '(未找到)';
  ok(a80 !== '68%', '§11★ 反向自测：把 --today-fill-alpha 改回 80% 后必须判红（判红行：--today-fill-alpha: ' + a80 + ' ≠ 68%）');

  /* --- 11.6 §9 不变量：今日 .d/.sub 仍为白字 --- */
  var whiteRule = rulesOf(cssOf(TPL)).some(function (r) { return /\.cell\.today/.test(r.sel) && /(^|;)\s*color:\s*#fff\b/i.test(r.decl); });
  ok(whiteRule, '§11 §9 不变量继续成立：今日 .d/.sub 仍为 #fff（半透明白字未被动摇）');
})();

/* ============================================================
 * §12 ★ 自选图片窗 blur 豁免（v3.4.0 #1 缺陷）：调皮肤时日历主窗不得被 hideMain 收走
 * ------------------------------------------------------------
 * 用户原话：「调整皮肤参数的时候，导致日历窗口消失，无法实时看到调整效果」。
 * 缺陷事实：win.on('blur') 的兄弟窗豁免名单（逐个 isFocused() 判定）**漏了 skinCustomWin**
 *   （「自选图片」窗，用户正是在这里调 MP4 的取景/缩放/不透明度）→ 该窗一获得焦点就无人豁免
 *   → 落到 hideMain() 把日历收走 → 用户失去实时预览。
 * 修法：① 名单补 skinCustomWin 守卫；② openSkinCustomWindow() 首行 guardBlur(350)，
 *   盖住 show()/focus() 的异步竞态（新窗拿到焦点前主窗 blur 可能先到）。
 * 手法：抠 win.on('blur') 的**代码体**做文本扫描（先剥注释再配平括号，保证守卫确在 blur 体内），
 *   并配反向自测 —— 把该守卫从源码副本删掉后扫描**必须判红**（「没红过的闸门不算闸门」）。
 * ============================================================ */
(function section12_SkinCustomBlurGuard() {
  /* 抠 win.on('blur', function () { … }) 的函数体（先 codeOnly 剥注释，再大括号配平） */
  function blurBody(src) {
    var code = codeOnly(src);
    var i = code.indexOf("win.on('blur'");
    if (i < 0) return '';
    var s = code.indexOf('{', i);
    if (s < 0) return '';
    var depth = 0;
    for (var j = s; j < code.length; j++) {
      var ch = code[j];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return code.slice(s + 1, j); }
    }
    return '';
  }
  /* 单行守卫：if ( <win> … isFocused() ) return;  —— 限定单行（[^\n]）避免跨行误配到别的 isFocused */
  function guardRe(w) {
    return new RegExp('if\\s*\\(\\s*' + w + '\\b[^\\n]*isFocused\\(\\)\\s*\\)\\s*return;');
  }
  function hasGuard(body, w) { return guardRe(w).test(body); }

  var body = blurBody(MAIN);

  /* --- 12.1~~12.7 兄弟窗豁免名单一个都不能少（含本轮补的 skinCustomWin） --- */
  var NAMES = ['dockWin', 'desktopWin', 'settingsWin', 'skinWin', 'skinCustomWin', 'remindlistWin', 'reminderWin'];
  NAMES.forEach(function (w) {
    ok(hasGuard(body, w), "§12 win.on('blur') 豁免名单含 " + w + ' 的 isFocused() 守卫');
  });

  /* --- 12.8 ★ 反向自测：删掉 skinCustomWin 守卫（还原 #1 缺陷）→ 扫描必须判红 --- */
  var bodyDel = body.replace(guardRe('skinCustomWin'), '');
  ok(bodyDel !== body && !hasGuard(bodyDel, 'skinCustomWin'),
    '§12★ 反向自测：删掉 skinCustomWin 守卫后扫描必须判红（证明闸门真会红，而非恒真）');

  /* --- 12.9 竞态加固：openSkinCustomWindow 体内含 guardBlur(350) --- */
  var osBody = '';
  try { osBody = codeOnly(extractFn(MAIN, 'openSkinCustomWindow')); } catch (e) { osBody = ''; }
  ok(/guardBlur\(350\)\s*;/.test(osBody),
    '§12 openSkinCustomWindow 体内含 guardBlur(350)（盖住 show()/focus() 的异步 blur 竞态）');
})();

/* ============================================================
 * §13 ★ MP4 身份随行 + 存量扩展名自证（v3.4.0 第二轮 #2）
 * ------------------------------------------------------------
 * 缺陷形状（lead 从用户真机 settings.json 取证）：四个 surface 全被写成 bg='native' + image=null。
 *   「显式把 bg 写回 native」的代码位置全仓仅三处（已首尾核对）：applyNativeStyleAll :1211-1212
 *   （唯一一次改 4 个面，见 §13 末注释）、materializeFromCalendar、applySkinSet 的 field==='bg' 分支。
 *   本条固化的两条不变量：① 身份随行 —— 渲染层回写取景/透明度带 kind，主进程 normalizeImageSpec
 *   对**缺失** kind 的存量配置按 .mp4 扩展名自证 'video'（用户盘上 3 个 calendar_*.mp4 的历史值来源）；
 *   ② 只调取景/缩放/透明度**不得**把 bg 从 'image' 改掉、不得把 image 置 null。
 * 手法沿用 §2/§6：extractFn 抠真实函数，隔离作用域注入最小桩后执行；诊断日志以 log 桩捕获。
 * ============================================================ */
(function section13_VideoIdentitySurvival() {
  /* --- 13.A normalizeImageSpec：「显式优先 + 缺失才自证」分派 --- */
  var NDEPS = ['clamp01', 'clampZoom', 'clampImageOpacity', 'sanitizeBasename', 'normalizeImageSpec'];
  var norm = null;
  try {
    norm = new Function(NDEPS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n')
      + '\nreturn normalizeImageSpec;')();
  } catch (e) { ok(false, '§13 抽取 normalizeImageSpec 失败 — ' + e.message); }
  if (norm) {
    eq(norm({ file: 'calendar_1789185821147.mp4' }).kind, 'video',
      '§13★ 存量救回：无 kind 的 .mp4 → 推断为 video（否则 <img> 加载 .mp4 空白）');
    eq(norm({ file: 'photo.png' }).kind, 'image',
      '§13 反向：无 kind 的 .png → image（不误判为视频）');
    eq(norm({ file: 'clip.MP4' }).kind, 'video',
      '§13 扩展名大小写不敏感：.MP4 → video');
    eq(norm({ file: 'x.mp4', kind: 'image' }).kind, 'image',
      '§13 显式 kind 优先：显式 image 即便文件是 .mp4 也不被扩展名覆盖');
    eq(norm({ file: 'x.png', kind: 'video' }).kind, 'video',
      '§13 显式 kind 优先：显式 video 即便文件是 .png 也保留 video');
    eq(norm({ file: 'x.mp4', kind: 'VIDEO' }).kind, 'image',
      "§13 脏值不猜：kind:'VIDEO'（非法值）→ image（只对**缺失** kind 做扩展名推断）");
  }

  /* --- 13.B applySkinSet 端：身份随行 + bg 不变量 + 诊断日志 --- */
  var DEPS = ['clamp01', 'clampZoom', 'clampImageOpacity', 'sanitizeBasename',
    'normalizeImageSpec', 'normStyle', 'normShape', 'normBg', 'normTone',
    'normalizeClarity', 'normDockScale', 'applySkinSet'];
  var makeApi = null;
  try {
    var src = DEPS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
    /* log 作为注入桩传入 —— 既验证诊断日志真的会打（13.3），也还原真实主进程有顶层 log 的作用域。 */
    makeApi = new Function('skin', 'saveSettings', 'recomputeTheme', 'pushThemeToAll',
      'syncDockGeometry', 'pushSkinToAll', 'refreshTrayMenu', 'applyOpacity', 'log',
      src + '\nreturn { applySkinSet: applySkinSet };');
  } catch (e) { ok(false, '§13 抽取 applySkinSet 依赖失败 — ' + e.message); }

  function freshSkin() {
    return { surfaces: {
      calendar: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect' },
      expanded: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect', follow: 'calendar' },
      desktop: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect', follow: 'calendar' },
      dock: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect', follow: 'calendar' }
    } };
  }
  var logs = [];
  function mk(skin) {
    return makeApi(skin, function () {}, function () {}, function () {}, function () {},
      function () {}, function () {}, function () {}, function (m) { logs.push(String(m)); });
  }
  var videoSpec = { file: 'calendar_x.mp4', snapshot: null, w: 2560, h: 1440,
    crop: { x: 0, y: 0, w: 1, h: 1 }, zoom: 1, opacity: 1, dark: false, complexity: 0, kind: 'video' };

  if (makeApi) {
    /* 13.1 ★ 渲染层只回写 {file, opacity}（透明度滑杆）→ kind 仍 'video'、bg 仍 'image' */
    var s1 = freshSkin(); var a1 = mk(s1);
    a1.applySkinSet({ surface: 'calendar', field: 'image', value: videoSpec });
    a1.applySkinSet({ surface: 'calendar', field: 'image', value: { file: 'calendar_x.mp4', opacity: 0.5 } });
    eq(s1.surfaces.calendar.image && s1.surfaces.calendar.image.kind, 'video',
      "§13★ 只回写 {file,opacity} → kind 仍 'video'（透明度写入不回退身份）");
    eq(s1.surfaces.calendar.image && s1.surfaces.calendar.image.opacity, 0.5, '§13 透明度 0.5 已写入');
    eq(s1.surfaces.calendar.bg, 'image', "§13 透明度写入后 bg 仍 'image'");

    /* 13.2 ★ 渲染层只回写取景 {file, crop, zoom} → bg 不得回 native、image 不得 null、kind 保持 */
    var s2 = freshSkin(); var a2 = mk(s2);
    a2.applySkinSet({ surface: 'calendar', field: 'image', value: videoSpec });
    a2.applySkinSet({ surface: 'calendar', field: 'image',
      value: { file: 'calendar_x.mp4', crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, zoom: 2 } });
    eq(s2.surfaces.calendar.bg, 'image', '§13★ 取景回写后 bg 仍为 image（不得被写回 native）');
    ok(s2.surfaces.calendar.image !== null, '§13★ 取景回写后 image 未被置 null');
    eq(s2.surfaces.calendar.image && s2.surfaces.calendar.image.kind, 'video', '§13 取景回写后 kind 仍 video');
    eq(s2.surfaces.calendar.image && s2.surfaces.calendar.image.zoom, 2, '§13 zoom 已写入 2');

    /* 13.3 诊断日志：对 image/bg/style 写入必须打 'skin:' 前缀行；其它字段不打 */
    logs.length = 0;
    var s3 = freshSkin(); var a3 = mk(s3);
    a3.applySkinSet({ surface: 'calendar', field: 'image', value: videoSpec });
    a3.applySkinSet({ surface: 'calendar', field: 'style', value: 'glass' });
    a3.applySkinSet({ surface: 'calendar', field: 'clarity', value: 40 });
    ok(logs.some(function (m) { return /^skin: surface=calendar field=image/.test(m); }),
      '§13 applySkinSet 对 field=image 打诊断日志（skin: …）');
    ok(logs.some(function (m) { return /^skin: surface=calendar field=style/.test(m); }),
      '§13 applySkinSet 对 field=style 打诊断日志');
    ok(!logs.some(function (m) { return /field=clarity/.test(m); }),
      '§13 applySkinSet 对 field=clarity 不打诊断日志（只锁 image/bg/style）');
  }

  /* --- 13.4 源码锁：kind 在 setField() **唯一收口点**补齐；两处调用点保持原字面量 ---
   * 为什么锁「收口点」而不是「调用点各带」：图片回写有 3+ 调用点，逐个补必漏；收口等价于「凡 image 写入都自带 kind」。
   * 为什么必须同时锁「调用点仍是原字面量」：verify_v1721.js:831 用精确字面量钉死了透明度回写行 ——
   *   若调用点被改写会误伤既有闸门 #1；此处正向保护这条不变量（闸门 #1 保持 276/276）。 */
  var scInject = /field === 'image' && value && typeof value === 'object' && value\.kind === undefined/.test(SKINCUSTOM)
    && /value\.kind = cur\.kind/.test(SKINCUSTOM)
    && /function currentImage\(\)/.test(SKINCUSTOM);
  ok(scInject, '§13 skincustom.html setField() 在 kind 缺失时统一补 currentImage().kind（唯一收口点）');
  var scLiteral = /setField\(S\.surface, 'image', \{ file: img\.file, opacity: v \}\)/.test(SKINCUSTOM)
    && /setField\(S\.surface, 'image', \{ file: img\.file, crop: cropRect, zoom: zoom \}\)/.test(SKINCUSTOM);
  ok(scLiteral, "§13 取景/透明度两处调用点仍为**原字面量**（未逐个改写 ⇒ verify_v1721 不被误伤）");

  /* --- 13.5 记录「写回 bg=native」的确切代码位置（防回归：三处一个都不能悄悄改语义） ---
   * applyNativeStyleAll 是唯一会同时把 4 个面写成 bg='native'+image=null 的地方（用户 settings.json
   * 的四全 native 形状只能由它产生）；materializeFromCalendar 与 field==='bg' 只改单面。 */
  ok(/function applyNativeStyleAll\(/.test(codeOnly(MAIN))
    && /c\.bg = 'native';\s*\/\/[^\n]*四界面一律回原生背景来源/.test(MAIN)
    && /c\.image = null;\s*\/\/[^\n]*仅解除引用/.test(MAIN),
    "§13 bg 写回 native 的四界面唯一入口：applyNativeStyleAll（c.bg='native' + c.image=null）");
})();

/* ============================================================
 * §14 ★ 媒体层空白底衬 + skin:// Range（v3.4.0 第三轮）
 * ------------------------------------------------------------
 * 缺陷一（透明）：[data-skin="image"] #widget { background: transparent }，媒体失败 / 未就绪时整窗透明。
 *   修法：app.js 维护 documentElement.dataset.mediaBlank；template.html 加带属性门的底衬规则（var(--paper)）。
 *   硬要求：媒体正常时观感零变化 ⇒ :671 那条 transparent 规则**必须逐字保留**（14.2 正向锁）。
 * 缺陷二（不动）：skin:// 不转发 Range ⇒ 大 MP4（moov 在文件末尾）不可 seek ⇒ 循环回跳挂住。
 *   修法：skin:// handler 自实现 206（Content-Range + Accept-Ranges）；实测 net.fetch 转发仍是 200（见
 *   .tmp-diag/rangetest/probe.out.txt），故只能自实现。14.6 反向自测证明闸门真会红。
 * ============================================================ */
(function section14_MediaBlankAndRange() {
  /* --- 14.1 底衬规则存在且 background 不是 transparent --- */
  var blankRule = /html\[data-skin="image"\]\[data-media-blank="1"\]\s*#widget\s*\{([^}]*)\}/.exec(TPL);
  ok(!!blankRule && /background\s*:\s*var\(--paper\)/.test(blankRule[1]) && !/transparent/.test(blankRule[1]),
    '§14 底衬规则 html[data-skin="image"][data-media-blank="1"] #widget 存在且 background=var(--paper)（非 transparent）');

  /* --- 14.2 ★ :671 逐字保留（媒体正常时观感零变化是硬要求） --- */
  ok(TPL.indexOf('[data-skin="image"] #widget { background: transparent; }') >= 0,
    '§14★ [data-skin="image"] #widget { background: transparent; } 逐字保留（媒体正常时观感零变化）');

  /* --- 14.3 app.js 置 '1' 的三处 + 置 '0' 的两处 --- */
  ok(/dataset\.mediaBlank\s*=\s*blank\s*\?\s*'1'\s*:\s*'0'/.test(APP),
    "§14 app.js setMediaBlank 写 dataset.mediaBlank = blank ? '1' : '0'");
  var onerrorAt = APP.indexOf('vid.onerror');
  ok(onerrorAt >= 0 && /setMediaBlank\(true\)/.test(APP.slice(onerrorAt, onerrorAt + 240)),
    '§14 app.js 视频 onerror → setMediaBlank(true)（媒体空白）');
  ok(/readyState\s*<\s*2\)\s*setMediaBlank\(true\)/.test(APP),
    '§14 app.js 视频未 loadeddata（readyState<2）→ setMediaBlank(true)');
  ok(/vid\.onloadeddata\s*=\s*function\s*\(\)\s*\{\s*setMediaBlank\(false\)/.test(APP),
    '§14 app.js 视频 loadeddata → setMediaBlank(false)');
  ok(/!sz\s*\|\|\s*!sz\.w\s*\|\|\s*!sz\.h\)\s*\{\s*setMediaBlank\(true\)/.test(APP),
    '§14 app.js 图片探针失败 → setMediaBlank(true)');
  var probeAt = APP.indexOf('realImageSize(file, function');
  ok(probeAt >= 0 && /setMediaBlank\(false\)/.test(APP.slice(probeAt, probeAt + 600)),
    '§14 app.js 图片探针成功 → setMediaBlank(false)');

  /* --- 14.4 skin:// 自实现 206：206 / Content-Range / Accept-Ranges / Content-Type 齐备 --- */
  var mainCode = codeOnly(MAIN);
  ok(/function skinFileResponse/.test(mainCode) && /status:\s*206/.test(mainCode),
    '§14 skin:// 自实现 206（skinFileResponse 返回 status:206）');
  ok(/'Content-Range':\s*'bytes '\s*\+/.test(MAIN) && /'Accept-Ranges':\s*'bytes'/.test(MAIN),
    "§14 skin:// 206 响应带 Content-Range + Accept-Ranges: bytes");
  ok(/function skinMimeType/.test(mainCode) && /'Content-Type':\s*mime/.test(MAIN)
    && /video\/mp4/.test(MAIN) && /image\/jpeg/.test(MAIN),
    '§14 skin:// 带正确 Content-Type（mp4→video/mp4、jpeg→image/jpeg…）');
  ok(/bytes \*\//.test(MAIN), '§14 skin:// 越界 Range 返回 416（Content-Range: bytes */total）');

  /* --- 14.5 保留 404 + skinUrlToName 清洗（不得放松路径穿越防护） --- */
  ok(/skinUrlToName\(request && request\.url\)/.test(mainCode) && /status:\s*404/.test(mainCode),
    '§14 skin:// 仍走 skinUrlToName 清洗 + 未命中返回 404（路径穿越防护未放松）');

  /* --- 14.6 ★ 反向自测：删掉 Accept-Ranges 必须判红 --- */
  function hasRangeSupport(src) {
    return /'Accept-Ranges':\s*'bytes'/.test(src) && /status:\s*206/.test(src) && /'Content-Range':/.test(src);
  }
  var stripped = MAIN.replace(/'Accept-Ranges':\s*'bytes'/g, '');
  ok(hasRangeSupport(MAIN) && !hasRangeSupport(stripped),
    '§14★ 反向自测：删掉 Accept-Ranges 后扫描必须判红（证明闸门真会红、非恒真）');
})();

/* ================= 收尾 ================= */
console.log('\n===== qa-v340 独立对抗性验证（MP4 动图）=====');
if (fail) {
  console.error('  ✗ 失败 ' + fail + ' 项：');
  failures.forEach(function (m) { console.error('    - ' + m); });
  console.error('\n  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(1);
}
console.log('  ✓ 全部 ' + pass + ' 项断言通过');
console.log('PASS ' + pass + ' / FAIL 0');
console.log('[qa-v340] PASS');
process.exit(0);
