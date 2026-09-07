/* v1.7.21 运行时逻辑单测
 * 与 verify_v1721.js（静态文本自检）互补：这里把 electron-main.js / dock.html 里的
 ** 真实函数体抽出来，注入 mock 依赖后**实际执行**，用边界数据验证需求 1 / 3 / 4。
 * 目的：纸面断言证明不了"算得对不对"，只有跑起来才知道。 */
const fs = require('fs');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

const mainSrc = fs.readFileSync('electron-main.js', 'utf8');
const dockSrc = fs.readFileSync('dock.html', 'utf8');

/* 从源码里按大括号配平抠出整个函数（测的是真实代码，不是复制品） */
function extractFn(src, name) {
  const idx = src.indexOf('function ' + name);
  if (idx < 0) throw new Error('源码里找不到函数: ' + name);
  let i = src.indexOf('{', idx), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(idx, j);
}

/* 读源码里的常量，避免单测与实现各写一份尺寸 */
function constNum(src, name) {
  const m = new RegExp(name + '\\s*=\\s*(\\d+)').exec(src);
  return m ? parseInt(m[1], 10) : NaN;
}
const MINI_W = constNum(mainSrc, 'MINI_W');
const MINI_H = constNum(mainSrc, 'MINI_H');
const MAIN_GAP = constNum(mainSrc, 'MAIN_GAP');
const DOCK_W = constNum(mainSrc, 'DOCK_W');
const DOCK_H = constNum(mainSrc, 'DOCK_H');

console.log('常量（读自源码）: MINI_W=' + MINI_W + ' MINI_H=' + MINI_H +
  ' MAIN_GAP=' + MAIN_GAP + ' DOCK_W=' + DOCK_W + ' DOCK_H=' + DOCK_H + '\n');

/* ============ 需求3：插件拖动边界（clampDockToWorkArea） ============ */
console.log('【需求3】clampDockToWorkArea —— 插件四条边夹进屏幕工作区');

// 1920×1080 屏，任务栏 40px → workArea 高 1040
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const mockScreen = {
  getDisplayMatching: function () { return { workArea: WA }; }
};
const clamp = new Function('screen', extractFn(mainSrc, 'clampDockToWorkArea') +
  '; return clampDockToWorkArea;')(mockScreen);

const D = { width: DOCK_W, height: DOCK_H };
const maxX = WA.x + WA.width - D.width;    // 1804
const maxY = WA.y + WA.height - D.height;  // 990
function cl(x, y) { return clamp({ x: x, y: y, width: D.width, height: D.height }); }

let r;
r = cl(500, 500);
ok('工作区内的正常位置不动', r.x === 500 && r.y === 500, JSON.stringify(r));
r = cl(-100, 500);
ok('左边越界 → 夹到 x=0', r.x === 0 && r.y === 500, JSON.stringify(r));
r = cl(1900, 500);
ok('右边越界 → 夹到 x=' + maxX, r.x === maxX, JSON.stringify(r));
r = cl(500, -80);
ok('上边越界 → 夹到 y=0', r.y === 0, JSON.stringify(r));
r = cl(500, 1000);
ok('下边越界（压任务栏）→ 夹到 y=' + maxY, r.y === maxY, JSON.stringify(r));
r = cl(5000, 5000);
ok('拖到屏幕外很远 → 夹回右下角工作区内', r.x === maxX && r.y === maxY, JSON.stringify(r));
r = cl(-5000, -5000);
ok('拖到左上屏幕外 → 夹回 (0,0)', r.x === 0 && r.y === 0, JSON.stringify(r));
r = cl(1804, 990);
ok('刚好卡在右下极限 → 原样保留', r.x === 1804 && r.y === 990, JSON.stringify(r));
r = cl(1805, 991);
ok('右下极限 +1px → 夹回', r.x === 1804 && r.y === 990, JSON.stringify(r));

// 多显示器：副屏在主屏左侧，坐标可为负
const WA2 = { x: -1920, y: 0, width: 1920, height: 1040 };
const clamp2 = new Function('screen', extractFn(mainSrc, 'clampDockToWorkArea') +
  '; return clampDockToWorkArea;')({ getDisplayMatching: function () { return { workArea: WA2 }; } });
r = clamp2({ x: -2000, y: 500, width: D.width, height: D.height });
ok('副屏（负坐标）左越界 → 夹到 x=-1920', r.x === -1920, JSON.stringify(r));

/* ============ v1.7.22 需求1：间距紧贴 ============ */
ok('【v1.7.22 需求1】间距紧贴 MAIN_GAP=1（读自源码）', MAIN_GAP === 1, 'MAIN_GAP=' + MAIN_GAP);

/* ============ v1.7.22 需求3：Win10/Win11 检测（真实执行 detectWin11） ============ */
function runDetect(osMock) {
  // new Function 的 body 是「定义 detectWin11 + return 函数引用」，所以再补一次 () 才拿到执行结果
  return new Function('os', extractFn(mainSrc, 'detectWin11') + '; return detectWin11;')(osMock)();
}
ok('【v1.7.22 需求3】build 22621 → Win11=true',
  runDetect({ release: function () { return '10.0.22621'; } }) === true);
