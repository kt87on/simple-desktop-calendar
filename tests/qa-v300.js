'use strict';
/* ============================================================
 * tests/qa-v300.js —— v3.0.0 皮肤模型 v3 独立对抗性验证（+ v3.1.0 C1 follow 语义）
 * ------------------------------------------------------------
 * 设计原则（与 tests/qa-v244.js 同源）：
 *   1) 只读 electron-main.js 源码，绝不修改 verify_v1721.js / smoke-test.js /
 *      runtime-test_v1721.js（三脚本归工程师维护，避免撞车）。
 *   2) 裸 Node，自建 ok()/eq()/near() 计数器，process.exit(fail?1:0)。
 *   3) extractFn 从源码配平抠出**真实函数体**，注入最小 mock 后在隔离作用域执行
 *      —— 断言「源码里那几行真实逻辑」，而非在测试里复刻一份实现。
 *   4) 全程不读写任何文件/目录（纯内存）。
 *
 * v3.0.0 模型：每面 { style, bg, image, text, clarity, tone }
 *   （**v3.1.0 C1 起 dock 亦为可跟随面**，expanded/desktop/dock 均带 follow）
 *   style ∈ {default,minimal,glass,neu,tech,warm}；bg ∈ {native,image}；
 *   text ∈ {auto,light,dark}（仅文字轴）；tone ∈ {auto,light,dark,system}（明暗轴）。
 *
 * 覆盖：
 *   §1 normStyle / normBg / normTone 白名单（非法一律回落默认，绝不透传脏值）
 *   §2 normalizeSurfaceV3 单面归一化 + 防白屏不变量（bg=image 无图 → 回落 native）
 *   §3 normalizeSkinV3：__v 恒 3、4 面齐全、opacity 三元组、垃圾输入不抛
 *   §4 migrateSkinV2toV3：五类 v2 type 映射 + 旧字段保留 + 防白屏 + 幂等
 *   §5 styleNativeTheme / surfaceTheme 明暗优先级（image.dark > tone 显式 > system > style）
 *   §6 surfaceTheme 与 text 完全解耦（改深浅字绝不改整窗明暗）
 *   §7 surfaceBg / solidFallbackFor（native / image / 无图兜底色）
 *   §8 resolvedSurfaceState 下发结构 + warn 真值表 + clarity 联动
 *   §9 clarityForConfig 的 v3 判据（bg=image 按 complexity 推导，其余归零）
 *   §10 cleanupStaleInstances：dev 短路 / self 不在候选即放弃 / 只杀子孙外的 stale
 *   §11【v3.1.0 C1】normalizeSurfaceV3 的 follow 语义（pristine→calendar / 非 pristine→null / 幂等）
 *   §12【v3.1.0 C1】migrateSkinV2toV3 的 dock follow 口径（oldType 判定）+ 两条路径刻意不同守护
 *   §13【v3.1.0 回归护栏】真实用户 v3.0.0 遗留 dock 形态（无 follow 且非 pristine）→ 端到端
 *       resolveSurfaceConfig('dock') 必须解析回 dock 自身（minimal），绝不被 calendar 覆盖
 * ============================================================ */

const fs = require('fs');
const path = require('path');

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
function deepEq(a, b, msg) { eq(JSON.stringify(a), JSON.stringify(b), msg); }

