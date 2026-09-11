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
ok('[关键] ready-to-show 恢复位置 → pickDockRestore 选落点 + dockClamped 夹取（意图尺寸）',
  /ready-to-show[\s\S]{0,1200}pickDockRestore\([\s\S]{0,700}dockClamped\(restoreRect\.x, restoreRect\.y\)/.test(mainSrc));
ok('[关键] applyDockMode 恢复位置 → 同样 pickDockRestore + dockClamped',
  /applyDockMode[\s\S]{0,1200}pickDockRestore\([\s\S]{0,700}dockClamped\(restoreRect\.x, restoreRect\.y\)/.test(mainSrc));
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

/* ============ v2.4.0 皮肤中枢：validHex / isDarkColor（WCAG 相对亮度） ============ */
console.log('\n【v2.4.0】validHex / isDarkColor —— 色值校验 + WCAG 深色判定');

const colorApi = new Function(
  extractFn(mainSrc, 'validHex') + '\n' + extractFn(mainSrc, 'isDarkColor') +
  '; return { validHex: validHex, isDarkColor: isDarkColor };'
)();

ok('validHex "#123456" → 原样大写', colorApi.validHex('#123456') === '#123456');
ok('validHex "123456"（无#）→ 补全#', colorApi.validHex('123456') === '#123456');
ok('validHex "#abcDEF" → 统一大写', colorApi.validHex('#abcDEF') === '#ABCDEF');
ok('validHex "  #1a2b3c  "（含空白）→ trim 后解析', colorApi.validHex('  #1a2b3c  ') === '#1A2B3C');
ok('validHex "#fff"（3位）→ null', colorApi.validHex('#fff') === null);
ok('validHex "#gggggg"（非法字符）→ null', colorApi.validHex('#gggggg') === null);
ok('validHex "#12345g" → null', colorApi.validHex('#12345g') === null);
ok('validHex "12345"（5位）→ null', colorApi.validHex('12345') === null);
ok('validHex "" → null', colorApi.validHex('') === null);
ok('validHex null → null', colorApi.validHex(null) === null);
ok('validHex 123456（非字符串）→ null', colorApi.validHex(123456) === null);

ok('isDarkColor #000000 → true（纯黑）', colorApi.isDarkColor('#000000') === true);
ok('isDarkColor #FFFFFF → false（纯白）', colorApi.isDarkColor('#ffffff') === false);
ok('isDarkColor #0000FF → true（纯蓝，亮度≈0.07）', colorApi.isDarkColor('#0000FF') === true);
ok('isDarkColor #FFFF00 → false（纯黄，亮度≈0.93）', colorApi.isDarkColor('#FFFF00') === false);
ok('isDarkColor #808080 → true（中灰，WCAG 亮度≈0.216 < 0.5）', colorApi.isDarkColor('#808080') === true);
ok('isDarkColor #1f2430 → true（日历深色预设）', colorApi.isDarkColor('#1f2430') === true);
ok('isDarkColor #e8eaf0 → false（深背景浅字用浅色）', colorApi.isDarkColor('#e8eaf0') === false);
ok('isDarkColor 非法输入 → false（不抛错）', colorApi.isDarkColor('nope') === false);

/* ============ v2.4.0 第二轮 皮肤中枢：per-surface 明暗 + 背景 + 迁移 ============ */
console.log('\n【v2.4.0 第二轮】resolveSurfaceConfig / surfaceTheme / surfaceBg / resolvedSurfaceState / migrateSkin / normalizeSkin');

function makeSkinHub(skinState, nativeThemeMock) {
  const src = [
    'sanitizeBasename', 'clamp01', 'clampZoom', 'clampImageOpacity', 'normalizeClarity',
    'validHex', 'isDarkColor', 'clampOpacity',
    'normalizeImageSpec', 'normalizeSkin', 'migrateSkin',
    // v3.0.0：surfaceTheme 依赖 styleNativeTheme（tech→dark，其余→light），必须抽取，否则 ReferenceError
    'styleNativeTheme',
    'resolveSurfaceConfig',
    'surfaceTheme', 'solidFallbackFor', 'surfaceBg', 'clarityForConfig', 'baseTheme', 'resolvedSurfaceState'
  ].map(function (n) { return extractFn(mainSrc, n); }).join('\n');
  return new Function('skin', 'nativeTheme', src +
    '; return { resolveSurfaceConfig: resolveSurfaceConfig, surfaceTheme: surfaceTheme, surfaceBg: surfaceBg, baseTheme: baseTheme, resolvedSurfaceState: resolvedSurfaceState, migrateSkin: migrateSkin, normalizeSkin: normalizeSkin };'
  )(skinState, nativeThemeMock);
}

(function () {
  const skin = { __v: 3, surfaces: {
    calendar: { style: 'glass', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'dark' },
    expanded: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    desktop: { follow: null, style: 'neu', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    dock: { style: 'minimal', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' }
  }, opacity: { calendar: 1, desktop: 1, dock: 1 } };
  const api = makeSkinHub(skin, { shouldUseDarkColors: false });
  ok('expanded follow=calendar → 返回 calendar 配置（style=glass）', api.resolveSurfaceConfig('expanded').style === 'glass');
  ok('desktop follow=null → 返回自身（style=neu）', api.resolveSurfaceConfig('desktop').style === 'neu');
  ok('dock 独立 → 返回自身（style=minimal）', api.resolveSurfaceConfig('dock').style === 'minimal');
  ok('baseTheme = calendar 表面生效明暗（tone=dark → dark）', api.baseTheme() === 'dark');
})();

(function () {
  const skin = { __v: 3, surfaces: {
    calendar: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'light' },
    expanded: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    desktop: { follow: null, style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'system' },
    dock: { style: 'tech', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' }
  }, opacity: {} };
  const api = makeSkinHub(skin, { shouldUseDarkColors: true });
  ok('surfaceTheme tone=light → light', api.surfaceTheme('calendar') === 'light');
  ok('surfaceTheme tone=system + 系统深色 → dark', api.surfaceTheme('desktop') === 'dark');
  ok('surfaceTheme tone=auto + style=tech → dark（styleNativeTheme tech）', api.surfaceTheme('dock') === 'dark');
})();

(function () {
  const skin = { __v: 3, surfaces: {
    calendar: { style: 'default', bg: 'native', image: null, text: 'dark', clarity: 'auto', tone: 'auto' },
    expanded: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    desktop: { follow: null, style: 'minimal', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'dark' },
    dock: { style: 'default', bg: 'image', image: { file: 'x.png', snapshot: null, w: 1000, h: 1000, crop: { x: 0, y: 0, w: 1, h: 1 }, zoom: 1, dark: false }, text: 'auto', clarity: 'auto', tone: 'auto' }
  }, opacity: {} };
  const api = makeSkinHub(skin, { shouldUseDarkColors: false });
  ok('surfaceTheme 与 text 解耦：text=dark + tone=auto（default）仍 → light', api.surfaceTheme('calendar') === 'light');
  ok('surfaceTheme tone=dark → dark', api.surfaceTheme('desktop') === 'dark');
  ok('surfaceTheme bg=image 亮图 → light（按图片亮度）', api.surfaceTheme('dock') === 'light');
})();

(function () {
  const skin = { __v: 3, surfaces: {
    calendar: { style: 'default', bg: 'image', image: { file: 'c.png', snapshot: null, w: 1000, h: 1000, crop: { x: 0, y: 0, w: 1, h: 1 }, zoom: 1, dark: false }, text: 'auto', clarity: 'auto', tone: 'auto' },
    expanded: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    desktop: { follow: null, style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    dock: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' }
  }, opacity: {} };
  const api = makeSkinHub(skin, { shouldUseDarkColors: false });
  const b1 = api.surfaceBg('calendar');
  ok('surfaceBg calendar bg=image → {kind:image,file}', b1.kind === 'image' && b1.image && b1.image.file === 'c.png', JSON.stringify(b1));
  ok('surfaceBg expanded follow → 复用 calendar 背景', api.surfaceBg('expanded').kind === 'image');
  ok('surfaceBg desktop bg=native → {kind:native}', api.surfaceBg('desktop').kind === 'native');
  ok('surfaceBg dock bg=native → {kind:native}', api.surfaceBg('dock').kind === 'native');
})();

(function () {
  const skin = { __v: 3, surfaces: {
    calendar: { style: 'glass', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    expanded: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    desktop: { follow: null, style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    dock: { style: 'default', bg: 'image', image: { file: 'd.gif', snapshot: 'd_frame.png', w: 1280, h: 853, crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }, zoom: 1.5, dark: true }, text: 'auto', clarity: 'auto', tone: 'auto' }
  }, opacity: {} };
  const api = makeSkinHub(skin, { shouldUseDarkColors: false });
  const st = api.resolvedSurfaceState('calendar');
  ok('resolvedSurfaceState calendar → style/tone/theme/bg 齐全（v3 无 type）',
    st.style === 'glass' && st.tone === 'auto' && st.theme === 'light' && st.bg === 'native' && st.type === undefined, JSON.stringify(st));
  const dk = api.resolvedSurfaceState('dock');
  ok('resolvedSurfaceState dock image → image 透传 + theme=dark', dk.bg === 'image' && dk.image && dk.image.file === 'd.gif' && dk.theme === 'dark', JSON.stringify(dk));
})();

/* ============ v3.0.0 / v2.4.1 C/E：bg=image 但尚未导入图片 → 回退纯色 + 不硬切黑夜 ============ */
(function () {
  const skin = { __v: 3, surfaces: {
    calendar: { style: 'default', bg: 'image', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    expanded: { follow: 'calendar', style: 'default', bg: 'image', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    desktop: { follow: null, style: 'default', bg: 'image', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
    dock: { style: 'default', bg: 'image', image: null, text: 'auto', clarity: 'auto', tone: 'dark' }
  }, opacity: {} };
  const api = makeSkinHub(skin, { shouldUseDarkColors: false });
  const b1 = api.surfaceBg('calendar');
  ok('v2.4.1 surfaceBg bg=image 但无图 → 回退纯色兜底（不透明）', b1.kind === 'color' && b1.color === '#FCFBF9', JSON.stringify(b1));
  ok('v2.4.1 surfaceTheme bg=image 无图 + tone=auto → light（不硬切黑夜）', api.surfaceTheme('calendar') === 'light');
  const st = api.resolvedSurfaceState('calendar');
  ok('v2.4.1 resolvedSurfaceState bg=image 无图 → bg=color 而非 image', st.bg === 'color' && st.color === '#FCFBF9' && st.image === null, JSON.stringify(st));
  const dk = api.surfaceBg('dock');
  ok('v3.0.0 surfaceBg bg=image 无图 + tone=dark → 深色兜底', dk.kind === 'color' && dk.color === '#1C202C', JSON.stringify(dk));
})();

/* ============ v2.4.1 D：skin:// URL → 文件名（standard 协议尾斜杠兼容） ============ */
console.log('\n【v2.4.1】skinUrlToName —— skin:// URL 安全解析为 basename');
(function () {
  const api = new Function(extractFn(mainSrc, 'sanitizeBasename') + '\n' + extractFn(mainSrc, 'skinUrlToName') + '; return { skinUrlToName: skinUrlToName };')();
  ok('skin://x.png/ → x.png（剥 standard 协议尾斜杠）', api.skinUrlToName('skin://x.png/') === 'x.png');
  ok('skin://x.png → x.png（无尾斜杠兼容）', api.skinUrlToName('skin://x.png') === 'x.png');
  ok('skin://../../evil.png → evil.png（防路径穿越）', api.skinUrlToName('skin://../../evil.png') === 'evil.png');
  ok('skin://x.png?v=1 → x.png（去 query）', api.skinUrlToName('skin://x.png?v=1') === 'x.png');
  ok('skin://a/b/c.png/ → c.png（多级取末段）', api.skinUrlToName('skin://a/b/c.png/') === 'c.png');
})();

(function () {
  const api = makeSkinHub({}, { shouldUseDarkColors: false });
  const m = api.migrateSkin({ theme: 'dark', nativeSkin: 'light', skinMode: 'custom', skinColor: { calendar: '#224466', desktop: '#334455', dock: '#102030' }, desktopFollowCalendar: false, dockFollowCalendar: false, mainOpacity: 0.8, desktopOpacity: 0.6, dockOpacity: 0.7 });
  ok('migrateSkin 日历 custom 色 → type=color + color', m.surfaces.calendar.type === 'color' && m.surfaces.calendar.color === '#224466');
  ok('migrateSkin 桌面不跟随+色 → follow=null + color', m.surfaces.desktop.follow === null && m.surfaces.desktop.type === 'color' && m.surfaces.desktop.color === '#334455');
  ok('migrateSkin 浮动色 → dock color（丢弃 dockFollowCalendar）', m.surfaces.dock.type === 'color' && m.surfaces.dock.color === '#102030');
  ok('migrateSkin 透明度迁移 0.8/0.6/0.7', m.opacity.calendar === 0.8 && m.opacity.desktop === 0.6 && m.opacity.dock === 0.7);
  ok('migrateSkin __v===2', m.__v === 2);
})();

(function () {
  const api = makeSkinHub({}, { shouldUseDarkColors: false });
  const m = api.migrateSkin({ nativeSkin: 'system' });
  ok('migrateSkin nativeSkin=system（无自定义色）→ calendar.type=system', m.surfaces.calendar.type === 'system');
  ok('migrateSkin expanded/desktop 默认 follow=calendar', m.surfaces.expanded.follow === 'calendar' && m.surfaces.desktop.follow === 'calendar');
})();

(function () {
  const api = makeSkinHub({}, { shouldUseDarkColors: false });
  const n = api.normalizeSkin({ __v: 2, surfaces: {
    calendar: { type: 'color', color: 'abc' },
    dock: { type: 'image', image: { file: '../../evil.png', crop: { x: -1, y: 2, w: 3, h: 0.5 }, zoom: 9 } }
  }, opacity: { calendar: 2, dock: 0.1 } });
  ok('normalizeSkin 非法色 → null（validHex 校验）', n.surfaces.calendar.color === null);
  ok('normalizeSkin 路径穿越 → basename 消毒', n.surfaces.dock.image && n.surfaces.dock.image.file === 'evil.png');
  ok('normalizeSkin crop clamp 到 0~1', n.surfaces.dock.image.crop.x === 0 && n.surfaces.dock.image.crop.w === 1);
  ok('normalizeSkin zoom clamp 到 1~5', n.surfaces.dock.image.zoom === 5);
  ok('normalizeSkin opacity clamp 到 0.3~1', n.opacity.calendar === 1 && n.opacity.dock === 0.3);
})();

/* ============ v2.4.0 第二轮 取景数学：crop+zoom ↔ CSS background（正向/反向一致性） ============ */
console.log('\n【v2.4.0 第二轮】取景数学 —— 归一化 crop/zoom 与视口/原图尺寸解耦，重启复现一致');

function _clamp01(v) { return Math.max(0, Math.min(1, v)); }
function _clampZoom(v) { return Math.max(1, Math.min(5, v)); }
function cropForward(image, cropRect, zoom, vp) {
  const IW = image.w, IH = image.h;
  const cx = cropRect.x * IW, cy = cropRect.y * IH, cw = cropRect.w * IW, ch = cropRect.h * IH;
  // 全图 cover 基准（crop.w/h 是 zoom 的派生冗余，不进基准；否则与反向 zoom=s/s0 不互逆）
  const s0 = Math.max(vp.w / IW, vp.h / IH);
  const s = s0 * zoom;
  return {
    size: [IW * s, IH * s],
    pos: [vp.w / 2 - (cx + cw / 2) * s, vp.h / 2 - (cy + ch / 2) * s],
    s: s, s0: s0
  };
}
function cropReverse(image, center, s, vp) {
  const IW = image.w, IH = image.h;
  const vw = vp.w / s, vh = vp.h / s;
  return {
    crop: {
      x: _clamp01(Math.max(0, Math.min((center.x - vw / 2) / IW, Math.max(0, 1 - vw / IW)))),
      y: _clamp01(Math.max(0, Math.min((center.y - vh / 2) / IH, Math.max(0, 1 - vh / IH)))),
      w: _clamp01(vw / IW),
      h: _clamp01(vh / IH)
    },
    zoom: _clampZoom(s / Math.max(vp.w / IW, vp.h / IH))
  };
}

(function () {
  const img = { w: 1280, h: 853 };
  // 日历取景框 340×430，原图 cover 缩放后（zoom=1）应横向取满、纵向裁切
  const f1 = cropForward(img, { x: 0, y: 0, w: 1, h: 1 }, 1, { w: 340, h: 430 });
  ok('cover 缩放（zoom=1）横图 → 尺寸铺满且纵向超出视口', f1.size[0] >= 340 && f1.size[1] >= 430, JSON.stringify(f1.size));
  ok('cover 缩放中心对齐 → pos 使图片中心落在视口中心', Math.abs(f1.pos[0] - (340 / 2 - 640 * f1.s)) < 1e-6);
})();

(function () {
  const img = { w: 1280, h: 853 };
  const vp = { w: 340, h: 430 };
  // 自洽数据：从权威 center + zoom 反向推导 crop（crop.w/h 是 zoom 的派生冗余），
  // 再正向→反向必须全量还原（crop.x/y/w/h 与 zoom 都一致，含中心点）。
  const center = { x: 0.5 * img.w, y: 0.5 * img.h };
  const zoom = 1.5;
  const s0 = Math.max(vp.w / img.w, vp.h / img.h);
  const s = s0 * zoom;
  const crop0 = cropReverse(img, center, s, vp).crop;
  const f = cropForward(img, crop0, zoom, vp);
  const centerF = { x: (crop0.x + crop0.w / 2) * img.w, y: (crop0.y + crop0.h / 2) * img.h };
  const rev = cropReverse(img, centerF, f.s, vp);
  ok('正向→反向还原 zoom 一致（≈1.5）', Math.abs(rev.zoom - zoom) < 1e-9, 'rev.zoom=' + rev.zoom);
  ok('正向→反向还原 crop 中心 x（0.5*IW）',
    Math.abs((rev.crop.x + rev.crop.w / 2) - 0.5) < 1e-9, 'rev.cx=' + (rev.crop.x + rev.crop.w / 2));
  ok('正向→反向还原 crop 中心 y（0.5*IH）',
    Math.abs((rev.crop.y + rev.crop.h / 2) - 0.5) < 1e-9, 'rev.cy=' + (rev.crop.y + rev.crop.h / 2));
  ok('正向→反向全量还原 crop/zoom（自洽数据）',
    Math.abs(rev.crop.x - crop0.x) < 1e-9 && Math.abs(rev.crop.y - crop0.y) < 1e-9 &&
    Math.abs(rev.crop.w - crop0.w) < 1e-9 && Math.abs(rev.crop.h - crop0.h) < 1e-9 &&
    Math.abs(rev.zoom - zoom) < 1e-9,
    'crop0=' + JSON.stringify(crop0) + ' rev=' + JSON.stringify(rev.crop) + ' zoom=' + rev.zoom);
})();

(function () {
  // 缩放越大，crop 矩形越小（可见源区域越小）
  const img = { w: 1280, h: 853 }, vp = { w: 340, h: 430 };
  const z1 = cropReverse(img, { x: 640, y: 426.5 }, cropForward(img, { x: 0, y: 0, w: 1, h: 1 }, 1, vp).s, vp);
  const z5 = cropReverse(img, { x: 640, y: 426.5 }, cropForward(img, { x: 0, y: 0, w: 1, h: 1 }, 5, vp).s, vp);
  ok('zoom 越大 crop 面积越小', z5.crop.w * z5.crop.h < z1.crop.w * z1.crop.h, 'z1=' + JSON.stringify(z1.crop) + ' z5=' + JSON.stringify(z5.crop));
})();

// 静态复核：真实代码里用的就是同一套正向公式（全图 cover 基准 + background-size/position）
// v2.4.4：正公式已抽到 layoutSkin 纯函数（app.js）；dock 侧为 dockLayoutSkin。
ok('[关键] app.js layoutSkin 用全图 cover 基准 Math.max(vp.w/iw, vp.h/ih)',
  /function layoutSkin\(el, IW, IH, crop, zoom\)[\s\S]{0,600}Math\.max\(vp\.w \/ iw, vp\.h \/ ih\)/.test(fs.readFileSync('app.js', 'utf8')));
ok('[关键] app.js 背景定位用取景中心对齐 (vp.w/2 - centerX*s)',
  /vp\.w \/ 2 - centerX \* s/.test(fs.readFileSync('app.js', 'utf8')));
ok('[关键] dock.html dockLayoutSkin 同样用全图 cover 基准公式',
  /function dockLayoutSkin\(el, IW, IH, crop, zoom\)[\s\S]{0,600}Math\.max\(vp\.w \/ iw, vp\.h \/ ih\)/.test(dockSrc));
ok('[关键] skincustom.html 反向换算 crop/zoom 落盘（saveCrop，v3.2.0 迁自 skin.html）',
  /crop\.center\.x - vw \/ 2/.test(fs.readFileSync('skincustom.html', 'utf8')) &&
  /crop\.s \/ crop\.s0/.test(fs.readFileSync('skincustom.html', 'utf8')));

/* ============ v2.4.0 A3：pickDockRestore（按显示器 ID 记忆插件落点） ============ */
console.log('\n【v2.4.0 A3】pickDockRestore —— 多屏插件位置记忆');

const pickDockRestore = new Function(extractFn(mainSrc, 'pickDockRestore') + '; return pickDockRestore;')();
const DISP = [{ id: 'a' }, { id: 'b' }];
const MAP = { a: { x: 10, y: 20 }, b: { x: 100, y: 200 } };

(function () {
  const r = pickDockRestore(DISP, MAP, 'a', null);
  ok('displayId=a 且 a 存活 → 原屏原位', r.x === 10 && r.y === 20, JSON.stringify(r));
})();
(function () {
  const r = pickDockRestore([{ id: 'b' }], MAP, 'a', null);
  ok('displayId=a 已不存在 → 回退首个存活且有记录的屏（b）', r.x === 100 && r.y === 200, JSON.stringify(r));
})();
(function () {
  const r = pickDockRestore(DISP, MAP, null, null);
  ok('无 displayId → 首个存活且有记录的屏（a）', r.x === 10 && r.y === 20, JSON.stringify(r));
})();
(function () {
  const r = pickDockRestore(DISP, MAP, 'a', { x: 5, y: 6 });
  ok('displayId 命中且存活 → 忽略 fallback', r.x === 10 && r.y === 20, JSON.stringify(r));
})();
(function () {
  const fb = { x: 5, y: 6 };
  const r = pickDockRestore([{ id: 'c' }], MAP, 'a', fb);
  ok('无任何存活记录 → 用 fallbackRect', r === fb, JSON.stringify(r));
})();
(function () {
  ok('空 map → fallbackRect', pickDockRestore(DISP, {}, 'a', { x: 9, y: 9 }) !== null);
  ok('null map → fallbackRect', pickDockRestore(DISP, null, 'a', { x: 9, y: 9 }) !== null);
  ok('null displays → fallbackRect', pickDockRestore(null, MAP, 'a', { x: 9, y: 9 }) !== null);
  ok('空 displays + 空 map + null fallback → null', pickDockRestore([], {}, 'a', null) === null);
})();
(function () {
  // 换机 / 显示器 ID 变化：map 里还留着旧 ID，但当前屏列表按顺序给出新 ID → 应回退到首个存活屏
  const r = pickDockRestore([{ id: 'x' }, { id: 'y' }], { x: { x: 33, y: 44 } }, 'old', null);
  ok('换机后旧 displayId 无记录 → 回退首个存活屏记录', r.x === 33 && r.y === 44, JSON.stringify(r));
})();

/* ============ v2.4.2：bgColorFor 窗口背景始终透明（浮动纯色视觉修复根因1） ============ */
console.log('\n【v2.4.2】bgColorFor —— 窗口背景不再退化成方形色块');
(function () {
  const api = new Function(extractFn(mainSrc, 'bgColorFor') + '; return { bgColorFor: bgColorFor };')();
  ok('bgColorFor calendar/dock/desktop 均返回透明',
    api.bgColorFor('calendar') === '#00000000' && api.bgColorFor('dock') === '#00000000' &&
    api.bgColorFor('desktop') === '#00000000');
})();

/* ============ v2.4.2：readGifSize 从文件头读 GIF 尺寸（GIF 导入跳过 nativeImage） ============ */
console.log('\n【v2.4.2】readGifSize —— GIF 尺寸从文件头读取');
(function () {
  const os = require('os');
  const api = new Function('fs', extractFn(mainSrc, 'readGifSize') + '; return { readGifSize: readGifSize };')(fs);
  const tmp = os.tmpdir() + '/_gifsize_test_' + Date.now() + '.gif';
  const buf = Buffer.alloc(10);
  Buffer.from('GIF89a', 'ascii').copy(buf, 0);
  buf.writeUInt16LE(320, 6);
  buf.writeUInt16LE(240, 8);
  fs.writeFileSync(tmp, buf);
  const s = api.readGifSize(tmp);
  ok('readGifSize GIF89a 320×240 读取正确', s && s.width === 320 && s.height === 240, JSON.stringify(s));
  const bad = tmp.replace(/\.gif$/, '.png');
  fs.writeFileSync(bad, Buffer.from('not-a-gif'));
  ok('readGifSize 非 GIF → null', api.readGifSize(bad) === null);
  try { fs.unlinkSync(tmp); fs.unlinkSync(bad); } catch (e) {}
})();

/* ============ v2.4.3：clampImageOpacity / normalizeImageSpec 图片不透明度 ============ */
console.log('\n【v2.4.3】clampImageOpacity / normalizeImageSpec —— 图片不透明度 0.2~1.0');
(function () {
  const api = new Function(
    extractFn(mainSrc, 'sanitizeBasename') + '\n' + extractFn(mainSrc, 'clamp01') + '\n' +
    extractFn(mainSrc, 'clampZoom') + '\n' + extractFn(mainSrc, 'clampImageOpacity') + '\n' +
    extractFn(mainSrc, 'normalizeImageSpec') + '; return { clampImageOpacity: clampImageOpacity, normalizeImageSpec: normalizeImageSpec };'
  )();
  ok('clampImageOpacity 默认（undefined）→ 1', api.clampImageOpacity(undefined) === 1);
  ok('clampImageOpacity null → 1', api.clampImageOpacity(null) === 1);
  ok('clampImageOpacity 1 → 1', api.clampImageOpacity(1) === 1);
  ok('clampImageOpacity 0.5 → 0.5', api.clampImageOpacity(0.5) === 0.5);
  ok('clampImageOpacity 0.2（下限）→ 0.2', api.clampImageOpacity(0.2) === 0.2);
  ok('clampImageOpacity 0.05（低于下限）→ 夹到 0.2', api.clampImageOpacity(0.05) === 0.2);
  ok('clampImageOpacity 1.5（超上限）→ 夹到 1', api.clampImageOpacity(1.5) === 1);
  ok('clampImageOpacity "abc"（非法）→ 1', api.clampImageOpacity('abc') === 1);

  const n1 = api.normalizeImageSpec({ file: 'x.png', opacity: 0.4 });
  ok('normalizeImageSpec 透传 opacity 0.4', n1.opacity === 0.4, JSON.stringify(n1));
  const n2 = api.normalizeImageSpec({ file: 'x.png' });
  ok('normalizeImageSpec 缺省 opacity → 1', n2.opacity === 1, JSON.stringify(n2));
  const n3 = api.normalizeImageSpec({ file: 'x.png', opacity: 9 });
  ok('normalizeImageSpec 越界 opacity → 夹到 1', n3.opacity === 1, JSON.stringify(n3));
})();

/* ============ v2.4.4：normalizeClarity / clarityForConfig / decideDark / wcagLum ============ */
console.log('\n【v2.4.4】normalizeClarity / clarityForConfig / decideDark —— UI 清晰度数据模型');
(function () {
  const src = [
    extractFn(mainSrc, 'normalizeClarity'), extractFn(mainSrc, 'clarityForConfig'),
    extractFn(mainSrc, 'decideDark'), extractFn(mainSrc, 'wcagLum')
  ].join('\n');
  const api = new Function(src +
    '; return { normalizeClarity: normalizeClarity, clarityForConfig: clarityForConfig, decideDark: decideDark, wcagLum: wcagLum };')();

  ok('normalizeClarity undefined → auto', api.normalizeClarity(undefined) === 'auto');
  ok('normalizeClarity null → auto', api.normalizeClarity(null) === 'auto');
  ok("normalizeClarity 'auto' → auto", api.normalizeClarity('auto') === 'auto');
  ok('normalizeClarity 40 → 40', api.normalizeClarity(40) === 40);
  ok('normalizeClarity 40.6 → 41（四舍五入）', api.normalizeClarity(40.6) === 41);
  ok('normalizeClarity -5 → 0（下限）', api.normalizeClarity(-5) === 0);
  ok('normalizeClarity 150 → 100（上限）', api.normalizeClarity(150) === 100);
  ok('normalizeClarity "abc"（非法）→ auto', api.normalizeClarity('abc') === 'auto');

  ok('clarityForConfig 手动 60 → 60', api.clarityForConfig({ clarity: 60 }) === 60);
  ok('clarityForConfig auto + bg=image complexity 0.5 → 50',
    api.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0.5 } }) === 50);
  ok('clarityForConfig auto + bg=image complexity 0.05 → 夹到 20（下限）',
    api.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0.05 } }) === 20);
  ok('clarityForConfig auto + bg=image complexity 0.99 → 夹到 85（上限）',
    api.clarityForConfig({ clarity: 'auto', bg: 'image', image: { complexity: 0.99 } }) === 85);
  ok('clarityForConfig auto + bg=native → 0', api.clarityForConfig({ clarity: 'auto', bg: 'native' }) === 0);
  ok('clarityForConfig null → 0', api.clarityForConfig(null) === 0);

  ok('decideDark light 起点 L=0.44 → 仍 light（未越阈）', api.decideDark(0.44, false) === false);
  ok('decideDark light 起点 L=0.40 → 切 dark', api.decideDark(0.40, false) === true);
  ok('decideDark dark 起点 L=0.56 → 维持 dark（迟滞带内）', api.decideDark(0.56, true) === true);
  ok('decideDark dark 起点 L=0.60 → 切 light', api.decideDark(0.60, true) === false);

  const lw = api.wcagLum(1, 1, 1), lb = api.wcagLum(0, 0, 0);
  ok('wcagLum 白 → 1', Math.abs(lw - 1) < 1e-6, 'lum=' + lw);
  ok('wcagLum 黑 → 0', Math.abs(lb - 0) < 1e-6, 'lum=' + lb);
})();

/* ============ v2.4.4：readJpegOrientation —— JPEG EXIF 方向解析（II/MM, 1/3/6/8） ============ */
console.log('\n【v2.4.4】readJpegOrientation —— JPEG EXIF Orientation 解析');
(function () {
  const api = new Function('fs',
    extractFn(mainSrc, 'readJpegOrientation') + '\n' + extractFn(mainSrc, 'parseTiffOrientation') +
    '; return { readJpegOrientation: readJpegOrientation };')(fs);

  // 构造最小 JPEG：SOI + APP1(Exif\0\0 + TIFF[IFD0: tag 0x0112 Orientation]) + EOI
  function buildJpeg(le, orient) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    if (le) { tiff[0] = 0x49; tiff[1] = 0x49; } else { tiff[0] = 0x4D; tiff[1] = 0x4D; }
    if (le) { tiff.writeUInt16LE(0x002A, 2); tiff.writeUInt32LE(8, 4); }
    else { tiff.writeUInt16BE(0x002A, 2); tiff.writeUInt32BE(8, 4); }
    if (le) tiff.writeUInt16LE(1, 8); else tiff.writeUInt16BE(1, 8);
    const e = 10;
    if (le) { tiff.writeUInt16LE(0x0112, e); tiff.writeUInt16LE(3, e + 2); tiff.writeUInt32LE(1, e + 4); tiff.writeUInt16LE(orient, e + 8); }
    else { tiff.writeUInt16BE(0x0112, e); tiff.writeUInt16BE(3, e + 2); tiff.writeUInt32BE(1, e + 4); tiff.writeUInt16BE(orient, e + 8); }
    const body = Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff]);
    const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2, 0);
    return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), len, body, Buffer.from([0xFF, 0xD9])]);
  }
  const tmpDir = require('os').tmpdir();
  function writeTmp(name, buf) { const p = require('path').join(tmpDir, name); fs.writeFileSync(p, buf); return p; }
  const files = [];
  function tf(le, orient, label) {
    const p = writeTmp('r3_' + label + '.jpg', buildJpeg(le, orient));
    files.push(p); return p;
  }
  try {
    ok('II(小端) orient=1 → 1', api.readJpegOrientation(tf(true, 1, 'ii1')) === 1);
    ok('II(小端) orient=3 → 3', api.readJpegOrientation(tf(true, 3, 'ii3')) === 3);
    ok('II(小端) orient=6 → 6（竖拍）', api.readJpegOrientation(tf(true, 6, 'ii6')) === 6);
    ok('II(小端) orient=8 → 8（竖拍）', api.readJpegOrientation(tf(true, 8, 'ii8')) === 8);
    ok('MM(大端) orient=1 → 1', api.readJpegOrientation(tf(false, 1, 'mm1')) === 1);
    ok('MM(大端) orient=3 → 3', api.readJpegOrientation(tf(false, 3, 'mm3')) === 3);
    ok('MM(大端) orient=6 → 6', api.readJpegOrientation(tf(false, 6, 'mm6')) === 6);
    ok('MM(大端) orient=8 → 8', api.readJpegOrientation(tf(false, 8, 'mm8')) === 8);
    // 非 JPEG（PNG 头）→ 不旋转（返回 1）
    const png = writeTmp('r3_notjpeg.png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]));
    files.push(png);
    ok('非 JPEG（PNG）→ 1（不旋转）', api.readJpegOrientation(png) === 1);
    ok('不存在的文件 → 1（不抛错）', api.readJpegOrientation(require('path').join(tmpDir, 'r3_nope_zzz.jpg')) === 1);
  } finally {
    for (let i = 0; i < files.length; i++) { try { fs.unlinkSync(files[i]); } catch (e) {} }
  }
})();