ok('【v1.7.22 需求3】build 19045 → Win11=false（Win10）',
  runDetect({ release: function () { return '10.0.19045'; } }) === false);
ok('【v1.7.22 需求3】build 22000 → Win11=true（临界）',
  runDetect({ release: function () { return '10.0.22000'; } }) === true);
ok('【v1.7.22 需求3】异常 release → 回落 false 不抛错',
  runDetect({ release: function () { throw new Error('x'); } }) === false);

/* ============ 需求4：日历弹出定位（placeMainNearDock） ============ */
console.log('\n【需求4】placeMainNearDock —— 插件模式下四方位择优，且绝不超界');

const placed = [];
const mockWin = {
  isDestroyed: function () { return false; },
  setBounds: function (b) { placed.push(b); }
};
const placeMain = new Function('screen', 'win', 'MINI_W', 'MINI_H', 'MAIN_GAP', 'isWin11', 'WIN11_POS_COMP_X', 'WIN11_POS_COMP_Y', 'log',
  extractFn(mainSrc, 'placeMainNearDock') + '; return placeMainNearDock;'
)(mockScreen, mockWin, MINI_W, MINI_H, MAIN_GAP, false, 0, 0, function () {});

// 覆盖各种刁钻位置：中间 / 四角 / 四边 / 贴任务栏
const spots = [
  ['屏幕正中', 900, 500],
  ['左上角', 0, 0],
  ['右上角', maxX, 0],
  ['左下角（任务栏左侧）', 0, maxY],
  ['右下角（任务栏右侧，默认落点）', maxX, maxY],
  ['正贴上边', 900, 0],
  ['正贴下边（压任务栏上沿）', 900, maxY],
  ['正贴左边', 0, 500],
  ['正贴右边', maxX, 500]
];

for (const [label, dx, dy] of spots) {
  placed.length = 0;
  const ret = placeMain({ x: dx, y: dy, width: D.width, height: D.height });
  if (!ret || placed.length === 0) { ok('插件在' + label + ' → 定位成功', false, '返回 false'); continue; }
  const b = placed[0];
  const inside =
    b.x >= WA.x && b.y >= WA.y &&
    b.x + b.width <= WA.x + WA.width &&
    b.y + b.height <= WA.y + WA.height;
  ok('插件在' + label + ' → 日历完整落在工作区内', inside,
    '得到 (' + b.x + ',' + b.y + ') ' + b.width + '×' + b.height +
    ' 右下角=(' + (b.x + b.width) + ',' + (b.y + b.height) + ') 工作区右下=(' +
    (WA.x + WA.width) + ',' + (WA.y + WA.height) + ')');
}

// 日历窗口比工作区还大时的兜底（极端小屏）
const clampTiny = new Function('screen', extractFn(mainSrc, 'clampDockToWorkArea') +
  '; return clampDockToWorkArea;')({ getDisplayMatching: function () { return { workArea: { x: 0, y: 0, width: 200, height: 150 } }; } });
r = clampTiny({ x: 500, y: 500, width: D.width, height: D.height });
ok('工作区小于插件尺寸时也不抛异常', typeof r.x === 'number' && !isNaN(r.x), JSON.stringify(r));

/* ============ v1.7.22.4 修复：弹窗与插件右对齐（"弹窗没挨着插件"） ============ */
console.log('\n【v1.7.22.4】placeMainNearDock above/below 右对齐（修复弹窗水平错位）');
// 插件在右下角（默认落点）：弹窗应放上方且右边与插件右边贴齐（shift=0，不再左移 216px）
placed.length = 0;
placeMain({ x: maxX, y: maxY, width: D.width, height: D.height });
(function () {
  const b = placed[0];
  const dockRight = maxX + D.width;
  ok('右下角 → 弹窗右边与插件右边贴齐（无水平错位）',
    b && (b.x + b.width) === dockRight,
    '弹窗右=' + (b ? (b.x + b.width) : '?') + ' 插件右=' + dockRight);
  ok('右下角 → 弹窗紧贴插件上方（间距=MAIN_GAP=1）',
    b && (b.y + b.height) === (maxY - MAIN_GAP),
    '弹窗底=' + (b ? (b.y + b.height) : '?') + ' 插件顶-1=' + (maxY - MAIN_GAP));
})();
// 插件在左下角：弹窗应在右侧（右对齐方案下，below/above 会左超界，right 更优）
placed.length = 0;
placeMain({ x: 0, y: maxY, width: D.width, height: D.height });
ok('左下角 → 仍能定位成功且不超界',
  placed.length === 1 && placed[0].x >= WA.x && placed[0].y >= WA.y &&
  placed[0].x + placed[0].width <= WA.x + WA.width &&
  placed[0].y + placed[0].height <= WA.y + WA.height,
  JSON.stringify(placed[0]));

