/* v3.3.0 浮窗样式 · 造型预览工装（第五版：加「窗口矩形 / 卡片盒 / 圆角缺口」三层覆盖层）
 * ==========================================================================
 * 为什么要有这一版（X1 / X2 连续两轮溜过预览的根因）：
 *   旧工装只画「卡片盒」（.wg 的 156×64 / 150×150 …），**没有「窗口矩形」与「圆角缺口」两个概念**。
 *   而真实浮窗是「窗口 > 卡片盒」（四周留 pad）＋「卡片盒的四个圆角是透明的」——
 *   于是「卡片轮廓 ↔ 窗口矩形之间的那圈 pad」和「圆角缺口」这两片区域**在旧预览里根本不存在**，
 *   任何落在那里的不透明绘制（例如越界的 box-shadow 外投影、窗口/body 的底色）都只会**在真机上显形**。
 *   ⇒ 本版把这两片区域显式画出来，任何人改造型都能在预览里直接看见越界。
 *
 * 三层覆盖层（自上而下）：
 *   ① 窗口矩形（红虚线 + 淡红底）：winW×winH。这是**硬裁边界** —— 落在它外面的绘制会被裁掉。
 *   ② 卡片盒（蓝虚线）：winW−padL−padR × winH−padT−padB，位置 (padL, padT)。
 *      **必须按真实 pad 画，不能用等距假设** —— `rect` 的 padR/padB = 0（贴屏幕右沿/任务栏），
 *      `rainbow` Y1 起同样 padR/padB = 0（左上 24 为 inset 光晕的容纳区）；按等距画会把这两款画错。
 *   ③ 圆角缺口（红斜纹块）：卡片盒「方形角 − 四分之一圆」的四个角部区域。
 *      **这一层不能省**：它是「圆角外面是直角框」这种报障的真正指认对象。
 *
 * 成框判据（及它的盲区 —— 别再用它当唯一判据）：
 *   pad 缝 + 圆角缺口**同时**满足才会出现完整直角框。仅看 pad 会漏：
 *     `padL+padR>0 && padT+padB>0` 只说明「横竖各有缝」，不等于「四边都有缝」；
 *     正确的「完整 pad 环」判据是 **四边 pad 同时 > 0**。而 `rect`(2/2/0/0) / `rainbow`(24/24/0/0) 四边不同时为正 ⇒ 不成 pad 环。
 *     但真正的判决性证据是 **desktop 窗口 340×370 恰好等于 #widget 340×370（pad 全 0）时，
 *     四角照样露出底色** ⇒ 「窗口 == 卡片」时依然会出直角框，**pad 判据对它天然失效**。
 *     ⇒ 所以第 ③ 层（圆角缺口）才是这一类报障的通用指认层，pad 判据只是它的一个特例。
 *
 * 角部缺口面积（写进产物，供核对）：
 *   单角 = R²·(1 − π/4) ≈ 0.214602·R²；四角合计 = 4·R²·(1 − π/4)。
 *   R 取该造型的 `--dock-radius`（`ring` 是 50% ⇒ R = cardW/2；`flip`/`toon` 是 0 ⇒ 无缺口）。
 *   `rect` 的 R = `--r-md` = 10px ⇒ 单角 ≈ 21.46 px²、四角 ≈ 85.84 px²。
 *
 * 单一真源（本工装刻意遵守）：
 *   造型取值（尤其 `--dock-shadow`）**只允许一个真源 = `dock.html` 的 `DOCK_SHAPE_VARS`**；
 *   本工装不再各自硬编码一遍，而是①把值集中在本文件的 `DOCK_SHADOW` 里插值进 CSS，
 *   ②生成时**回读 dock.html / electron-main.js**，逐值核对并把**真源行号**写进产物；
 *   ③任何不一致 ⇒ 产物顶部红条 + stdout 告警（口径漂移必须可见，不得静默）。
 *
 * 开关注册：右上角「窗口层 / 仅卡片层」可切换，**默认 = 窗口层（三层全开）**。
 *   - `窗口层`：窗口矩形 + 卡片盒 + 圆角缺口（默认）
 *   - `仅卡片层`：隐藏窗口矩形，只留卡片盒 + 圆角缺口（用来区分「卡片自身几何」与「窗口边界」）
 *
 * 出图管线（--headless=new 下 --window-size 是精确的，实测 400×300→400×300、×dsf2→800×600）：
 *   node shape-preview-workbench.js                 # 生成预览页 + 六张分款出图页，并打印命令
 *   然后对每个分款页执行（本脚本在 Edge 可用时会自动执行）：
 *     msedge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
 *            --window-size=<W>,<H> --screenshot=<OUT>.png <file-url>
 *   即 PNG 尺寸 = 2×CSS 画布。
 * ========================================================================== */

'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var T = 'C:/Users/byab/AppData/Local/Temp/';
var REPO = path.resolve(__dirname, '..', '..', '..');   /* deliverables/design/v3.3.0-shape-spec → 仓库根 */
var OUTDIR = __dirname;                                  /* 新图与工装同目录；既有 PNG 一律不动 */
var DSF = 2;                                             /* 出图倍率：PNG = 2×CSS 画布 */

/* ---------- 3×5 点阵字模 ---------- */
var PF = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  ':': ['0', '1', '0', '1', '0']
};
var PX_CELL = 3.2, PX_GAP = 1.3;

