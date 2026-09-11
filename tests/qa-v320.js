'use strict';
/* ============================================================
 * tests/qa-v320.js —— v3.2.0 独立对抗性验证
 * ------------------------------------------------------------
 * 覆盖本轮四路实现的新行为（此前「零测试覆盖」）：
 *   §A C1 · apply-native-style 全局原子写（4 面 style/bg/image + 3 面 follow）
 *   §B C1 · 非法 style 回落 'default'（不写脏数据）
 *   §C C3 · skin.html 两入口 + 6 风格行 + 已删 per-surface
 *   §D C5 · skincustom.html 4 界面分段 + 取景/文字/清晰度/透明度/跟随 + dimmed 唯一性
 *   §E C2 · electron-main.js：skinCustomWin / openSkinCustomWindow / 双窗口推送 / 退出清理
 *   §F C6 · 用户可见文件「浮动插件」= 0
 *   §G C1 · 端到端跟随护栏（真实形态 dock.follow=null + bg=image → 选原生后跟随）
 *
 * 设计原则（与 tests/qa-v310.js / qa-v244.js 同源）：
 *   1) 只读源码，绝不修改任何产品文件；发现 bug 只回报 team-lead。
 *   2) 裸 Node，自建 ok()/eq()/deepEq()/countOcc 计数器，process.exit(fail?1:0)。
 *   3) extractFn 抠真实函数体注入 mock 执行 —— 断言的是源码里那几行真实逻辑。
 *   4) 全程只读，不写盘、不启 Electron。
 *
 * 说明：applyNativeStyleAll 依赖 normStyle（本测试抽取其**真身**，故 §B 回落验证走真实语义）；
 *       applyNativeStyleAll **不引用** applySkinSet，可安全孤立 eval（见 electron-main.js:963 注释）。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function readRoot(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
const MAIN = readRoot('electron-main.js');
const SKIN = readRoot('skin.html');
const SKINCUSTOM = readRoot('skincustom.html');

/* ================= 断言计数 ================= */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; failures.push(msg); } }
function eq(a, b, msg) {
  ok(a === b, msg + '  (期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + ')');
}
function deepEq(a, b, msg) { eq(JSON.stringify(a), JSON.stringify(b), msg); }
function countOcc(hay, needle) { return hay.split(needle).length - 1; }

