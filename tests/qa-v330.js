'use strict';
/* ============================================================
 * tests/qa-v330.js —— v3.3.0 独立对抗性验证（浮窗六造型 / 图片不继承 / 清空）
 * ------------------------------------------------------------
 * 覆盖契约 v3.3.0-增量设计.md §5 §A~§J：
 *   §A  normShape 白名单（非法 9 类 → 'rect'）
 *   §B  dockGeometry 六造型 (winW,winH,cardW,cardH,pad*) 与 C1 注册表一致；
 *       rect 的 winH 走任务栏 clamp（taskbarHeight 桩：40/48/56 + 上下越界）
 *   §C  materializeFromCalendar **不继承图片/背景来源**（R3 缺陷回归护栏，核心）
 *   §D  shape 写入：dock 非法 → 'rect'；calendar/expanded/desktop 恒 'rect'；followableFields 含 shape
 *   §E  resolvedSurfaceState(...).shape 存在；dock 跟随时 = 'rect'
 *   §F  dock.html：六 data-shape / 变量下沉 / 非 rect 清 style·skin / 负向无写死 vp
 *   §F2 dock.html 造型变量**取值**正确性（X2 回归护栏：外投影收进 pad 通用不变量、
 *       ring 零外投影、flip/toon 卡片盒不可见、十变量键集不多不少）
 *   §G  skin.html：第三入口 #entryShape + #shapeList + 6 行 + 六名 + skinSet('dock','shape')
 *   §H  skincustom.html：#btnClearImage + bg='native' 写入 + disabled 判据 + 空态两态文案
 *   §I  applyNativeStyleAll 语义未变（不写 shape）
 *   §J  六个造型名在 README.md / 使用说明.md 各 ≥1；用户可见文件「浮动插件」= 0
 *   §K  X1：原生皮肤下 Electron 的 body 透明（template.html 规则 + app.js 打 class +
 *       calendar.html 产物重建证据；负向：禁止裸 body.electron 弱特异性写法）
 *   §L  X4：浮窗等比缩放（normDockScale 真身判据矩阵 / skin.dockScale 默认 1 /
 *       applySkinSet 分支 / followableFields 不含 dockScale / pushDockSize 载荷基础值 /
 *       缩放由调用方施加而 dockGeometry 保持单参）
 *   §M  X4.7：落点记录的尺寸必须随缩放一起刷新（无条件不变量：syncDockGeometry 返回后
 *       dockBounds.width/height 恒等于当前 dockW/dockH，且与 dockWin 生死解耦；负向：
 *       dockBounds 为 null 时不得凭空造记录；dockBoundsByDisplay **既有键随同刷新**，
 *       但**绝不新增 / 清空 / 删除键**）
 *   §N  Y2：skincustom.html 取景区「当前造型不显示图片」回显对齐（#cropShapeWarn 初始
 *       display:none + CSS 暗色变体 + renderCrop 读 S.resolved[*].shape 且负向不得读
 *       skin.surfaces[*] + 判据 surface==='dock' && hasImg && effShape!=='rect' + 文案关键句；
 *       负向：不得成为第三份六造型名口径）
 *   §O  H4：electron-main.js choose-file 文件对话框挂父窗（BrowserWindow.fromWebContents(
 *       evt.sender)）且保留「无父窗退化不传」分支
 *
 * 编号唯一权威 = 本索引（与文档记忆不一致时以本文件为准）。
 *
 * 设计原则（与 tests/qa-v244.js / qa-v310.js / qa-v320.js 同源）：
 *   1) 只读源码，绝不修改任何产品文件；发现 bug 只回报 team-lead。
 *   2) 裸 Node，自建 ok()/eq()/near() 计数器，process.exit(fail?1:0)。
 *   3) extractFn 抠真实函数体、extractDecl 抠真实顶层声明，注入最小 mock 后执行——断言的是
 *      源码里那几行真实逻辑，而非在测试里复刻一份实现。
 *   4) 全程只读，不写盘、不启 Electron。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function readRoot(f) {
  try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
  catch (e) { return ''; }
}
const MAIN = readRoot('electron-main.js');
const DOCK = readRoot('dock.html');
const SKIN = readRoot('skin.html');
const SKINCUSTOM = readRoot('skincustom.html');

/* ================= 断言计数 ================= */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; failures.push(msg); } }
function eq(a, b, msg) {
  ok(a === b, msg + '  (期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + ')');
}
function near(a, b, eps, msg) {
  ok(Math.abs(a - b) <= eps, msg + '  (期望≈' + b + '，实际 ' + a + ')');
}
function countOcc(hay, needle) { return String(hay).split(needle).length - 1; }

/* ================= 注释剥离 ================= */
function codeOnly(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/* ================= extractFn：大括号配平抠真实函数体 ================= */
function extractFn(src, name) {
  const key = 'function ' + name + '(';
  const idx = src.indexOf(key);
  if (idx < 0) throw new Error('qa-v330: 源码未找到函数 ' + name);
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
  throw new Error('qa-v330: 配平失败 ' + name);
}

/* ================= extractDecl：抠真实顶层 var/let/const 声明（对象/数组字面量配平） =================
 * DOCK_SHAPES / DOCK_SHAPE_KEYS 是「数据」，不抽取就得在测试里复刻一份，那等于没测。 */
function extractDecl(src, name) {
  const opener = new RegExp('(?:var|let|const)\\s+' + name + '\\s*=');
  const m = opener.exec(src);
  if (!m) throw new Error('qa-v330: 源码未找到声明 ' + name);
  const idx = m.index;
  const afterEq = m.index + m[0].length;   // 非全局正则的 lastIndex 不更新，必须自算
  let open = null, close = null, start = -1;
  for (let j = afterEq; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') { start = j; open = '{'; close = '}'; break; }
    if (ch === '[') { start = j; open = '['; close = ']'; break; }
    if (ch === ';') return src.slice(idx, j + 1);   // 无括号的标量声明
  }
  if (start < 0) throw new Error('qa-v330: 声明 ' + name + ' 形态无法解析');
  let depth = 0, inStr = null, inBlock = false, inLine = false, esc = false;
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
    if (ch === open) { depth++; }
    else if (ch === close) {
      depth--;
      if (depth === 0) { let e = j + 1; if (src[e] === ';') e++; return src.slice(idx, e); }
    }
  }
  throw new Error('qa-v330: 声明 ' + name + ' 配平失败');
}

/* ============================================================
 * 契约冻结表（唯一真源：v3.3.0-增量设计.md §C1 / §C10）
 * ============================================================ */
const SHAPES = ['rect', 'pixel', 'rainbow', 'ring', 'flip', 'toon'];
const SHAPE_NAMES = {
  rect: '圆角卡片', pixel: '像素方屏', rainbow: '虹彩流光',
  ring: '极简圆环', flip: '翻页时牌', toon: '绘本台钟'
};
/* §C1 注册表逐项（rect 的 winH/cardH 由任务栏 clamp 决定，此处以 winH:0 占位）
 * Y1 变更：rainbow pad 由 12/12/12/12 → 24/24/0/0（贴屏幕右沿/任务栏）；cardW/H 不变
 *   （140−24−0=116 / 68−24−0=44，与 :317/:325 的减法断言相容）。 */
const REGISTRY = {
  rect:    { winW: 116, winH: 0,   padL: 2,  padT: 2,  padR: 0,  padB: 0,  cardW: 114 },
  pixel:   { winW: 180, winH: 88,  padL: 12, padT: 12, padR: 12, padB: 12, cardW: 156, cardH: 64 },
  rainbow: { winW: 140, winH: 68,  padL: 24, padT: 24, padR: 0,  padB: 0,  cardW: 116, cardH: 44 },
  ring:    { winW: 174, winH: 174, padL: 12, padT: 12, padR: 12, padB: 12, cardW: 150, cardH: 150 },
  flip:    { winW: 220, winH: 128, padL: 12, padT: 12, padR: 12, padB: 12, cardW: 196, cardH: 104 },
  toon:    { winW: 182, winH: 198, padL: 12, padT: 12, padR: 12, padB: 12, cardW: 158, cardH: 174 }
};

/* ============================================================
 * §A + §B 隔离执行台：DOCK_SHAPES / DOCK_SHAPE_KEYS / normShape / dockGeometry
 * ============================================================ */
let geoSrcBase = '';
try {
  geoSrcBase = [
    extractDecl(MAIN, 'DOCK_SHAPES'),
    extractDecl(MAIN, 'DOCK_SHAPE_KEYS'),
    extractFn(MAIN, 'normShape')
  ].join('\n\n');
} catch (e) {
  console.error('qa-v330: 抽取造型注册表/normShape 失败 — ' + e.message);
  console.error('（可能 W-B 的 electron-main.js 造型改动尚未落地）');
  process.exit(1);
}

let dockGeometrySrc = '';
try {
  dockGeometrySrc = extractFn(MAIN, 'dockGeometry');
} catch (e) {
  console.error('qa-v330: 抽取 dockGeometry 失败 — ' + e.message);
  process.exit(1);
}

/** 造一个含 normShape + dockGeometry 的隔离 api；taskbarH 为 taskbarHeight() 的桩返回值。 */
function makeGeo(taskbarH) {
  const body = [
    geoSrcBase,
    'var taskbarHeight = function () { return ' + taskbarH + '; };',
    dockGeometrySrc,
    'return { normShape: normShape, dockGeometry: dockGeometry, DOCK_SHAPES: DOCK_SHAPES, DOCK_SHAPE_KEYS: DOCK_SHAPE_KEYS };'
  ].join('\n');
  return new Function(body)();
}

/* ============================================================
 * §C + §D 隔离执行台：applySkinSet（孤立 eval，含 materializeFromCalendar）
 * ------------------------------------------------------------
 * v3.3.0：applySkinSet 新增 normShape() 跨函数调用 → FN 名单必须同步维护（§1.4）。
 * 另：契约 C5 要求 applySkinSet 末尾调用顶层 syncDockGeometry()，它依赖 dockWin/dockW…，
 * 不是本测试的被测对象 → 此处注入空桩（与 qa-v244 的 hooks 同性质）。
 * ============================================================ */
const SET_FNS = [
  'clamp01', 'clampZoom', 'clampImageOpacity', 'clampOpacity', 'sanitizeBasename',
  'normalizeClarity', 'normalizeImageSpec', 'normStyle', 'normBg', 'normTone', 'normShape',
  // v3.3.0 X4：normalizeSkinV3 / migrateSkinV2toV3 新增 normDockScale 调用
  //（与 normShape 同款内联白名单，只依赖 Math/Number，单独抽取即可自洽）。
  'normDockScale',
  'resolveSurfaceConfig', 'applySkinSet'
];
let SET_SRC = '';
try {
  SET_SRC = geoSrcBase + '\n\n' +
    SET_FNS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
} catch (e) {
  console.error('qa-v330: 抽取 applySkinSet 依赖失败 — ' + e.message);
  process.exit(1);
}
const makeSet = new Function('skinObj', 'hooks', [
  'var skin = skinObj;',
  'hooks = hooks || {};',
  'var recomputeTheme = hooks.recomputeTheme || function () {};',
  'var saveSettings = hooks.saveSettings || function () {};',
  'var pushThemeToAll = hooks.pushThemeToAll || function () {};',
  'var pushSkinToAll = hooks.pushSkinToAll || function () {};',
  'var pushSkinConfigState = hooks.pushSkinConfigState || function () {};',
  'var refreshTrayMenu = hooks.refreshTrayMenu || function () {};',
  'var applyOpacity = hooks.applyOpacity || function () {};',
  'var syncDockGeometry = hooks.syncDockGeometry || function () {};',
  SET_SRC,
  'return { applySkinSet: applySkinSet, resolveSurfaceConfig: resolveSurfaceConfig, normShape: normShape };'
].join('\n'));

function runSet(skinObj, payload) {
  const calls = { recompute: 0, save: 0, pushTheme: 0, pushSkin: 0, pushConfig: 0, tray: 0, opacity: 0, syncGeo: 0 };
  const hooks = {
    recomputeTheme: function () { calls.recompute++; },
    saveSettings: function () { calls.save++; },
    pushThemeToAll: function () { calls.pushTheme++; },
    pushSkinToAll: function () { calls.pushSkin++; },
    pushSkinConfigState: function () { calls.pushConfig++; },
    refreshTrayMenu: function () { calls.refreshTray++; },
    applyOpacity: function () { calls.opacity++; },
    syncDockGeometry: function () { calls.syncGeo++; }
  };
  const api = makeSet(skinObj, hooks);
  api.applySkinSet(payload);
  return { skin: skinObj, api: api, calls: calls };
}