function pixGlyph(ch) {
  var rows = PF[ch] || PF['0'];
  var cols = rows[0].length;
  var cells = '';
  for (var r = 0; r < rows.length; r++) {
    for (var c = 0; c < cols; c++) {
      cells += '<i class="' + (rows[r].charAt(c) === '1' ? 'on' : 'off') + '"></i>';
    }
  }
  return '<span class="g" style="grid-template-columns:repeat(' + cols + ',' + PX_CELL + 'px)">' + cells + '</span>';
}
function pixText(str) { return str.split('').map(pixGlyph).join(''); }

/* ---------- 绘本台钟的盘面 ---------- */
var NUMR = 36;
function pbNumerals() {
  return [[50, 7, '12'], [88, 50, '3'], [50, 88, '6'], [12, 50, '9']].map(function (n) {
    return '<span class="num" style="left:' + n[0] + '%;top:' + n[1] + '%">' + n[2] + '</span>';
  }).join('');
}
function pbDots() {
  var out = '';
  for (var i = 0; i < 12; i++) {
    if (i % 3 === 0) continue;
    var a = i * 30 * Math.PI / 180;
    out += '<i class="dot" style="left:' + (50 + NUMR * Math.sin(a)).toFixed(2) + '%;top:' +
      (50 - NUMR * Math.cos(a)).toFixed(2) + '%"></i>';
  }
  return out;
}

/* ==========================================================================
 * 造型注册表 —— 单一真源在 dock.html / electron-main.js，本表是**镜像**
 *   win.w/win.h : 窗口尺寸（DIP/基准 px）。rect 的 win.h 在注册表里是 0，
 *                 真身 =「任务栏高 clamp 40~56」，此处取 50 作代表值并在产物里注明。
 *   pad         : [L,T,R,B]，**逐边**，不许按等距简化。
 *   r           : 卡片盒圆角半径（px）。ring 的 --dock-radius 是 50% ⇒ 取 cardW/2。
 * ========================================================================== */
var ROWS = [
  { k: 'px', no: '①', nm: '像素方屏', sk: 'pixel', sz: '156×64',
    win: { w: 180, h: 88 }, pad: [12, 12, 12, 12], r: 14,
    ds: '珍珠白机身 + 黑屏<br>3×5 真点阵块拼蓝光数字 <b>（已放宽）</b>' },
  { k: 'rb', no: '②', nm: '虹彩流光', sk: 'rainbow', sz: '116×44',
    win: { w: 140, h: 68 }, pad: [24, 24, 0, 0], r: 13,
    ds: '一层近乎透明的玻璃薄片<br>只留彩虹渐变内容，无实边框' },
  { k: 'cr', no: '③', nm: '极简圆环', sk: 'ring', sz: '150×150',
    win: { w: 174, h: 174 }, pad: [12, 12, 12, 12], r: 75,
    ds: '磨砂玻璃圆盘 + 圆环进度<br>环随秒走满一圈' },
  { k: 'fl', no: '④', nm: '翻页时牌', sk: 'flip', sz: '196×104',
    win: { w: 220, h: 128 }, pad: [12, 12, 12, 12], r: 0,
    ds: '三块深色翻牌 时/分/秒<br>上排日期星期 <b>（24 小时制）</b>' },
  { k: 'pb', no: '⑤', nm: '绘本台钟', sk: 'toon', sz: '158×174',
    win: { w: 182, h: 198 }, pad: [12, 12, 12, 12], r: 0,
    ds: '简笔画 / 儿童绘本：粗暖墨线 + 蜡笔平涂<br>数字只留 12·3·6·9，其余整点画小圆点' },
  { k: 'cd', no: '⑥', nm: '圆角卡片', sk: 'rect', sz: '116×50 · 现行对照',
    win: { w: 116, h: 50 }, pad: [2, 2, 0, 0], r: 10, rectTaskbarH: true,
    ds: '保持现状，完全跟随皮肤<br>（原生六风格 / 自选纯色 / 自选图片）<br>' +
        '<b>padR/padB = 0</b> ⇒ 卡片贴死窗口右下沿（<b>rainbow</b> Y1 起同此特征；其余四款四边 12）' }
];
var byKey = {};
ROWS.forEach(function (r) {
  r.cardW = r.win.w - r.pad[0] - r.pad[2];
  r.cardH = r.win.h - r.pad[1] - r.pad[3];
  byKey[r.k] = r;
});

/* ==========================================================================
 * 造型取值（镜像 dock.html 的 DOCK_SHAPE_VARS）—— 集中一处，不再散布在 CSS 字符串里
 *   生成时会回读 dock.html 核对，不一致即在产物顶部报警。
 * ========================================================================== */
var DOCK_SHADOW = {
  pixel: '0 3px 8px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.85)',
  rainbow: 'inset 0 0 0 1px rgba(255,255,255,.16),inset 0 1px 0 rgba(255,255,255,.26)',
  ring: 'inset 0 1px 0 rgba(255,255,255,.42),inset 0 0 0 1px rgba(255,255,255,.20)',
  flip: 'none',
  toon: 'none',
  rect: null   /* rect 走主题默认外投影，不是造型常量 */
};