/* ================= 注释剥离（判「是否真的引用某函数」时用，避免注释里提到就误判） ================= */
function codeOnly(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* ================= extractFn（大括号配平） ================= */
function extractFn(src, name) {
  const key = 'function ' + name + '(';
  const idx = src.indexOf(key);
  if (idx < 0) throw new Error('qa-v320: 源码未找到函数 ' + name);
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
  throw new Error('qa-v320: 配平失败 ' + name);
}

/* ============================================================
 * apply-native-style 隔离执行台
 * 抽取 applyNativeStyleAll + 其依赖（normStyle / normBg / resolveSurfaceConfig）真身，
 * 注入 mock skin + 收尾 hooks 后执行。绝不依赖「顶层新函数在孤立作用域可见」。
 * ============================================================ */
const NATIVE_FNS = ['normStyle', 'normBg', 'resolveSurfaceConfig', 'applyNativeStyleAll'];
let NATIVE_SRC = '';
try {
  NATIVE_SRC = NATIVE_FNS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
} catch (e) {
  console.error('qa-v320: 抽取 apply-native-style 依赖失败 — ' + e.message);
  process.exit(1);
}

const makeNative = new Function('skinObj', 'hooks', [
  'var skin = skinObj;',
  'hooks = hooks || {};',
  'var recomputeTheme = hooks.recomputeTheme || function () {};',
  'var saveSettings = hooks.saveSettings || function () {};',
  'var pushThemeToAll = hooks.pushThemeToAll || function () {};',
  'var pushSkinToAll = hooks.pushSkinToAll || function () {};',
  'var pushSkinConfigState = hooks.pushSkinConfigState || function () {};',
  'var refreshTrayMenu = hooks.refreshTrayMenu || function () {};',
  /* v3.3.0 C5：applyNativeStyleAll 末尾调用顶层 syncDockGeometry()（依赖 dockWin/dockW/dockH，
   * 非本测试被测对象）→ 注入空桩，避免隔离作用域 ReferenceError。 */
  'var syncDockGeometry = hooks.syncDockGeometry || function () {};',
  NATIVE_SRC,
  'return { applyNativeStyleAll: applyNativeStyleAll, resolveSurfaceConfig: resolveSurfaceConfig, normStyle: normStyle };'
].join('\n'));

/** 在给定 skin 上执行一次 applyNativeStyleAll(style)，返回调用计数与 api。 */
function runNative(skinObj, style) {
  const calls = { recompute: 0, save: 0, pushTheme: 0, pushSkin: 0, pushConfig: 0, tray: 0 };
  const hooks = {
    recomputeTheme: function () { calls.recompute++; },
    saveSettings: function () { calls.save++; },
    pushThemeToAll: function () { calls.pushTheme++; },
    pushSkinToAll: function () { calls.pushSkin++; },
    pushSkinConfigState: function () { calls.pushConfig++; },
    refreshTrayMenu: function () { calls.tray++; }
  };
  const api = makeNative(skinObj, hooks);
  api.applyNativeStyleAll(style);
  return { api: api, calls: calls };
}

/* ================= 夹具 ================= */
const FOUR = ['calendar', 'expanded', 'desktop', 'dock'];
const FOLLOWABLE = ['expanded', 'desktop', 'dock'];

function face(over) {
  return Object.assign({ style: 'default', bg: 'native', image: null,
    text: 'auto', clarity: 'auto', tone: 'auto' }, over || {});
}
/** 通用 v3 皮肤夹具（expanded/desktop 默认跟随、dock 默认独立）。 */
function skinFixture(over) {
  over = over || {};
  return {
    __v: 3,
    surfaces: {
      calendar: Object.assign(face(), over.calendar),
      expanded: Object.assign(face({ follow: 'calendar' }), over.expanded),
      desktop: Object.assign(face({ follow: 'calendar' }), over.desktop),
      dock: Object.assign(face({ follow: null }), over.dock)
    },
    opacity: { calendar: 1, desktop: 1, dock: 1 }
  };
}
/** 用户真实形态：dock 曾单独导入图片 → follow=null；calendar 面**不含 follow 字段**。 */
function userShape() {
  return {
    __v: 3,
    surfaces: {
      calendar: { style: 'warm', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
      expanded: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', follow: 'calendar' },
      desktop: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', follow: 'calendar' },
      dock: {
        style: 'minimal', bg: 'image',
        image: { file: 'dock_1789105800240.png', w: 400, h: 200, crop: { x: 0, y: 0, w: 1, h: 1 }, zoom: 1, opacity: 1, dark: true, complexity: 0.4 },
        text: 'auto', clarity: 'auto', tone: 'system', follow: null
      }
    },
    opacity: { calendar: 1, desktop: 1, dock: 1 }
  };
}

/* ============================================================
 * §A C1 · apply-native-style 全局原子写
 * ============================================================ */
(function () {
  const skin = skinFixture({
    calendar: { style: 'glass', bg: 'image', image: { file: 'cal.png', w: 800, h: 600 } }, // 刻意不含 follow
    expanded: { style: 'neu' },
    desktop: { style: 'warm' },
    dock: { style: 'minimal', bg: 'image', image: { file: 'dock.png', w: 400, h: 200 }, tone: 'system', follow: null }
  });
  const r = runNative(skin, 'tech');

  // 4 面 style 一致
  FOUR.forEach(function (n) {
    eq(skin.surfaces[n].style, 'tech', '§A ' + n + '.style 统一为 tech');
  });
  // 4 面 bg 一律 native
  FOUR.forEach(function (n) {
    eq(skin.surfaces[n].bg, 'native', '§A ' + n + '.bg = native');
  });
  // 4 面 image 一律 null
  FOUR.forEach(function (n) {
    eq(skin.surfaces[n].image, null, '§A ' + n + '.image = null（仅解除引用）');
  });
  // expanded/desktop/dock 额外写 follow='calendar'
  FOLLOWABLE.forEach(function (n) {
    eq(skin.surfaces[n].follow, 'calendar', '§A ' + n + '.follow = calendar（纳入全局统一）');
  });
  // calendar 面不被写入 follow 字段（保持「非可跟随面」语义）
  ok(!('follow' in skin.surfaces.calendar), '§A calendar 未被写入 follow 字段（无 follow key）');
  eq(skin.surfaces.calendar.follow, undefined, '§A calendar.follow 仍为 undefined');

  // 收尾序列（与 applySkinSet 末尾一致）
  eq(r.calls.recompute, 1, '§A 收尾调用 recomputeTheme 恰 1 次');
  eq(r.calls.save, 1, '§A 收尾调用 saveSettings 恰 1 次（单次原子写）');
  eq(r.calls.pushTheme, 1, '§A 收尾调用 pushThemeToAll 恰 1 次');
  eq(r.calls.pushSkin, 1, '§A 收尾调用 pushSkinToAll 恰 1 次');
  eq(r.calls.pushConfig, 1, '§A 收尾显式调用 pushSkinConfigState 恰 1 次');
  eq(r.calls.tray, 1, '§A 收尾调用 refreshTrayMenu 恰 1 次');

  // 原子性：不含 per-face skinSet 调用（不逐面写、不反复落盘）
  // 用剥离注释后的代码体判断 —— 函数体注释里会提到 applySkinSet（说明可安全孤立 eval），不算引用
  ok(codeOnly(extractFn(MAIN, 'applyNativeStyleAll')).indexOf('applySkinSet') < 0,
    '§A applyNativeStyleAll 代码体不引用 applySkinSet（可安全孤立 eval）');
})();

/* ============================================================
 * §B C1 · 非法 style 回落 'default'（不写脏数据）
 * ============================================================ */
(function () {
  const BAD = ['bogus', 'TECH', '', null, undefined, 123, NaN, {}, []];
  BAD.forEach(function (v) {
    const s = skinFixture();
    runNative(s, v);
    FOUR.forEach(function (n) {
      eq(s.surfaces[n].style, 'default', '§B style=' + JSON.stringify(v) + ' → ' + n + ' 回落 default');
      ok(s.surfaces[n].style !== 'bogus' && s.surfaces[n].style !== v,
        '§B style=' + JSON.stringify(v) + ' → ' + n + ' 未写入非法值');
    });
  });
  // normStyle 真身语义对照
  const api = makeNative(skinFixture(), {});
  eq(api.normStyle('tech'), 'tech', "§B normStyle('tech') = 'tech'（合法原样）");
  eq(api.normStyle('bogus'), 'default', "§B normStyle('bogus') = 'default'（非法回落）");
  eq(api.normStyle(null), 'default', '§B normStyle(null) = default');
})();

/* ============================================================
 * §C C3 · skin.html 结构（两入口 + 6 风格行 + 已删 per-surface）
 * ============================================================ */
(function () {
  ok(SKIN.indexOf('id="entryNative"') >= 0, '§C skin.html 含 #entryNative（原生皮肤入口）');
  ok(SKIN.indexOf('id="entryCustom"') >= 0, '§C skin.html 含 #entryCustom（自选图片入口）');
  ok(SKIN.indexOf('id="nativeList"') >= 0, '§C skin.html 含 #nativeList（动画展开容器）');
  eq(countOcc(SKIN, 'class="style-row" data-style='), 6, '§C skin.html 6 行 style-row[data-style]');
  ['default', 'minimal', 'glass', 'neu', 'tech', 'warm'].forEach(function (s) {
    ok(SKIN.indexOf('data-style="' + s + '"') >= 0, '§C skin.html 含 data-style="' + s + '"');
  });
  // 每行含该风格的迷你预览（.pv.pv-<style>）
  ['default', 'minimal', 'glass', 'neu', 'tech', 'warm'].forEach(function (s) {
    ok(SKIN.indexOf('class="pv pv-' + s + '"') >= 0, '§C skin.html 风格行含迷你预览 .pv.pv-' + s);
  });
  ok(SKIN.indexOf("skinAction('apply-native-style'") >= 0,
    "§C skin.html 调 skinAction('apply-native-style')（C1 全局统一）");
  ok(SKIN.indexOf("skinAction('open-custom'") >= 0,
    "§C skin.html 调 skinAction('open-custom')（C2 开独立新窗口）");
  // 已删结构（负向）
  ok(SKIN.indexOf('bgGrid') < 0, '§C skin.html 不含 bgGrid（背景来源已迁走/删除）');
  ok(SKIN.indexOf('toneGrid') < 0, '§C skin.html 不含 toneGrid（明暗段已删除）');
  ok(SKIN.indexOf('id="overlay"') < 0, '§C skin.html 不含 #overlay（窗内浮层已删除）');
  ok(SKIN.indexOf('浮动插件') < 0, '§C skin.html 不含「浮动插件」（C6 文案）');
})();

/* ============================================================
 * §D C5 · skincustom.html 结构（4 界面分段 + per-surface 区块 + dimmed 唯一）
 * ============================================================ */
(function () {
  // 4 个 data-surface 恰为 calendar/dock/desktop/expanded
  const found = [];
  const re = /data-surface="([a-z]+)"/g;
  let m;
  while ((m = re.exec(SKINCUSTOM)) !== null) found.push(m[1]);
  eq(found.length, 4, '§D skincustom.html 恰含 4 个 data-surface');
  deepEq(found.slice().sort(), ['calendar', 'desktop', 'dock', 'expanded'],
    '§D skincustom.html data-surface 集合 = calendar/dock/desktop/expanded');

  // 保留区块
  ['followRow', 'imageSection', 'textSection', 'claritySection', 'opacityRange'].forEach(function (id) {
    ok(SKINCUSTOM.indexOf('id="' + id + '"') >= 0, '§D skincustom.html 含 #' + id);
  });
  ok(SKINCUSTOM.indexOf('id="followSwitch"') >= 0, '§D skincustom.html 含 #followSwitch');
  ok(SKINCUSTOM.indexOf('id="dropZone"') >= 0 && SKINCUSTOM.indexOf('id="cropBox"') >= 0,
    '§D skincustom.html 含取景 #dropZone / #cropBox');
  ok(SKINCUSTOM.indexOf("dock: '浮窗界面'") >= 0, '§D skincustom.html SURFACE_LABEL.dock = 「浮窗界面」');
  ok(SKINCUSTOM.indexOf("skinAction('close-custom'") >= 0, "§D skincustom.html ✕/Esc → 'close-custom'");

  // 删除项（负向）
  ok(SKINCUSTOM.indexOf('bgGrid') < 0, '§D skincustom.html 不含 bgGrid（背景来源已删）');
  ok(SKINCUSTOM.indexOf('toneGrid') < 0, '§D skincustom.html 不含 toneGrid（明暗已删）');
  ok(SKINCUSTOM.indexOf('浮动插件') < 0, '§D skincustom.html 不含「浮动插件」（C6 文案）');

  // 语义变更护栏：.dimmed 只允许一处（claritySlider 的 auto 档），不得再有「跟随时整块置灰」
  eq(countOcc(SKINCUSTOM, "classList.toggle('dimmed'"), 1,
    '§D skincustom.html classList.toggle(\'dimmed\') 仅 1 处');
  ok(SKINCUSTOM.indexOf("$('claritySlider').classList.toggle('dimmed', clarityAutoOn)") >= 0,
    '§D 该处为 claritySlider ↔ clarityAutoOn（与 follow 无关）');
  ok(SKINCUSTOM.indexOf("toggle('dimmed', following)") < 0,
    '§D skincustom.html 已移除「follow 时置灰 image/text/clarity 整块」的旧规则');
})();

/* ============================================================
 * §E C2 · electron-main.js：「自选图片」窗口与推送路由
 * ============================================================ */
(function () {
  ok(/let skinCustomWin = null;/.test(MAIN), '§E skinCustomWin 声明（let … = null）');
  ok(/function openSkinCustomWindow\(initialSurface\)/.test(MAIN), '§E openSkinCustomWindow(initialSurface) 存在');
  ok(MAIN.indexOf("loadFile(path.join(__dirname, 'skincustom.html'") >= 0,
    "§E openSkinCustomWindow 载入 skincustom.html");
  ok(/action === 'open-custom'/.test(MAIN) && /openSkinCustomWindow\(payload && payload\.surface\)/.test(MAIN),
    "§E skin-action 含 'open-custom' 分支 → openSkinCustomWindow(surface)");
  ok(/action === 'close-custom'/.test(MAIN) && /skinCustomWin && !skinCustomWin\.isDestroyed\(\)\) \{ try \{ skinCustomWin\.close\(\)/.test(MAIN),
    "§E skin-action 含 'close-custom' 分支 → 只关 skinCustomWin");
  ok(/action === 'apply-native-style'/.test(MAIN) && /applyNativeStyleAll\(payload && payload\.style\)/.test(MAIN),
    "§E skin-action 含 'apply-native-style' 分支 → applyNativeStyleAll(style)");

  // close 仍只关 skinWin（不得误伤 skinCustomWin）
  const aStart = MAIN.indexOf("ipcMain.on('skin-action'");
  const aEnd = MAIN.indexOf('\n});', aStart);
  const actBody = MAIN.slice(aStart, aEnd > aStart ? aEnd : MAIN.length);
  const cClose = actBody.indexOf("action === 'close')");
  const cCloseCustom = actBody.indexOf("action === 'close-custom')");
  const closeBranch = actBody.slice(cClose, cCloseCustom);
  ok(cClose >= 0 && cCloseCustom > cClose, '§E 定位到 close / close-custom 两个分支');
  ok(closeBranch.indexOf('skinWin.close()') >= 0 && closeBranch.indexOf('skinCustomWin') < 0,
    "§E 'close' 分支只关 skinWin（不含 skinCustomWin）");

  // pushSkinConfigState 同时发两个窗口
  const pStart = MAIN.indexOf('function pushSkinConfigState()');
  const pEnd = MAIN.indexOf('\n}', pStart);
  const pBody = MAIN.slice(pStart, pEnd > pStart ? pEnd : MAIN.length);
  ok(/skinWin\.webContents\.send\('skin-config-state'/.test(pBody),
    '§E pushSkinConfigState 发 skinWin');
  ok(/skinCustomWin\.webContents\.send\('skin-config-state'/.test(pBody),
    '§E pushSkinConfigState 同时发 skinCustomWin');

  // skin-import-result 同时发两个窗口
  ok(/skinWin\.webContents\.send\('skin-import-result'/.test(MAIN),
    '§E skin-import-result 回传 skinWin');
  ok(/skinCustomWin\.webContents\.send\('skin-import-result'/.test(MAIN),
    '§E skin-import-result 同时回传 skinCustomWin');

  // 退出清理
  ok(/if \(skinCustomWin\) \{ try \{ skinCustomWin\.destroy\(\); \}/.test(MAIN),
    '§E 退出清理含 skinCustomWin.destroy()');

  // 单例复用：已存在则 focus + pushSkinConfigState + return
  const oStart = MAIN.indexOf('function openSkinCustomWindow(');
  const oEnd = MAIN.indexOf('function buildTrayMenu', oStart);
  const oBody = MAIN.slice(oStart, oEnd > oStart ? oEnd : MAIN.length);
  ok(/if \(skinCustomWin && !skinCustomWin\.isDestroyed\(\)\) \{[\s\S]{0,120}skinCustomWin\.focus\(\)[\s\S]{0,120}pushSkinConfigState\(\)[\s\S]{0,40}return;/.test(oBody),
    '§E openSkinCustomWindow 单例：已存在 → focus + pushSkinConfigState + return');
  ok(/skinCustomWin\.on\('closed', function \(\) \{ skinCustomWin = null; \}\)/.test(oBody),
    '§E openSkinCustomWindow closed → 置 null');
  ok(/setAlwaysOnTop\(true, 'screen-saver'\)/.test(oBody), "§E openSkinCustomWindow setAlwaysOnTop(true,'screen-saver')");
  ok(/const W = 500, H = 660;/.test(oBody), '§E openSkinCustomWindow 尺寸 500×660（C4）');
})();

/* ============================================================
 * §F C6 · 用户可见文件「浮动插件」命中为 0
 * ------------------------------------------------------------
 * 限定**用户可见**清单（设计 §1.3 需求 3）：skin.html / skincustom.html / settings.html /
 * 使用说明.md / 使用说明.html / README.md。
 * 排除：CHANGELOG.md（历史段落不动）、OVERVIEW.md（内部文档）、deliverables/*（设计稿）、
 *       dist/*（构建产物）、electron-main.js / dock.html（仅注释里残留，非用户可见）。
 * ============================================================ */
(function () {
  const USER_FACING = ['skin.html', 'skincustom.html', 'settings.html', '使用说明.md', '使用说明.html', 'README.md'];
  USER_FACING.forEach(function (f) {
    let src = null;
    try { src = readRoot(f); } catch (e) { src = null; }
    ok(src !== null, '§F ' + f + ' 可读');
    if (src !== null) {
      eq(countOcc(src, '浮动插件'), 0, '§F ' + f + ' 无「浮动插件」（C6 已统一为「浮窗」）');
    }
  });
  /* 正向：应出现「浮窗」的文件（skin.html 本身无该文案 —— dock 文案已迁至 skincustom.html，故不列） */
  ['skincustom.html', 'settings.html', '使用说明.md', '使用说明.html', 'README.md'].forEach(function (f) {
    ok(countOcc(readRoot(f), '浮窗') >= 1, '§F ' + f + ' 含「浮窗」（统一命名生效）');
  });
  /* v3.3.0 C8 有意变更：skin.html 新增第三个入口「浮窗样式」（其 per-surface 细调文案仍在
   * skincustom.html）。故此处由「skin.html 无浮窗文案」改为断言该入口存在，而非放宽命名统一。 */
  ok(countOcc(SKIN, '浮窗样式') >= 1,
    '§F v3.3.0 skin.html 含第三入口「浮窗样式」（C8；细调文案仍在 skincustom.html）');
})();

/* ============================================================
 * §G C1 · 端到端跟随护栏（用户真实形态）
 * ============================================================ */
(function () {
  // 修复前：dock.follow=null（曾单独导入图片）→ resolveSurfaceConfig 返回 dock 自身 → 不跟随
  const pre = userShape();
  const preApi = makeNative(pre, {});
  eq(preApi.resolveSurfaceConfig('dock'), pre.surfaces.dock,
    '§G 修复前：dock.follow=null → resolveSurfaceConfig(dock) 返回自身（不跟随，即需求 1 的根因）');

  // 修复后：选原生皮肤 → 四界面全局统一 → dock 跟随日历
  const post = userShape();
  runNative(post, 'tech');
  eq(post.surfaces.dock.follow, 'calendar', '§G 选原生后：dock.follow = calendar');
  eq(post.surfaces.dock.bg, 'native', '§G 选原生后：dock.bg = native（原 image 被覆盖）');
  eq(post.surfaces.dock.style, 'tech', '§G 选原生后：dock.style = tech（与日历一致）');
  eq(post.surfaces.dock.image, null, '§G 选原生后：dock.image = null（解除图片引用）');
  const postApi = makeNative(post, {});
  eq(postApi.resolveSurfaceConfig('dock'), post.surfaces.calendar,
    '§G 选原生后：resolveSurfaceConfig(dock) 返回**日历配置**（端到端「选原生皮肤 → 浮窗跟随」成立）');
  eq(postApi.resolveSurfaceConfig('expanded'), post.surfaces.calendar, '§G expanded 亦跟随日历');
  eq(postApi.resolveSurfaceConfig('desktop'), post.surfaces.calendar, '§G desktop 亦跟随日历');
})();

/* ================= 收尾 ================= */
console.log('\n===== qa-v320 独立对抗性验证（C1 全局统一 / C2 自选图片窗口 / C3-C5 结构 / C6 文案 / C1 端到端）=====');
if (fail) {
  console.error('  ✗ 失败 ' + fail + ' 项：');
  failures.forEach(function (m) { console.error('    - ' + m); });
  console.error('\n  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(1);
}
console.log('  ✓ 全部 ' + pass + ' 项断言通过');
console.log('[qa-v320] PASS');
process.exit(0);