/* ============================================================
 * 夹具
 * ============================================================ */
function face(over) {
  return Object.assign({
    style: 'default', bg: 'native', image: null,
    text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect'
  }, over || {});
}
function v3skin(over) {
  over = over || {};
  return {
    __v: 3,
    surfaces: {
      calendar: face(over.calendar),
      expanded: face(Object.assign({ follow: 'calendar' }, over.expanded)),
      desktop: face(Object.assign({ follow: 'calendar' }, over.desktop)),
      dock: face(Object.assign({ follow: null }, over.dock))
    },
    opacity: { calendar: 1, desktop: 1, dock: 1 }
  };
}
function imgSpec(over) {
  return Object.assign({
    file: 'cal.jpg', snapshot: null, w: 800, h: 600,
    crop: { x: 0, y: 0, w: 1, h: 1 }, zoom: 1, opacity: 1,
    dark: false, complexity: 0.5
  }, over || {});
}

/* ============================================================
 * §A  normShape 白名单（非法 9 类 → 'rect'）
 * ============================================================ */
(function () {
  const api = makeGeo(50);
  SHAPES.forEach(function (s) {
    eq(api.normShape(s), s, "§A normShape('" + s + "') 原样返回（白名单合法值）");
  });
  const BAD = [
    ['undefined', undefined], ['null', null], ["''", ''], ["'RECT'（大写）", 'RECT'],
    ["'Pixel'（混合大小写）", 'Pixel'], ['123', 123], ['0', 0], ['{}', {}], ['[]', []],
    ["'unknown'", 'unknown'], ['NaN', NaN], ['true', true], ["'rect '（尾空格）", 'rect ']
  ];
  BAD.forEach(function (p) {
    eq(api.normShape(p[1]), 'rect', '§A normShape(' + p[0] + ') → rect（非法回落）');
  });
  // 注册表与白名单同步：六键 + 顺序
  ok(Array.isArray(api.DOCK_SHAPE_KEYS) && api.DOCK_SHAPE_KEYS.length === 6,
    '§A DOCK_SHAPE_KEYS 恰好 6 个键');
  eq(api.DOCK_SHAPE_KEYS.join(','), SHAPES.join(','), '§A DOCK_SHAPE_KEYS 顺序 = rect,pixel,rainbow,ring,flip,toon');
  SHAPES.forEach(function (s) {
    ok(api.DOCK_SHAPES[s] && api.DOCK_SHAPES[s].name === SHAPE_NAMES[s],
      '§A DOCK_SHAPES.' + s + '.name = 「' + SHAPE_NAMES[s] + '」（C10 命名冻结）');
  });
})();

/* ============================================================
 * §B  dockGeometry 六造型逐项
 * ============================================================ */
(function () {
  const TB = 50;                       // 任务栏高度桩
  const api = makeGeo(TB);

  SHAPES.forEach(function (k) {
    const exp = REGISTRY[k];
    const g = api.dockGeometry(k);
    ok(g && typeof g === 'object', '§B dockGeometry(' + k + ') 返回对象');
    if (!g) return;
    eq(g.key, k, '§B ' + k + '.key = ' + k);
    eq(g.name, SHAPE_NAMES[k], '§B ' + k + '.name = 「' + SHAPE_NAMES[k] + '」');
    eq(g.winW, exp.winW, '§B ' + k + '.winW = ' + exp.winW);
    eq(g.padL, exp.padL, '§B ' + k + '.padL = ' + exp.padL);
    eq(g.padT, exp.padT, '§B ' + k + '.padT = ' + exp.padT);
    eq(g.padR, exp.padR, '§B ' + k + '.padR = ' + exp.padR);
    eq(g.padB, exp.padB, '§B ' + k + '.padB = ' + exp.padB);
    eq(g.cardW, exp.cardW, '§B ' + k + '.cardW = ' + exp.cardW + '（winW - padL - padR）');
    eq(g.cardW, g.winW - g.padL - g.padR, '§B ' + k + ' 两侧同一条减法：cardW = winW - padL - padR');
    if (k === 'rect') {
      eq(g.winH, TB, '§B rect.winH 走任务栏 clamp（taskbarHeight=50 → 50）');
      eq(g.cardH, TB - exp.padT - exp.padB, '§B rect.cardH = dockH - padT - padB = ' + (TB - exp.padT - exp.padB));
    } else {
      eq(g.winH, exp.winH, '§B ' + k + '.winH = ' + exp.winH + '（hMode:fixed）');
      eq(g.cardH, exp.cardH, '§B ' + k + '.cardH = ' + exp.cardH);
      eq(g.cardH, g.winH - g.padT - g.padB, '§B ' + k + ' 两侧同一条减法：cardH = winH - padT - padB');
    }
  });

  /* ---- rect 的 winH clamp 40~56（沿用 createDock 既有算法） ---- */
  [[40, 40], [48, 48], [56, 56], [30, 40], [70, 56], [0, 40]].forEach(function (p) {
    const g = makeGeo(p[0]).dockGeometry('rect');
    eq(g.winH, p[1], '§B rect.winH：taskbarHeight=' + p[0] + ' → clamp 到 ' + p[1]);
    eq(g.cardH, p[1] - 2, '§B rect.cardH：taskbarHeight=' + p[0] + ' → ' + (p[1] - 2));
  });

  /* ---- 非法 key 经 normShape 归一到 rect（组合语义） ---- */
  const api50 = makeGeo(50);
  ['bogus', 'unknown', undefined, null, {}].forEach(function (v, i) {
    const g = api50.dockGeometry(api50.normShape(v));
    eq(g.key, 'rect', '§B 非法 key[' + i + '] 经 normShape → rect 几何');
    eq(g.winW, 116, '§B 非法 key[' + i + '] → winW=116');
    eq(g.cardW, 114, '§B 非法 key[' + i + '] → cardW=114');
  });

  /* ---- 全部造型 card 为正数（尺寸不退化，防「窗口装不进」） ---- */
  SHAPES.forEach(function (k) {
    const g = api50.dockGeometry(k);
    ok(g.cardW > 0 && g.cardH > 0, '§B ' + k + ' 卡片宽高均为正（cardW=' + g.cardW + ', cardH=' + g.cardH + '）');
  });

  /* ---- dockGeometry 冻结为「单参数」契约（C1 增量设计 #344）----
   * 浮动窗口缩放只能在 dockGeometry 之外施加；以下两条守卫把这条不变量固化。
   * 注意：不要用 dockGeometry.length === 1 当守卫 —— 默认参数会让 length 仍为 1，恰好放过「第二参带默认值」这种绕法。 */
  ok(/function dockGeometry\(\s*[A-Za-z_$][\w$]*\s*\)/.test(MAIN),
    '§B dockGeometry 单参签名冻结（C1：#344）— 参数列表不得出现第二参/默认参');
  /* 遍历 DOCK_SHAPE_KEYS（makeGeo 已返回），不硬编码 key —— 将来新增造型自动纳入，免维护。 */
  const scaleLeak = api50.DOCK_SHAPE_KEYS.filter(function (k) {
    return JSON.stringify(api50.dockGeometry(k)) !== JSON.stringify(api50.dockGeometry(k, 1.5));
  });
  ok(scaleLeak.length === 0,
    '§B 全部 ' + api50.DOCK_SHAPE_KEYS.length + ' 款造型多传 scale 参数几何均不变（缩放必须在 dockGeometry 之外施加；覆盖默认参与 arguments 取参两种绕法' +
    (scaleLeak.length ? '；违反：' + scaleLeak.join(',') : '') + '）');
})();

/* ============================================================
 * §C  materializeFromCalendar 不继承图片/背景来源（R3 回归护栏，核心）
 * ============================================================ */
(function () {
  /* C-1：关跟随（field='follow', value=null） */
  const sk = v3skin({
    calendar: { style: 'glass', bg: 'image', image: imgSpec({ file: 'cal.jpg', dark: false }), text: 'dark', clarity: 70, tone: 'dark', shape: 'rect' },
    dock: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'toon' }
  });
  const calImgRef = sk.surfaces.calendar.image;
  // 前置事实（缺陷成立的前提）
  eq(sk.surfaces.calendar.bg, 'image', '§C 前置：日历 bg=image');
  ok(sk.surfaces.calendar.image && sk.surfaces.calendar.image.file === 'cal.jpg', '§C 前置：日历有图 cal.jpg');
  eq(sk.surfaces.dock.follow, 'calendar', '§C 前置：dock 跟随中');
  eq(sk.surfaces.dock.shape, 'toon', '§C 前置：dock.shape=toon');

  const r = runSet(sk, { surface: 'dock', field: 'follow', value: null });
  const d = sk.surfaces.dock;
  eq(d.follow, null, '§C 关跟随 → dock.follow=null');
  /* ★ 本轮缺陷修复本体：背景来源与图片都不再继承 */
  eq(d.bg, 'native', '§C★ 关跟随后 dock.bg = native（不再继承日历的 image）');
  eq(d.image, null, '§C★ 关跟随后 dock.image = null（图片框回到空态）');
  ok(d.image === null, '§C★ dock.image 不是日历图片的深拷贝（无 cal.jpg 引用）');
  eq(d.image !== calImgRef, true, '§C★ dock.image 与日历 image 无引用关系');
  /* ★ 其余四项仍按 C4 继承 */
  eq(d.style, 'glass', '§C 仍继承 calendar.style=glass');
  eq(d.text, 'dark', '§C 仍继承 calendar.text=dark');
  eq(d.clarity, 70, '§C 仍继承 calendar.clarity=70');
  eq(d.tone, 'dark', '§C 仍继承 calendar.tone=dark');
  /* ★ shape 刻意不复制 */
  eq(d.shape, 'toon', '§C★ shape 未被覆盖（dock 独立身份保留 toon）');
  eq(sk.surfaces.calendar.shape, 'rect', '§C 日历 shape 恒 rect，未被改动');
  ok(r.calls.save >= 1 && r.calls.pushSkin >= 1, '§C 关跟随仍触发持久化 + 下发');

  /* C-2：C2「手调即豁免」路径（field='style'）也走同一物化 */
  const sk2 = v3skin({
    calendar: { style: 'tech', bg: 'image', image: imgSpec({ file: 'c2.png', dark: true }), text: 'auto', clarity: 30, tone: 'auto', shape: 'rect' },
    dock: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'pixel' }
  });
  runSet(sk2, { surface: 'dock', field: 'style', value: 'warm' });
  const d2 = sk2.surfaces.dock;
  eq(d2.follow, null, '§C C2 手调 style → dock.follow=null');
  eq(d2.style, 'warm', '§C C2 本次写入生效（warm 覆盖物化的 tech）');
  eq(d2.bg, 'native', '§C★ C2 物化后 dock.bg=native（同样不继承图片）');
  eq(d2.image, null, '§C★ C2 物化后 dock.image=null');
  eq(d2.clarity, 30, '§C C2 物化继承 clarity=30');
  eq(d2.shape, 'pixel', '§C★ C2 物化后 shape 未被覆盖（仍 pixel）');

  /* C-3：日历无图（bg=native）时物化也不引入图片 */
  const sk3 = v3skin({
    calendar: { style: 'minimal', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'light', shape: 'rect' },
    dock: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'flip' }
  });
  runSet(sk3, { surface: 'dock', field: 'follow', value: null });
  eq(sk3.surfaces.dock.image, null, '§C 日历无图 → 物化后 dock.image 仍 null');
  eq(sk3.surfaces.dock.bg, 'native', '§C 日历 bg=native → 物化后 dock.bg=native');
  eq(sk3.surfaces.dock.tone, 'light', '§C 物化继承 tone=light');
  eq(sk3.surfaces.dock.shape, 'flip', '§C 物化后 shape 仍 flip');

  /* C-4：expanded / desktop 同样受益（C4 是三面共用同一内部函数） */
  const sk4 = v3skin({
    calendar: { style: 'glass', bg: 'image', image: imgSpec({ file: 'x.png' }), text: 'auto', clarity: 55, tone: 'light', shape: 'rect' },
    expanded: { follow: 'calendar' },
    desktop: { follow: 'calendar' }
  });
  runSet(sk4, { surface: 'expanded', field: 'follow', value: null });
  runSet(sk4, { surface: 'desktop', field: 'follow', value: null });
  eq(sk4.surfaces.expanded.bg, 'native', '§C expanded 物化后 bg=native');
  eq(sk4.surfaces.expanded.image, null, '§C expanded 物化后 image=null');
  eq(sk4.surfaces.desktop.bg, 'native', '§C desktop 物化后 bg=native');
  eq(sk4.surfaces.desktop.image, null, '§C desktop 物化后 image=null');
  eq(sk4.surfaces.expanded.clarity, 55, '§C expanded 物化继承 clarity=55');
})();