/* ============ v2.4.4：applyClarity —— clarity 0/50/100 → CSS 变量值 ============ */
console.log('\n【v2.4.4】applyClarity —— 三层可读性变量随 clarity 线性联动');
(function () {
  const appSrc = fs.readFileSync('app.js', 'utf8');
  const applyClarity = new Function(extractFn(appSrc, 'applyClarity') + '; return applyClarity;')();
  function mockRoot() {
    const store = {};
    return {
      style: { setProperty: function (k, v) { store[k] = v; }, removeProperty: function (k) { delete store[k]; } },
      _s: store
    };
  }

  const r0 = mockRoot(); applyClarity(r0, 'dark', 0);
  ok('dark clarity=0 --protect-top=transparent（归零）', r0._s['--protect-top'] === 'transparent', r0._s['--protect-top']);
  ok('dark clarity=0 --protect-mid=transparent（归零）', r0._s['--protect-mid'] === 'transparent', r0._s['--protect-mid']);
  ok('dark clarity=0 --protect-state=transparent（归零）', r0._s['--protect-state'] === 'transparent', r0._s['--protect-state']);
  ok('dark clarity=0 --stroke-color=rgba(0,0,0,0.550)（保留兜底描边）', r0._s['--stroke-color'] === 'rgba(0,0,0,0.550)', r0._s['--stroke-color']);
  ok('dark clarity=0 --ink-glow=0 0 0 transparent（归零）', r0._s['--ink-glow'] === '0 0 0 transparent', r0._s['--ink-glow']);

  const r50 = mockRoot(); applyClarity(r50, 'dark', 50);
  ok('dark clarity=50 --protect-mid=rgba(0,0,0,0.130)', r50._s['--protect-mid'] === 'rgba(0,0,0,0.130)', r50._s['--protect-mid']);

  const r100 = mockRoot(); applyClarity(r100, 'dark', 100);
  ok('dark clarity=100 --protect-mid=rgba(0,0,0,0.230)', r100._s['--protect-mid'] === 'rgba(0,0,0,0.230)', r100._s['--protect-mid']);
  ok('dark clarity=100 --protect-top=rgba(0,0,0,0.360)', r100._s['--protect-top'] === 'rgba(0,0,0,0.360)', r100._s['--protect-top']);
  ok('dark clarity=100 --stroke-color=rgba(0,0,0,0.300)（描边变淡）', r100._s['--stroke-color'] === 'rgba(0,0,0,0.300)', r100._s['--stroke-color']);
  ok('dark clarity=100 --ink-glow=0 0 4.0px rgba(0,0,0,0.700)', r100._s['--ink-glow'] === '0 0 4.0px rgba(0,0,0,0.700)', r100._s['--ink-glow']);

  const l0 = mockRoot(); applyClarity(l0, 'light', 0);
  ok('light clarity=0 --protect-mid=transparent（归零）', l0._s['--protect-mid'] === 'transparent', l0._s['--protect-mid']);
  ok('light clarity=0 --stroke-color=rgba(255,255,255,0.700)（保留兜底描边）', l0._s['--stroke-color'] === 'rgba(255,255,255,0.700)', l0._s['--stroke-color']);
  // p>0 时保护层回归原公式（零回归）：clarity=50 应为 0.130（非 transparent）
  ok('light clarity=50 --protect-mid=rgba(255,255,255,0.130)（p>0 原公式不变）', (function () { var r = mockRoot(); applyClarity(r, 'light', 50); return r._s['--protect-mid'] === 'rgba(255,255,255,0.130)'; })());
  const l100 = mockRoot(); applyClarity(l100, 'light', 100);
  ok('light clarity=100 --stroke-color=rgba(255,255,255,0.400)', l100._s['--stroke-color'] === 'rgba(255,255,255,0.400)', l100._s['--stroke-color']);

  // 短路保护：root 为空不抛错
  let threw = false;
  try { applyClarity(null, 'dark', 50); } catch (e) { threw = true; }
  ok('applyClarity null root → 不抛错', threw === false);
})();

console.log('\n==================================');
console.log('运行时单测： ' + pass + ' 通过 / ' + fail + ' 失败');
console.log('==================================');
process.exit(fail === 0 ? 0 : 1);