/* ================= 注释剥离（结构断言用） ================= */
function codeOnly(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* ================= extractFn：大括号配平抠真实函数体 ================= */
function extractFn(src, name) {
  const key = 'function ' + name + '(';
  const idx = src.indexOf(key);
  if (idx < 0) throw new Error('qa-v300: 源码未找到函数 ' + name);
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
  throw new Error('qa-v300: 配平失败 ' + name);
}

/* 边界抽取：cleanupStaleInstances 里含正则 /'/g，会令字符串扫描器失步；
 * 改为「从函数声明切到下一个顶层 function 声明之前」——对这类函数更稳。 */
function extractFnBoundary(src, name) {
  const key = 'function ' + name + '(';
  const start = src.indexOf(key);
  if (start < 0) throw new Error('qa-v300: 源码未找到函数 ' + name);
  const re = /\nfunction [A-Za-z_$]/g;
  re.lastIndex = start + key.length;
  const m = re.exec(src);
  return src.slice(start, m ? m.index : src.length);
}

/* ================= 组装被测函数（隔离作用域 + 最小注入） ================= */
const FN_NAMES = [
  // 基础夹取 / 校验
  'clamp01', 'clampZoom', 'clampImageOpacity', 'clampOpacity',
  'validHex', 'isDarkColor', 'sanitizeBasename',
  // 图片 / 皮肤归一化
  'normalizeClarity', 'normalizeImageSpec', 'normalizeSkin',
  // v3 白名单 + 单面/整体归一化
  // v3.3.0 C2：normalizeSurfaceV3 新增 shape 归一 → 跨函数调用 normShape（内联白名单，单独抽取即可自洽）。
  // 不加入本名单会在隔离作用域 ReferenceError（同 tests/qa-v244.js 的 FN_NAMES 维护义务）。
  'normStyle', 'normBg', 'normTone', 'normShape',
  // v3.3.0 X4：normalizeSkinV3 / migrateSkinV2toV3 新增 normDockScale 调用
  //（同款内联白名单，只依赖 Math/Number，单独抽取即可自洽）。
  'normDockScale',
  'normalizeSurfaceV3', 'normalizeSkinV3',
  // v2→v3 迁移
  'migrateSkinV2toV3',
  // 中枢解析
  'resolveSurfaceConfig', 'styleNativeTheme', 'surfaceTheme', 'solidFallbackFor',
  'surfaceBg', 'baseTheme', 'clarityForConfig', 'resolvedSurfaceState'
];

/* migrateSkinV2toV3 依赖顶层常量 V2_TYPE_MAP（非函数，extractFn 抓不到）→ 单独抠出。 */
let V2MAP_SRC = '';
try {
  const m = /var V2_TYPE_MAP = \{[\s\S]*?\};/.exec(SRC);
  if (!m) throw new Error('源码未找到 V2_TYPE_MAP');
  V2MAP_SRC = m[0];
} catch (e) {
  console.error('qa-v300: 抽取 V2_TYPE_MAP 失败 — ' + e.message);
  process.exit(1);
}

let FN_SRC = '';
try {
  FN_SRC = V2MAP_SRC + '\n\n' + FN_NAMES.map(function (n) { return extractFn(SRC, n); }).join('\n\n');
} catch (e) {
  console.error('qa-v300: 抽取函数失败 — ' + e.message);
  console.error('（可能函数签名变动，请核对 electron-main.js）');
  process.exit(1);
}

const makeApi = new Function(
  'skinObj', 'nativeThemeGlobal',
  [
    'var skin = skinObj;',
    'var nativeTheme = nativeThemeGlobal;',
    FN_SRC,
    'return { ' + FN_NAMES.join(', ') + ' };'
  ].join('\n')
);

/** 造一个隔离作用域的 api 实例（skin 与 nativeTheme 均可控）。 */
function api(skinObj, nativeThemeGlobal) {
  return makeApi(skinObj || null, nativeThemeGlobal || { shouldUseDarkColors: false });
}

/* ================= 构造器 ================= */
/** v3 皮肤夹具（每面含 style/bg/image/text/clarity/tone）。 */
function v3skin(over) {
  over = over || {};
  function face(base, o) { return Object.assign({}, base, o || {}); }
  const base = { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' };
  const followBase = Object.assign({}, base, { follow: 'calendar' });
  return {
    __v: 3,
    surfaces: {
      calendar: face(base, over.calendar),
      expanded: face(followBase, over.expanded),
      desktop: face(followBase, over.desktop),
      dock: face(base, over.dock)
    },
    opacity: Object.assign({ calendar: 1, desktop: 1, dock: 1 }, over.opacity || {})
  };
}

/** v2 皮肤夹具（旧 type/color/image/text/clarity）。 */
function v2skin(over) {
  over = over || {};
  function face(base, o) { return Object.assign({}, base, o || {}); }
  const base = { type: 'light', color: null, image: null, text: 'auto' };
  const followBase = Object.assign({}, base, { follow: 'calendar' });
  return {
    __v: 2,
    surfaces: {
      calendar: face(base, over.calendar),
      expanded: face(followBase, over.expanded),
      desktop: face(followBase, over.desktop),
      dock: face(base, over.dock)
    },
    opacity: Object.assign({ calendar: 1, desktop: 1, dock: 1 }, over.opacity || {})
  };
}

/** 合法 image spec。 */
function imgSpec(over) {
  return Object.assign({
    file: 'a.jpg', snapshot: null, w: 800, h: 600,
    crop: { x: 0, y: 0, w: 1, h: 1 }, zoom: 1, opacity: 1,
    dark: true, complexity: 0.5
  }, over || {});
}

/* ============================================================
 * §1 normStyle / normBg / normTone 白名单
 * ============================================================ */
(function () {
  const A = api();
  const okStyles = ['default', 'minimal', 'glass', 'neu', 'tech', 'warm'];
  okStyles.forEach(function (s) { eq(A.normStyle(s), s, '§1 normStyle 合法值保留 ' + s); });
  ['x', 'Color', 'DEFAULT', '', null, undefined, 5, {}, 'minimal ', 'glass2'].forEach(function (v, i) {
    eq(A.normStyle(v), 'default', '§1 normStyle 非法#' + i + ' → default');
  });

  eq(A.normBg('image'), 'image', '§1 normBg image 保留');
  eq(A.normBg('native'), 'native', '§1 normBg native 保留');
  // bg='color' 已从用户可选集删除（仅内部兜底态）→ 一律回落 native
  eq(A.normBg('color'), 'native', '§1 normBg color 回落 native（不再可选）');
  ['', null, undefined, 1, {}, 'IMAGE', 'Image'].forEach(function (v, i) {
    eq(A.normBg(v), 'native', '§1 normBg 非法#' + i + ' → native');
  });

  ['light', 'dark', 'system', 'auto'].forEach(function (s) {
    eq(A.normTone(s), s, '§1 normTone 合法值保留 ' + s);
  });
  ['LIGHT', 'Dark', '', null, undefined, 1, {}, 'sys'].forEach(function (v, i) {
    eq(A.normTone(v), 'auto', '§1 normTone 非法#' + i + ' → auto');
  });
})();

/* ============================================================
 * §2 normalizeSurfaceV3 单面归一化 + 防白屏不变量
 * ============================================================ */
(function () {
  const A = api();

  // 合法面原样归一
  const c1 = A.normalizeSurfaceV3({ style: 'tech', bg: 'native', text: 'dark', clarity: 60, tone: 'dark' }, false);
  eq(c1.style, 'tech', '§2 单面 style 保留');
  eq(c1.bg, 'native', '§2 单面 bg 保留');
  eq(c1.text, 'dark', '§2 单面 text 保留');
  eq(c1.clarity, 60, '§2 单面 clarity 保留');
  eq(c1.tone, 'dark', '§2 单面 tone 保留');
  eq(c1.image, null, '§2 bg=native 时 image 强制 null');
  /* 注意：本调用的第 2 参显式传 isFollowable=false，故无 follow 字段（与「dock 是否可跟随」无关）。
   * v3.1.0 C1 起 dock 已是可跟随面，见 §11。 */
  ok(!('follow' in c1), '§2 isFollowable=false 的面不带 follow 字段');

  // 可跟随面带 follow（v3.1.0 起 expanded/desktop/dock 均为可跟随面）
  const c2 = A.normalizeSurfaceV3({ follow: 'calendar' }, true);
  eq(c2.follow, 'calendar', '§2 可跟随面 follow=calendar 保留');
  const c3 = A.normalizeSurfaceV3({ follow: 'x' }, true);
  eq(c3.follow, null, '§2 follow 非法值 + followDefault 非 calendar → null');

  // 脏值一律回落
  const c4 = A.normalizeSurfaceV3({ style: 'bogus', bg: 'color', text: 'weird', clarity: -9, tone: 'nope' }, false);
  eq(c4.style, 'default', '§2 脏 style → default');
  eq(c4.bg, 'native', '§2 脏 bg(color) → native');
  eq(c4.text, 'auto', '§2 脏 text → auto');
  eq(c4.clarity, 0, '§2 clarity 负数 → 0（经 normalizeClarity）');
  eq(c4.tone, 'auto', '§2 脏 tone → auto');

  // 防白屏：bg=image 但图缺失 → 回落 native，绝不留下 image 空壳
  const c5 = A.normalizeSurfaceV3({ bg: 'image', image: null }, false);
  eq(c5.bg, 'native', '§2 bg=image 无图 → 回落 native（防白屏）');
  eq(c5.image, null, '§2 回落 native 后 image 为 null');

  const c6 = A.normalizeSurfaceV3({ bg: 'image', image: { file: '' } }, false);
  eq(c6.bg, 'native', '§2 bg=image 但 file 非法 → 回落 native');

  // 有图则保留
  const c7 = A.normalizeSurfaceV3({ bg: 'image', image: imgSpec({ file: 'p.png' }) }, false);
  eq(c7.bg, 'image', '§2 bg=image 有合法图 → 保留 image');
  ok(c7.image && c7.image.file === 'p.png', '§2 image.file 保留');

  // 空/undefined 输入不抛
  const c8 = A.normalizeSurfaceV3(undefined, false);
  eq(c8.style, 'default', '§2 undefined 输入 → 默认 style');
  eq(c8.bg, 'native', '§2 undefined 输入 → native');

  // 不变量：任何输入下，surface 绝不出现 bg=image 且 image=null
  const dirty = [
    {}, { surfaces: {} },
    { surfaces: { calendar: { bg: 'image' } } },
    { surfaces: { calendar: { bg: 'image', image: null } } },
    { surfaces: { calendar: { bg: 'image', image: { file: '' } } } },
    { surfaces: { calendar: { style: 'zzz', bg: 'zzz', image: 'notobj' } } },
    { __v: 3, surfaces: { calendar: { bg: 'image', image: { file: 'ok.jpg' } } }, opacity: 'bad' }
  ];
  let invariantOk = true;
  dirty.forEach(function (raw) {
    try {
      const n = A.normalizeSkinV3(raw);
      ['calendar', 'expanded', 'desktop', 'dock'].forEach(function (s) {
        if (n.surfaces[s].bg === 'image' && !n.surfaces[s].image) invariantOk = false;
      });
    } catch (e) { invariantOk = false; }
  });
  ok(invariantOk, '§2【不变量】任何输入下都不出现 bg=image 且 image=null（防白屏）');
})();

/* ============================================================
 * §3 normalizeSkinV3：__v 恒 3、4 面齐全、opacity 三元组
 * ============================================================ */
(function () {
  const A = api(v3skin());
  const n = A.normalizeSkinV3(v3skin({ opacity: { calendar: 0.5, desktop: 2, dock: 0.1 } }));
  eq(n.__v, 3, '§3 normalizeSkinV3 输出 __v===3');
  deepEq(Object.keys(n.surfaces).sort(), ['calendar', 'desktop', 'dock', 'expanded'], '§3 输出 4 个面');
  eq(n.opacity.calendar, 0.5, '§3 opacity.calendar 保留');
  eq(n.opacity.desktop, 1, '§3 opacity.desktop 越界 2 → 夹到 1');
  eq(n.opacity.dock, 0.3, '§3 opacity.dock 0.1 → 夹到下限 0.3');

  const nul = A.normalizeSkinV3(null);
  eq(nul.__v, 3, '§3 normalizeSkinV3(null) 不抛且 __v===3');
  eq(Object.keys(nul.surfaces).length, 4, '§3 null 输入仍补齐 4 个面');
  eq(nul.surfaces.calendar.style, 'default', '§3 null 输入 calendar.style=default');

  // opacity 非对象 → 保持默认 1
  const n2 = A.normalizeSkinV3({ __v: 3, surfaces: {}, opacity: 'bad' });
  eq(n2.opacity.calendar, 1, '§3 opacity 非对象 → 默认 1');
  eq(n2.opacity.dock, 1, '§3 opacity.dock 默认 1');
})();

/* ============================================================
 * §4 migrateSkinV2toV3：五类映射 + 旧字段保留 + 防白屏
 * ============================================================ */
(function () {
  const A = api();

  function mig(cal) { return A.migrateSkinV2toV3(v2skin({ calendar: cal })).surfaces.calendar; }

  const light = mig({ type: 'light' });
  eq(light.style, 'minimal', '§4 light → minimal');
  eq(light.tone, 'light', '§4 light → tone light');
  eq(light.bg, 'native', '§4 light → bg native');

  const dark = mig({ type: 'dark' });
  eq(dark.style, 'minimal', '§4 dark → minimal');
  eq(dark.tone, 'dark', '§4 dark → tone dark');
  eq(dark.bg, 'native', '§4 dark → bg native');

  const sys = mig({ type: 'system' });
  eq(sys.style, 'minimal', '§4 system → minimal');
  eq(sys.tone, 'system', '§4 system → tone system');

  const color = mig({ type: 'color', color: '#FF0000' });
  eq(color.style, 'default', '§4 color → default');
  eq(color.tone, 'auto', '§4 color → tone auto');
  eq(color.bg, 'native', '§4 color → bg native（自定义色值丢弃）');

  const image = mig({ type: 'image', image: imgSpec({ file: 'p.jpg', dark: true, complexity: 0.42 }) });
  eq(image.style, 'default', '§4 image → default');
  eq(image.tone, 'auto', '§4 image → tone auto');
  eq(image.bg, 'image', '§4 image → bg image');
  ok(image.image && image.image.file === 'p.jpg', '§4 image 旧字段 file 原样保留');
  near(image.image.complexity, 0.42, 1e-9, '§4 image 旧 complexity 原样保留');

  // 旧 image 缺失 → 回落 native（防白屏）
  const imageBroken = mig({ type: 'image', image: null });
  eq(imageBroken.bg, 'native', '§4 v2 image 无图 → 回落 native（防白屏）');

  // 未知 type → 视作 light
  const unknown = mig({ type: 'weird' });
  eq(unknown.style, 'minimal', '§4 未知 type → 视作 light → minimal');
  eq(unknown.tone, 'light', '§4 未知 type → tone light');

  // 旧 text / clarity / follow 原样保留
  const keep = mig({ type: 'light', text: 'dark', clarity: 70 });
  eq(keep.text, 'dark', '§4 旧 text 原样保留');
  eq(keep.clarity, 70, '§4 旧 clarity 原样保留');

  const full = A.migrateSkinV2toV3(v2skin({ expanded: { type: 'system', follow: 'calendar' } }));
  eq(full.__v, 3, '§4 迁移输出 __v===3');
  eq(full.surfaces.expanded.follow, 'calendar', '§4 expanded.follow 原样保留');
  eq(full.surfaces.expanded.tone, 'system', '§4 expanded type=system 迁移');
  eq(full.surfaces.dock.style, 'minimal', '§4 dock（默认 light）→ minimal');

  // migrate(null) 不抛且 __v=3
  let nullOk = true;
  try { const m = A.migrateSkinV2toV3(null); nullOk = (m.__v === 3) && !!m.surfaces.calendar; }
  catch (e) { nullOk = false; }
  ok(nullOk, '§4 migrateSkinV2toV3(null) 不抛且产出合法 v3');

  // 迁移不变量：不出现 bg=image 且 image=null
  let migInv = true;
  [[{ type: 'image', image: null }], [{ type: 'image' }], [{ type: 'image', image: { file: '' } }]].forEach(function (arr) {
    const m = A.migrateSkinV2toV3(v2skin({ calendar: arr[0] })).surfaces.calendar;
    if (m.bg === 'image' && !m.image) migInv = false;
  });
  ok(migInv, '§4【不变量】迁移后不出现 bg=image 且 image=null');
})();

/* ============================================================
 * §5 styleNativeTheme / surfaceTheme 明暗优先级
 * ============================================================ */
(function () {
  const A = api();

  eq(A.styleNativeTheme('tech'), 'dark', '§5 styleNativeTheme tech → dark');
  ['default', 'minimal', 'glass', 'neu', 'warm'].forEach(function (s) {
    eq(A.styleNativeTheme(s), 'light', '§5 styleNativeTheme ' + s + ' → light');
  });
  ['', null, undefined, 'weird'].forEach(function (v, i) {
    eq(A.styleNativeTheme(v), 'light', '§5 styleNativeTheme 非法#' + i + ' → light');
  });

  // ① tier: bg=image 且有图 → 按照片暗（压过一切 tone）
  const A_dark = api(v3skin({ calendar: { bg: 'image', image: imgSpec({ dark: true }), tone: 'light' } }));
  eq(A_dark.surfaceTheme('calendar'), 'dark', '§5 tier① image.dark=true 压过 tone=light');
  const A_light = api(v3skin({ calendar: { bg: 'image', image: imgSpec({ dark: false }), tone: 'dark' } }));
  eq(A_light.surfaceTheme('calendar'), 'light', '§5 tier① image.dark=false 压过 tone=dark');

  // ② tier tone 显式
  eq(api(v3skin({ calendar: { tone: 'light' } })).surfaceTheme('calendar'), 'light', '§5 tier② tone=light → light');
  eq(api(v3skin({ calendar: { tone: 'dark', style: 'default' } })).surfaceTheme('calendar'), 'dark', '§5 tier② tone=dark → dark');

  // ③ tier tone=system 跟随 nativeTheme
  eq(api(v3skin({ calendar: { tone: 'system' } }), { shouldUseDarkColors: true }).surfaceTheme('calendar'), 'dark',
    '§5 tier③ tone=system + 系统深 → dark');
  eq(api(v3skin({ calendar: { tone: 'system' } }), { shouldUseDarkColors: false }).surfaceTheme('calendar'), 'light',
    '§5 tier③ tone=system + 系统浅 → light');

  // ④ tier tone=auto → styleNativeTheme
  eq(api(v3skin({ calendar: { style: 'tech', tone: 'auto' } })).surfaceTheme('calendar'), 'dark',
    '§5 tier④ tech + auto → dark');
  eq(api(v3skin({ calendar: { style: 'warm', tone: 'auto' } })).surfaceTheme('calendar'), 'light',
    '§5 tier④ warm + auto → light');

  // baseTheme = surfaceTheme('calendar')
  const Ast = api(v3skin({ calendar: { style: 'tech' } }));
  eq(Ast.baseTheme(), Ast.surfaceTheme('calendar'), '§5 baseTheme === surfaceTheme(calendar)');
})();

/* ============================================================
 * §6 surfaceTheme 与 text 完全解耦
 * ============================================================ */
(function () {
  // text=dark 但 tone 未指定 → 整窗仍按 style 明暗，不因浅字变黑
  const s1 = A_text({ text: 'dark' });
  eq(s1.surfaceTheme('calendar'), 'light', '§6 text=dark 不改变整窗明暗（light）');
  const s2 = A_text({ text: 'light', style: 'tech' });
  eq(s2.surfaceTheme('calendar'), 'dark', '§6 text=light 不改变 tech 的 dark');
  function A_text(cal) { return api(v3skin({ calendar: cal })); }
})();

/* ============================================================
 * §7 surfaceBg / solidFallbackFor
 * ============================================================ */
(function () {
  const native = api(v3skin({ calendar: { bg: 'native' } })).surfaceBg('calendar');
  eq(native.kind, 'native', '§7 bg=native → kind native');

  const image = api(v3skin({ calendar: { bg: 'image', image: imgSpec() } })).surfaceBg('calendar');
  eq(image.kind, 'image', '§7 bg=image 有图 → kind image');
  ok(image.image && image.image.file === 'a.jpg', '§7 kind image 携带 image');

  // 无图兜底 → kind color（绝不透明/白屏）
  const fbLight = api(v3skin({ calendar: { bg: 'image', image: null, tone: 'light' } })).surfaceBg('calendar');
  eq(fbLight.kind, 'color', '§7 bg=image 无图 → kind color（兜底）');
  eq(fbLight.color, '#FCFBF9', '§7 兜底色跟随 light → #FCFBF9');
  const fbDark = api(v3skin({ calendar: { bg: 'image', image: null, tone: 'dark' } })).surfaceBg('calendar');
  eq(fbDark.color, '#1C202C', '§7 兜底色跟随 dark → #1C202C');

  // solidFallbackFor 直接调用
  const Af = api(v3skin({ calendar: { tone: 'dark' } }));
  eq(Af.solidFallbackFor(Af.resolveSurfaceConfig('calendar'), 'calendar'), '#1C202C',
    '§7 solidFallbackFor(tone=dark) → #1C202C');
  const Af2 = api(v3skin({ calendar: { tone: 'light' } }));
  eq(Af2.solidFallbackFor(Af2.resolveSurfaceConfig('calendar'), 'calendar'), '#FCFBF9',
    '§7 solidFallbackFor(tone=light) → #FCFBF9');
})();

/* ============================================================
 * §8 resolvedSurfaceState 下发结构 + warn 真值表 + clarity
 * ============================================================ */
(function () {
  // 默认：native + light + text auto → 无 warn
  const d = api(v3skin()).resolvedSurfaceState('calendar');
  eq(d.style, 'default', '§8 下发 style');
  eq(d.tone, 'auto', '§8 下发 tone');
  eq(d.theme, 'light', '§8 下发 theme');
  eq(d.text, 'auto', '§8 下发 text');
  eq(d.warn, false, '§8 下发 warn=false（浅底+自动字）');
  eq(d.bg, 'native', '§8 下发 bg');
  eq(d.color, null, '§8 native 时 color=null');
  eq(d.image, null, '§8 native 时 image=null');
  eq(d.clarity, 0, '§8 native 时 clarity=0');
  deepEq(Object.keys(d).sort(),
    // v3.3.0 C3：resolvedSurfaceState 新增 shape 字段（浮窗造型下发）
    ['bg', 'clarity', 'color', 'image', 'shape', 'style', 'text', 'theme', 'tone', 'warn'].sort(),
    '§8 下发字段集合完整');

  // warn 真值表：浅底+浅字 / 深底+深字
  eq(api(v3skin({ calendar: { tone: 'light', text: 'dark' } })).resolvedSurfaceState('calendar').warn, true,
    '§8 warn：light 底 + dark 字 → true');
  eq(api(v3skin({ calendar: { tone: 'dark', text: 'light' } })).resolvedSurfaceState('calendar').warn, true,
    '§8 warn：dark 底 + light 字 → true');
  eq(api(v3skin({ calendar: { tone: 'light', text: 'light' } })).resolvedSurfaceState('calendar').warn, false,
    '§8 warn：light 底 + light 字 → false（同向）');
  eq(api(v3skin({ calendar: { tone: 'dark', text: 'dark' } })).resolvedSurfaceState('calendar').warn, false,
    '§8 warn：dark 底 + dark 字 → false（同向）');
  eq(api(v3skin({ calendar: { tone: 'tech', text: 'auto' } })).resolvedSurfaceState('calendar').warn, false,
    '§8 warn：text=auto 恒 false');

  // bg=image → color=null，image 非空，clarity 按 complexity
  const di = api(v3skin({ calendar: { bg: 'image', image: imgSpec({ dark: false, complexity: 0.5 }) } })).resolvedSurfaceState('calendar');
  eq(di.bg, 'image', '§8 bg=image 下发 bg=image');
  ok(di.image && di.image.file === 'a.jpg', '§8 bg=image 下发 image');
  eq(di.color, null, '§8 bg=image 时 color=null');
  eq(di.theme, 'light', '§8 image.dark=false → theme light');
  eq(di.clarity, 50, '§8 image complexity 0.5 → clarity 50');

  // bg=image 无图 → 兜底 color + 非空色值
  const df = api(v3skin({ calendar: { bg: 'image', image: null, tone: 'dark' } })).resolvedSurfaceState('calendar');
  eq(df.bg, 'color', '§8 无图兜底下发 bg=color');
  eq(df.color, '#1C202C', '§8 兜底下发 color 非空');
  eq(df.image, null, '§8 兜底时 image=null');

  // 跟随：expanded/desktop follow=calendar → 与 calendar 相同
  const follow = api(v3skin({
    calendar: { style: 'tech', tone: 'dark' },
    expanded: { follow: 'calendar' }
  }));
  const ce = follow.resolvedSurfaceState('calendar');
  const ee = follow.resolvedSurfaceState('expanded');
  eq(ee.style, ce.style, '§8 follow=calendar 时 expanded.style 跟随 calendar');
  eq(ee.theme, ce.theme, '§8 follow=calendar 时 expanded.theme 跟随 calendar');
  eq(ee.tone, ce.tone, '§8 follow=calendar 时 expanded.tone 跟随 calendar');

  // 非跟随 → 用自身配置
  const nonFollow = api(v3skin({
    calendar: { style: 'tech' },
    expanded: { follow: null, style: 'warm', tone: 'dark' }
  }));
  eq(nonFollow.resolvedSurfaceState('expanded').style, 'warm', '§8 expanded 不跟随 → 用自身 style');
  eq(nonFollow.resolvedSurfaceState('expanded').theme, 'dark', '§8 expanded 不跟随 → 用自身 tone');
})();

/* ============================================================
 * §9 clarityForConfig 的 v3 判据
 * ============================================================ */
(function () {
  const A = api();
  eq(A.clarityForConfig(null), 0, '§9 clarityForConfig(null) → 0');
  eq(A.clarityForConfig({ clarity: 50 }), 50, '§9 数字 50 直用');
  eq(A.clarityForConfig({ clarity: -5 }), 0, '§9 负数 → 0');
  eq(A.clarityForConfig({ clarity: 150 }), 100, '§9 >100 → 100');
  eq(A.clarityForConfig({ clarity: 72.6 }), 73, '§9 小数四舍五入');

  // 'auto' + bg=image → complexity 推导（clamp 20~85）
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0.5 } }), 50, '§9 auto+image cx=0.5 → 50');
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0.05 } }), 20, '§9 auto+image cx=0.05 → 下限 20');
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0.99 } }), 85, '§9 auto+image cx=0.99 → 上限 85');
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'image', image: {} }), 20, '§9 auto+image 无 complexity → 下限 20');
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: NaN } }), 20, '§9 auto+image complexity=NaN → 20');

  // 'auto' + 非 image → 0（不引入多余灰罩）
  eq(A.clarityForConfig({ clarity: 'auto', bg: 'native' }), 0, '§9 auto+native → 0');
  eq(A.clarityForConfig({ clarity: 'auto' }), 0, '§9 auto 无 bg → 0');
})();