/* ---------- 真源回读：行号暴露 + 口径漂移自检 ---------- */
function readSrc(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function lineAt(src, idx) { return src.slice(0, idx).split('\n').length; }
function lineOf(src, needle) {
  if (!src || !needle) return null;
  var i = src.indexOf(needle);
  return i < 0 ? null : lineAt(src, i);
}
var DOCK_SRC = readSrc(path.join(REPO, 'dock.html'));
var MAIN_SRC = readSrc(path.join(REPO, 'electron-main.js'));
var DRIFT = [];

ROWS.forEach(function (r) {
  /* ① 阴影取值必须能在 dock.html 里原样找到（X2 之后 ring/pixel 都改过值，最容易漂的就是它） */
  var v = DOCK_SHADOW[r.sk];
  r.srcShadowLine = null;
  if (v) {
    r.srcShadowLine = lineOf(DOCK_SRC, "'" + v + "'");
    if (!r.srcShadowLine) DRIFT.push(r.nm + '：本工装的 --dock-shadow 在 dock.html 里找不到 → 取值已漂移');
  }
  /* ② 窗口/内边距必须与 electron-main.js 的 DOCK_SHAPES 一致 */
  r.srcRegLine = lineOf(MAIN_SRC, "name: '" + r.nm + "'");
  if (!r.srcRegLine) { DRIFT.push(r.nm + '：在 electron-main.js 的 DOCK_SHAPES 里找不到注册行'); return; }
  var ls = MAIN_SRC.lastIndexOf('\n', MAIN_SRC.indexOf("name: '" + r.nm + "'")) + 1;
  var le = MAIN_SRC.indexOf('\n', ls); if (le < 0) le = MAIN_SRC.length;
  var rowTxt = MAIN_SRC.slice(ls, le);
  function num(re) { var m = re.exec(rowTxt); return m ? parseInt(m[1], 10) : null; }
  var wW = num(/winW:\s*(\d+)/), wH = num(/winH:\s*(\d+)/);
  var pL = num(/padL:\s*(\d+)/), pT = num(/padT:\s*(\d+)/), pR = num(/padR:\s*(\d+)/), pB = num(/padB:\s*(\d+)/);
  if (wW !== r.win.w) DRIFT.push(r.nm + '：winW 工装 ' + r.win.w + ' ≠ 注册表 ' + wW);
  if (!r.rectTaskbarH && wH !== r.win.h) DRIFT.push(r.nm + '：winH 工装 ' + r.win.h + ' ≠ 注册表 ' + wH);
  if (pL !== r.pad[0] || pT !== r.pad[1] || pR !== r.pad[2] || pB !== r.pad[3]) {
    DRIFT.push(r.nm + '：pad 工装 [' + r.pad.join(',') + '] ≠ 注册表 [' + [pL, pT, pR, pB].join(',') + ']');
  }
  /* ③ 几何自洽：卡片盒必须等于 窗口 − 四边 pad */
  if (r.cardW !== r.win.w - r.pad[0] - r.pad[2] || r.cardH !== r.win.h - r.pad[1] - r.pad[3]) {
    DRIFT.push(r.nm + '：卡片盒与 窗口−pad 不自洽');
  }
});

/* ---------- 角部缺口面积 ---------- */
var NOTCH_K = 1 - Math.PI / 4;                        /* ≈ 0.21460184，方角减四分之一圆 */
function notchPer(r) { return r.r * r.r * NOTCH_K; }
function notchTotal(r) { return 4 * notchPer(r); }
function f2(x) { return Math.round(x * 100) / 100; }

/* ---------- 覆盖层 SVG：四角缺口（方形角 − 四分之一圆） ---------- */
function notchSvg(r) {
  if (!r.r || r.r <= 0) return '';
  var W = r.cardW, H = r.cardH, R = r.r;
  var d = 'M0,0 H' + W + ' V' + H + ' H0 Z ' +
    'M' + R + ',0 H' + (W - R) + ' A' + R + ',' + R + ' 0 0 1 ' + W + ',' + R +
    ' V' + (H - R) + ' A' + R + ',' + R + ' 0 0 1 ' + (W - R) + ',' + H +
    ' H' + R + ' A' + R + ',' + R + ' 0 0 1 0,' + (H - R) +
    ' V' + R + ' A' + R + ',' + R + ' 0 0 1 ' + R + ',0 Z';
  return '<svg class="ovl-notch" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
    '<path d="' + d + '" fill="rgba(255,60,60,.30)" fill-rule="evenodd"' +
    ' stroke="rgba(255,60,60,.92)" stroke-width="1"/></svg>';
}

/* ---------- 造卡片本体 ---------- */
function ringSvg() {
  return '<svg viewBox="0 0 150 150">' +
    '<circle cx="75" cy="75" r="69" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="3"/>' +
    '<circle cx="75" cy="75" r="69" fill="none" stroke="rgba(255,255,255,.92)" stroke-width="5"' +
    ' stroke-linecap="round" stroke-dasharray="376 58" transform="rotate(-90 75 75)"/></svg>';
}
var widgets = {
  cd: function (theme) {
    return '<div class="wg cd ' + (theme === 'dark' ? 'd' : 'l') + '">' +
      '<div class="t">20:26:19</div><div class="d">周五 09/11</div></div>';
  },
  px: function () {
    return '<div class="wg px"><div class="scr"><div class="tm">' + pixText('20:26:19') + '</div>' +
      '<div class="dtxt">周五 09/11</div></div></div>';
  },
  rb: function () {
    return '<div class="wg rb"><div class="t halo">20:26:19</div><div class="d halo">周五 09/11</div></div>';
  },
  cr: function () {
    return '<div class="wg cr">' + ringSvg() + '<div class="in">' +
      '<div class="date">2026/09/11</div><div class="time">20:26</div><div class="week">周五</div></div></div>';
  },
  fl: function () {
    return '<div class="wg fl"><div class="hdr halo">2026.09.11<i>周五</i></div><div class="tiles">' +
      '<div class="tile"><span class="dg">20</span></div>' +
      '<div class="tile"><span class="dg">26</span></div>' +
      '<div class="tile"><span class="dg">19</span></div></div></div>';
  },
  pb: function () {
    return '<div class="wg pb"><div class="gnd"></div><div class="shine"><i></i><i></i><i></i></div>' +
      '<div class="body"><div class="face">' + pbNumerals() + pbDots() +
      '<div class="hand h-hour" style="transform:rotate(253deg)"></div>' +
      '<div class="hand h-min" style="transform:rotate(156deg)"></div>' +
      '<div class="hand h-sec" style="transform:rotate(114deg)"></div>' +
      '<div class="cap"></div></div></div>' +
      '<div class="feet"><i></i><i></i></div></div>';
  }
};

/* ---------- 覆盖层外壳 ---------- */
function overlay(r, inner, opts) {
  opts = opts || {};
  var st = '--w:' + r.win.w + 'px;--h:' + r.win.h + 'px;--pl:' + r.pad[0] + 'px;--pt:' + r.pad[1] + 'px;' +
    '--pw:' + r.cardW + 'px;--ph:' + r.cardH + 'px';
  return '<div class="ovl" style="' + st + '">' +
    '<div class="ovl-win' + (opts.coincide ? ' coincide' : '') + '"></div>' +
    notchSvg(r) + inner + '<div class="ovl-card"></div>' +
    '<div class="ovl-tag">窗口 ' + r.win.w + '×' + r.win.h + ' · 卡片盒 ' + r.cardW + '×' + r.cardH +
    ' · pad ' + r.pad.join('/') + '</div></div>';
}

/* ---------- CSS ---------- */
var CSS = [
  '*{box-sizing:border-box;margin:0;padding:0;}',
  'body{font-family:"Microsoft YaHei","Segoe UI",sans-serif;background:#f4f6fa;color:#1b2230;padding:20px 22px 26px;}',
  'h1{font-size:17px;font-weight:700;letter-spacing:.3px;}',
  '.sub{font-size:12px;color:#6b7488;margin:5px 0 14px;line-height:1.6;}',
  '.drift{background:#ffe9e9;border:1px solid #e58b8b;color:#8a1f1f;border-radius:8px;padding:8px 11px;',
  '  font-size:11.5px;line-height:1.7;margin:0 0 14px;}',
  '.legend{background:#fff;border:1px solid #e2e6ee;border-radius:10px;padding:10px 13px;margin:0 0 6px;',
  '  font-size:11px;color:#4b5563;line-height:1.85;}',
  '.legend b{color:#1b2230;}',
  '.legend .k{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:5px;}',
  '.legend .k.win{border:1px dashed #ff5a5a;background:rgba(255,90,90,.10);}',
  '.legend .k.card{border:1px dashed #4a86ff;}',
  '.legend .k.notch{background:rgba(255,60,60,.30);border:1px solid rgba(255,60,60,.92);}',
  '.toggle{font-size:11.5px;color:#3a4254;margin:8px 0 2px;}',
  '.toggle label{margin-right:14px;cursor:pointer;}',
  '.row{display:flex;align-items:flex-start;gap:16px;padding:14px 0;border-top:1px solid #e2e6ee;}',
  '.meta{width:186px;flex:0 0 186px;padding-top:6px;}',
  '.nm{font-size:14px;font-weight:700;color:#141a26;}',
  '.no{display:inline-block;width:19px;height:19px;line-height:19px;text-align:center;border-radius:6px;',
  '    background:#2f3a4d;color:#fff;font-size:11px;margin-right:6px;vertical-align:1px;}',
  '.sz{font-size:10px;color:#8792a6;margin:6px 0;font-family:Consolas,monospace;}',
  '.ds{font-size:11px;color:#5d6779;line-height:1.65;}',
  '.geo{font-size:10px;color:#5d6779;margin-top:7px;line-height:1.7;font-family:Consolas,monospace;}',
  '.geo .src{color:#2f6fb0;}',
  '.geo .warn{color:#a33;font-weight:700;}',
  '.stage{width:320px;height:272px;flex:0 0 320px;border-radius:12px;position:relative;',
  '       display:flex;align-items:center;justify-content:center;overflow:visible;',
  '       box-shadow:inset 0 0 0 1px rgba(20,30,50,.10);}',
  '.stage>.cap{position:absolute;left:9px;bottom:7px;font-size:9.5px;letter-spacing:.4px;color:rgba(255,255,255,.62);z-index:9;}',
  '.stage.light{background:radial-gradient(62% 56% at 18% 20%,#ffd9a8,transparent 60%),',
  '  radial-gradient(56% 52% at 84% 28%,#a9c9ff,transparent 62%),',
  '  radial-gradient(72% 62% at 58% 92%,#dcbcff,transparent 66%),linear-gradient(160deg,#f6f8fc,#e4eaf4);}',
  '.stage.light>.cap{color:rgba(30,40,60,.45);}',
  '.stage.dark{background:radial-gradient(62% 56% at 20% 24%,#2b4c72,transparent 62%),',
  '  radial-gradient(56% 52% at 80% 30%,#4d2b62,transparent 62%),',
  '  radial-gradient(72% 62% at 54% 92%,#123149,transparent 66%),linear-gradient(160deg,#1b2432,#0c1118);}',
  '.halo{filter:drop-shadow(1px 0 0 rgba(0,0,0,.5)) drop-shadow(-1px 0 0 rgba(0,0,0,.5))',
  '  drop-shadow(0 1px 0 rgba(0,0,0,.5)) drop-shadow(0 -1px 0 rgba(0,0,0,.5))',
  '  drop-shadow(0 2px 5px rgba(0,0,0,.45));}',

  '/* ===== 覆盖层三层 ===== */',
  '.ovl{position:relative;z-index:0;display:flex;align-items:center;justify-content:center;}',
  '.ovl-win{position:absolute;z-index:1;pointer-events:none;left:calc(-1 * var(--pl));top:calc(-1 * var(--pt));',
  '  width:var(--w);height:var(--h);border:1px dashed rgba(255,90,90,.95);background:rgba(255,90,90,.055);}',
  '.ovl-win.coincide{border-style:solid;border-width:2px;border-color:rgba(255,60,60,.95);background:transparent;}',
  '.ovl-card{position:absolute;z-index:4;pointer-events:none;left:0;top:0;',
  '  width:var(--pw);height:var(--ph);border:1px dashed rgba(74,134,255,.95);}',
  '.ovl-notch{position:absolute;z-index:3;left:0;top:0;pointer-events:none;}',
  '.ovl-tag{position:absolute;z-index:6;left:calc(-1 * var(--pl));top:calc(100% + 7px);width:var(--w);',
  '  text-align:center;white-space:normal;font:600 10px/1.5 Consolas,monospace;color:#5d6779;}',
  '.stage.dark .ovl-tag{color:rgba(255,255,255,.72);}',
  'html[data-ovl="card"] .ovl-win{display:none;}',

  '/* ---------- ⑥ 圆角矩形（现行对照） ---------- */',
  '.wg.cd{width:114px;height:48px;border-radius:' + ROWS[5].r + 'px;display:flex;flex-direction:column;',
  '  align-items:center;justify-content:center;gap:2px;border:1px solid;box-shadow:0 2px 8px rgba(0,0,0,.22);}',
  '.wg.cd.l{background:rgba(252,251,249,.97);border-color:rgba(31,35,48,.12);color:#1f2430;}',
  '.wg.cd.d{background:rgba(28,32,44,.95);border-color:rgba(255,255,255,.09);color:#e8eaf0;}',
  '.wg.cd .t{font-size:17px;font-weight:700;line-height:1;letter-spacing:.3px;}',
  '.wg.cd .d{font-size:10px;font-weight:600;line-height:1;opacity:.66;letter-spacing:.4px;}',

  '/* ---------- ① 像素方屏 156×64 ---------- */',
  '.wg.px{width:156px;height:64px;border-radius:' + ROWS[0].r + 'px;padding:5px;',
  '  background:linear-gradient(158deg,#f7f8fb,#c9d1de 55%,#eaedf4);',
  '  box-shadow:' + DOCK_SHADOW.pixel + ';}',
  '.wg.px .scr{position:relative;width:100%;height:100%;border-radius:10px;overflow:hidden;',
  '  background:radial-gradient(120% 130% at 50% 0%,#0a121b,#04070b 72%);',
  '  box-shadow:inset 0 0 0 1px rgba(0,0,0,.9),inset 0 0 15px rgba(0,150,255,.14);',
  '  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;}',
  '.wg.px .tm{display:flex;gap:4.5px;align-items:center;}',
  '.wg.px .g{display:grid;grid-auto-rows:' + PX_CELL + 'px;gap:' + PX_GAP + 'px;}',
  '.wg.px .g i{display:block;border-radius:1px;}',
  '.wg.px .g i.on{background:#b3ecff;box-shadow:0 0 2px rgba(120,215,255,.85);}',
  '.wg.px .g i.off{background:rgba(120,190,255,.045);}',
  '.wg.px .dtxt{font-family:Consolas,monospace;font-size:8.5px;font-weight:700;letter-spacing:1.6px;',
  '  color:#4fb6e6;text-shadow:0 0 5px rgba(90,200,255,.65);}',

  '/* ---------- ② 虹彩流光 116×44 ---------- */',
  '.wg.rb{width:116px;height:44px;border-radius:' + ROWS[1].r + 'px;display:flex;flex-direction:column;',
  '  align-items:center;justify-content:center;gap:5px;',
  '  background:linear-gradient(150deg,rgba(255,255,255,.10),rgba(255,255,255,.03));',
  '  -webkit-backdrop-filter:blur(9px) saturate(1.3);backdrop-filter:blur(9px) saturate(1.3);',
  '  box-shadow:' + DOCK_SHADOW.rainbow + ';}',
  '.wg.rb .t{font-size:21px;font-weight:800;line-height:1;letter-spacing:.4px;',
  '  background-image:linear-gradient(100deg,#ff4f7d,#ffa63d 22%,#4fe08f 44%,#38bdf8 64%,#a855f7 84%,#ff4f7d);',
  '  -webkit-background-clip:text;background-clip:text;color:transparent;}',
  '.wg.rb .d{font-size:9.5px;font-weight:700;line-height:1;letter-spacing:.9px;',
  '  background-image:linear-gradient(100deg,#ff9db8,#ffd79a 30%,#a9f0c6 55%,#a5dcf9 75%,#d3a8e0);',
  '  -webkit-background-clip:text;background-clip:text;color:transparent;}',

  '/* ---------- ③ 极简圆环 150×150 ---------- */',
  '.wg.cr{width:150px;height:150px;border-radius:50%;position:relative;',
  '  display:flex;align-items:center;justify-content:center;',
  '  background:radial-gradient(circle at 36% 26%,rgba(255,255,255,.30),rgba(255,255,255,.07) 58%,rgba(255,255,255,.03));',
  '  -webkit-backdrop-filter:blur(15px) saturate(1.5);backdrop-filter:blur(15px) saturate(1.5);',
  '  box-shadow:' + DOCK_SHADOW.ring + ';}',
  '.wg.cr svg{position:absolute;inset:0;width:150px;height:150px;}',
  '.wg.cr .in{position:relative;z-index:2;text-align:center;',
  '  text-shadow:0 1px 4px rgba(0,0,0,.55),0 0 14px rgba(0,0,0,.3);}',
  '.wg.cr .date{font-size:11px;font-weight:600;color:rgba(255,255,255,.94);letter-spacing:.6px;}',
  '.wg.cr .time{font-size:34px;font-weight:700;color:#fff;line-height:1;margin:7px 0 6px;letter-spacing:.5px;',
  '  font-variant-numeric:tabular-nums;}',
  '.wg.cr .week{font-size:11.5px;font-weight:600;color:rgba(255,255,255,.9);letter-spacing:1.6px;}',

  '/* ---------- ④ 翻页时牌 196×104 ---------- */',
  '.wg.fl{width:196px;height:104px;display:flex;flex-direction:column;align-items:center;gap:9px;background:transparent;}',
  '.wg.fl .hdr{font-size:10.5px;font-weight:700;color:rgba(255,255,255,.96);letter-spacing:1.1px;}',
  '.wg.fl .hdr i{font-style:normal;opacity:.66;margin-left:6px;letter-spacing:.6px;}',
  '.wg.fl .tiles{display:flex;gap:9px;}',
  '.wg.fl .tile{position:relative;width:58px;height:72px;border-radius:10px;overflow:hidden;',
  '  background:linear-gradient(180deg,#3b4046,#2c3035 49.6%,#24282c 50.4%,#1d2124);',
  '  box-shadow:0 3px 10px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.18);',
  '  display:flex;align-items:center;justify-content:center;}',
  '.wg.fl .tile::before{content:"";position:absolute;left:0;right:0;top:50%;height:1px;',
  '  background:rgba(255,255,255,.16);z-index:1;}',
  '.wg.fl .dg{position:relative;z-index:2;font-size:33px;font-weight:700;color:#fff;line-height:1;',
  '  letter-spacing:-.5px;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px rgba(0,0,0,.5);}',

  '/* ---------- ⑤ 绘本台钟 158×174 ---------- */',
  '.wg.pb{width:158px;height:174px;position:relative;',
  '  font-family:"Segoe Print","Comic Sans MS","Microsoft YaHei",sans-serif;}',
  '.wg.pb .gnd{position:absolute;left:50%;bottom:-2px;margin-left:-42px;width:84px;height:13px;',
  '  border-radius:50%;background:radial-gradient(closest-side,rgba(62,50,41,.26),rgba(62,50,41,0));}',
  '.wg.pb .body{position:absolute;left:6px;top:5px;width:146px;height:146px;',
  '  border:5px solid #3E3229;background:#FFF6E2;',
  '  border-radius:50% 49% 51% 50% / 49% 52% 48% 51%;}',
  '.wg.pb .body::before{content:"";position:absolute;inset:1px;border-radius:inherit;',
  '  background:#FFD07A;transform:translate(2px,2px);}',
  '.wg.pb .face{position:absolute;left:17px;top:16px;width:112px;height:112px;',
  '  border:4px solid #3E3229;background:#FFFDF4;',
  '  border-radius:50% 51% 49% 50% / 51% 49% 51% 49%;}',
  '.wg.pb .face::before{content:"";position:absolute;inset:2px;border-radius:inherit;',
  '  background:#FFEFD0;transform:translate(2px,2px);}',
  '.wg.pb .num{position:absolute;z-index:3;transform:translate(-50%,-50%);',
  '  font-family:inherit;font-size:17px;font-weight:700;color:#3E3229;line-height:1;}',
  '.wg.pb .dot{position:absolute;z-index:3;width:4px;height:4px;border-radius:50%;',
  '  background:#3E3229;transform:translate(-50%,-50%);}',
  '.wg.pb .hand{position:absolute;z-index:4;left:50%;bottom:50%;transform-origin:50% 100%;',
  '  border-radius:99px;background:#3E3229;}',
  '.wg.pb .h-hour{width:7px;height:20px;margin-left:-3.5px;}',
  '.wg.pb .h-min{width:5.5px;height:27px;margin-left:-2.75px;}',
  '.wg.pb .h-sec{width:2.5px;height:30px;margin-left:-1.25px;background:#FF7A6B;}',
  '.wg.pb .cap{position:absolute;z-index:5;left:50%;top:50%;width:11px;height:11px;',
  '  margin:-5.5px 0 0 -5.5px;border-radius:50%;background:#3E3229;}',
  '.wg.pb .feet{position:absolute;left:50%;bottom:0;margin-left:-31px;width:62px;height:19px;}',
  '.wg.pb .feet i{position:absolute;bottom:0;width:18px;height:19px;border:4px solid #3E3229;border-top:none;',
  '  border-radius:0 0 9px 9px;background:#9FDCC3;}',
  '.wg.pb .feet i:first-child{left:0;}',
  '.wg.pb .feet i:last-child{right:0;}',
  '.wg.pb .shine i{position:absolute;display:block;height:4px;border-radius:2px;background:#3E3229;',
  '  box-shadow:0 0 0 1px rgba(255,255,255,.85);}',
  '.wg.pb .shine i:nth-child(1){left:5px;top:22px;width:15px;transform:rotate(-8deg);}',
  '.wg.pb .shine i:nth-child(2){left:16px;top:8px;width:14px;transform:rotate(-46deg);}',
  '.wg.pb .shine i:nth-child(3){left:34px;top:2px;width:12px;transform:rotate(-78deg);}',

  '/* ---------- 出图页（固定画布，--window-size 与之逐像素对应） ---------- */',
  '.shot{width:100%;min-height:100%;}',
  '.shot .row:last-child{border-bottom:1px solid #e2e6ee;}',
  '.foot{font-size:11px;color:#4b5563;line-height:1.9;padding:12px 0 4px;}',
  '.foot code{font-family:Consolas,monospace;background:#eef1f6;border-radius:4px;padding:1px 4px;color:#243043;}'
].join('\n');

/* ---------- 文案块 ---------- */
var TOGGLE_TXT = '<div class="toggle"><b>覆盖层注册：</b>' +
  '<label><input type="radio" name="ovl" value="win" checked> 窗口层（窗口矩形 + 卡片盒 + 圆角缺口）</label>' +
  '<label><input type="radio" name="ovl" value="card"> 仅卡片层（隐藏窗口矩形）</label></div>';
var TOGGLE_JS = '<script>(function(){function a(){var r=document.querySelectorAll(\'input[name=ovl]\');' +
  'var v="win";for(var i=0;i<r.length;i++){if(r[i].checked)v=r[i].value;}' +
  'document.documentElement.setAttribute("data-ovl",v);}' +
  'var rs=document.querySelectorAll(\'input[name=ovl]\');' +
  'for(var i=0;i<rs.length;i++){rs[i].addEventListener("change",a);}a();})();<\/script>';

function legendHtml() {
  return '<div class="legend">' +
    '<b>三层覆盖层：</b>' +
    '<span class="k win"></span>① <b>窗口矩形</b> ' + 'winW×winH —— 硬裁边界，落在它外面的绘制会被裁掉；' +
    '<span class="k card"></span>② <b>卡片盒</b> = 窗口 − 四边 pad（<b>逐边</b>，不是等距）；' +
    '<span class="k notch"></span>③ <b>圆角缺口</b> = 方形角 − 四分之一圆，共 4 处。<br>' +
    '<b>③ 不能省：</b>「圆角外面是直角框」的报障就发生在这里 —— 且它<u>与 pad 是否 >0 无关</u>：' +
    '当窗口 == 卡片（pad 全 0）时缺口照样在（⑥ 图第三格里有一个真实对照）。' +
    '</div>';
}
function driftHtml() {
  if (!DRIFT.length) {
    return '<div class="legend" style="background:#eefaf0;border-color:#b7e0c0;color:#22603a;">' +
      '<b>口径自检通过：</b>本工装的窗口/内边距/阴影取值与 <code>electron-main.js</code>、' +
      '<code>dock.html</code> 逐值一致（真源行号见各行标注）。</div>';
  }
  return '<div class="drift"><b>⚠ 口径漂移（' + DRIFT.length + ' 项）—— 造型取值只允许一个真源：</b><br>' +
    DRIFT.join('<br>') + '</div>';
}

function geoHtml(r) {
  var np = notchPer(r), nt = notchTotal(r);
  var s = '<div class="geo">窗口 ' + r.win.w + '×' + r.win.h + ' · 卡片盒 ' + r.cardW + '×' + r.cardH +
    ' · pad ' + r.pad.join('/') + '<br>';
  s += 'R = ' + r.r + (r.sk === 'ring' ? '（50% → cardW/2）' : '') +
    (r.r > 0 ? ' ⇒ 缺口 单角 ' + f2(np) + ' px² / 四角 ' + f2(nt) + ' px²' : ' ⇒ 无缺口') + '<br>';
  s += '<span class="src">注册表 ← electron-main.js:' + (r.srcRegLine || '?') + '</span><br>';
  if (r.sk === 'rect') {
    s += '<span class="src">--dock-shadow = 主题默认（rect 无造型常量）</span>';
  } else {
    s += r.srcShadowLine
      ? '<span class="src">--dock-shadow ← dock.html:' + r.srcShadowLine + '</span>'
      : '<span class="warn">--dock-shadow 未在 dock.html 找到（见顶部漂移告警）</span>';
  }
  if (r.sk === 'rect') s += '<br>winH = 任务栏高 clamp 40~56（此处取 50）';
  return s + '</div>';
}

function rowHtml(r) {
  function stage(theme, label) {
    var w = (r.k === 'cd') ? widgets.cd(theme) : widgets[r.k]();
    return '<div class="stage ' + theme + '">' + overlay(r, w) +
      '<div class="cap">' + label + '</div></div>';
  }
  var extra = '';
  if (r.k === 'cd') {
    /* pad≡0 对照组：窗口 == 卡片时，圆角缺口依旧存在 —— 这是 pad 判据失效的判决性证据 */
    extra = '<div class="stage light">' +
      '<div class="ovl" style="--w:' + r.cardW + 'px;--h:' + r.cardH + 'px;--pl:0px;--pt:0px;--pw:' + r.cardW + 'px;--ph:' + r.cardH + 'px">' +
      '<div class="ovl-win coincide"></div>' + notchSvg(r) + widgets.cd('light') +
      '<div class="ovl-card"></div>' +
      '<div class="ovl-tag">窗口 == 卡片盒 ' + r.cardW + '×' + r.cardH + '（pad 全 0）</div></div>' +
      '<div class="cap">对照：pad≡0 —— 缺口照样在</div></div>';
  }
  return '<div class="row">' +
    '<div class="meta"><div class="nm"><span class="no">' + r.no + '</span>' + r.nm + '</div>' +
    '<div class="sz">' + r.sz + '</div><div class="ds">' + r.ds + '</div>' + geoHtml(r) + '</div>' +
    stage('light', '浅色壁纸') + stage('dark', '深色壁纸') + extra + '</div>';
}

var FOOT = '<div class="foot"><b>角部缺口面积</b> = 单角 R²·(1 − π/4) ≈ 0.214602·R² ；四角合计 = 4·R²·(1 − π/4)。' +
  'R 取该造型 <code>--dock-radius</code>；<code>ring</code> 是 50% ⇒ R = cardW/2；' +
  '<code>flip</code>/<code>toon</code> 是 0 ⇒ 无缺口；<code>rect</code> 的 R = <code>--r-md</code> = 10px ⇒ 四角 ≈ 85.84 px²。<br>' +
  '<b>成框判据（勿单独使用）</b>：完整 pad 环需<b>四边 pad 同时 &gt; 0</b>；' +
  '<code>padL+padR&gt;0 &amp;&amp; padT+padB&gt;0</code> 只说明横竖各有缝、<b>不等于</b>四边都有缝。' +
  '而 pad 判据的真正盲区是「窗口 == 卡片」—— 那时四边 pad 全 0，缺口却依然可见（见 ⑥ 对照格）。</div>';

var rows = ROWS.map(rowHtml).join('\n');

/* ---------- 主预览页 ---------- */
var html = '<!DOCTYPE html><html lang="zh-CN" data-ovl="win"><head><meta charset="UTF-8"><style>\n' + CSS +
  '\n</style></head><body>\n' +
  '<h1>浮窗样式 · 造型预览工装（第五版：三层覆盖层）</h1>\n' +
  '<div class="sub">全部按<b>真实像素尺寸</b>渲染，未做缩放。每款给「浅色壁纸 / 深色壁纸」两档，' +
  '并把<b>窗口矩形</b>、<b>卡片盒</b>、<b>圆角缺口</b>三层显式画出。</div>\n' +
  driftHtml() + legendHtml() + TOGGLE_TXT + '\n' + rows + '\n' + FOOT + '\n</body></html>\n';
fs.writeFileSync(T + 'wb-shapes5.html', html, 'utf8');

/* ---------- 六张分款出图页 ---------- */
var SHOT_W2 = 900, SHOT_W3 = 1234, SHOT_H = 560;
var shots = ROWS.map(function (r) {
  var w = (r.k === 'cd') ? SHOT_W3 : SHOT_W2;
  var page = '<!DOCTYPE html><html lang="zh-CN" data-ovl="win"><head><meta charset="UTF-8"><style>\n' +
    CSS + '\n' +
    /* 出图页覆盖：必须在主 CSS 之后，否则 body 的 20px padding 会把固定画布顶偏、截图尺寸对不上 */
    'html,body{margin:0;padding:0;background:#ff00ff;overflow:hidden;}' +
    '.shot{width:' + w + 'px;height:' + SHOT_H + 'px;background:#f4f6fa;padding:14px 16px;overflow:hidden;}' +
    '\n</style></head><body>\n' +
    '<div class="shot">' +
    '<div class="sub" style="margin:0 0 8px"><b>' + r.no + ' ' + r.nm + '</b> —— ' + r.sz +
    ' ｜ 三层覆盖层预览（窗口矩形 / 卡片盒 / 圆角缺口）</div>\n' +
    driftHtml() + legendHtml() + TOGGLE_TXT + rowHtml(r) + FOOT + '</div>\n' +
    TOGGLE_JS + '\n</body></html>\n';
  var f = T + 'wbshot-' + r.k + '.html';
  fs.writeFileSync(f, page, 'utf8');
  return { k: r.k, nm: r.nm, file: f, w: w, h: SHOT_H, png: path.join(OUTDIR, 'v3.3.0-覆盖层-' + r.no + r.nm + '.png') };
});

/* ---------- 出图（Edge 仍在则自动执行） ---------- */
var EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(function (p) {
    try { return fs.statSync(p).isFile(); } catch (e) { return false; }
  })[0];
var drawn = [];
if (EDGE) {
  shots.forEach(function (s) {
    try {
      cp.execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--user-data-dir=' + T + 'wbshot-prof', '--hide-scrollbars',
        '--force-device-scale-factor=' + DSF, '--window-size=' + s.w + ',' + s.h,
        '--screenshot=' + s.png, 'file:///' + s.file.replace(/\\/g, '/')],
        { stdio: 'ignore', timeout: 60000 });
      drawn.push(s);
    } catch (e) { /* 单张失败不影响其它 */ }
  });
}
drawn.forEach(function (s) { s.written = true; });

console.log('wrote ' + T + 'wb-shapes5.html');
shots.forEach(function (s) {
  console.log('shot ' + s.k + ' -> ' + (EDGE ? (s.written ? s.png : '(Edge 失败) ' + s.png) : '(未找到 Edge) ' + s.png));
});
if (DRIFT.length) { console.log('DRIFT ' + DRIFT.length + ':'); DRIFT.forEach(function (d) { console.log('  - ' + d); }); }
else { console.log('drift check: OK（与 dock.html / electron-main.js 逐值一致）'); }