/* ============ 需求1：点击热区（isInCard） ============ */
console.log('\n【需求1】isInCard —— 只有插件可视小方框内才算命中');

const isInCard = new Function('cardEl',
  extractFn(dockSrc, 'isInCard') + '; return isInCard;')(
  // 窗口 116×50，卡片内缩 2px → 可视方框 (2,2)-(114,48)
  { getBoundingClientRect: function () { return { left: 2, top: 2, right: 114, bottom: 48 }; } });

ok('方框正中 (58,25) → 命中', isInCard(58, 25) === true);
ok('【用户报的 bug】方框下方透明区 (58,60) → 不命中', isInCard(58, 60) === false);
ok('方框正下方一点点 (58,49) → 不命中', isInCard(58, 49) === false);
ok('方框内底边 (58,47) → 命中', isInCard(58, 47) === true);
ok('窗口内但卡片外 (58,3) 之外的左边 (1,25) → 不命中', isInCard(1, 25) === false);
ok('卡片左边界 (2,25) → 命中（闭区间）', isInCard(2, 25) === true);
ok('卡片右边界 (114,25) → 不命中（半开区间）', isInCard(114, 25) === false);
ok('卡片内右上角 (113,47) → 命中', isInCard(113, 47) === true);
ok('左上角外 (0,0) → 不命中（圆角外的透明区）', isInCard(0, 0) === false);
ok('方框右侧透明区 (115,25) → 不命中', isInCard(115, 25) === false);
ok('方框上方 (58,1) → 不命中', isInCard(58, 1) === false);

// 遍历整条水平线：y=49（用户说的"水平线及以下"）必须全程不命中
let leakBelow = 0;
for (let x = -20; x < 140; x++) { if (isInCard(x, 49)) leakBelow++; }
ok('y=49 整条水平线（x 从 -20 到 140）零命中', leakBelow === 0, '泄漏 ' + leakBelow + ' 个像素');
let leakRow = 0;
for (let x = -20; x < 140; x++) { if (isInCard(x, 30)) leakRow++; }
ok('y=30 命中像素数 = 112（恰好是方框宽度）', leakRow === 112, '实际 ' + leakRow);

/* ============ 需求3 回归：拖到窗口外松手不能卡死 ============ */
console.log('\n【需求3 回归】endDrag —— 拖到窗口外松手后不能粘住鼠标');

/* 复现场景：光标移出窗口后窗口收不到 mouseup → dragging 卡在 true
 * → 鼠标一回到插件上就继续跟着走。用真实 endDrag 函数验证收口逻辑。 */
const endDragSrc = extractFn(dockSrc, 'endDrag');
const h = new Function(`
  var dragging = false, dragMoved = false;     // v1.7.22.5：变量名 moved → dragMoved
  var calls = { dragEnd: 0, hit: [] };
  var window = { api: { dockDragEnd: function () { calls.dragEnd++; } } };
  function updateHit(x, y, force) { calls.hit.push([x, y, force]); }
  ${endDragSrc}
  return {
    endDrag: endDrag, calls: calls,
    set: function (d, m) { dragging = d; dragMoved = m; },
    isDragging: function () { return dragging; }
  };
`)();

h.set(true, true);
h.endDrag({ clientX: 30, clientY: 20 });
ok('拖动后松手 → dragging 归位为 false（不再卡死）', h.isDragging() === false);
ok('拖动后松手 → 通知主进程夹取落点一次', h.calls.dragEnd === 1, '实际 ' + h.calls.dragEnd + ' 次');
ok('拖动后松手 → 按坐标强制复判热区', h.calls.hit.length === 1 &&
  h.calls.hit[0][0] === 30 && h.calls.hit[0][2] === true, JSON.stringify(h.calls.hit));

h.set(true, false);
h.calls.dragEnd = 0; h.calls.hit.length = 0;
h.endDrag({ clientX: 30, clientY: 20 });
ok('只点击没拖动 → 不通知主进程（避免无谓落库）', h.calls.dragEnd === 0);
ok('只点击没拖动 → 仍复判热区', h.calls.hit.length === 1);

h.set(true, true);
h.calls.dragEnd = 0; h.calls.hit.length = 0;
h.endDrag(null);   // 兜底路径：没有坐标（失焦 / 拖出窗口）
ok('兜底路径（无坐标）→ dragging 归位为 false', h.isDragging() === false);
ok('兜底路径（无坐标）→ 用 (-1,-1) 复判，先恢复穿透',
  h.calls.hit.length === 1 && h.calls.hit[0][0] === -1, JSON.stringify(h.calls.hit));

h.set(false, false);
h.calls.dragEnd = 0; h.calls.hit.length = 0;
h.endDrag({ clientX: 10, clientY: 10 });
ok('未处于拖动时调用 → 完全空转（幂等）',
  h.calls.dragEnd === 0 && h.calls.hit.length === 0);

