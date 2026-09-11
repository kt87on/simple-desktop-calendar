'use strict';
/* ============================================================
 * tests/qa-v310.js —— v3.1.0 独立对抗性验证
 * ------------------------------------------------------------
 * 覆盖本轮四路实现的新行为（此前「零测试覆盖」）：
 *   §A C2 · 手调即豁免跟随（applySkinSet + materializeFromCalendar）
 *   §B C5 · 定时提示文案「定时提醒：H时M分」（无空格）
 *   §C C6 · 关注列表四列（日期/内容/定时/删除）+ 时间独立成格
 *   §D C7 · 关注列表直接录入 → 双向同步链路
 *   §E C8 · 提醒弹窗置顶调用序列
 *   §F C1/C3/C5 · skin.html 两入口 + 6 行风格行 + skincustom.html per-surface（v3.2.0 结构迁移）
 *   §G     · 浮动插件六风格 token 同步
 *
 * 设计原则（与 tests/qa-v300.js 同源）：
 *   1) 只读源码，绝不修改任何产品文件；发现 bug 只回报 team-lead。
 *   2) 裸 Node，自建 ok()/eq()/near() 计数器，process.exit(fail?1:0)。
 *   3) extractFn 抠真实函数体注入 mock 执行——断言源码里那几行真实逻辑。
 *   4) 全程不读写文件/目录（纯内存）。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function readRoot(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
const MAIN = readRoot('electron-main.js');
const APP = readRoot('app.js');
const CAL = readRoot('calendar.html');
const REMINDLIST = readRoot('remindlist.html');
const SKIN = readRoot('skin.html');
const SKINCUSTOM = readRoot('skincustom.html');
const DOCK = readRoot('dock.html');

/* ================= 断言计数 ================= */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; failures.push(msg); } }
function eq(a, b, msg) {
  ok(a === b, msg + '  (期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + ')');
}
function deepEq(a, b, msg) { eq(JSON.stringify(a), JSON.stringify(b), msg); }
function countOcc(hay, needle) { return hay.split(needle).length - 1; }