/* ============================================================
 * §D  shape 写入回落 + 非 dock 面恒 rect + followableFields 含 shape
 * ============================================================ */
(function () {
  /* D-1：dock 写合法值 → 原样 */
  SHAPES.forEach(function (s) {
    const sk = v3skin({ dock: { follow: null, shape: 'rect' } });
    runSet(sk, { surface: 'dock', field: 'shape', value: s });
    eq(sk.surfaces.dock.shape, s, '§D dock 写 shape=' + s + ' → ' + s);
  });

  /* D-2：dock 写非法值 → 'rect' */
  const BAD = [undefined, null, '', 'RECT', 123, {}, [], 'unknown', NaN];
  BAD.forEach(function (v, i) {
    const sk = v3skin({ dock: { follow: null, shape: 'toon' } });
    runSet(sk, { surface: 'dock', field: 'shape', value: v });
    eq(sk.surfaces.dock.shape, 'rect', '§D dock 写非法 shape[' + i + ']=' + JSON.stringify(v) + ' → rect');
  });

  /* D-3：写 shape 触发 C2 豁免（shape ∈ followableFields） */
  const sk3 = v3skin({
    calendar: { style: 'glass', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect' },
    dock: { follow: 'calendar', shape: 'rect' }
  });
  runSet(sk3, { surface: 'dock', field: 'shape', value: 'ring' });
  eq(sk3.surfaces.dock.follow, null, '§D 写 shape → 先豁免跟随（follow=null）');
  eq(sk3.surfaces.dock.shape, 'ring', '§D 本次 shape=ring 生效');
  eq(sk3.surfaces.dock.style, 'glass', '§D 顺带物化 style=glass');

  /* D-4：源码级 —— followableFields 含 shape */
  ok(/followableFields\s*=\s*\{[^}]*\bshape\s*:\s*1[^}]*\}/.test(codeOnly(MAIN)),
    '§D followableFields 含 shape:1（手调即豁免）');

  /* D-5：非 dock 面恒 'rect' —— normalizeSkinV3 真身执行 */
  const NFNS = [
    'clamp01', 'clampZoom', 'clampImageOpacity', 'clampOpacity', 'sanitizeBasename',
    'normalizeClarity', 'normalizeImageSpec', 'normStyle', 'normBg', 'normTone', 'normShape',
    // v3.3.0 X4：normalizeSkinV3 / migrateSkinV2toV3 新增 normDockScale 调用（同款内联白名单）。
    'normDockScale',
    'normalizeSurfaceV3', 'normalizeSkinV3'
  ];
  let nApi = null;
  try {
    const src = geoSrcBase + '\n\n' + NFNS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
    nApi = new Function(src + '\nreturn { normalizeSkinV3: normalizeSkinV3 };')();
  } catch (e) {
    ok(false, '§D 抽取 normalizeSkinV3 失败 — ' + e.message);
  }
  if (nApi) {
    const n = nApi.normalizeSkinV3({
      __v: 3,
      surfaces: {
        calendar: { style: 'default', bg: 'native', text: 'auto', clarity: 'auto', tone: 'auto', shape: 'toon' },
        expanded: { style: 'default', bg: 'native', text: 'auto', clarity: 'auto', tone: 'auto', shape: 'pixel', follow: null },
        desktop: { style: 'default', bg: 'native', text: 'auto', clarity: 'auto', tone: 'auto', shape: 'ring', follow: null },
        dock: { style: 'default', bg: 'native', text: 'auto', clarity: 'auto', tone: 'auto', shape: 'toon', follow: null }
      },
      opacity: {}
    });
    eq(n.surfaces.calendar.shape, 'rect', '§D calendar 写 toon → 归一为 rect（脏数据护栏）');
    eq(n.surfaces.expanded.shape, 'rect', '§D expanded 写 pixel → 归一为 rect');
    eq(n.surfaces.desktop.shape, 'rect', '§D desktop 写 ring → 归一为 rect');
    eq(n.surfaces.dock.shape, 'toon', '§D dock 写 toon → 保留 toon（仅 dock 可持特殊造型）');
    SHAPES.forEach(function (s) {
      const nn = nApi.normalizeSkinV3({ __v: 3, surfaces: { dock: { style: 'default', bg: 'native', text: 'auto', clarity: 'auto', tone: 'auto', shape: s, follow: null } }, opacity: {} });
      eq(nn.surfaces.dock.shape, s, '§D normalizeSkinV3 保留 dock.shape=' + s);
    });
    // 旧数据无 shape → 补 'rect'（C2 兼容）
    const legacy = nApi.normalizeSkinV3({ __v: 3, surfaces: { dock: { style: 'default', bg: 'native', text: 'auto', clarity: 'auto', tone: 'auto', follow: null } }, opacity: {} });
    eq(legacy.surfaces.dock.shape, 'rect', '§D 旧数据（无 shape 字段）→ 补 rect');
    eq(legacy.surfaces.calendar.shape, 'rect', '§D 旧数据 calendar → rect');
  }

  /* D-6：migrateSkinV2toV3 亦补 shape='rect'（源码级） */
  ok(/function migrateSkinV2toV3\(/.test(codeOnly(MAIN)), '§D migrateSkinV2toV3 存在');
  ok(/shape/.test(codeOnly(extractFn(MAIN, 'normalizeSurfaceV3'))),
    '§D normalizeSurfaceV3 源码含 shape 归一（isDock 分支）');
  ok(/shape/.test(codeOnly(extractFn(MAIN, 'migrateSkinV2toV3'))),
    '§D migrateSkinV2toV3 源码含 shape（v2 数据补 rect）');
  ok(/isDock/.test(codeOnly(extractFn(MAIN, 'normalizeSurfaceV3'))),
    '§D normalizeSurfaceV3 用 isDock 第 4 参区分「只有 dock 可持非 rect」');
})();

/* ============================================================
 * §D2  X3 守卫回归：脏 file 零副作用 + 正常导入不被误伤
 * ------------------------------------------------------------
 * 走**真实** applySkinSet 孤立台（与 §C/§D 同一套 makeSet/runSet）。
 * X3 的 image 分支必须以 normalizeImageSpec 的返回值（nimg）为准再写入：
 * 若退回「只看 value.file 真值」的写法，{file:123}/'/' 等脏值会被 sanitizeBasename
 * 洗成空 → normalizeImageSpec 返回 null，却仍写出「image=null 但 bg='image'、shape='rect'」
 * 的矛盾态 —— 这是全仓唯一能打破 `bg==='image' ⟺ image!==null` 不变量、并把浮窗造型
 * 从 toon/ring 打回 rect 的入口。此断言把该不变量永久钉住（一次性隔离台不算护栏）。
 * 一条断言同时覆盖两向，失败文案可分辨是哪一侧破了。
 * ============================================================ */
(function () {
  const DIRTY = [123, '/', '', true, {}, []];
  const leaks = [];
  DIRTY.forEach(function (v) {
    const sk = v3skin({ dock: { follow: null, shape: 'toon', bg: 'native', image: null } });
    runSet(sk, { surface: 'dock', field: 'image', value: { file: v } });
    const d = sk.surfaces.dock;
    const bad = [];
    if (d.image !== null) bad.push('image=' + JSON.stringify(d.image));
    if (d.bg !== 'native') bad.push('bg=' + d.bg);
    if (d.shape !== 'toon') bad.push('shape=' + d.shape);
    if (bad.length) leaks.push('file=' + JSON.stringify(v) + '→' + bad.join('/'));
  });
  /* 反向对照：合法 file 必须照常写入，防止「一刀切拦死」把正路也堵了 */
  const skOk = v3skin({ dock: { follow: null, shape: 'toon', bg: 'native', image: null } });
  runSet(skOk, { surface: 'dock', field: 'image', value: { file: 'a.jpg' } });
  const okd = skOk.surfaces.dock;
  const hurt = [];
  if (!okd.image || okd.image.file !== 'a.jpg') hurt.push('image 未写入');
  if (okd.bg !== 'image') hurt.push('bg=' + okd.bg);
  if (okd.shape !== 'rect') hurt.push('shape=' + okd.shape);
  ok(leaks.length === 0 && hurt.length === 0,
    '§D2 X3 守卫：六类脏 file 零副作用' + (leaks.length ? '【破：' + leaks.join(' | ') + '】' : '✓') +
    ' ＋ 正常导入不被误伤' + (hurt.length ? '【破：' + hurt.join(' | ') + '】' : '✓'));
})();

/* ============================================================
 * §E  resolvedSurfaceState(...).shape
 * ============================================================ */
(function () {
  const EFNS = [
    'styleNativeTheme', 'resolveSurfaceConfig', 'surfaceTheme', 'solidFallbackFor',
    'surfaceBg', 'clarityForConfig', 'resolvedSurfaceState'
  ];
  let apiE = null;
  try {
    const src = EFNS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
    apiE = new Function('skinObj', 'nativeTheme', 'var skin = skinObj;\n' + src +
      '\nreturn { resolvedSurfaceState: resolvedSurfaceState };');
  } catch (e) {
    ok(false, '§E 抽取 resolvedSurfaceState 失败 — ' + e.message);
  }
  if (apiE) {
    /* E-1：字段存在 */
    const sk = v3skin({
      calendar: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect' },
      dock: { follow: null, shape: 'toon' }
    });
    const api = apiE(sk, { shouldUseDarkColors: false });
    const st = api.resolvedSurfaceState('dock');
    ok('shape' in st, '§E resolvedSurfaceState(dock) 含 shape 字段');
    eq(st.shape, 'toon', '§E dock 独立 shape=toon → resolved 透传 toon');

    /* E-2：dock 跟随时 = 'rect'（C3 推论：跟随态渲染的一定是 rect） */
    const sk2 = v3skin({
      calendar: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect' },
      dock: { follow: 'calendar', shape: 'toon' }
    });
    const api2 = apiE(sk2, { shouldUseDarkColors: false });
    eq(api2.resolvedSurfaceState('dock').shape, 'rect', '§E★ dock 跟随时 resolved.shape=rect（跟随 → 统一）');

    /* E-3：calendar / expanded / desktop resolved.shape 恒 rect */
    eq(api2.resolvedSurfaceState('calendar').shape, 'rect', '§E calendar resolved.shape=rect');
    const sk3 = v3skin({
      calendar: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', shape: 'rect' },
      expanded: { follow: 'calendar', shape: 'pixel' },
      desktop: { follow: 'calendar', shape: 'ring' }
    });
    const api3 = apiE(sk3, { shouldUseDarkColors: false });
    eq(api3.resolvedSurfaceState('expanded').shape, 'rect', '§E expanded 跟随 → resolved.shape=rect');
    eq(api3.resolvedSurfaceState('desktop').shape, 'rect', '§E desktop 跟随 → resolved.shape=rect');

    /* E-4：源码级 —— resolvedSurfaceState 返回对象含 shape: c.shape */
    ok(/shape:\s*c\.shape/.test(codeOnly(extractFn(MAIN, 'resolvedSurfaceState'))),
      '§E resolvedSurfaceState 源码含 shape: c.shape');
  }
})();

/* ============================================================
 * §F  dock.html：六 data-shape / 变量下沉 / 非 rect 清 style·skin / 负向
 * ============================================================ */