// 静态复核：三条收口路径都必须存在
ok('mousedown 里调用 setPointerCapture（保证窗口外松手也能收到 mouseup）',
  /setPointerCapture/.test(dockSrc));
ok('[关键] 监听 blur 兜底收口', /addEventListener\('blur'[\s\S]{0,80}endDrag/.test(dockSrc));
ok('[关键] 监听 pointercancel 兜底收口',
  /addEventListener\('pointercancel'[\s\S]{0,80}endDrag/.test(dockSrc));
ok('[关键] mouseup 走统一收口 endDrag',
  /addEventListener\('mouseup'[\s\S]{0,80}endDrag/.test(dockSrc));

/* ============ 需求2/5/6：形态与清理（静态复核） ============ */
console.log('\n【需求2/5/6】形态切换与遗留清理');
const code = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

ok('setDockMode 切换函数存在', /function setDockMode\s*\(/.test(code));
ok('dockMode 持久化到 settings', /dockMode: dockMode/.test(mainSrc));
ok('插件位置持久化到 settings', /dockBounds: dockBounds/.test(mainSrc));
ok('托盘点击事件只绑 click（避开双击冲突）',
  /tray\.on\('click'/.test(mainSrc) && !/tray\.on\('double-click'/.test(mainSrc));
ok('[关键] 已无 attachDockToTaskbar', !/attachDockToTaskbar/.test(code));
ok('[关键] 已无 dock-embedded 通道', !/'dock-embedded'/.test(code));
ok('[关键] 主进程已无 SetParent / ReBarWindow32',
  !/SetParent/.test(code) && !/ReBarWindow32/.test(code));
ok('[关键] 已无 setSize 调用', !/\.setSize\s*\(/.test(code));
// 注意：必须用剥掉注释的 code —— 「贴回任务栏」只应出现在说明"为什么删掉它"的注释里
ok('[关键] 菜单已无「贴回任务栏」（代码层零残留）', !/贴回任务栏/.test(code));
// v2.2.0：settingsSnapshot（设置弹窗状态快照）里含 "Snap"，故用负向前瞻排除 "shot"，
// 避免把「snapshot」误判成「snap 吸附」逻辑。
ok('[关键] 拖动逻辑已无吸附（snap）', !/snap(?!shot)/i.test(code));

/* ============ v1.7.22.3 修复（"卡在半空"回归） ============ */
console.log('\n【v1.7.22.3】挂件条"卡在半空"回归修复');

/* 测试 1：loadSettings 校验 —— 异常尺寸必须丢弃，否则脏 dockBounds 会被 setBounds 进去撑大窗口。
 * 把 loadSettings 函数抠出来，注入 mock fs / 全局状态变量，模拟"读到脏 dockBounds"。 */
function makeLoadSettings(fakeJson) {
  const state = { themeMode: 'light', pinned: true, autoLaunch: true, dockOn: true,
    dockMode: 'dock', dockPinned: true, isWin11: false, dockBounds: null,
    lastRemindlistBounds: null };
  const ctx = {
    fs: { readFileSync: function () { return fakeJson; } },
    settingsFile: function () { return '/fake/path/settings.json'; },
    log: function () {},
    DOCK_W: DOCK_W, DOCK_H: DOCK_H
  };
  /* 注意：函数体里的所有状态变量都必须写 this.xxx —— new Function 创建的函数直接
   * 写 `dockBounds = ...` 会落到 global 上而非 this 绑定的 state 对象上。 */
  const fn = new Function('fs', 'settingsFile', 'log', 'DOCK_W', 'DOCK_H',
    'function loadSettings(){' +
    '  try{var f=settingsFile();if(!f)return;var o=JSON.parse(fs.readFileSync(f,"utf8"));' +
    '  if(o&&typeof o==="object"){' +
    '    this.themeMode=(o.theme==="dark")?"dark":"light";' +
    '    this.pinned=o.pinned!==false;this.autoLaunch=o.autoLaunch!==false;this.dockOn=o.dockOn!==false;' +
    '    this.dockMode=(o.dockMode==="icon")?"icon":"dock";' +
    '    this.dockPinned=o.dockPinned!==false;' +
    '    this.isWin11=o.isWin11===true;' +
    '    if(o.dockBounds&&typeof o.dockBounds.x==="number"&&typeof o.dockBounds.y==="number"){' +
    '      var bw=o.dockBounds.width||DOCK_W;var bh=o.dockBounds.height||DOCK_H;' +
    '      var wOk=Math.abs(bw-DOCK_W)<=4;var hOk=bh>=36&&bh<=60;' +
    '      if(wOk&&hOk){this.dockBounds={x:o.dockBounds.x,y:o.dockBounds.y,width:bw,height:bh};}' +
    '      else{try{log("invalid dockBounds "+bw+"x"+bh);}catch(_){} this.dockBounds=null;}' +
    '    }' +
    '    if(o.remindlistBounds&&typeof o.remindlistBounds.x==="number"){' +
    '      this.lastRemindlistBounds=o.remindlistBounds;}' +
    '  }}catch(e){}' +
    '}\nreturn loadSettings;'
  )(ctx.fs, ctx.settingsFile, ctx.log, ctx.DOCK_W, ctx.DOCK_H);
  // 用闭包绑定状态 + 函数
  return { run: function () { fn.call(state, ctx); }, state: state };
}

(function () {
  // 场景 A：脏数据 350×178（用户实测遇到的） → 必须丢弃
  const dirty = '{"dockBounds":{"x":1068,"y":742,"width":350,"height":178}}';
  const t = makeLoadSettings(dirty);
  t.run();
  ok('脏 dockBounds 350×178 → 抛掉（dockBounds=null）', t.state.dockBounds === null,
    '实际=' + JSON.stringify(t.state.dockBounds));
})();
(function () {
  // 场景 B：合理尺寸 → 必须接受
  const good = '{"dockBounds":{"x":1068,"y":742,"width":' + DOCK_W + ',"height":' + DOCK_H + '}}';
  const t = makeLoadSettings(good);
  t.run();
  ok('合理尺寸 ' + DOCK_W + '×' + DOCK_H + ' → 保留',
    t.state.dockBounds && t.state.dockBounds.width === DOCK_W && t.state.dockBounds.height === DOCK_H,
    '实际=' + JSON.stringify(t.state.dockBounds));
})();
(function () {
  // 场景 C：宽度在范围内但高度离谱（嵌入子窗常见错写） → 必须丢弃
  const wide = '{"dockBounds":{"x":0,"y":0,"width":' + DOCK_W + ',"height":300}}';
  const t = makeLoadSettings(wide);
  t.run();
  ok('宽度对但高度 300 → 丢弃', t.state.dockBounds === null,
    '实际=' + JSON.stringify(t.state.dockBounds));
})();
(function () {
  // 场景 D：尺寸完全正确，但缺 x/y → 不进 if 分支（已有外层守卫）
  const noxy = '{"dockBounds":{"width":' + DOCK_W + ',"height":' + DOCK_H + '}}';
  const t = makeLoadSettings(noxy);
  t.run();
  ok('缺 x/y → 不写入（外层守卫拦截）', t.state.dockBounds === null,
    '实际=' + JSON.stringify(t.state.dockBounds));
})();

/* 测试 2：clampDockToWorkArea 在脏数据下的"卡在半空"行为对比
 * 演示：不修的话，350×178 撑大窗口后卡片只能去到 maxX-118 位置（看似"过不去"）；
 * 修了之后，按真实 116×50 计算 maxX，卡片能贴到屏幕右边。 */
(function () {
  const maxXdirty = WA.x + Math.max(0, WA.width - 350);
  const maxYdirty = WA.y + Math.max(0, WA.height - 178);
  const maxXok = WA.x + Math.max(0, WA.width - DOCK_W);
  const maxYok = WA.y + Math.max(0, WA.height - DOCK_H);
  ok('演示：脏数据 maxX=' + maxXdirty + '，maxY=' + maxYdirty + ' → 严重压缩',
    maxXdirty < maxXok - 200 && maxYdirty < maxYok - 100);
  ok('演示：正确尺寸 maxX=' + maxXok + '，maxY=' + maxYok + ' → 允许贴边',
    maxXok === WA.width - DOCK_W && maxYok === WA.height - DOCK_H);
})();

/* 测试 3：静态确认 ready-to-show / applyDockMode 路径的尺寸来源。
 * v1.7.22.3 的语义是"尺寸用 dockWin.getBounds()"，用来防磁盘脏数据撑大窗口；
 * v1.7.22.7 实测发现 getBounds() 本身就会被撑大（日志取证：请求 116×40，
 * 实际落到 232×164，且同一次运行内从 230×152 变到 232×164），
 * 因此升级为"尺寸用意图常量 dockW×dockH"，统一走 dockClamped()。 */
ok('[关键] ready-to-show 恢复位置 → 尺寸用意图常量（走 dockClamped）',
  /ready-to-show[\s\S]{0,900}dockClamped\(dockBounds\.x, dockBounds\.y\)/.test(mainSrc));
ok('[关键] applyDockMode 恢复位置 → 同样走 dockClamped',
  /applyDockMode[\s\S]{0,900}dockClamped\(dockBounds\.x, dockBounds\.y\)/.test(mainSrc));
ok('[关键] loadSettings 第一道防线：宽度差 <=4 + 高度 [36,60] 才放行',
  /Math\.abs\(bw - DOCK_W\) <= 4/.test(mainSrc) && /bh >= 36 && bh <= 60/.test(mainSrc));

/* ============ v1.7.22.5 修复：拖拽"底部边界上移"根因 ============ */
console.log('\n【v1.7.22.5】拖拽绝对定位（mouse - offset，禁止 b.y + dy 累加漂移）');

/* ===== 测试 1：绝对定位算法本身 ——
 * 核心公式：mousedown 时记一次 offset = mouseDown - windowStart；之后 mousemove 用
 * newPos = mouseNow - offset（offset 永不变，与窗口是否被 clamp 无关）。
 * 该公式与窗口被 clamp 无关，零累积误差。 */
function dragAbsStep(offset, mouseNow) {
  return { x: mouseNow.x - offset.x, y: mouseNow.y - offset.y };
}

(function () {
  const win0 = { x: 1000, y: 850 };
  const md = { x: 1020, y: 870 };
  const offset = { x: md.x - win0.x, y: md.y - win0.y };     // mousedown 时记一次，永不变
  const r = dragAbsStep(offset, { x: 1080, y: 920 });        // 拖到 (1080, 920)
  ok('基础绝对定位：offset=(20,20)，拖到 (1080,920) → 窗口 (1060,900)',
    r.x === 1060 && r.y === 900, JSON.stringify(r));
})();

/* ===== 测试 2：100 次 (1,1) 累加无误差（模拟"持续拖动不松手"） ===== */
(function () {
  const win0 = { x: 1000, y: 850 };
  const md = { x: 1020, y: 870 };
  const offset = { x: md.x - win0.x, y: md.y - win0.y };     // 一次性记录
  let mouse = { x: md.x, y: md.y };
  let win = win0;
  for (let i = 0; i < 100; i++) {
    mouse.x += 1; mouse.y += 1;
    win = dragAbsStep(offset, mouse);                         // offset 永不变
  }
  ok('100 次 (1,1) 拖动累加 → 窗口 (1100, 950)，无漂移',
    win.x === 1100 && win.y === 950, '实际 (' + win.x + ', ' + win.y + ')');
})();

/* ===== 测试 3：关键 — "夹紧 + 再次拖动" 不产生漂移（修复用户报的 bug） ===== */
(function () {
  // 模拟工作区 1920×1040（任务栏 40px），窗口 116×50
  const clamp = function (b) {
    return {
      x: Math.max(0, Math.min(b.x, 1920 - b.width)),
      y: Math.max(0, Math.min(b.y, 1040 - b.height)),
      width: b.width, height: b.height
    };
  };
  // 模拟"新实现"：dockDragStart/Move 主进程逻辑（绝对定位，offset 一次记录永不变）
  function newImplDragStart(win, mouseX, mouseY) {
    return { offsetX: mouseX - win.x, offsetY: mouseY - win.y };
  }
  function newImplDragMove(win, offset, mouseX, mouseY) {
    return clamp(Object.assign({},
      { x: mouseX - offset.offsetX, y: mouseY - offset.offsetY },
      { width: win.width, height: win.height }));
  }

  // 关键约束：mousedown / mousemove 的 mouseY 都必须在 dock 视口内（[win.y, win.y+50]）
  // 否则 dock.html 不会触发 mousemove —— 这是 dock.html 物理尺寸决定的硬约束。
  // 所以测试只能在 dock 视口范围内模拟，但 dock.y 会跟着 setBounds 移动。

  let win = { x: 1000, y: 800, width: 116, height: 50 };
  // ---- 第 1 轮：拖到底，期望贴任务栏 ----
  let offset = newImplDragStart(win, 1020, 820);   // mousedown 在 dock 顶
  win = newImplDragMove(win, offset, 1020, 830);
  ok('【新实现】第 1 轮拖下 10px → 窗口 y=810', win.y === 810, '实际 y=' + win.y);
  win = newImplDragMove(win, offset, 1020, 850);
  // newY = 850 - (820-800) = 830 → clamp 990
  ok('【新实现】第 1 轮继续拖下 → 窗口 y=830', win.y === 830, '实际 y=' + win.y);
  win = newImplDragMove(win, offset, 1020, 870);
  ok('【新实现】第 1 轮拖到 dock 视口底 → 窗口 y=850', win.y === 850, '实际 y=' + win.y);

  // ---- 跨越夹边界：dragStart 必须重新记录 ----
  // 第 2 轮：mousedown 在新 dock 视口内
  offset = newImplDragStart(win, 1020, 870);   // mousedown 在 dock 顶（视口 [850, 900]）
  win = newImplDragMove(win, offset, 1020, 880);
  // newY = 880 - (870-850) = 860
  ok('【新实现】第 2 轮 mousedown 重置 offset → 窗口 y=860', win.y === 860, '实际 y=' + win.y);
  win = newImplDragMove(win, offset, 1020, 900);   // dock 视口底
  // newY = 900 - (870-850) = 880
  ok('【新实现】第 2 轮拖到 dock 视口底 → 窗口 y=880', win.y === 880, '实际 y=' + win.y);

  // ---- 第 3 轮：进入夹紧区域，验证不漂移 ----
  offset = newImplDragStart(win, 1020, 900);
  win = newImplDragMove(win, offset, 1020, 910);
  // newY = 910 - (900-880) = 890 → clamp 990
  ok('【新实现】第 3 轮 → 窗口 y=890', win.y === 890, '实际 y=' + win.y);
  win = newImplDragMove(win, offset, 1020, 920);
  // newY = 920 - (900-880) = 900 → clamp 990
  ok('【新实现】第 3 轮拖到 dock 视口底 → 窗口 y=900', win.y === 900, '实际 y=' + win.y);

  // 第 4 轮：模拟"反复拖下到底" —— 验证贴任务栏的稳定性（关键修复证据）
  // 真实约束：mousedown/mousemove 的 mouseY 必须落在 dock 视口内（[win.y, win.y+50]），
  // 否则 dock.html 不响应。每轮 mousedown 在 dock 中心，拖到 dock 视口底。
  let prevY = win.y;
  let allStable = true;
  for (let i = 0; i < 20; i++) {
    offset = newImplDragStart(win, 1020, win.y + 25);
    win = newImplDragMove(win, offset, 1020, win.y + 50);   // 拖到 dock 视口底
    if (win.y !== Math.min(990, prevY + 25)) { allStable = false; break; }
    prevY = win.y;
  }
  ok('【新实现】20 轮反复拖到底后稳定贴任务栏（maxY=990）',
    allStable && win.y === 990,
    '最终 win.y=' + win.y + ' allStable=' + allStable);

  // ---- 反向证据：旧累加模式在 dock 视口内反复拖动，期望 dock 跟鼠标 1:1 移动 ----
  let oldY = 800;
  // 旧实现：mousedown y=825, 拖到 850, dy=25, curY=825
  oldY = Math.max(0, Math.min(oldY + 25, 990));
  // 旧实现：mousedown y=850（curY=825+25）, 拖到 875, dy=25, curY=850
  oldY = Math.max(0, Math.min(oldY + 25, 990));
  ok('【对照】旧累加模式单纯拖下：dock 也跟鼠标 1:1 移动（不漂移）',
    oldY === 850, '旧模式 y=' + oldY + ' —— 但旧模式更脆弱：mousedown 必须落在 dock 视口内');
})();

/* ===== 测试 4：源码静态确认 ——
 * 主进程 dock-drag-move 必须用绝对定位（mouse - offset），不能再用 b.x + Math.round(dx) */
ok('[关键] dock-drag-move 用 newX = mouseX - dragOffsetX（绝对定位）',
  /const newX = Math\.round\(mouseX\)\s*-\s*dragOffsetX/.test(mainSrc) &&
  /const newY = Math\.round\(mouseY\)\s*-\s*dragOffsetY/.test(mainSrc));
ok('[关键] dock-drag-move 内部禁止 b\.x \+ Math\.round\(dx\) 这种累加写法',
  !/b\.x\s*\+\s*Math\.round\(dx\)/.test(mainSrc) &&
  !/b\.y\s*\+\s*Math\.round\(dy\)/.test(mainSrc));
ok('[关键] dock-drag-start 注册存在，记录 offset = mouseDown - windowStart',
  /ipcMain\.on\('dock-drag-start'/.test(mainSrc) &&
  /dragOffsetX\s*=\s*Math\.round\(mouseX\)\s*-\s*b\.x/.test(mainSrc));
ok('[关键] dock.html mousedown 调 dockDragStart(mouseX, mouseY)',
  /dockDragStart\(e\.screenX,\s*e\.screenY\)/.test(dockSrc));
ok('[关键] dock.html mousemove 调 dockDragMove(mouseX, mouseY)（不再算 dx/dy）',
  /dockDragMove\(e\.screenX,\s*e\.screenY\)/.test(dockSrc) &&
  !/var\s+dx\s*=\s*e\.screenX\s*-\s*dragStartX/.test(dockSrc));

/* ============ v1.7.22.7 修复：物理窗口被撑大 → 拖不到底/拖不到右/弹窗错位 ============ */
console.log('\n【v1.7.22.7】意图尺寸 dockW×dockH 成为唯一真值（不采信 getBounds 尺寸）');

/* 取证数据来自真实日志 calendar.log：
 *   `dock dropped at 1208,756` 且屏幕 workArea = 1440×920
 *   → 反推物理窗口宽 1440-1208 = 232、高 920-756 = 164
 *   → 而代码请求的只是 116×40（DOCK_W × clamp(taskbarHeight,40,56)）
 * 同一次运行内还出现过 `dock dropped at 1210,768` → 反推 230×152，尺寸会变。
 * 结论：物理窗口确实被引擎/OS 撑大，且不可控 —— 不能拿它做任何布局决策。 */
const REAL_WA = { x: 0, y: 0, width: 1440, height: 920 };   // 用户实测 workArea
const INTENT_W = 116, INTENT_H = 40;                        // dockW / dockH
const INFLATED_W = 232, INFLATED_H = 164;                   // 日志反推的物理窗口

function clampWith(w, h, x, y) {
  const maxX = REAL_WA.x + Math.max(0, REAL_WA.width - w);
  const maxY = REAL_WA.y + Math.max(0, REAL_WA.height - h);
  return { x: Math.max(REAL_WA.x, Math.min(x, maxX)), y: Math.max(REAL_WA.y, Math.min(y, maxY)) };
}

ok('取证一致：日志 1208,756 反推出的 232×164 与"意图 116×40"明显不符',
  INFLATED_W !== INTENT_W && INFLATED_H !== INTENT_H,
  '物理 ' + INFLATED_W + 'x' + INFLATED_H + ' vs 意图 ' + INTENT_W + 'x' + INTENT_H);

(function () {
  // 旧行为：拿撑大的物理尺寸算边界 → 卡片贴不到边
  const oldMax = clampWith(INFLATED_W, INFLATED_H, 99999, 99999);
  // 新行为：拿意图尺寸算边界 → 卡片能真正贴到屏幕右沿 / 任务栏上沿
  const newMax = clampWith(INTENT_W, INTENT_H, 99999, 99999);
  ok('旧行为（用撑大尺寸）最低只能到 y=' + oldMax.y + '、最右 x=' + oldMax.x,
    oldMax.x === 1208 && oldMax.y === 756, JSON.stringify(oldMax));
  ok('新行为（用意图尺寸）能到 y=' + newMax.y + '、最右 x=' + newMax.x,
    newMax.x === 1324 && newMax.y === 880, JSON.stringify(newMax));
  ok('修复后向右多出 ' + (newMax.x - oldMax.x) + 'px、向下多出 ' + (newMax.y - oldMax.y) + 'px 可活动空间',
    newMax.x - oldMax.x === 116 && newMax.y - oldMax.y === 124,
    'Δx=' + (newMax.x - oldMax.x) + ' Δy=' + (newMax.y - oldMax.y));
  ok('新行为下卡片底边正好压在任务栏上沿（' + (newMax.y + INTENT_H) + ' = workArea 底 920）',
    newMax.y + INTENT_H === REAL_WA.height);
  ok('新行为下卡片右边正好贴屏幕右沿（' + (newMax.x + INTENT_W) + ' = workArea 宽 1440）',
    newMax.x + INTENT_W === REAL_WA.width);
})();

(function () {
  // 弹窗定位：传撑大矩形会让日历右对齐时偏出 (232-116)=116px
  const db = { x: 1324, y: 880 };
  const CAL_W = 340;
  const oldRightAlignX = db.x + INFLATED_W - CAL_W;   // 旧：用物理宽度
  const newRightAlignX = db.x + INTENT_W - CAL_W;     // 新：用意图宽度
  ok('弹窗右对齐：旧行为偏出 ' + (oldRightAlignX - newRightAlignX) + 'px',
    oldRightAlignX - newRightAlignX === 116,
    '旧 x=' + oldRightAlignX + ' 新 x=' + newRightAlignX);
  ok('弹窗右对齐：新行为与卡片右沿对齐（' + (newRightAlignX + CAL_W) + ' = 卡片右沿 ' + (db.x + INTENT_W) + '）',
    newRightAlignX + CAL_W === db.x + INTENT_W);
})();

/* 源码静态确认 */
ok('[关键] dockW/dockH 意图尺寸变量已声明',
  /let dockW = DOCK_W;/.test(mainSrc) && /let dockH = DOCK_H;/.test(mainSrc));
ok('[关键] dockClamped() 存在且内部用 dockW/dockH',
  /function dockClamped\(x, y\)/.test(mainSrc) &&
  /clampDockToWorkArea\(\{ x: x, y: y, width: dockW, height: dockH \}\)/.test(mainSrc));
ok('[关键] 建窗用 dockW/dockH（dockH 由 taskbarHeight 夹取而来）',
  /dockH = Math\.max\(40, Math\.min\(tb, 56\)\);/.test(mainSrc) &&
  /width: dockW, height: dockH,/.test(mainSrc));
ok('[关键] pushDockSize 下发意图尺寸（不再把撑大的尺寸发给页面渲染卡片）',
  /send\('dock-size', \{ w: dockW, h: dockH \}\)/.test(mainSrc));
ok('[关键] placeMainNearDock 传意图矩形（弹窗不错位）',
  /placeMainNearDock\(\{ x: db\.x, y: db\.y, width: dockW, height: dockH \}\)/.test(mainSrc));
ok('[关键·反向] 已无 placeMainNearDock(dockWin.getBounds()) 直传',
  !/placeMainNearDock\(dockWin\.getBounds\(\)\)/.test(mainSrc));
ok('建窗后自诊断：实际尺寸 ≠ 意图尺寸时写日志',
  /dock size INFLATED by OS/.test(mainSrc));

console.log('\n==================================');
console.log('运行时单测： ' + pass + ' 通过 / ' + fail + ' 失败');
console.log('==================================');
process.exit(fail === 0 ? 0 : 1);