/* ================= 注释剥离 ================= */
function codeOnly(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* ================= extractFn（大括号配平） ================= */
function extractFn(src, name) {
  const key = 'function ' + name + '(';
  const idx = src.indexOf(key);
  if (idx < 0) throw new Error('qa-v310: 源码未找到函数 ' + name);
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
  throw new Error('qa-v310: 配平失败 ' + name);
}
function extractFnBoundary(src, name) {
  const key = 'function ' + name + '(';
  const start = src.indexOf(key);
  if (start < 0) throw new Error('qa-v310: 源码未找到函数 ' + name);
  const re = /\nfunction [A-Za-z_$]/g;
  re.lastIndex = start + key.length;
  const m = re.exec(src);
  return src.slice(start, m ? m.index : src.length);
}

/* ================= applySkinSet 隔离执行台 ================= */
const SET_FNS = [
  'clamp01', 'clampZoom', 'clampImageOpacity', 'clampOpacity',
  'sanitizeBasename', 'normStyle', 'normBg', 'normTone',
  'normalizeClarity', 'normalizeImageSpec', 'resolveSurfaceConfig', 'applySkinSet'
];
let SET_SRC = '';
try {
  SET_SRC = SET_FNS.map(function (n) { return extractFn(MAIN, n); }).join('\n\n');
} catch (e) {
  console.error('qa-v310: 抽取 applySkinSet 依赖失败 — ' + e.message);
  process.exit(1);
}
const makeSet = new Function('skinObj', 'hooks',
  [
    'var skin = skinObj;',
    'var recomputeTheme = hooks.recomputeTheme;',
    'var saveSettings = hooks.saveSettings;',
    'var pushThemeToAll = hooks.pushThemeToAll;',
    'var pushSkinToAll = hooks.pushSkinToAll;',
    'var refreshTrayMenu = hooks.refreshTrayMenu;',
    'var applyOpacity = hooks.applyOpacity;',
    SET_SRC,
    'return { applySkinSet: applySkinSet, resolveSurfaceConfig: resolveSurfaceConfig };'
  ].join('\n')
);

/** 在给定 skin 上执行一次 applySkinSet(payload)，返回调用计数与（被就地修改的）skin。 */
function runSet(skinObj, payload) {
  const calls = { recompute: 0, save: 0, pushTheme: 0, pushSkin: 0, refreshTray: 0, opacity: [] };
  const hooks = {
    recomputeTheme: function () { calls.recompute++; },
    saveSettings: function () { calls.save++; },
    pushThemeToAll: function () { calls.pushTheme++; },
    pushSkinToAll: function () { calls.pushSkin++; },
    refreshTrayMenu: function () { calls.refreshTray++; },
    applyOpacity: function (k) { calls.opacity.push(k); }
  };
  const api = makeSet(skinObj, hooks);
  api.applySkinSet(payload);
  return { skin: skinObj, api: api, calls: calls };
}

/* ================= 构造器 ================= */
function imgSpec(over) {
  return Object.assign({
    file: 'a.jpg', snapshot: null, w: 800, h: 600,
    crop: { x: 0, y: 0, w: 1, h: 1 }, zoom: 1, opacity: 1,
    dark: true, complexity: 0.5
  }, over || {});
}
/** v3 皮肤夹具。每面默认 follow=null；可显式覆盖。 */
function v3skin(over) {
  over = over || {};
  function face(base, o) { return Object.assign({}, base, o || {}); }
  const base = { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto', follow: null };
  return {
    __v: 3,
    surfaces: {
      calendar: face(base, over.calendar),
      expanded: face(base, over.expanded),
      desktop: face(base, over.desktop),
      dock: face(base, over.dock)
    },
    opacity: Object.assign({ calendar: 1, desktop: 1, dock: 1 }, over.opacity || {})
  };
}
/** 一块「已自定」的日历配置（用于验证物化快照内容）。 */
function richCalendar() {
  return { style: 'tech', bg: 'image', image: imgSpec({ file: 'cal.jpg' }), text: 'dark', clarity: 70, tone: 'dark', follow: null };
}

/* ============================================================
 * §A C2 · 手调即豁免跟随
 * ============================================================ */
(function () {
  // A1：跟随中的面被手调 style → 先物化日历快照 + follow=null，再写入本次值
  {
    let skin = v3skin({
      calendar: richCalendar(),
      expanded: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' }
    });
    const calImageRef = skin.surfaces.calendar.image;
    runSet(skin, { surface: 'expanded', field: 'style', value: 'warm' });
    const e = skin.surfaces.expanded;
    eq(e.follow, null, '§A1 手调 style → follow 置 null（豁免跟随）');
    eq(e.style, 'warm', '§A1 本次写入的值生效（warm）');
    eq(e.bg, 'image', '§A1 其余字段物化为日历快照（bg=image）');
    eq(e.text, 'dark', '§A1 物化 text 快照');
    eq(e.clarity, 70, '§A1 物化 clarity 快照');
    eq(e.tone, 'dark', '§A1 物化 tone 快照');
    ok(e.image && e.image.file === 'cal.jpg', '§A1 物化 image 快照');
    ok(e.image !== calImageRef, '§A1 物化 image 为深拷贝（不共享日历的 image 引用）');
  }

  // A2：物化后再改日历风格，该面不再跟随
  {
    let skin = v3skin({
      calendar: richCalendar(),
      dock: { follow: 'calendar' }
    });
    runSet(skin, { surface: 'dock', field: 'clarity', value: 42 });   // 手调 → 豁免
    eq(skin.surfaces.dock.follow, null, '§A2 手调 clarity → dock.follow=null');
    eq(skin.surfaces.dock.clarity, 42, '§A2 本次 clarity 生效');
    // 之后改日历风格
    runSet(skin, { surface: 'calendar', field: 'style', value: 'glass' });
    eq(skin.surfaces.calendar.style, 'glass', '§A2 日历风格已改为 glass');
    eq(skin.surfaces.dock.style, 'tech', '§A2 已豁免的 dock 不被后续日历改动波及（仍为物化的 tech）');
    // resolveSurfaceConfig 不再返回日历
    const api2 = makeSet(skin, { recomputeTheme: function () {}, saveSettings: function () {}, pushThemeToAll: function () {}, pushSkinToAll: function () {}, refreshTrayMenu: function () {}, applyOpacity: function () {} });
    ok(api2.resolveSurfaceConfig('dock') === skin.surfaces.dock, '§A2 dock.follow=null → resolveSurfaceConfig 返回自身');
  }

  // A3（对抗）：写 calendar 本身，绝不触发任何面的 follow 变化
  {
    let skin = v3skin({
      calendar: richCalendar(),
      expanded: { follow: 'calendar' },
      desktop: { follow: 'calendar' },
      dock: { follow: 'calendar' }
    });
    runSet(skin, { surface: 'calendar', field: 'style', value: 'glass' });
    eq(skin.surfaces.expanded.follow, 'calendar', '§A3 写 calendar → expanded.follow 不变');
    eq(skin.surfaces.desktop.follow, 'calendar', '§A3 写 calendar → desktop.follow 不变');
    eq(skin.surfaces.dock.follow, 'calendar', '§A3 写 calendar → dock.follow 不变');
    eq(skin.surfaces.calendar.style, 'glass', '§A3 日历风格已生效');
    // 跟随面 resolve 仍指向日历（跟随生效）
    const api2 = makeSet(skin, { recomputeTheme: function () {}, saveSettings: function () {}, pushThemeToAll: function () {}, pushSkinToAll: function () {}, refreshTrayMenu: function () {}, applyOpacity: function () {} });
    eq(api2.resolveSurfaceConfig('dock'), skin.surfaces.calendar, '§A3 follow=calendar 的 dock 仍 resolve 到日历');
  }

  // A4：expanded / desktop / dock 三者手调「实质字段」均触发豁免（逐一字段）
  ['expanded', 'desktop', 'dock'].forEach(function (surf) {
    ['style', 'bg', 'text', 'clarity', 'tone'].forEach(function (field) {
      let val = { style: 'neu', bg: 'native', text: 'light', clarity: 30, tone: 'light' }[field];
      let skin = v3skin({ calendar: richCalendar() });
      skin.surfaces[surf].follow = 'calendar';
      runSet(skin, { surface: surf, field: field, value: val });
      eq(skin.surfaces[surf].follow, null, '§A4 ' + surf + '.' + field + ' 手调 → 豁免跟随');
    });
  });

  // A5（对抗）：非「实质字段」（opacity）不触发豁免
  {
    let skin = v3skin({ calendar: richCalendar() });
    skin.surfaces.dock.follow = 'calendar';
    runSet(skin, { surface: 'dock', field: 'opacity', value: 0.5 });
    eq(skin.surfaces.dock.follow, 'calendar', '§A5 改 opacity 不豁免 follow（仍跟随）');
    eq(skin.opacity.dock, 0.5, '§A5 opacity 已写入');
  }

  // A6：显式 field='follow' = 'calendar' 恢复跟随；= 其它 取消并物化
  {
    let skin = v3skin({ calendar: richCalendar() });
    skin.surfaces.dock.follow = null;
    runSet(skin, { surface: 'dock', field: 'follow', value: 'calendar' });
    eq(skin.surfaces.dock.follow, 'calendar', "§A6 field='follow' value='calendar' → 恢复跟随");
    runSet(skin, { surface: 'dock', field: 'follow', value: null });
    eq(skin.surfaces.dock.follow, null, "§A6 field='follow' value=null → 取消跟随");
    eq(skin.surfaces.dock.style, 'tech', '§A6 取消跟随时物化日历快照（style=tech）');
    eq(skin.surfaces.dock.tone, 'dark', '§A6 物化 tone');
  }

  // A7：非可跟随面（calendar）手调风格不触发物化副作用（follow 恒不存在）
  {
    let skin = v3skin({ calendar: richCalendar() });
    runSet(skin, { surface: 'calendar', field: 'clarity', value: 10 });
    eq(skin.surfaces.calendar.clarity, 10, '§A7 calendar 手调 clarity 生效');
    ok(!('follow' in skin.surfaces.calendar) || skin.surfaces.calendar.follow === null,
      '§A7 calendar 不因手调产生 follow=calendar');
  }
})();

/* ============================================================
 * §B C5 · 定时提示文案「定时提醒：H时M分」（无空格）
 * ============================================================ */
(function () {
  const appLit = "'定时提醒：' + t.hh + '时' + t.mm + '分'";
  const listLit = "'定时提醒：' + r.hh + '时' + r.mm + '分'";
  ok(APP.indexOf(appLit) >= 0, "§B app.js 定时提示 = '定时提醒：' + t.hh + '时' + t.mm + '分'（无空格）");
  ok(CAL.indexOf(appLit) >= 0, '§B calendar.html（构建产物）同步含同一字面量（已 build）');
  ok(REMINDLIST.indexOf(listLit) >= 0, "§B remindlist.html tooltip 同口径（r.hh/r.mm，无空格）");
  // 负向：不得出现带空格的变体
  ok(APP.indexOf("'时 ' + ") < 0 && APP.indexOf("' 时'") < 0, '§B app.js 不含带空格的「时 」变体');
  ok(REMINDLIST.indexOf("'时 ' + ") < 0 && REMINDLIST.indexOf("' 时'") < 0, '§B remindlist 不含带空格的「时 」变体');
  // 提示行是「定时/全天」二选一
  ok(APP.indexOf("remindTimeHintEl.textContent =") >= 0, '§B app.js 有 remindTimeHintEl 文案写入点');
})();

/* ============================================================
 * §C C6 · 关注列表四列（日期/内容/定时/删除），时间独立成格
 * ============================================================ */
(function () {
  eq(countOcc(REMINDLIST, 'grid-template-columns: 62px 1fr 56px 24px'), 2,
    '§C 两处栅格均为 62px 1fr 56px 24px（表头行 + 数据行）');
  ok(REMINDLIST.indexOf('<div id="cols"><div>日期</div><div>关注内容</div><div>定时</div><div></div></div>') >= 0,
    '§C 表头 4 格：日期 / 关注内容 / 定时 /（空）');
  ok(REMINDLIST.indexOf('.rl-time {') >= 0, '§C 有独立「定时」单元格样式 .rl-time');
  ok(REMINDLIST.indexOf(".rl-time.is-allday") >= 0, '§C 全天态弱化样式 .rl-time.is-allday');
  ok(REMINDLIST.indexOf("timeEl.className = hasTime ? 'rl-time' : 'rl-time is-allday';") >= 0,
    '§C 定时单元格类名随有无时间切换');
  ok(REMINDLIST.indexOf("timeEl.textContent = hasTime ? (pad2(r.hh) + ':' + pad2(r.mm)) : '全天';") >= 0,
    '§C 有时间 → HH:MM（补零），无 → 全天');
  // 时间不再拼进内容文本
  ok(REMINDLIST.indexOf("+ ' · '") < 0, "§C 内容文本不再拼接 ' · '（时间已拆出为独立列）");
  // 排序：无定时的全天排最前，同日再按时:分升序
  ok(REMINDLIST.indexOf('全天提醒排最前') >= 0 || /无定时的全天提醒排最前/.test(REMINDLIST),
    '§C 注释保留「全天排最前」排序契约');
})();

/* ============================================================
 * §D C7 · 关注列表直接录入 → 双向同步链路
 * ============================================================ */
(function () {
  // 列表侧：调用 window.api.addReminder，hh/mm 成对才传
  ok(REMINDLIST.indexOf('window.api.addReminder') >= 0, '§D 列表直接录入走 window.api.addReminder');
  ok(REMINDLIST.indexOf('if (hh !== null && mm !== null) { payload.hh = hh; payload.mm = mm; }') >= 0,
    '§D hh/mm 成对才传（否则按全天）');
  // 主进程：add-reminder → push + broadcastReminders
  ok(MAIN.indexOf("ipcMain.handle('add-reminder'") >= 0, '§D 主进程有 add-reminder IPC');
  ok(MAIN.indexOf('broadcastReminders();') >= 0, '§D add-reminder 后调 broadcastReminders()');
  // broadcastReminders → 主窗 reminders-changed + 列表 remindlist-data
  const brs = MAIN.indexOf('function broadcastReminders()');
  const bre = MAIN.indexOf('\n}', brs);
  const brBody = MAIN.slice(brs, bre);
  ok(brBody.indexOf("send('reminders-changed'") >= 0, '§D broadcastReminders 下发主窗 reminders-changed');
  ok(brBody.indexOf('pushDataToRemindlist()') >= 0, '§D broadcastReminders 同步调用 pushDataToRemindlist()');
  ok(MAIN.indexOf("remindlistWin.webContents.send('remindlist-data'") >= 0,
    '§D pushDataToRemindlist 下发列表 remindlist-data');
})();

/* ============================================================
 * §E C8 · 提醒弹窗置顶调用序列
 * ============================================================ */
(function () {
  let fn;
  try { fn = extractFnBoundary(MAIN, 'showReminderWindow'); }
  catch (e) { console.error('qa-v310: 抽取 showReminderWindow 失败 — ' + e.message); process.exit(1); }

  // 复用分支：从 `if (reminderWin) {` 到其 `return;`
  const bs = fn.indexOf('if (reminderWin) {');
  const be = fn.indexOf('return;', bs);
  ok(bs >= 0 && be > bs, '§E 定位到复用分支');
  const reuse = fn.slice(bs, be);
  const iTop = reuse.indexOf("setAlwaysOnTop(true, 'screen-saver')");
  const iVis = reuse.indexOf('.isVisible()');
  const iShow = reuse.indexOf('.show()');
  const iMove = reuse.indexOf('.moveTop()');
  const iFocus = reuse.indexOf('.focus()');
  ok(iTop >= 0 && iVis >= 0 && iShow >= 0 && iMove >= 0 && iFocus >= 0,
    '§E 复用分支包含全部 5 个调用');
  ok(iTop < iVis && iVis < iShow && iShow < iMove && iMove < iFocus,
    '§E【序列】复用分支顺序：setAlwaysOnTop → isVisible → show → moveTop → focus');
  ok(/if \(!reminderWin\.isVisible\(\)\)\s*reminderWin\.show\(\);/.test(reuse),
    '§E show() 受 isVisible() 门控（已显示则不重复 show）');

  // 新建分支 ready-to-show：show() → 再断言置顶 → moveTop()
  // 注意：'ready-to-show' 也出现在复用分支的说明注释里，故锚定真实注册调用 `reminderWin.once('ready-to-show'`。
  const rs = fn.indexOf("reminderWin.once('ready-to-show'");
  const re = fn.indexOf("reminderWin.on('closed'", rs);
  const ready = fn.slice(rs, re > rs ? re : fn.length);
  const rShow = ready.indexOf('.show()');
  const rTop = ready.indexOf("setAlwaysOnTop(true, 'screen-saver')");
  const rMove = ready.indexOf('.moveTop()');
  ok(rShow >= 0 && rTop >= 0 && rMove >= 0, '§E ready-to-show 分支含 show/setAlwaysOnTop/moveTop');
  ok(rShow < rTop && rTop < rMove,
    '§E【序列】ready-to-show：先 show() → 再 setAlwaysOnTop → moveTop()');
})();

/* ============================================================
 * §F C1/C3/C5 · v3.2.0：skin.html 两入口 + skincustom.html per-surface
 * ------------------------------------------------------------
 * v3.2.0 结构大改：原 skin.html 的「6 行风格 + 自选图片浮层 + per-surface 细调」拆成
 *   · skin.html：只剩两个入口（原生皮肤 / 自选图片），6 行风格行；点风格 → apply-native-style
 *   · skincustom.html（新建）：4 界面分段 + 取景/文字/清晰度/透明度/跟随（独立新窗口）
 * 故本节的 per-surface 断言改读 SKINCUSTOM；「风格行」「全局原子写」留在 SKIN。
 * ============================================================ */
(function () {
  const styles = ['default', 'minimal', 'glass', 'neu', 'tech', 'warm'];

  /* ---- skin.html：6 行风格行 + 两入口 + 全局原子写 ---- */
  eq(countOcc(SKIN, 'class="style-row" data-style='), 6, '§F skin.html 主视图 6 行原生风格（style-row）');
  styles.forEach(function (s) {
    ok(SKIN.indexOf('data-style="' + s + '"') >= 0, '§F skin.html 含风格行 data-style="' + s + '"');
  });
  ok(SKIN.indexOf('id="nativeList"') >= 0, '§F skin.html 风格列表容器 #nativeList');
  ok(SKIN.indexOf('id="entryNative"') >= 0 && SKIN.indexOf('id="entryCustom"') >= 0,
    '§F skin.html 两个入口 #entryNative / #entryCustom');
  // v3.2.0 C1：点风格 = 主进程一次原子写 4 个面（apply-native-style）；旧 setCalendarStyle 只写 calendar，已删
  ok(SKIN.indexOf("skinAction('apply-native-style'") >= 0,
    "§F skin.html 点风格行 → skinAction('apply-native-style')（C1 全局统一）");
  ok(SKIN.indexOf("skinAction('open-custom'") >= 0,
    "§F skin.html 点自选图片 → skinAction('open-custom')（C2 开独立新窗口）");
  // 旧 per-surface 结构必须已删除（防止旧浮层残留）
  ok(SKIN.indexOf('id="overlay"') < 0 && SKIN.indexOf('id="styleList"') < 0 &&
     SKIN.indexOf('data-surface=') < 0 && SKIN.indexOf('data-tone="') < 0,
    '§F skin.html 已删除旧浮层/per-surface（无 overlay / styleList / data-surface / data-tone）');

  /* ---- skincustom.html：per-surface 控件落位 ---- */
  ok(SKINCUSTOM.indexOf('data-surface="calendar"') >= 0 && SKINCUSTOM.indexOf('data-surface="dock"') >= 0 &&
     SKINCUSTOM.indexOf('data-surface="desktop"') >= 0 && SKINCUSTOM.indexOf('data-surface="expanded"') >= 0,
    '§F skincustom.html 含 4 界面分段（calendar/dock/desktop/expanded）');
  ok(SKINCUSTOM.indexOf('var FOLLOWABLE = { expanded: 1, desktop: 1, dock: 1 };') >= 0,
    '§F skincustom.html FOLLOWABLE 含 dock（浮窗可跟随）');
  ok(SKINCUSTOM.indexOf('id="followRow"') >= 0 && SKINCUSTOM.indexOf('id="followSwitch"') >= 0,
    '§F skincustom.html 跟随开关 #followRow / #followSwitch');
  ok(SKINCUSTOM.indexOf('id="imageSection"') >= 0 && SKINCUSTOM.indexOf('id="dropZone"') >= 0 &&
     SKINCUSTOM.indexOf('id="cropBox"') >= 0,
    '§F skincustom.html 图片取景区 #imageSection / #dropZone / #cropBox');
  ok(SKINCUSTOM.indexOf('SURFACE_LABEL') >= 0 && SKINCUSTOM.indexOf("dock: '浮窗界面'") >= 0,
    '§F skincustom.html SURFACE_LABEL.dock = 「浮窗界面」（C6 命名）');
  ok(SKINCUSTOM.indexOf("skinAction('close-custom'") >= 0,
    "§F skincustom.html ✕/Esc → skinAction('close-custom')");
  // 删除项：背景来源 / 明暗 整段不得存在
  ok(SKINCUSTOM.indexOf('id="bgGrid"') < 0 && SKINCUSTOM.indexOf('id="toneGrid"') < 0 &&
     SKINCUSTOM.indexOf('data-tone="') < 0,
    '§F skincustom.html 已删除「背景来源」「明暗」（无 bgGrid / toneGrid / data-tone）');
})();

/* ============================================================
 * §G 浮动插件六风格 token 同步（dock.html）
 * ============================================================ */
(function () {
  const styles = ['default', 'minimal', 'glass', 'neu', 'tech', 'warm'];
  styles.forEach(function (s) {
    ['light', 'dark'].forEach(function (th) {
      ok(DOCK.indexOf('[data-theme="' + th + '"][data-style="' + s + '"]') >= 0,
        '§G dock 含 [data-theme="' + th + '"][data-style="' + s + '"]');
    });
  });
  // tech 霓虹光晕 + glass 高光带（装饰层）
  ok(DOCK.indexOf('--tech-ink-glow') >= 0, '§G dock tech 霓虹光晕变量存在');
  ok(DOCK.indexOf('html[data-style="glass"]:not([data-skin]) #card::after') >= 0,
    '§G dock glass 斜向高光带装饰层存在');
  ok(DOCK.indexOf('html[data-style="tech"]:not([data-skin]) #card') >= 0,
    '§G dock tech 四角切角装饰层存在');
})();

/* ================= 收尾 ================= */
console.log('\n===== qa-v310 独立对抗性验证（C1/C2/C5/C6/C7/C8 + 六风格 + 关注列表）=====');
if (fail) {
  console.error('  ✗ 失败 ' + fail + ' 项：');
  failures.forEach(function (m) { console.error('    - ' + m); });
  console.error('\n  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(1);
}
console.log('  ✓ 全部 ' + pass + ' 项断言通过');
console.log('[qa-v310] PASS');
process.exit(0);