/* ============================================================
 * §10 cleanupStaleInstances：dev 隔离 + 安全网 + 只杀 stale
 * ============================================================ */
(function () {
  let CLEAN_SRC;
  try { CLEAN_SRC = extractFnBoundary(SRC, 'cleanupStaleInstances'); }
  catch (e) { console.error('qa-v300: 抽取 cleanupStaleInstances 失败 — ' + e.message); process.exit(1); }
  const makeClean = new Function('app', 'spawn', 'log', 'myProcessPid', 'path',
    CLEAN_SRC + '\nreturn cleanupStaleInstances;');

  function runCleanup(opts) {
    opts = opts || {};
    const calls = { ps: 0, kill: 0, killArgs: null, logs: [] };
    const app = { isPackaged: !!opts.packaged };
    const spawnMock = function (cmd, args) {
      if (cmd === 'taskkill.exe') {
        calls.kill++; calls.killArgs = args.slice();
        return { stdout: { on: function () {} }, on: function () {} };
      }
      calls.ps++;
      const rowsText = (opts.rows === undefined) ? '' : opts.rows;
      return {
        stdout: { on: function (ev, cb) { if (ev === 'data' && rowsText) cb(Buffer.from(rowsText)); } },
        on: function (ev, cb) { if (ev === 'close') cb(opts.code || 0); }
      };
    };
    const log = function (m) { calls.logs.push(String(m)); };
    makeClean(app, spawnMock, log, opts.selfPid, path)();
    return calls;
  }

  // ① dev 短路：绝不 spawn、绝不 taskkill
  const dev = runCleanup({ packaged: false, selfPid: 100, rows: '999 1\n' });
  eq(dev.ps, 0, '§10【关键】dev 形态不启动 powershell');
  eq(dev.kill, 0, '§10【关键】dev 形态绝不 taskkill（防误杀真实实例）');
  ok(dev.logs.join('|').indexOf('dev build') >= 0, '§10 dev 短路有日志可循');

  // ② 安全网：self 不在候选集 → 放弃，绝不 taskkill
  const notSelf = runCleanup({ packaged: true, selfPid: 999, rows: '100 1\n101 100\n' });
  eq(notSelf.ps, 1, '§10 打包形态才启动 powershell');
  eq(notSelf.kill, 0, '§10【关键】self 不在候选集 → 放弃清理，绝不 taskkill');
  ok(notSelf.logs.join('|').indexOf('not in candidate set') >= 0, '§10 放弃时留下告警日志');

  // ③ 只杀「子孙传递闭包」之外的 stale
  const kill1 = runCleanup({ packaged: true, selfPid: 100, rows: '100 1\n101 100\n200 1\n' });
  eq(kill1.kill, 1, '§10 有 stale 时 taskkill 一次');
  deepEq(kill1.killArgs, ['/F', '/PID', '200'], '§10 只杀 stale=200，不碰自己/子进程');

  // ④ 传递闭包：孙进程也属自己，绝不误杀
  const kill2 = runCleanup({ packaged: true, selfPid: 100, rows: '100 1\n101 100\n102 101\n200 1\n300 1\n' });
  deepEq(kill2.killArgs, ['/F', '/PID', '200', '300'], '§10 子孙闭包内(100/101/102)全保留，只杀外部的 200/300');

  // ⑤ 仅自己一棵树 → 不杀
  const onlySelf = runCleanup({ packaged: true, selfPid: 100, rows: '100 1\n101 100\n' });
  eq(onlySelf.kill, 0, '§10 只剩自己树 → 不 taskkill');
  ok(onlySelf.logs.join('|').indexOf('no stale peers') >= 0, '§10 无 stale 有日志');

  // ⑥ 拿不到任何进程信息 → 放弃
  const empty = runCleanup({ packaged: true, selfPid: 100, rows: '' });
  eq(empty.ps, 1, '§10 空输出仍只启动一次 powershell');
  eq(empty.kill, 0, '§10 无进程信息 → 绝不 taskkill');
  ok(empty.logs.join('|').indexOf('no process info') >= 0, '§10 无进程信息有日志');

  // ⑦ 源码护栏：进程名不硬编码，改用 path.basename(process.execPath)
  const code = codeOnly(CLEAN_SRC);
  ok(code.indexOf('SimpleCalendar.exe') < 0, '§10【关键】清理逻辑不再硬编码 SimpleCalendar.exe');
  ok(/path\.basename\(process\.execPath\)/.test(code), '§10 进程名改用 path.basename(process.execPath)');
  ok(/app\.isPackaged/.test(code), '§10 源码含 app.isPackaged 形态判断');
})();