(function () {
  const dockCode = codeOnly(DOCK);

  /* F-1：<html> 带 data-shape，且六值齐备 + 六套装饰作用域 */
  ok(/<html[^>]*\bdata-shape=/.test(DOCK), '§F dock.html <html> 带 data-shape 属性');
  SHAPES.forEach(function (s) {
    ok(countOcc(DOCK, 'data-shape="' + s + '"') >= 1, '§F dock.html 含 data-shape="' + s + '"');
  });
  ok(countOcc(DOCK, 'html[data-shape="pixel"]') >= 1 ||
     countOcc(DOCK, 'html[data-shape="px"]') >= 1, '§F dock.html pixel 造型作用域规则存在');
  SHAPES.filter(function (s) { return s !== 'rect'; }).forEach(function (s) {
    ok(DOCK.indexOf('html[data-shape="' + s + '"]') >= 0, '§F dock.html 造型装饰作用域 html[data-shape="' + s + '"]');
  });

  /* F-1b：渲染层自带六键表 + 六中文名（C10 冻结命名，与主进程/文档三处对齐） */
  ok(/var SHAPE_KEYS = \['rect', 'pixel', 'rainbow', 'ring', 'flip', 'toon'\]/.test(DOCK),
    '§F dock.html SHAPE_KEYS 六键冻结表（与主进程 DOCK_SHAPE_KEYS 同序同值）');
  ok(/var SHAPE_NAME = \{/.test(DOCK) &&
     SHAPES.every(function (s) { return DOCK.indexOf(SHAPE_NAMES[s]) >= 0; }),
    '§F dock.html SHAPE_NAME 表含六中文名（C10）');

  /* F-1c：五套非 rect 装饰类根存在（造型视觉的挂载点） */
  SHAPES.filter(function (s) { return s !== 'rect'; }).forEach(function (s) {
    ok(DOCK.indexOf('.shape-' + s) >= 0 || DOCK.indexOf('class="shape shape-' + s + '"') >= 0,
      '§F dock.html 造型装饰类 .shape-' + s + ' 存在');
  });

  /* F-2：#shapeLayer 挂载点 + applyShape 函数 */
  ok(DOCK.indexOf('id="shapeLayer"') >= 0, '§F dock.html 存在 #shapeLayer 造型挂载点');
  ok(/function applyShape\(/.test(dockCode), '§F dock.html 存在 applyShape()');

  /* F-3：--dock-* 变量消费（C7.2 变量下沉） */
  ['--dock-bg', '--dock-edge', '--dock-shadow', '--dock-radius', '--dock-overflow'].forEach(function (v) {
    ok(DOCK.indexOf('var(' + v) >= 0, '§F dock.html #card 消费 var(' + v + ', 缺省)');
  });
  ['--dock-bg-hover', '--dock-edge-hover', '--dock-shadow-hover'].forEach(function (v) {
    ok(DOCK.indexOf('var(' + v) >= 0, '§F dock.html hover 消费 var(' + v + ')');
  });
  ok(/'--dock-bg'/.test(dockCode) && dockCode.indexOf('DOCK_SHAPE_VARS') >= 0,
    '§F dock.html DOCK_SHAPE_VARS 表含 --dock-bg（非 rect 造型 inline 写值）');
  ok(/setProperty\(\s*n\s*,/.test(dockCode) || /style\.setProperty\(/.test(dockCode),
    '§F dock.html JS inline setProperty 写造型变量（绕开特异性之争）');
  ok(/DOCK_VAR_KEYS\s*=\s*\[[\s\S]{0,300}--dock-bg/.test(dockCode),
    '§F dock.html DOCK_VAR_KEYS 含 --dock-bg');
  ok(/removeProperty\(\s*DOCK_VAR_KEYS\[/.test(dockCode),
    '§F dock.html rect 分支对 DOCK_VAR_KEYS 逐个 removeProperty（回落原值）');

  /* F-4：非 rect 时清 data-style / data-skin / 可读性 / #skinImg（精确到 dockApplySkin 函数体） */
  let applySkinBody = '';
  try { applySkinBody = codeOnly(extractFn(DOCK, 'dockApplySkin')); }
  catch (e) { ok(false, '§F 抽取 dockApplySkin 失败 — ' + e.message); }
  if (applySkinBody) {
    ok(/dockShape\s*!==\s*'rect'/.test(applySkinBody), '§F dockApplySkin 有 dockShape!=="rect" 让位分支');
    ok(/delete\s+root\.dataset\.style/.test(applySkinBody), '§F 非 rect 分支清 data-style');
    ok(/delete\s+root\.dataset\.skin/.test(applySkinBody), '§F 非 rect 分支清 data-skin');
    ok(/delete\s+root\.dataset\.text/.test(applySkinBody),
      '§F 非 rect 分支清 data-text（C7.2：非 rect 让位 style/skin/text 三者）');
    ok(/dockClearReadability\(root\)/.test(applySkinBody), '§F 非 rect 分支调用 dockClearReadability');
    ok(/skinImg/.test(applySkinBody), '§F 非 rect 分支清 #skinImg 背景');
    ok(/return;/.test(applySkinBody), '§F 非 rect 分支提前 return（不写任何 token）');
  }

  /* F-4b：造型权威来源 = resolved.dock.shape（C7.7），渲染层不自行判 follow */
  ok(/applyShape\(/.test(dockCode), '§F dock.html 调用 applyShape()');
  ok(/state\.resolved\s*&&\s*state\.resolved\.dock[\s\S]{0,120}applyShape\(/.test(DOCK) ||
     /resolved\.dock\.shape[\s\S]{0,120}applyShape\(/.test(DOCK),
    '§F applyShape 的入参来自 resolved.dock.shape（C7.7 权威来源）');

  /* F-5：负向 —— 不再写死 116×50 视口 */
  ok(!/vp\s*=\s*\{\s*w\s*:\s*116\s*,\s*h\s*:\s*50\s*\}/.test(DOCK),
    '§F★ 负向：dock.html 不再有 `vp = { w: 116, h: 50 }` 写死视口');
  ok(/function dockLayoutSkin[\s\S]{0,700}(sizeW|sizeH|cardW|cardH)/.test(DOCK),
    '§F dockLayoutSkin 视口读当前卡片尺寸（sizeW/sizeH 或 cardW/cardH）');

  /* F-6：applyDockSize 消费 pad（C5 载荷 padL/T/R/B），缺省回 rect 的 2/2/0/0 */
  ok(/\.padL/.test(dockCode) && /\.padR/.test(dockCode), '§F dock.html applyDockSize 消费载荷 padL/padR');
  ok(/padL\s*=\s*\(typeof\s+s\.padL\s*===\s*'number'\)\s*\?\s*s\.padL/.test(dockCode),
    '§F pad 由 dock-size 载荷驱动（s.padL），非写死');
  ok(/var\s+padL\s*=\s*2\s*,\s*padT\s*=\s*2\s*,\s*padR\s*=\s*0\s*,\s*padB\s*=\s*0/.test(dockCode),
    '§F 缺省 pad 仍为 rect 的 2/2/0/0（IPC 到达前占位，v1.7.22.4 右下归零硬约束保留）');

  /* F-7：点击热区按造型收敛（ring/toon 圆形判定） */
  ok(/function isInCard\(/.test(dockCode), '§F isInCard 仍存在（拖动那套未动）');
  ok(/Math\.min\([^)]*\)\s*\/\s*2\s*-\s*2/.test(dockCode),
    '§F isInCard 复用半径公式 min(cardW,cardH)/2 - 2（圆形判定）');
  ok(/'ring'/.test(dockCode) && /'toon'/.test(dockCode),
    '§F dock.html JS 含 ring / toon 判定分支');

  /* F-8：点阵字模内联（无外部依赖）+ 每秒重绘点 */
  ok(/PX_CELL/.test(dockCode) && /PX_GAP/.test(dockCode), '§F dock.html 内联点阵 PX_CELL / PX_GAP');
  ok(/PF\b/.test(dockCode), '§F dock.html 内联点阵字模 PF（3×5）');
  ok(/function renderShape\(/.test(dockCode), '§F dock.html 每秒重绘入口 renderShape(t)');
  ok(/\(h % 12\) \* 30 \+ m \* 0\.5/.test(DOCK) && /m \* 6 \+ s \* 0\.1/.test(DOCK),
    '§F toon 指针角度公式（时 h%12*30+m*0.5 / 分 m*6+s*0.1 / 秒 s*6）');
  ok(/getHours\(\)/.test(dockCode) && /getMinutes\(\)/.test(dockCode) && /getSeconds\(\)/.test(dockCode),
    '§F dock.html 每秒重绘仍读 h/m/s');

  /* F-9：rect 行为逐字保留（现状 token / #dockTime ） */
  ok(DOCK.indexOf('id="dockTime"') >= 0 && DOCK.indexOf('id="dockDate"') >= 0,
    '§F rect 内容节点 #dockTime / #dockDate 保留');

  /* ============================================================
   * §F2  X2 判据：造型变量「取值」正确性（X2 修复的永久回归护栏）
   * ------------------------------------------------------------
   * 背景：§F-3 只证明「--dock-* 变量名存在且被消费」，**不检查取值**。于是 X2 的三条
   *   修复（ring 去外投影 / pixel 外投影收进 pad / flip·toon 卡片盒不可见）即使被改坏，
   *   本文件照样全绿 —— 与 w-b-main 的 nimg 守卫是同一类覆盖空白，故在此补齐。
   * 做法：把 dock.html 的 invisibleCardVars() + DOCK_SHAPE_VARS + DOCK_VAR_KEYS 三个
   *   纯数据/纯工厂抽出来注入最小隔离台 eval，再对**解析出的对象**断言。
   *   刻意不用正则匹配取值 —— 正则会被「改透明度 / 换空格」这类无关编辑推着走。
   * ============================================================ */
  const VAR_KEYS = ['--dock-bg', '--dock-bg-hover', '--dock-edge', '--dock-edge-hover',
                    '--dock-shadow', '--dock-shadow-hover', '--dock-radius', '--dock-overflow',
                    '--dock-blur', '--dock-sat'];
  const NONRECT = SHAPES.filter(function (s) { return s !== 'rect'; });

  let svars = null, vkeys = null;
  try {
    const src = [
      extractFn(DOCK, 'invisibleCardVars'),
      extractDecl(DOCK, 'DOCK_SHAPE_VARS'),
      extractDecl(DOCK, 'DOCK_VAR_KEYS')
    ].join('\n');
    const api = new Function(src +
      '\nreturn { D: DOCK_SHAPE_VARS, K: DOCK_VAR_KEYS };')();
    svars = api.D; vkeys = api.K;
  } catch (e) {
    ok(false, '§F2 抽取 DOCK_SHAPE_VARS / invisibleCardVars 失败 — ' + e.message);
  }

  /* 深度感知切层：rgba(...) 内部含逗号，裸 split(',') 会把一层切碎 */
  function splitShadowLayers(v) {
    const s = String(v || ''), out = [];
    let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') { depth++; }
      else if (ch === ')') { depth--; }
      if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  /* 非 inset 外投影层的越界量，与「该方向 pad」比较。
   * 长度 token 必须容忍**无单位 0**（CSS 合法写法，`0 3px 8px` 首位就是它）——漏读它会让
   *   offsetX/offsetY/blur/spread 四个位置整体错位，从而少算越界量、放过真实回归。
   * 四段齐全：offsetX offsetY blur **spread** —— spread 必须计入（`0 3px 8px 4px` 真越界
   *   3+8+4 = 15 > pad 12）。只读前 3 段会把 spread 静默丢弃 = 假绿，故一并纳入。
   * ⚠ 非 px 单位（em/rem/%/vw…）：本项目 CSS 大量用 em/rem，**静默按 0 处理就是低估 ⇒ 假绿**。
   *   故此处不猜，回 unknown 由调用方判红 —— 护栏宁可**假红**（吵）不可**假绿**（哑）。
   * ⚠ 零偏移层（如 `0 0 0 1px` 这类发丝内描边）越界量仅 1px ≤ pad，**恒过是刻意的**：
   *   本护栏的唯一使命是防「被窗口矩形硬裁成直角切断」（用户报的问题）；1px 外扩不会被裁，
   *   不违使命。未来请勿为「看起来更严」给它加禁令 —— 那会误伤合法的内描边设计。 */
  function outerNeed(layer, reg) {
    const toks = String(layer).split(/\s+/);
    const isUnitless = /^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/;          // px 或无单位（含裸 0）
    const isForeignUnit = /^-?(?:\d+\.?\d*|\.\d+)(?:em|rem|%|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)$/;
    let ox = 0, oy = 0, blur = 0, spread = 0, seen = 0, foreign = null;
    for (let i = 0; i < toks.length; i++) {
      if (isForeignUnit.test(toks[i])) { foreign = toks[i]; continue; }
      if (isUnitless.test(toks[i])) {
        const n = parseFloat(toks[i]);
        seen++;
        if (seen === 1) { ox = n; }
        else if (seen === 2) { oy = n; }
        else if (seen === 3) { blur = n; }
        else if (seen === 4) { spread = n; }
      }
    }
    if (foreign) { return { need: NaN, allow: NaN, layer: layer, foreign: foreign }; }
    const pads = [];
    if (oy > 0) { pads.push(reg.padB); } else if (oy < 0) { pads.push(reg.padT); }
    if (ox > 0) { pads.push(reg.padR); } else if (ox < 0) { pads.push(reg.padL); }
    /* spread 向**四周同时**外扩 ⇒ 不能只看偏移方向，取四边最小 pad（保守界：宁可假红） */
    if (spread !== 0 || !pads.length) { pads.length = 0; pads.push(reg.padL, reg.padT, reg.padR, reg.padB); }
    return {
      need: Math.max(Math.abs(ox), Math.abs(oy)) + blur + Math.abs(spread),
      allow: Math.min.apply(null, pads), layer: layer, foreign: null
    };
  }

  /* F2-1：变量键集 —— 十个键，一个不多一个不少，五款造型键集一致 */
  if (vkeys) {
    eq(vkeys.length, 10, '§F2 DOCK_VAR_KEYS 恰 10 个变量键');
    eq(vkeys.slice().sort().join(','), VAR_KEYS.slice().sort().join(','),
      '§F2 DOCK_VAR_KEYS 键集 = 契约冻结集（逐名一致）');
  }
  if (svars) {
    NONRECT.forEach(function (s) {
      const got = Object.keys(svars[s] || {}).sort().join(',');
      eq(got, VAR_KEYS.slice().sort().join(','),
        '§F2 ' + s + ' 造型变量键集 = DOCK_VAR_KEYS 全集（不多写不漏写）');
    });
  }

  /* F2-2★：通用不变量 —— 五款非 rect 造型的每一层**外投影**（`inset` 层不参与本判定，
   * 它们是卡片内侧的高光/描边，本就不会被窗口矩形硬裁），其
   *   max(|offsetX|,|offsetY|) + blur + |spread|   必须 ≤ 对应方向的 pad
   * （pad 现取自 §B 同一张 REGISTRY 冻结表，不硬编码 12；pad 调小则断言自动变严）。
   * 覆盖 ring（**零层外投影** → 本断言平凡通过；注意它与「`inset 0 0 0 1px` 高光」无关，
   * 后者属 inset 层、被过滤掉，不参与越界判定）与将来新增的第七款造型，杜绝静默漏检。
   * rect 必须排除：它 padR/padB = 0 且刻意贴屏幕右沿/任务栏，属文档化取舍。
   * Y1 后 rainbow 亦 padR/padB = 0（同贴右沿+任务栏）—— 它靠**零层外投影**通过（:826 早退），
   * 而非「pad>0」；若将来给 rainbow 加任何外投影，本断言会与 rect 同因报红（这正是设计意图）。
   * 非 px 单位（em/rem…）一律判红并写明「须人工确认」—— 静默按 0 就是低估 ⇒ 假绿。 */
  if (svars) {
    const bad = [];
    NONRECT.forEach(function (s) {
      const reg = REGISTRY[s];
      ['--dock-shadow', '--dock-shadow-hover'].forEach(function (k) {
        splitShadowLayers(svars[s] && svars[s][k]).forEach(function (layer) {
          if (/^inset\b/.test(layer) || layer === 'none') { return; }
          const r = outerNeed(layer, reg);
          if (r.foreign) {
            bad.push(s + '.' + k + ' 「' + r.layer + '」含非 px 单位 `' + r.foreign +
              '`：该值无法静态判定，须人工确认');
          } else if (r.need > r.allow) {
            bad.push(s + '.' + k + ' 「' + r.layer + '」越界 ' + r.need + 'px > pad ' + r.allow + 'px');
          }
        });
      });
    });
    ok(bad.length === 0,
      '§F2★ 五款非 rect 造型外投影（含 blur+spread）全部收进对应方向 pad（X2 通用不变量；违反项：' +
      (bad.join(' | ') || '无') + '）');
  }

  /* F2-3：ring 零外投影（X2 核心 —— 删掉的 `0 10px 30px rgba(0,0,0,.42)` 40px 越界会被窗口硬裁） */
  if (svars && svars.ring) {
    ['--dock-shadow', '--dock-shadow-hover'].forEach(function (k) {
      const outer = splitShadowLayers(svars.ring[k]).filter(function (l) {
        return l && l !== 'none' && !/^inset\b/.test(l);
      });
      ok(outer.length === 0,
        '§F2 ring.' + k + ' 零外投影层（违反层：' + (outer.join(' | ') || '无') + '）');
    });
  }

  /* F2-4：ring 圆盘轮廓（半径 + 裁剪） */
  if (svars && svars.ring) {
    eq(svars.ring['--dock-radius'], '50%', '§F2 ring --dock-radius = 50%（圆盘轮廓）');
    eq(svars.ring['--dock-overflow'], 'hidden', '§F2 ring --dock-overflow = hidden（圆盘裁剪）');
  }

  /* F2-5：flip / toon 卡片盒不可见 —— 对应 dock.html 文件头硬约束
   * 「flip/toon 必须显式把 --dock-overflow 放开为 visible，否则内层翻牌投影/落地影被切」 */
  if (svars) {
    ['flip', 'toon'].forEach(function (s) {
      eq((svars[s] || {})['--dock-overflow'], 'visible',
        '§F2 ' + s + ' --dock-overflow = visible（内层可见物不被卡片盒切掉）');
    });
    ['flip', 'toon'].forEach(function (s) {
      eq((svars[s] || {})['--dock-shadow'], 'none',
        '§F2 ' + s + ' --dock-shadow = none（卡片盒本身完全不可见）');
    });
    /* 反向对照：非 rect 造型不得沿用 rect 的缺省阴影变量（否则「不可见卡片盒」被破坏） */
    const leaked = NONRECT.filter(function (s) {
      return String((svars[s] || {})['--dock-bg']) === '';
    });
    ok(leaked.length === 0, '§F2 五款造型均已显式给出 --dock-bg（无空值回落到主题卡面）');
  }
})();

/* ============================================================
 * §G  skin.html：第三入口「浮窗样式」
 * ============================================================ */
(function () {
  ok(SKIN.indexOf('id="entryShape"') >= 0, '§G skin.html 含 #entryShape（第三入口）');
  ok(SKIN.indexOf('id="shapeList"') >= 0, '§G skin.html 含 #shapeList（动画展开容器）');
  eq(countOcc(SKIN, 'class="shape-row" data-shape='), 6, '§G skin.html 恰 6 行 shape-row[data-shape]');
  SHAPES.forEach(function (s) {
    ok(SKIN.indexOf('data-shape="' + s + '"') >= 0, '§G skin.html 含 shape 行 data-shape="' + s + '"');
  });
  SHAPES.forEach(function (s) {
    ok(countOcc(SKIN, SHAPE_NAMES[s]) >= 1, '§G skin.html 含造型名「' + SHAPE_NAMES[s] + '」');
  });
  ok(/skinSet\(\s*'dock'\s*,\s*'shape'/.test(codeOnly(SKIN)) || /skinSet\("dock",\s*"shape"/.test(codeOnly(SKIN)),
    "§G skin.html 点造型行 → skinSet('dock','shape',key)（复用既有通道）");
  ok(SKIN.indexOf('shape-tag') >= 0, '§G skin.html 有 .shape-tag 小标签');
  ok(SKIN.indexOf('跟随主界面') >= 0, '§G skin.html 「圆角卡片」行标注「跟随主界面」');
  ok(SKIN.indexOf('id="entryShape"') >= 0 && SKIN.indexOf('id="nativeList"') >= 0,
    '§G skin.html 三入口并存（#nativeList 风格列表未丢）');
  ok(/Escape/.test(codeOnly(SKIN)), '§G skin.html Esc 处理存在');
  (function () {
    const i = SKIN.indexOf("e.key !== 'Escape'");
    const blk = i >= 0 ? SKIN.slice(i, i + 700) : '';
    ok(blk.indexOf('shapeOpen') >= 0 && blk.indexOf('nativeOpen') >= 0,
      '§G Esc 逐层回收含 shapeOpen / nativeOpen 两层');
    ok(blk.indexOf('shapeOpen') < blk.indexOf('nativeOpen'),
      '§G★ Esc 顺序：先收形状列表（shapeOpen）→ 再收风格列表（nativeOpen）→ 关窗');
  })();
  // 回显：active ⇔ resolved.dock.shape
  ok(/resolved[\s\S]{0,80}\.dock[\s\S]{0,80}\.shape/.test(codeOnly(SKIN)) ||
     /resolved\.dock\.shape/.test(codeOnly(SKIN)),
    '§G skin.html .active 回显依据 resolved.dock.shape');
})();

/* ============================================================
 * §H  skincustom.html：「清空」按钮 + 空态两态
 * ============================================================ */
(function () {
  const sc = codeOnly(SKINCUSTOM);
  ok(SKINCUSTOM.indexOf('id="btnClearImage"') >= 0, '§H skincustom.html 含 #btnClearImage');
  ok(/setField\(\s*S\.surface\s*,\s*'bg'\s*,\s*'native'\s*\)/.test(sc) ||
     /setField\(S\.surface,\s*'bg',\s*'native'\)/.test(sc),
    "§H 点击清空 → setField(S.surface,'bg','native')（不新增 IPC）");
  ok(/btnClearImage[\s\S]{0,400}disabled/.test(sc), '§H #btnClearImage 有 disabled 判据');
  /* §H 可用性判据用「本面自己有图片」（bg==='image' && image），非「跟随中」。
   * 刻意不用「两锚点距离 < N」的写法：那段距离会被无关文案改动推着走；
   * 且旧写法只匹配到 bg==='image'，**没有校验 && cfg.image** —— 自称号称的语义它并没验，
   * 属正确性缺口而非仅仅脆弱。改为两条语义断言，各自只声明一件事。 */
  ok(/var img\s*=\s*\(\s*cfg\.bg\s*===\s*'image'\s*&&\s*cfg\.image\s*\)\s*\?\s*cfg\.image\s*:\s*null/.test(sc),
    "§H 判据取自本面配置：img = (cfg.bg==='image' && cfg.image) ? cfg.image : null");
  ok(/\$\('btnClearImage'\)\s*\.disabled\s*=\s*!hasImg/.test(sc),
    "§H #btnClearImage.disabled = !hasImg（hasImg 由上面那条 img 推导）");
  ok(!/disabled[\s\S]{0,120}following/.test(sc), '§H 未用「跟随中」作为禁用判据（第二套判据禁止）');
  ok(SKINCUSTOM.indexOf('已清空，回到原生皮肤') >= 0, '§H 清空后 toast「已清空，回到原生皮肤」');
  ok(SKINCUSTOM.indexOf('跟随主界面中') >= 0, '§H #cropEmpty 跟随态文案：「跟随主界面中…」');
  ok(SKINCUSTOM.indexOf('尚未选择图片') >= 0, '§H #cropEmpty 独立无图态文案：「尚未选择图片…」');
  ok(/自动独立/.test(SKINCUSTOM) && /回到原生皮肤/.test(SKINCUSTOM),
    '§H 跟随开关 hint 说明「自动独立 + 回到原生皮肤」');
})();

/* ============================================================
 * §I  applyNativeStyleAll 语义未变（不写 shape）
 * ============================================================ */
(function () {
  let body = '';
  try { body = codeOnly(extractFn(MAIN, 'applyNativeStyleAll')); }
  catch (e) { ok(false, '§I 抽取 applyNativeStyleAll 失败 — ' + e.message); }
  if (body) {
    ok(!/\.shape\b/.test(body), '§I applyNativeStyleAll 代码体不出现 .shape（语义未变）');
    ok(!/\bnormShape\b/.test(body), '§I applyNativeStyleAll 不引用 normShape');
  }

  const NFNS = ['normStyle', 'normBg', 'resolveSurfaceConfig', 'applyNativeStyleAll'];
  let apiN = null;
  try {
    const src = NFNS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
    apiN = new Function('skinObj', 'hooks', [
      'var skin = skinObj;',
      'hooks = hooks || {};',
      'var recomputeTheme = hooks.recomputeTheme || function () {};',
      'var saveSettings = hooks.saveSettings || function () {};',
      'var pushThemeToAll = hooks.pushThemeToAll || function () {};',
      'var pushSkinToAll = hooks.pushSkinToAll || function () {};',
      'var pushSkinConfigState = hooks.pushSkinConfigState || function () {};',
      'var refreshTrayMenu = hooks.refreshTrayMenu || function () {};',
      'var syncDockGeometry = hooks.syncDockGeometry || function () {};',
      src,
      'return { applyNativeStyleAll: applyNativeStyleAll };'
    ].join('\n'));
  } catch (e) {
    ok(false, '§I 抽取 applyNativeStyleAll 隔离台失败 — ' + e.message);
  }
  if (apiN) {
    const sk = v3skin({
      calendar: { shape: 'rect' },
      dock: { follow: null, shape: 'toon' }
    });
    apiN(sk, {}).applyNativeStyleAll('tech');
    eq(sk.surfaces.dock.shape, 'toon', '§I 选原生后 dock.shape 仍 toon（造型不随原生皮肤变）');
    eq(sk.surfaces.calendar.shape, 'rect', '§I 选原生后 calendar.shape 仍 rect');
    eq(sk.surfaces.dock.follow, 'calendar', '§I 选原生后 dock.follow=calendar（既有语义）');
    eq(sk.surfaces.dock.bg, 'native', '§I 选原生后 dock.bg=native（既有语义）');
  }
})();

/* ============================================================
 * §J  造型名进文档 + 用户可见文件「浮动插件」= 0
 * ============================================================ */
(function () {
  const README = readRoot('README.md');
  const MANUAL = readRoot('使用说明.md');
  ok(README.length > 0, '§J README.md 可读');
  ok(MANUAL.length > 0, '§J 使用说明.md 可读');
  SHAPES.forEach(function (s) {
    ok(countOcc(README, SHAPE_NAMES[s]) >= 1, '§J README.md 含造型名「' + SHAPE_NAMES[s] + '」');
  });
  SHAPES.forEach(function (s) {
    ok(countOcc(MANUAL, SHAPE_NAMES[s]) >= 1, '§J 使用说明.md 含造型名「' + SHAPE_NAMES[s] + '」');
  });

  /* 用户可见文件「浮动插件」仍为 0（C6 命名统一，v3.2.0 起） */
  const USER_FACING = ['skin.html', 'skincustom.html', 'settings.html', '使用说明.md', '使用说明.html', 'README.md'];
  USER_FACING.forEach(function (f) {
    const src = readRoot(f);
    ok(src.length > 0, '§J ' + f + ' 可读');
    if (src.length > 0) {
      eq(countOcc(src, '浮动插件'), 0, '§J ' + f + ' 无「浮动插件」（统一为「浮窗」）');
    }
  });
  const HTML_MANUAL = readRoot('使用说明.html');
  ok(HTML_MANUAL.indexOf('3.3.0') >= 0, '§J 使用说明.html 含版本 3.3.0');
})();

/* ============================================================
 * §K  X1：原生皮肤下 Electron 的 body 透明（含产物重建证据）
 * ------------------------------------------------------------
 * 根因：皮肤层只补了 [data-skin="color"/"image"] 两态，**原生皮肤一直没补** ⇒ 未选皮肤时
 *   body 取基础渐变底（或 [data-theme="dark"] body 的深底），而窗口本身是「透明 + 圆角」的，
 *   圆角之外就露出这块底色 —— 四角漏底 / 深色主题发黑。
 * 修法：html body.electron { background: transparent; } —— 加 html 前缀把特异性提到 (0,1,2)，
 *   恒压 [data-theme="dark"] body 的 (0,1,1)；.electron 只在 Electron 下由 app.js 打在 body 上，
 *   故浏览器预览（无 window.api）不命中、仍保留那层衬底。
 * ============================================================ */
(function () {
  const TPL = readRoot('template.html');
  const CAL = readRoot('calendar.html');   // build.js 的产物 —— 产物重建证据
  const APP = readRoot('app.js');

  ok(TPL.length > 0, '§K template.html 可读');
  ok(CAL.length > 0, '§K calendar.html 可读（build 产物）');

  /* K-1：规则本体 + 特异性前缀 */
  ok(/html\s+body\.electron\s*\{[^}]*background\s*:\s*transparent[^}]*\}/.test(TPL),
    '§K★ template.html 含 `html body.electron { background: transparent; }`（X1 规则本体）');
  ok(/html\s+body\.electron\s*\{/.test(TPL),
    '§K 规则带 html 前缀 ⇒ 特异性 (0,1,2)，恒压 [data-theme="dark"] body 的 (0,1,1)');

  /* K-2 负向：不得出现「裸 body.electron 写 transparent」的弱特异性写法 ——
   * 裸 body.electron 是 (0,1,1)，与深色主题同权且源序更前 ⇒ 会被反压，四角黑边复发。 */
  ok(!/body\.electron\s*\{[^}]*background\s*:\s*transparent/.test(
       TPL.replace(/html\s+body\.electron\s*\{/g, '{')),
    '§K★ 负向：不存在「裸 body.electron 写 transparent」的弱特异性写法（会与深色主题同权而被反压）');

  /* K-3：前提与对照 —— X1 是「补原生缺口」，既有的皮肤两态 + 冲突源都必须还在 */
  ok(/html\[data-skin="color"\]\s*body\s*,\s*html\[data-skin="image"\]\s*body\s*\{\s*background\s*:\s*transparent/.test(TPL),
    '§K 对照：既有皮肤两态 body 透明规则仍在（X1 只补原生缺口，未删既有）');
  ok(/\[data-theme="dark"\]\s*body\s*\{/.test(TPL),
    '§K 前提：冲突源 [data-theme="dark"] body 存在（特异性论证的前提，否则本护栏无意义）');

  /* K-4：.electron 只在 Electron 下打在 body 上（浏览器预览不命中 ⇒ 预览页保留衬底美观） */
  ok(/if\s*\(\s*window\.api\s*\)\s*\{[\s\S]{0,400}classList\.add\('electron'\)/.test(APP),
    '§K app.js 仅在 Electron（window.api 存在）下给 body 打 .electron class');

  /* K-5：产物重建证据 —— 只改源模板不重新构建，用户装到的仍是旧的（四角照样漏底） */
  ok(/html\s+body\.electron\s*\{\s*background\s*:\s*transparent\s*;?\s*\}/.test(CAL),
    '§K★ 产物重建证据：calendar.html 含同一条 `html body.electron` 规则（构建确实跑过）');
  ok(/body\.electron/.test(CAL), '§K calendar.html 含 body.electron 系列规则');

  /* K-6 负向：规则体内 background 仅允许 transparent（禁止「顺手加个底色」把透明打回原形）。
   * 实现刻意**不用 `(?!transparent)` 前瞻** —— `\s*` 会匹配空串让前瞻在空格处回退通过，
   * 是个经典假绿写法（我第一版就踩了）。改为把规则体按 `;` 拆成声明逐条等值比较。 */
  const mK = /html\s+body\.electron\s*\{([^}]*)\}/.exec(TPL);
  const kBodyDecls = (mK ? mK[1].split(';') : [])
    .map(function (d) { return d.replace(/\s+/g, ' ').trim(); })
    .filter(function (d) { return /^background/.test(d); });
  const kBadBg = kBodyDecls.filter(function (d) { return d !== 'background: transparent'; });
  ok(!!mK && kBadBg.length === 0,
    '§K★ 负向：html body.electron 规则体内 background 仅允许 transparent（禁止加底色；违规声明：' +
    (kBadBg.join(' | ') || '无') + '）');
})();

/* ============================================================
 * §L  X4：浮窗等比缩放（normDockScale 判据矩阵 / 默认值 / 载荷不变量）
 * ------------------------------------------------------------
 * 契约：缩放只改「窗口在屏幕上的 DIP」与 zoom，**不改卡片相对几何** ⇒ 系数一律由
 *   **调用方**施加（syncDockGeometry），dockGeometry 保持单参纯函数（§B 已钉）。
 * 本段只覆盖**静态可测**部分；「zoom 是否被重放 / 载荷是否基础值 / dockBounds 是否乘 s」
 *   里属运行时行为的部分不进闸门（静态写进去就是「写了却跑不了」的假断言），由真机取证覆盖。
 * ⚠ 判据矩阵的来源是 normDockScale **真身执行**，不是源码注释 —— 注释若与实现不符，
 *   下面会红（届时回报，绝不改注释去迁就测试）。
 * ============================================================ */
(function () {
  /* L-1：判据矩阵（真身孤立 eval —— normDockScale 内联白名单、只依赖 Math/Number，可单抽） */
  let norm = null;
  try {
    norm = new Function(extractFn(MAIN, 'normDockScale') +
      '\nreturn normDockScale;')();
  } catch (e) {
    ok(false, '§L 抽取 normDockScale 失败 — ' + e.message);
  }
  if (norm) {
    const CASES = [
      [undefined, 1, 'undefined'], [null, 1, 'null'], [{}, 1, '{}'],
      [true, 1, 'true'], ['', 1, "''"], ['abc', 1, "'abc'"], [NaN, 1, 'NaN'],
      [0, 0.6, '0'], [0.5, 0.6, '0.5'], [0.6, 0.6, '0.6'],
      [1.6, 1.6, '1.6'], [2, 1.6, '2'], [99, 1.6, '99'],
      [1.234, 1.25, '1.234（5% 吸附 → 1.25）'], ['1.5', 1.5, "'1.5'（字符串数字）"],
      [0.975, 1, '0.975（吸附 → 1）'], [0.9, 0.9, '0.9'], [1, 1, '1'],
      [1.1, 1.1, '1.1']
    ];
    CASES.forEach(function (c) {
      eq(norm(c[0]), c[1], '§L normDockScale(' + c[2] + ') → ' + c[1]);
    });
  }

  /* L-2：skin.dockScale 默认值 = 1（缩放是「可选增强」，历史数据无该字段必须保持原尺寸，
   * 绝不能因为一次迁移把老用户的浮窗悄悄缩小） */
  ok(/let\s+skin\s*=\s*\{[\s\S]{0,900}?\bdockScale\s*:\s*1\b/.test(MAIN),
    '§L skin 顶层默认 dockScale = 1（未设 ⇒ 原尺寸，不缩不放）');

  /* L-3：applySkinSet 的 dockScale 分支 */
  const setBody = codeOnly(extractFn(MAIN, 'applySkinSet'));
  ok(/field\s*===\s*'dockScale'/.test(setBody), "§L applySkinSet 含 field==='dockScale' 分支");
  ok(/skin\.dockScale\s*=\s*normDockScale\(value\)/.test(setBody),
    '§L dockScale 分支经 normDockScale 归一后写顶层 skin.dockScale');

  /* L-4 负向：dockScale **不进 followableFields** —— 缩放是几何不是身份，
   * 改缩放不得把浮窗从「跟随主界面」踢成独立。 */
  const ff = /followableFields\s*=\s*\{([^}]*)\}/.exec(codeOnly(MAIN));
  ok(!!ff && !/dockScale/.test(ff[1]),
    '§L★ 负向：followableFields 不含 dockScale（改缩放不得踢掉 dock 的跟随身份）');

  /* L-5：pushDockSize 载荷必须发**基础值**（geo.winW/winH），不得发已乘 s 的 dockW/dockH。
   * 理由：S1 下 CSS 视口 = 窗口 DIP / zoom = 基础尺寸；下发 DIP 会让卡片按放大后尺寸摆而被裁。 */
  const pushBody = codeOnly(extractFn(MAIN, 'pushDockSize'));
  ok(/w\s*:\s*geo\.winW\s*,\s*h\s*:\s*geo\.winH/.test(pushBody),
    '§L★ pushDockSize 载荷 w/h 取基础值 geo.winW/geo.winH（与缩放系数解耦）');
  ok(!/w\s*:\s*dockW\s*,\s*h\s*:\s*dockH/.test(pushBody),
    '§L★ 负向：载荷不再出现已乘 s 的 w: dockW, h: dockH');

  /* L-6：缩放施加在**调用方**（syncDockGeometry），dockGeometry 单参不受影响（§B 已钉死） */
  const syncBody = codeOnly(extractFn(MAIN, 'syncDockGeometry'));
  ok(/dockGeometry\(\s*resolveSurfaceConfig\('dock'\)\.shape\s*\)/.test(syncBody) &&
     /normDockScale\(/.test(syncBody),
    '§L★ 缩放系数在 syncDockGeometry（调用方）取用与施加，dockGeometry 保持单参纯净');
  ok(/Math\.round\(geo\.winW\s*\*\s*s\)/.test(syncBody) && /Math\.round\(geo\.winH\s*\*\s*s\)/.test(syncBody),
    '§L dockW/dockH 语义 = 屏幕真实 DIP = round(base × s)');
})();

/* ============================================================
 * §M  X4.7：落点记录的尺寸必须随缩放一起刷新（R3 缺陷回归护栏）
 * ------------------------------------------------------------
 * 症状（w-g-scale 真机复现）：定位好浮窗 → 改「浮窗大小」→ **不拖动、直接重启** →
 *   浮窗跳回默认位，且落点记忆**永久丢失**（把缩放调回来也找不回）。
 * 根因：dockBounds 只在 dock-drag-end 写；syncDockGeometry 改完 dockW/dockH 后从不刷新落点记录
 *   ⇒ 盘上尺寸停留在旧 s；重启时 loadSettings 按新 s 算期望（如 278）看到旧值（174）
 *   ⇒ |174-278| > 8 ⇒ 判脏 ⇒ dockBounds = null ⇒ positionDock() 回默认位。
 *   可达路径：dockBoundsByDisplay 是 v2.4.0 A3 才引入的 ⇒ pre-v2.4.0 老文件只写 dockBounds
 *   ⇒ 升级到 3.3.0 后从未再拖动、只改过浮窗大小 ⇒ 必现。
 *
 * 本段钉的不变量（**无条件**，对 dockWin 存在性不敏感）：
 *   任何 syncDockGeometry() 调用返回后，落点记录的 width/height 必与当前 dockW/dockH 同口径。
 *
 * ✓ 终裁（team-lead，2026 本轮）：dockBoundsByDisplay **既有键随同刷新** —— 宽度/高度同步为当前
 *   DIP，保留各自 x/y；**绝不新增键、绝不清空、绝不删除**（实现 :1362-1372 只遍历既有键原地改写）。
 *   依据：① 下游 pickDockRestore → dockClamped 只取 x/y，尺寸不进 loadSettings 校验也不被消费 ⇒ 零行为差异；
 *   ② dockW/dockH = round(geo.winW × s) 是 DIP、与显示器 DPI 无关 ⇒ 同造型+缩放在任何屏同值 ⇒ 刷成它是真值；
 *   ③ 消除同族字段的误导性陈旧数据（lead 本轮曾被陈旧尺寸误导）。
 *   ⚠ 我最初据任务书写死「刻意不刷新」，与本实现冲突；现按终裁改为正向断言（见 B-6）。
 * ⚠ loadSettings（:92-107）一个字未动：仍会对「与生效造型期望尺寸 ±8 不符」的落点判脏丢弃。
 *   本段保护的是「落盘值被及时刷新、不再变成脏值」，不是放宽那道门。
 * ============================================================ */
(function () {
  const M_SYNC = codeOnly(extractFn(MAIN, 'syncDockGeometry'));

  /* M-1 静态：刷新语句存在，写的是**当前 DIP**（dockW/dockH），不是基础值 geo.winW/winH。
   * 形态无关写法（不要求 x/y 取自 nb.x）—— 解耦前后都能过。 */
  ok(/dockBounds\s*=\s*\{[\s\S]{0,140}?width:\s*dockW\s*,\s*height:\s*dockH/.test(M_SYNC),
    '§M★ syncDockGeometry 内含落点尺寸刷新（width: dockW, height: dockH）');
  ok(!/dockBounds\s*=\s*\{[^}]*width:\s*geo\.(winW|cardW)/.test(M_SYNC),
    '§M★ 负向：刷新不得写成基础值（geo.winW/cardW）—— 盘上必须是与校验侧同口径的 DIP');

  /* M-2 静态：只在「原本已有记录」时刷新（不得凭空造记录），且仅在值真变时写盘（幂等）。
   * 断言刻意**不绑定守卫的书写形态** —— `if (dockBounds)` 与 `if (dockBounds && …)` 都接受
   * （上一版我写死成 `dockBounds\s*&&`，被一次等价重构打红 —— 形态耦合是脆弱断言的根源）。 */
  ok(/if\s*\(\s*dockBounds\s*[)&]/.test(M_SYNC),
    '§M 刷新带 `dockBounds` 真值守卫：从未定位过（null）不凭空创建记录');
  ok(/dockBounds\.width\s*!==\s*dockW[\s\S]{0,120}?dockBounds\.height\s*!==\s*dockH/.test(M_SYNC),
    '§M 刷新带尺寸比较：已有记录但尺寸未变时不重复写盘（幂等，避免无谓刷盘）');

  /* M-3 静态：本函数内含 saveSettings() 落盘（applySkinSet / applyNativeStyleAll 的
   * saveSettings 都排在本函数**之前**，不补这一写，强杀进程就会丢落点）。
   * 「只在值真变时才写」的语义由行为面证明（B-1 写 1 次 / B-3、B-4 写 0 次），
   * 静态不断言它在刷新语句后多少字符内 —— 那种写法会被等价的「置标记 → 统一收尾落盘」重构打红。 */
  ok(/saveSettings\s*\(\s*\)/.test(M_SYNC),
    '§M★ syncDockGeometry 内含 saveSettings() 落盘动作');

  /* M-4 静态（**无条件不变量**）：尺寸刷新必须位于 `if (dockWin && !dockWin.isDestroyed())`
   * 块**之外** —— 否则 dockWin 为 null（建窗前 / 已销毁）时刷新不发生，不变量不成立。 */
  function blockOf(src, marker) {
    const i = src.indexOf(marker);
    if (i < 0) { return null; }
    let start = src.indexOf('{', i);
    if (start < 0) { return null; }
    let d = 0;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') { d++; }
      else if (src[j] === '}') { d--; if (d === 0) { return src.slice(start, j + 1); } }
    }
    return null;
  }
  const winBlock = blockOf(M_SYNC, 'if (dockWin && !dockWin.isDestroyed())');
  ok(!!winBlock, '§M 静态：syncDockGeometry 仍以 `if (dockWin && !dockWin.isDestroyed())` 守卫窗口操作');
  const outsideWin = winBlock ? M_SYNC.split(winBlock).join('«WINBLOCK»') : M_SYNC;
  ok(/dockBounds\s*=\s*\{[\s\S]{0,140}?width:\s*dockW\s*,\s*height:\s*dockH/.test(outsideWin),
    '§M★★ 无条件不变量：落点尺寸刷新在 `if (dockWin && !dockWin.isDestroyed())` 块**之外**（dockWin 为 null 时也刷新）');

  /* M-5 静态（负向，终裁口径）：该表若被触碰，必须是**按既有键原地改写**，不得整体重置 / 清空 /
   *   删除、也不得整体新建赋值。终裁 = 既有键随同刷新（见段头），故正向断言落在行为面 B-6。
   *   ⚠ 实现 :1362-1372 用 `for…in` + `hasOwnProperty` 遍历既有键原地写 ⇒ 不可能新增键（白名单语义），
   *   静态只钉「不复写整表」这一条，形态无关。 */
  ok(!/\bdockBoundsByDisplay\s*=\s*\{/.test(M_SYNC) &&
     !/\bdockBoundsByDisplay\s*=\s*null/.test(M_SYNC) &&
     !/delete\s+dockBoundsByDisplay/.test(M_SYNC),
    '§M★ 负向：syncDockGeometry 不得整体重置/清空/删除 dockBoundsByDisplay（只允许按既有键改写）');

  /* ---------- 行为面：真跑 syncDockGeometry（隔离台，含最小 mock） ---------- */
  let makeSync = null;
  try {
    const src = [
      geoSrcBase,                                   // DOCK_SHAPES / DOCK_SHAPE_KEYS / normShape
      dockGeometrySrc,                              // dockGeometry
      extractFn(MAIN, 'normDockScale'),
      extractFn(MAIN, 'resolveSurfaceConfig'),
      extractFn(MAIN, 'syncDockGeometry')
    ].join('\n\n');
    makeSync = function (st, hk) {
      return new Function('skinObj', 'st', 'hk',
        'var skin = skinObj;' +
        'var dockWin = st.dockWin;' +
        'var dockW = st.dockW, dockH = st.dockH, dockBounds = st.dockBounds;' +
        'var dockBoundsByDisplay = st.dockBoundsByDisplay;' +   // X4.7 补强新增的依赖
        'function taskbarHeight(){ return st.taskbarHeight; }' +
        'function dockClamped(x, y){ return hk.dockClamped(x, y); }' +
        'function pushDockSize(){ hk.pushDockSize(); }' +
        'function saveSettings(){ hk.saveSettings(); }' +
        'function log(m){ hk.log(m); }' +
        src +
        '\nsyncDockGeometry();' +
        '\nreturn { dockW: dockW, dockH: dockH, dockBounds: dockBounds, byDisplay: dockBoundsByDisplay };'
      )(st.skin, st, hk);
    };
  } catch (e) {
    ok(false, '§M 抽取 syncDockGeometry 隔离台失败 — ' + e.message);
  }

  /* 台架：pixel 造型（基础 180×88）+ dockScale，期望 DIP = round(180×s) × round(88×s) */
  function mkSt(opts) {
    const hk = {
      saves: 0, pushes: 0,
      dockClamped: function (x, y) { return { x: x, y: y }; },
      pushDockSize: function () { hk.pushes++; },
      saveSettings: function () { hk.saves++; },
      log: function () {}
    };
    const st = {
      skin: { surfaces: { calendar: { shape: 'rect' }, dock: { follow: null, shape: 'pixel' } },
              dockScale: opts.scale },
      taskbarHeight: 50,
      dockW: opts.oldW, dockH: opts.oldH, dockBounds: opts.bounds,
      dockWin: opts.withWin ? {
        isDestroyed: function () { return false; },
        getBounds: function () { return { x: 100, y: 200, width: opts.oldW, height: opts.oldH }; },
        setBounds: function () {},
        webContents: { setZoomFactor: function () {} }
      } : null
    };
    return { st: st, hk: hk };
  }

  if (makeSync) {
    /* B-1 窗口存在 + 尺寸与目标不符 + 已有记录（旧 s） → 刷新为当前 DIP 并落盘 */
    let t = mkSt({ scale: 1.5, oldW: 180, oldH: 88,
      bounds: { x: 100, y: 200, width: 180, height: 88 }, withWin: true });
    let r = makeSync(t.st, t.hk);
    eq(r.dockW, 270, '§M B-1 dockW = round(180 × 1.5) = 270');
    eq(r.dockH, 132, '§M B-1 dockH = round(88 × 1.5) = 132');
    ok(!!r.dockBounds && r.dockBounds.width === 270 && r.dockBounds.height === 132,
      '§M★ B-1 落点记录刷新为当前 DIP 270×132（实际 ' +
      JSON.stringify(r.dockBounds) + '）');
    ok(r.dockBounds && r.dockBounds.x === 100 && r.dockBounds.y === 200,
      '§M B-1 刷新保留原落点 x/y（只换尺寸，不动位置）');
    ok(t.hk.saves >= 1, '§M★ B-1 刷新后已 saveSettings()（实际调用 ' + t.hk.saves + ' 次）');

    /* B-2 【无条件不变量】dockWin 为 null 时仍须刷新 —— 与窗口存在性无关 */
    t = mkSt({ scale: 1.5, oldW: 180, oldH: 88,
      bounds: { x: 100, y: 200, width: 180, height: 88 }, withWin: false });
    t.st.dockBoundsByDisplay = { 'DISPLAY-A': { x: 100, y: 200, width: 180, height: 88 } };
    r = makeSync(t.st, t.hk);
    eq(r.dockW, 270, '§M B-2 dockWin=null 时 dockW 仍更新为 270');
    ok(!!r.dockBounds && r.dockBounds.width === 270 && r.dockBounds.height === 132,
      '§M★★ B-2 无条件不变量：dockWin=null 时落点记录仍被刷新为 270×132（实际 ' +
      JSON.stringify(r.dockBounds) + '）');
    ok(!!r.byDisplay && r.byDisplay['DISPLAY-A'].width === 270 && r.byDisplay['DISPLAY-A'].height === 132,
      '§M★★ B-2 无条件不变量：dockWin=null 时 dockBoundsByDisplay 既有键同样被刷新为 270×132（实际 ' +
      JSON.stringify(r.byDisplay && r.byDisplay['DISPLAY-A']) + '）');

    /* B-3 反向：从未定位过（dockBounds=null）→ 不得凭空创建记录，也不该无谓写盘 */
    t = mkSt({ scale: 1.5, oldW: 180, oldH: 88, bounds: null, withWin: true });
    r = makeSync(t.st, t.hk);
    eq(r.dockBounds, null, '§M★ B-3 反向：dockBounds=null 时不得凭空创建记录');
    eq(t.hk.saves, 0, '§M★ B-3 反向：未创建记录时不得 saveSettings（避免无谓刷盘）');

    /* B-4 幂等：记录已是当前口径 + 窗口尺寸与目标一致 → 不重复写盘 */
    t = mkSt({ scale: 1.5, oldW: 270, oldH: 132,
      bounds: { x: 100, y: 200, width: 270, height: 132 }, withWin: true });
    r = makeSync(t.st, t.hk);
    eq(t.hk.saves, 0, '§M B-4 幂等：尺寸与记录都已同口径 → 不重复 saveSettings');
    ok(r.dockBounds && r.dockBounds.width === 270 && r.dockBounds.height === 132,
      '§M B-4 幂等后记录仍为 270×132（未被清空/改写）');

    /* B-5 跟随态：dock follow=calendar（shape 解析为 rect）也要刷新 ——
     * 这正是 pre-v2.4.0 老文件「只改过浮窗大小」的那条必现路径。 */
    t = mkSt({ scale: 1.5, oldW: 116, oldH: 50, bounds: { x: 10, y: 20, width: 116, height: 50 }, withWin: true });
    t.st.skin.surfaces.dock.follow = 'calendar';
    r = makeSync(t.st, t.hk);
    eq(r.dockW, 174, '§M B-5 跟随态解析为 rect：dockW = round(116 × 1.5) = 174');
    ok(!!r.dockBounds && r.dockBounds.width === 174,
      '§M★ B-5 跟随态同样刷新落点尺寸（实际 ' + JSON.stringify(r.dockBounds) + '）');

    /* B-6 dockBoundsByDisplay【终裁：既有键随同刷新，但绝不新增/清空/删除】
     * 覆盖 ①正向 既有键尺寸 == 当前 DIP（含第二屏）②正向 刷新路径落盘
     *      ③负向 键集不多不少（不新增）④负向 各键原落点 x/y 保留（不清空/不动位置）。 */
    t = mkSt({ scale: 1.5, oldW: 180, oldH: 88,
      bounds: { x: 100, y: 200, width: 180, height: 88 }, withWin: true });
    t.st.dockBoundsByDisplay = {
      'DISPLAY-A': { x: 100, y: 200, width: 180, height: 88 },   // 尺寸为旧 s
      'DISPLAY-B': { x: 7, y: 9, width: 116, height: 50 }        // 另一屏：尺寸各异
    };
    r = makeSync(t.st, t.hk);
    /* ③ 负向：键集不多不少（hasOwnProperty 遍历既有键 ⇒ 绝不新增） */
    eq(Object.keys(r.byDisplay).sort().join(','), 'DISPLAY-A,DISPLAY-B',
      '§M★ B-6 负向：不新增 dockBoundsByDisplay 键（不得替用户凭空记下一个显示器）');
    /* ① 正向：既有键尺寸同步为当前 DIP 270×132 */
    ok(r.byDisplay['DISPLAY-A'].width === 270 && r.byDisplay['DISPLAY-A'].height === 132,
      '§M★ B-6 正向：DISPLAY-A 尺寸随同刷新为当前 DIP 270×132（实际 ' +
      JSON.stringify(r.byDisplay['DISPLAY-A']) + '）');
    ok(r.byDisplay['DISPLAY-B'].width === 270 && r.byDisplay['DISPLAY-B'].height === 132,
      '§M★ B-6 正向：DISPLAY-B（另一屏、原尺寸不同）同样刷新为 270×132（实际 ' +
      JSON.stringify(r.byDisplay['DISPLAY-B']) + '）');
    /* ④ 负向：各键原落点 x/y 保留 —— 只换尺寸，不清空/不动位置 */
    ok(r.byDisplay['DISPLAY-A'].x === 100 && r.byDisplay['DISPLAY-A'].y === 200 &&
       r.byDisplay['DISPLAY-B'].x === 7 && r.byDisplay['DISPLAY-B'].y === 9,
      '§M B-6 负向：既有键原落点 x/y 保留（只换尺寸，不清空/不动位置）');
    /* ② 正向：尺寸确有变更 ⇒ 刷新路径上必须落盘 */
    ok(t.hk.saves >= 1, '§M★ B-6 正向：刷新 dockBoundsByDisplay 后已 saveSettings()（实际 ' +
      t.hk.saves + ' 次）');

    /* B-6b 幂等：既有键尺寸已是当前 DIP → 不新增、不改写、不无谓写盘 */
    t = mkSt({ scale: 1.5, oldW: 270, oldH: 132,
      bounds: { x: 100, y: 200, width: 270, height: 132 }, withWin: true });
    t.st.dockBoundsByDisplay = { 'DISPLAY-A': { x: 100, y: 200, width: 270, height: 132 } };
    r = makeSync(t.st, t.hk);
    eq(Object.keys(r.byDisplay).join(','), 'DISPLAY-A',
      '§M B-6b 无变更时仍不新增键');
    ok(r.byDisplay['DISPLAY-A'].width === 270 && r.byDisplay['DISPLAY-A'].height === 132,
      '§M B-6b 尺寸已同口径 → 原值保留、不被清空/改写');
    eq(t.hk.saves, 0, '§M B-6b 尺寸已同口径 → 不重复写盘（幂等）');

    /* B-7 从未定位过 + 无用显示器记录 → 两个表都不该被创建，且不写盘 */
    t = mkSt({ scale: 1.5, oldW: 180, oldH: 88, bounds: null, withWin: true });
    t.st.dockBoundsByDisplay = null;
    r = makeSync(t.st, t.hk);
    eq(r.dockBounds, null, '§M B-7 两表皆空时仍不创建 dockBounds');
    eq(r.byDisplay, null, '§M B-7 两表皆空时仍不创建 dockBoundsByDisplay');
    eq(t.hk.saves, 0, '§M B-7 无任何变更时不写盘');
  }
})();

/* ============================================================
 * §N  Y2 回显对齐：取景区「当前造型不显示图片」提示（skincustom.html）
 * ------------------------------------------------------------
 * 「有图 + 生效造型非 rect」是可达态：导入图片会把造型归位 'rect'（electron-main.js:1026），
 * 但用户随后在「浮窗样式」里只写 shape、刻意不清 image（:960）⇒ 配置有图、浮窗一片空白。
 * 本窗必须解释，且判据必须读 **resolved**（跟随时解析到日历面、恒 'rect'）；
 * 读 skin.surfaces.dock.shape 会在「跟随中」误报。
 * ============================================================ */
(function () {
  /* N-1 DOM：提示元素存在，且**初始** display:none（须由 renderCrop 按判据开启，避免首帧可见） */
  const warnTag = (SKINCUSTOM.match(/<div\s+id="cropShapeWarn"[^>]*>/) || [''])[0];
  ok(warnTag !== '', '§N skincustom.html 含 #cropShapeWarn 元素');
  ok(/style="display:\s*none"/.test(warnTag),
    '§N★ #cropShapeWarn 初始 style="display:none"（由 renderCrop 按判据开/关）');

  /* N-2 CSS：规则存在 + 暗色主题变体 */
  ok(/#cropShapeWarn\s*\{/.test(SKINCUSTOM), '§N CSS 含 #cropShapeWarn 规则');
  ok(/html\[data-theme="dark"\]\s*#cropShapeWarn\s*\{/.test(SKINCUSTOM),
    '§N CSS 含 #cropShapeWarn 暗色主题变体');

  /* N-3 判据函数（真身抽取 + 去注释）。
   * 为什么必须去注释：源码注释里**同时**写了正确写法与错误写法（「必须读 resolved 而非
   * skin.surfaces.dock.shape」）⇒ 不去注释，正向与负向两条断言会互相打架。 */
  const cropCode = codeOnly(extractFn(SKINCUSTOM, 'renderCrop'));
  ok(/S\.resolved\[S\.surface\]\.shape/.test(cropCode),
    '§N★ renderCrop 读**生效**造型 S.resolved[S.surface].shape');
  ok(!/skin\.surfaces\s*\[/.test(cropCode),
    '§N★ 负向：renderCrop 不得读 skin.surfaces[...]（跟随时那是浮窗自身值 ⇒ 误报）');

  /* N-4 判据三要素齐备 + 显式写 display */
  ok(/S\.surface\s*===\s*'dock'/.test(cropCode) && /hasImg/.test(cropCode) &&
     /effShape\s*!==\s*'rect'/.test(cropCode),
    "§N★ 判据三要素齐备：surface === 'dock' && hasImg && effShape !== 'rect'");
  ok(/\$\('cropShapeWarn'\)\.style\.display\s*=/.test(cropCode),
    '§N renderCrop 显式设置 #cropShapeWarn 的 display');

  /* N-5 文案含关键句 */
  const warnText = ((SKINCUSTOM.match(/<div\s+id="cropShapeWarn"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
  ok(warnText.indexOf('当前造型不显示图片') >= 0,
    '§N 提示文案含「当前造型不显示图片」');

  /* N-6 负向（口径唯一性）：skincustom.html 不得成为**第三份**六造型名口径。
   * 判据 = 「六名中出现的**不同**名字数 ≤ 1」：文案里可以点名**目标**造型（圆角卡片，UI 必需），
   * 但不得并列列举多名 —— 那才等于复制一份口径清单。
   * ⚠ 与 lead 任务书「文案不得包含六款造型中文名」**字面不符**：落盘文案含「圆角卡片」×2，
   *   literal 版必红。我按「不得列举多名」的意图实现，并把该冲突回报 lead 定夺（未擅自改产品文件）。 */
  const NAME_LIST = SHAPES.map(function (s) { return SHAPE_NAMES[s]; });
  const namesInText = NAME_LIST.filter(function (nm) { return warnText.indexOf(nm) >= 0; });
  const namesInFile = NAME_LIST.filter(function (nm) { return SKINCUSTOM.indexOf(nm) >= 0; });
  ok(namesInText.length <= 1,
    '§N★ 负向：提示文案不得并列列举造型名（不同名 ≤ 1；实际 ' + (namesInText.join('/') || '无') + '）');
  ok(namesInFile.length <= 1,
    '§N★ 负向：skincustom.html 不得成为第三份六造型名口径（不同名 ≤ 1；实际 ' + (namesInFile.join('/') || '无') + '）');
})();

/* ============================================================
 * §O  H4 父窗口：choose-file 的文件对话框必须挂父窗口（owned window）
 * ------------------------------------------------------------
 * 皮肤设置窗 / 自选图片窗都是 setAlwaysOnTop(true,'screen-saver') 置顶窗；不传父窗口得到的是
 * **无主**顶层窗（真机实测 WS_EX_TOPMOST=false、被压在置顶窗之下、不居中、不联动）。
 * 用 evt.sender 反查发起方作父窗 ⇒ owned window，恒在 owner 之上。
 * 退化分支（无父窗时不传）是刻意的失败面收敛，**不得**改成「绝对必传」。 */
(function () {
  const actStart = MAIN.indexOf("ipcMain.on('skin-action'");
  const actEnd = MAIN.indexOf('\n});', actStart);
  const actBody = codeOnly(MAIN.slice(actStart, actEnd > 0 ? actEnd : MAIN.length));
  ok(actBody.indexOf("action === 'choose-file'") >= 0, "§O skin-action 含 'choose-file' 分支");
  ok(/BrowserWindow\.fromWebContents\(evt\.sender\)/.test(actBody),
    '§O★ choose-file 用 BrowserWindow.fromWebContents(evt.sender) 反查发起方窗口作父窗');
  ok(/chooseParent\s*&&\s*!chooseParent\.isDestroyed\(\)/.test(actBody),
    '§O★ 父窗可用性判据：chooseParent && !chooseParent.isDestroyed()');
  ok(/dialog\.showOpenDialog\(\s*chooseParent\s*,/.test(actBody),
    '§O★ 有父窗分支：dialog.showOpenDialog(chooseParent, chooseOpts)');
  ok(/dialog\.showOpenDialog\(\s*chooseOpts\s*\)/.test(actBody),
    '§O★ 无父窗退化分支：dialog.showOpenDialog(chooseOpts)（刻意保留，不得删）');
})();

/* ================= 收尾 ================= */
console.log('\n===== qa-v330 独立对抗性验证（六造型 / 图片不继承 / 清空）=====');
if (fail) {
  console.error('  ✗ 失败 ' + fail + ' 项：');
  failures.forEach(function (m) { console.error('    - ' + m); });
  console.error('\n  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(1);
}
console.log('  ✓ 全部 ' + pass + ' 项断言通过');
console.log('[qa-v330] PASS');
process.exit(0);