/* ============================================================
 * §11 C1 · normalizeSurfaceV3 的 follow 语义（v3.1.0：dock 纳入跟随）
 * ------------------------------------------------------------
 * 签名 (s, isFollowable, followDefault)。follow 规则：
 *   显式 'calendar' → 'calendar'；显式 null（用户取消过）→ null；
 *   缺失/其它非法 → 仅当 followDefault==='calendar' 且该面 pristine（六项全出厂默认）→ 'calendar'，否则 null。
 * ============================================================ */
(function () {
  const A = api();
  const pristine = { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' };

  // ① pristine dock + 缺失 follow → 默认统一
  eq(A.normalizeSurfaceV3(Object.assign({}, pristine), true, 'calendar').follow, 'calendar',
    '§11 pristine dock（无 follow）→ 默认统一 calendar');

  // ② 任一实质字段非默认 → 视为已手动调整 → null（逐一验证）
  [
    ['style', 'tech'], ['bg', 'image'], ['text', 'dark'], ['clarity', 50], ['tone', 'dark']
  ].forEach(function (pair) {
    const s = Object.assign({}, pristine); s[pair[0]] = pair[1];
    if (pair[0] === 'bg') s.image = imgSpec({ file: 'p.jpg' });   // 单改 bg=image 需带图才算非 pristine
    eq(A.normalizeSurfaceV3(s, true, 'calendar').follow, null,
      '§11 dock 单项非默认（' + pair[0] + '=' + pair[1] + '）→ null（保留独立）');
  });
  eq(A.normalizeSurfaceV3(Object.assign({}, pristine, { bg: 'image', image: imgSpec({ file: 'p.jpg' }) }), true, 'calendar').follow,
    null, '§11 dock 单独设过图片 → null（保留独立）');

  // ③ 显式 follow 优先于 pristine 判定
  eq(A.normalizeSurfaceV3(Object.assign({}, pristine, { follow: 'calendar' }), true, 'calendar').follow, 'calendar',
    '§11 显式 follow=calendar → calendar');
  eq(A.normalizeSurfaceV3(Object.assign({}, pristine, { follow: null }), true, 'calendar').follow, null,
    '§11 显式 follow=null（即使 pristine）→ 仍 null（用户取消过）');
  eq(A.normalizeSurfaceV3({ style: 'tech', follow: 'calendar' }, true, 'calendar').follow, 'calendar',
    '§11 显式 follow=calendar 压过「非 pristine」→ calendar');

  // ④ follow='x'（非法）等同「缺失」→ 走 pristine 判定
  eq(A.normalizeSurfaceV3(Object.assign({}, pristine, { follow: 'x' }), true, 'calendar').follow, 'calendar',
    "§11 follow='x' 视同缺失 → pristine → calendar");
  eq(A.normalizeSurfaceV3(Object.assign({}, pristine, { follow: 'x' }), true, null).follow, null,
    "§11 follow='x' 视同缺失 → followDefault=null → null");

  // ⑤ followDefault=null（expanded/desktop）：pristine 也不默认跟随
  eq(A.normalizeSurfaceV3(Object.assign({}, pristine), true, null).follow, null,
    '§11 expanded/desktop 缺失 follow（pristine）→ null（不默认跟随）');

  // ⑥ 不可跟随面（isFollowable=false）→ 无 follow 字段
  ok(!('follow' in A.normalizeSurfaceV3(Object.assign({}, pristine), false, 'calendar')),
    '§11 isFollowable=false → 无 follow 字段');

  // ⑦ 幂等：连续两次归一化结果一致（loadSettings 每次启动都会跑）
  const once = A.normalizeSurfaceV3(Object.assign({}, pristine), true, 'calendar');
  const twice = A.normalizeSurfaceV3(JSON.parse(JSON.stringify(once)), true, 'calendar');
  deepEq(twice, once, '§11 normalizeSurfaceV3 幂等（连续两次结果一致）');
  const skinOnce = A.normalizeSkinV3(v3skin());
  const skinTwice = A.normalizeSkinV3(JSON.parse(JSON.stringify(skinOnce)));
  deepEq(skinTwice, skinOnce, '§11 normalizeSkinV3 整树幂等');
})();

/* ============================================================
 * §12 C1 · migrateSkinV2toV3 的 dock follow 口径（与 __v3 路径刻意不同）
 * ------------------------------------------------------------
 * v2→v3 用 oldType 判定（不看 pristine）：type==='image' → null（唯一带磁盘 artifact 的强信号），
 * 其余（light/dark/system/color）→ 'calendar'。
 * 依据：migrateSkin() 把全局 baseType 复制给全部四面，v2 的 dock.type 无法区分「全局复制」与「单独自定」。
 * ============================================================ */
(function () {
  const A = api();
  function migDockFace(dock) { return A.migrateSkinV2toV3(v2skin({ dock: dock })).surfaces.dock; }

  ['light', 'dark', 'system', 'color'].forEach(function (t) {
    eq(migDockFace({ type: t }).follow, 'calendar', '§12 v2 dock type=' + t + ' → follow calendar');
  });
  const imgDock = migDockFace({ type: 'image', image: imgSpec({ file: 'd.jpg' }) });
  eq(imgDock.follow, null, '§12 v2 dock type=image（有图）→ follow null（保留独立）');
  ok(imgDock.image && imgDock.image.file === 'd.jpg', '§12 v2 dock image 原样保留');

  // 显式 follow 优先
  eq(migDockFace({ type: 'light', follow: null }).follow, null, '§12 v2 dock 显式 follow=null 保留 null');
  eq(migDockFace({ type: 'image', follow: 'calendar', image: imgSpec({ file: 'd.jpg' }) }).follow, 'calendar',
    '§12 v2 dock 显式 follow=calendar 压过 image → calendar');

  // expanded/desktop 仍只看显式 follow（缺失 → null，不默认跟随）
  // 用裸 v2 对象（不经过 v2skin，避免夹具给 expanded 预置 follow）构造「follow 字段缺失」。
  const rawV2NoFollow = {
    __v: 2,
    surfaces: { expanded: { type: 'light', color: null, image: null, text: 'auto' } },
    opacity: {}
  };
  eq(A.migrateSkinV2toV3(rawV2NoFollow).surfaces.expanded.follow, null,
    '§12 v2 expanded 缺失 follow → null（不默认跟随）');
  eq(A.migrateSkinV2toV3({ __v: 2, surfaces: { desktop: { type: 'dark', color: null, image: null, text: 'auto' } }, opacity: {} }).surfaces.desktop.follow,
    null, '§12 v2 desktop 缺失 follow → null（不默认跟随）');

  // 守护用例：两条口径**确实不同**（防后人以「看起来不一致」为由统一掉 → 重新引入回归）
  const v3DirtyDock = A.normalizeSkinV3({ __v: 3, surfaces: { calendar: {}, dock: { style: 'tech' } } }).surfaces.dock;
  const v2LightDock = migDockFace({ type: 'light' });
  eq(v3DirtyDock.follow, null, '§12【守护】v3 已自定 dock（style=tech）→ follow null');
  eq(v2LightDock.follow, 'calendar', '§12【守护】v2 light dock → follow calendar');
  ok(v3DirtyDock.follow !== v2LightDock.follow,
    '§12【守护】两条路径口径刻意不同（v3 pristine 判定 vs v2 oldType 判定），勿统一');

  // 反证：pristine dock 两条路径一致
  const v3Pristine = A.normalizeSkinV3({ __v: 3, surfaces: { calendar: {}, dock: {} } }).surfaces.dock;
  eq(v3Pristine.follow, 'calendar', '§12 v3 pristine dock → calendar');
  eq(v3Pristine.follow, v2LightDock.follow, '§12 pristine 时两条路径一致（calendar）');
})();

/* ============================================================
 * §13【v3.1.0 回归护栏】真实用户 v3.0.0 遗留 dock 形态（端到端）
 * ------------------------------------------------------------
 * 夹具逐字取自用户真实 settings.json 的 dock 段（团队实测，本机真实数据）：
 *   { style:'minimal', bg:'native', image:null, text:'auto', clarity:'auto', tone:'system' }   // 无 follow
 * 这是标准 v3.0.0 遗留形态（dock 无 follow），且**非 pristine**（style/tone 均非默认）。
 *
 * 若按 W-D 最初那版「dock 缺失 follow 一律赋 'calendar'」，则 resolveSurfaceConfig('dock')
 * 会返回日历配置（default/auto）→ **该用户的浮动插件会从 minimal 静默变成 default**。
 * 本用例锁死修复后口径：follow=null，端到端解析回 dock 自身（style 仍 minimal），永不被 calendar 覆盖。
 * ============================================================ */
(function () {
  const A = api();

  // 真实用户遗留 dock（原样照抄 settings.json，无 follow）
  const realLegacyDock = {
    style: 'minimal', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'system'
  };

  // ① 单面归一：缺失 follow + 非 pristine → null（不默认跟随）
  const normFace = A.normalizeSurfaceV3(Object.assign({}, realLegacyDock), true, 'calendar');
  eq(normFace.follow, null, '§13 真实遗留 dock（minimal/system，无 follow）→ follow null');
  eq(normFace.style, 'minimal', '§13 归一化不改写用户风格（仍 minimal，非 default）');

  // ② 整树归一：dock.follow 仍 null（模拟 loadSettings → normalizeSkinV3 的启动路径）
  const normSkin = A.normalizeSkinV3({
    __v: 3,
    surfaces: {
      calendar: {},                                       // 出厂默认
      dock: Object.assign({}, realLegacyDock)             // 真实遗留形态
    }
  });
  eq(normSkin.surfaces.dock.follow, null, '§13 启动归一化后 dock.follow 仍 null');

  // ③ 端到端：resolveSurfaceConfig('dock') 必须解析回 dock 自身（关键回归护栏）。
  //    resolveSurfaceConfig 闭包读 skin → 用归一化后的皮肤重建 api 实例。
  const A2 = api(normSkin);
  const resolvedDock = A2.resolveSurfaceConfig('dock');
  eq(resolvedDock.style, 'minimal', "§13 resolveSurfaceConfig('dock').style === minimal（未被 calendar 覆盖）");
  eq(resolvedDock, normSkin.surfaces.dock, "§13 resolveSurfaceConfig('dock') 返回 dock 自身对象引用");
  eq(resolvedDock.tone, 'system', "§13 resolveSurfaceConfig('dock').tone 保留 system");

  // ④ 反证：若误赋 follow='calendar'，解析结果必变为 calendar 的 default —— 证明本护栏确实在守真实风险
  const badSkin = A.normalizeSkinV3({
    __v: 3,
    surfaces: { calendar: {}, dock: Object.assign({}, realLegacyDock, { follow: 'calendar' }) }
  });
  const B = api(badSkin);
  eq(B.resolveSurfaceConfig('dock').style, 'default',
    "§13【反证】误赋 follow=calendar → resolveSurfaceConfig('dock') 变 default（正是要防的回归）");
  ok(B.resolveSurfaceConfig('dock') === badSkin.surfaces.calendar,
    "§13【反证】误赋 follow=calendar → 解析结果就是 calendar 配置对象");
})();

/* ================= 收尾 ================= */
console.log('\n===== qa-v300 独立对抗性验证（皮肤 v3 / 迁移 / 明暗优先级 / dev 隔离）=====');
if (fail) {
  console.error('  ✗ 失败 ' + fail + ' 项：');
  failures.forEach(function (m) { console.error('    - ' + m); });
  console.error('\n  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(1);
}
console.log('  ✓ 全部 ' + pass + ' 项断言通过');
console.log('[qa-v300] PASS');
process.exit(0);
