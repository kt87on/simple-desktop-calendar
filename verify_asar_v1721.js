// verify_asar_v1721.js —— 打包产物反验（v1.7.21）
// 把 dist/win-unpacked/resources/app.asar 解到 tmp/asar_extract，
// 对每个真实源文件（而非整块二进制）做断言，避免 latin1/注释剥离造成的误判。
// 断言三类：
//   ① v1.7.21 六项需求的核心代码必须存在；
//   ② v1.7.20 浮动方案与崩溃保护的核心代码必须存在；
//   ③ 嵌入方案的符号（SetParent / ReBarWindow32 / dock-embedded / dock-attach.ps1 …）在"代码区"必须为零。
// 注意：必须先把 /* */ 与 // 注释完整剥离，否则"已删除清单"这类说明性注释会造成误报。

const fs = require('fs');
const path = require('path');

const root = __dirname;
/* v1.7.22.6：支持验证任意目标，避免"只查 dist、不查真实运行目录"的误判。
 * 用法：
 *   node verify_asar_v1721.js                          → 默认 dist/win-unpacked
 *   node verify_asar_v1721.js D:\SimpleCalendar        → 指定已安装/可移植目录
 *   node verify_asar_v1721.js D:\SimpleCalendar\resources\app.asar → 直接给 asar 文件 */
const arg = process.argv[2];
const asarPath = !arg
  ? path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar')
  : (arg.toLowerCase().endsWith('.asar') ? arg : path.join(arg, 'resources', 'app.asar'));
const outDir = path.join(root, 'tmp', 'asar_extract');

if (!fs.existsSync(asarPath)) {
  console.error('找不到产物，请先 npm run build：' + asarPath);
  process.exit(1);
}

// ---- 极简 asar 解包（不依赖 @electron/asar）----
// 布局：[uint32 payloadSize=4][uint32 headerSize][headerPickle: uint32 strSize + JSON] + 文件数据
// 文件数据区起点 = 8 + headerSize；条目 offset 相对该起点。
const buf = fs.readFileSync(asarPath);
const headerSize = buf.readUInt32LE(4);          // header pickle 总长
const strLen = buf.readUInt32LE(12);             // pickle 内的字符串长度 [u32 len][bytes]
const header = JSON.parse(buf.toString('utf8', 16, 16 + strLen));
const dataBase = 8 + headerSize;

fs.rmSync(path.join(root, 'tmp'), { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function dump(node, dir) {
  if (!node || !node.files) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(node.files)) {
    const entry = node.files[name];
    const target = path.join(dir, name);
    if (entry.files) {
      dump(entry, target);
    } else if (entry.offset !== undefined && !entry.unpacked) {
      // 注意：新版 asar 的 offset 可能是字符串，必须 Number() 转换
      const off = dataBase + Number(entry.offset);
      fs.writeFileSync(target, buf.subarray(off, off + entry.size));
    }
  }
}
dump(header, outDir);

function read(f) {
  try { return fs.readFileSync(path.join(outDir, f), 'utf8'); }
  catch (e) { return ''; }
}
// 完整剥离块注释与行注释，只留可执行代码
const codeOnly = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

const mainRaw = read('electron-main.js');
const main = codeOnly(mainRaw);
const dockRaw = read('dock.html');
const dock = codeOnly(dockRaw);
const preloadRaw = read('preload.js');
const preload = codeOnly(preloadRaw);
const pkgRaw = read('package.json');
const whenReady = (function () {
  const a = main.indexOf('app.whenReady');
  const b = main.indexOf("app.on('before-quit'");
  return a >= 0 && b > a ? main.slice(a, b) : '';
})();

const checks = [];
const check = (name, cond, detail) => checks.push({ name, ok: !!cond, detail: detail || '' });

// =====================================================================
// 1. 产物清单
// =====================================================================
check('产物含 electron-main.js', mainRaw.length > 10000, 'len=' + mainRaw.length);
check('产物含 dock.html', dockRaw.length > 1000);
check('产物含 preload.js', preloadRaw.length > 500);
check('产物含 calendar.html', read('calendar.html').length > 100000);
check('产物含 使用说明.html', read('使用说明.html').length > 5000);
check('产物不再含 dock-attach.ps1', !fs.existsSync(path.join(outDir, 'dock-attach.ps1')));
check('产物 package.json version=1.7.22', /"version"\s*:\s*"1\.7\.22"/.test(pkgRaw));
check('产物 package.json 无 extraResources', !/"extraResources"/.test(pkgRaw));

// =====================================================================
// 2. v1.7.21 六项需求必须存在
// =====================================================================
const V1721 = [
  // 需求1 点击热区
  ['[需求1] 插件默认鼠标穿透+forward',
    /dockWin\.setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(main)],
  ['[需求1] dock-set-mouse IPC', /ipcMain\.on\('dock-set-mouse'/.test(main)],
  ['[需求1] preload dockSetMouse', /dockSetMouse:\s*function/.test(preload)],
  ['[需求1] dock.html isInCard 矩形判定', /function isInCard\(/.test(dock)],
  ['[需求1] dock.html updateHit force 复判', /function updateHit\(x,\s*y,\s*force\)/.test(dock)],
  ['[需求1] dock.html mouseleave 恢复穿透', /mouseleave[\s\S]{0,300}dockSetMouse\(true\)/.test(dock)],
  ['[需求1] hover 只在 body.hit 生效', /body\.hit #card:hover/.test(dockRaw)],
  // 需求2 两种形态
  ['[需求2] dockMode 状态', /let dockMode = 'dock';/.test(main)],
  ['[需求2] setDockMode', /function setDockMode\(/.test(main)],
  ['[需求2] applyDockMode', /function applyDockMode\(/.test(main)],
  ['[需求2] destroyTray', /function destroyTray\(/.test(main)],
  ['[需求2] 只在图标形态建托盘', /function createTray\(\)[\s\S]{0,200}dockMode !== 'icon'\) return;/.test(main)],
  ['[需求2] 菜单「缩小至桌面图标」', /缩小至桌面图标/.test(main)],
  ['[需求2] 菜单「切回桌面插件」', /切回桌面插件/.test(main)],
  ['[需求2] 托盘左键单击切回插件', /tray\.on\('click'[\s\S]{0,300}setDockMode\('dock'\)/.test(main)],
  ['[需求2] 不再绑 double-click', !/tray\.on\('double-click'/.test(main)],
  ['[需求2] dockMode 持久化', /dockMode:\s*dockMode,/.test(main)],
  ['[需求2] 图标形态下不 show 插件', /ready-to-show[\s\S]{0,400}dockMode === 'icon'\)[\s\S]{0,80}dockWin\.hide\(\)/.test(main)],
  // 需求3 拖动边界
  ['[需求3] clampDockToWorkArea', /function clampDockToWorkArea\(/.test(main)],
  ['[需求3] 用 display.workArea', /screen\.getDisplayMatching\(b\)\.workArea/.test(main)],
  // v1.7.22.7：统一走 dockClamped（内部用意图尺寸 dockW×dockH）
  ['[需求3] 拖动中实时夹取', /dock-drag-move[\s\S]{0,800}dockClamped\(newX, newY\)/.test(main)],
  ['[需求3] 松手夹取并记落点', /dockBounds = \{ x: nb\.x/.test(main)],
  ['[需求3] dockBounds 持久化', /dockBounds:\s*dockBounds,/.test(main)],
  // 需求4 弹出定位
  ['[需求4] placeMainNearDock', /function placeMainNearDock\(/.test(main)],
  ['[需求4] 四方位候选', /n: 'right'/.test(main) && /n: 'left'/.test(main) && /n: 'below'/.test(main) && /n: 'above'/.test(main)],
  ['[需求4] 候选夹回工作区', /Math\.max\(wa\.x, Math\.min\(c\.x, maxX\)\)/.test(main)],
  // v1.7.22.7：传意图矩形而非 getBounds()（撑大后会让弹窗右对齐偏出 100+px）
  ['[需求4] showMini 按形态分流',
    /placeMainNearDock\(\{ x: db\.x, y: db\.y, width: dockW, height: dockH \}\)/.test(main)],
  ['[需求4] 图标形态沿用原右下角逻辑', /x: wa\.width - MINI_W/.test(main) && /y: wa\.height - MINI_H/.test(main)],
  // 需求6 去吸附
  ['[需求6] 无吸附日志/逻辑', !/snap to top of taskbar/.test(mainRaw) && !/dock drag near taskbar/.test(mainRaw)],
  ['[需求6] drag-end 不算任务栏 gap', !/taskbarTopY/.test(main)],
  ['[需求6] 菜单无「贴回任务栏上沿」', !/贴回任务栏/.test(main) && !/label:[\s\S]{0,80}贴回任务栏/.test(main)],
  // 置顶等级
  ['[置顶] floating 而非 screen-saver',
    /dockWin\.setAlwaysOnTop\(dockPinned, 'floating'\)/.test(main) &&
    !/dockWin\.setAlwaysOnTop\(true, 'screen-saver'\)/.test(main)],
  ['[置顶] dockPinned 开关', /function toggleDockPinned\(/.test(main) && /插件总在最前/.test(main)],
];
for (const [name, ok] of V1721) check('[存在] ' + name, ok);

// =====================================================================
// 2.5. v1.7.22 三处微调必须存在
// =====================================================================
const V1722 = [
  ['间距紧贴 MAIN_GAP=1', /const MAIN_GAP = 1\b/.test(main)],
  // v2.0 UI 重构后：今日色由 Token 链 --blue-600/--accent-strong 派生（值为 #1976D2 / #1565C0），
  // 不再在 .cell.today 规则里硬编码 hex。改为断言 Token 链路 + 实际 CSS 变量值存在。
  ['今日深蓝 #1976D2（Token 链 --blue-600 → --accent-strong）',
    /--blue-600:\s*#1976d2/i.test(read('calendar.html')) &&
    /--accent-strong:\s*var\(--blue-600\)/.test(read('calendar.html')) &&
    /\.cell\.today:not\(\.other\)[\s\S]{0,160}var\(--accent-strong\)/.test(read('calendar.html'))
  ],
  ['今日描边（inset 1.5px 同色环，var(--accent-strong)）',
    /\.cell\.today:not\(\.other\)[\s\S]{0,160}inset[\s\S]{0,80}var\(--accent-strong\)/.test(read('calendar.html'))
  ],
  ['今日白字', /\.cell\.today:not\(\.other\)[\s\S]{0,200}color:\s*#fff/.test(read('calendar.html'))],
  ['引入 os 模块', /require\('os'\)/.test(main)],
  ['detectWin11 函数', /function detectWin11\s*\(/.test(main)],
  ['build>=22000 判定 Win11', /parseInt\(m\[1\],\s*10\)\s*>=\s*22000/.test(main)],
  ['isWin11 持久化写入', /isWin11:\s*isWin11/.test(main)],
  ['启动时检测并写回', /isWin11 = detectWin11\(\)/.test(main)],
];
// 2.6. v1.7.22.3 修复（"卡在半空"回归）必须存在
const V17223 = [
  ['loadSettings 校验 dockBounds 宽度 DOCK_W±4', /Math\.abs\(bw - DOCK_W\) <= 4/.test(main)],
  ['loadSettings 校验 dockBounds 高度 [36,60]', /bh >= 36 && bh <= 60/.test(main)],
  ['loadSettings 异常尺寸丢弃（dockBounds=null）', /ignore invalid dockBounds size/.test(main) && /dockBounds = null;/.test(main)],
  /* v1.7.22.7 语义升级：原来要求"尺寸用 dockWin.getBounds()"，现改为"尺寸用意图常量"。
   * 原因：实测 getBounds() 本身就会被引擎/OS 撑大（日志取证 232×164 vs 意图 116×40），
   * 采信它等于采信错误值。现在统一走 dockClamped()，既不认磁盘也不认被撑大的窗口。 */
  ['ready-to-show 恢复时只取 x/y 用意图尺寸',
    /ready-to-show[\s\S]{0,900}dockClamped\(dockBounds\.x, dockBounds\.y\)/.test(main)],
  ['applyDockMode 恢复时同样只取 x/y',
    /applyDockMode[\s\S]{0,900}dockClamped\(dockBounds\.x, dockBounds\.y\)/.test(main)],
];
for (const [name, ok] of V17223) check('[v1.7.22.3] ' + name, ok);
for (const [name, ok] of V1722) check('[v1.7.22] ' + name, ok);
// 2.7. v1.7.22.4 修复（"弹窗没挨着插件 / 插件和任务栏有空白"）必须存在
const V17224 = [
  ['below 方位 x 右对齐', /n: 'below',\s*x:\s*dockRect\.x \+ dockRect\.width - W/.test(main)],
  ['above 方位 x 右对齐', /n: 'above',\s*x:\s*dockRect\.x \+ dockRect\.width - W/.test(main)],
  // v1.7.22.7：b.width → dockW（意图宽度），被撑大的窗口会让落点离右沿差一大截
  ['positionDock 右边距 0', /Math\.round\(wa\.x \+ wa\.width - dockW\)/.test(main)],
  ['positionDock 底部压任务栏上沿', /Math\.round\(wa\.y \+ wa\.height - dockH\)/.test(main)],
  ['applyDockSize 右下 inset=0', /var padL = 2, padT = 2, padR = 0, padB = 0/.test(dock)],
];
for (const [name, ok] of V17224) check('[v1.7.22.4] ' + name, ok);
// 2.8. v1.7.22.5 修复（拖拽"底部边界不断上移"）必须存在 —— 这是用户反复报的 bug，
//     必须验证**打进安装包**的代码确实是绝对定位版，而不是旧的累加版。
const V17225 = [
  ['主进程注册 dock-drag-start', /ipcMain\.on\('dock-drag-start'/.test(main)],
  ['dragOffsetX = mouseX - b.x（mousedown 记一次 offset）',
    /dragOffsetX\s*=\s*Math\.round\(mouseX\)\s*-\s*b\.x/.test(main)],
  ['newX = mouseX - dragOffsetX（绝对定位）',
    /const newX = Math\.round\(mouseX\)\s*-\s*dragOffsetX/.test(main)],
  ['newY = mouseY - dragOffsetY（绝对定位）',
    /const newY = Math\.round\(mouseY\)\s*-\s*dragOffsetY/.test(main)],
  ['[关键·反向] 主进程已无 b.x + Math.round(dx) 累加写法',
    !/b\.x\s*\+\s*Math\.round\(dx\)/.test(main) && !/b\.y\s*\+\s*Math\.round\(dy\)/.test(main)],
  ['[关键] dock.html 已无 var dx = e.screenX - dragStartX 旧累加',
    !/var\s+dx\s*=\s*e\.screenX\s*-\s*dragStartX/.test(dock) &&
    !/var\s+dy\s*=\s*e\.screenY\s*-\s*dragStartY/.test(dock)],
  ['dock.html mousedown 调 dockDragStart(screenX, screenY)',
    /dockDragStart\(e\.screenX,\s*e\.screenY\)/.test(dock)],
  ['dock.html mousemove 调 dockDragMove(screenX, screenY)（传绝对坐标）',
    /dockDragMove\(e\.screenX,\s*e\.screenY\)/.test(dock)],
  ['preload.dockDragStart 签名 (mouseX, mouseY)',
    /dockDragStart:\s*function\s*\(mouseX,\s*mouseY\)/.test(preload)],
  ['preload.dockDragMove 签名 (mouseX, mouseY)',
    /dockDragMove:\s*function\s*\(mouseX,\s*mouseY\)/.test(preload)],
];
for (const [name, ok] of V17225) check('[v1.7.22.5] ' + name, ok);

// =====================================================================
// 2.7. v1.7.22.6 加固（Win11 DPI 取整 / 落库防抖 / 退出 flush / 托盘注释）
// =====================================================================
const V17226 = [
  ['Win11 X 补偿：compX 取自 WIN11_POS_COMP_X',
    /const compX = isWin11 \? WIN11_POS_COMP_X : 0;/.test(main)],
  ['Win11 Y 补偿：compY 取自 WIN11_POS_COMP_Y',
    /const compY = isWin11 \? WIN11_POS_COMP_Y : 0;/.test(main)],
  ['Win11 X 补偿套 Math.round（消 1px 白边）',
    /Math\.round\(best\.x \+ compX\)/.test(main)],
  ['Win11 Y 补偿套 Math.round',
    /Math\.round\(best\.y \+ compY\)/.test(main)],
  ['dock-drag-end 落库防抖定时器 _dockSaveTimer',
    /_dockSaveTimer/.test(main) && /clearTimeout\(_dockSaveTimer\)/.test(main)],
  ['防抖时长 500ms', /_dockSaveTimer\s*=\s*setTimeout\([\s\S]{0,200}500\)/.test(main)],
  ['落点内存立即更新（不防抖，避免形态切换读到旧值）',
    /dockBounds = \{ x: nb\.x[\s\S]{0,120}clearTimeout\(_dockSaveTimer\)/.test(main)],
  // 精确取函数体（到第一个行首 } 为止），避免宽窗口误吞到下一个函数
  ['flushDockBounds 函数存在且不依赖 dockWin（销毁后仍安全）',
    (function () {
      const m = main.match(/function flushDockBounds\(\)\s*\{([\s\S]*?)\n\}/);
      return !!m && !/dockWin|getBounds/.test(m[1]);
    })()],
  ['before-quit 兜底 flush 未落库的 dockBounds',
    /app\.on\('before-quit'[\s\S]*?flushDockBounds\(\)/.test(main)],
  // 注意：main 是剥离注释后的代码，注释类断言必须用 mainRaw
  ['makeTrayIcon 保留且标注「请勿删除」（历史托盘崩溃 bug 防护）',
    /function makeTrayIcon/.test(main) && /请勿删除 makeTrayIcon/.test(mainRaw)],
  ['[关键·反向] package.json 无 extraResources（v1.7.20 已废弃）',
    !/extraResources/.test(read('package.json'))],
];
for (const [name, ok] of V17226) check('[v1.7.22.6] ' + name, ok);

// =====================================================================
// 2.8. v1.7.22.7 物理窗口被撑大导致"拖不到底/拖不到右/弹窗错位"的根治
//      取证：日志 dock dropped at 1208,756 → 反推物理窗口 232×164，而意图仅 116×40
// =====================================================================
const V17227 = [
  ['意图尺寸 dockW/dockH 已声明',
    /let dockW = DOCK_W;/.test(main) && /let dockH = DOCK_H;/.test(main)],
  ['建窗用 dockW/dockH（dockH 由 taskbarHeight 夹取）',
    /dockH = Math\.max\(40, Math\.min\(tb, 56\)\);/.test(main) &&
    /width: dockW, height: dockH,/.test(main)],
  ['dockClamped 是插件定位唯一入口（内部用 dockW/dockH）',
    /function dockClamped\(x, y\)/.test(main) &&
    /clampDockToWorkArea\(\{ x: x, y: y, width: dockW, height: dockH \}\)/.test(main)],
  ['拖动走 dockClamped(newX, newY)',
    /dockWin\.setBounds\(dockClamped\(newX, newY\)\)/.test(main)],
  ['落点/分辨率变化走 dockClamped(cur.x, cur.y)',
    (main.match(/dockClamped\(cur\.x, cur\.y\)/g) || []).length === 2],
  ['恢复位置走 dockClamped(dockBounds.x, dockBounds.y)',
    (main.match(/dockClamped\(dockBounds\.x, dockBounds\.y\)/g) || []).length === 2],
  ['positionDock 用 dockW/dockH 贴边',
    /Math\.round\(wa\.x \+ wa\.width - dockW\)/.test(main) &&
    /Math\.round\(wa\.y \+ wa\.height - dockH\)/.test(main)],
  ['pushDockSize 下发意图尺寸（卡片不再被渲染成大块）',
    /send\('dock-size', \{ w: dockW, h: dockH \}\)/.test(main)],
  ['[关键·反向] pushDockSize 已不读 getBounds()',
    !/function pushDockSize[\s\S]{0,300}getBounds\(\)/.test(main)],
  ['placeMainNearDock 传意图矩形（弹窗不错位）',
    /placeMainNearDock\(\{ x: db\.x, y: db\.y, width: dockW, height: dockH \}\)/.test(main)],
  ['[关键·反向] 已无 placeMainNearDock(dockWin.getBounds()) 直传',
    !/placeMainNearDock\(dockWin\.getBounds\(\)\)/.test(main)],
  ['[关键·反向] clampDockToWorkArea 外部调用点只剩 dockClamped 一处',
    (main.match(/clampDockToWorkArea\(/g) || []).length === 2],
  ['建窗后自诊断：实际 ≠ 意图时记日志',
    /dock size INFLATED by OS/.test(main)],
  ['resize 事件记录尺寸漂移（不强制回弹，避免死循环）',
    /dockWin\.on\('resize'[\s\S]{0,300}dock resized to/.test(main)],
];
for (const [name, ok] of V17227) check('[v1.7.22.7] ' + name, ok);

// =====================================================================
// 3. v1.7.20 浮动方案 / 崩溃保护必须存在
// =====================================================================
const MUST = [
  ['positionDock 函数', /function positionDock\s*\(/.test(main)],
  ['pushDockSize 函数', /function pushDockSize\s*\(/.test(main)],
  ['did-finish-load 调 pushDockSize', /did-finish-load[\s\S]{0,300}pushDockSize/.test(main)],
  ['ready-to-show 调 pushDockSize', /ready-to-show[\s\S]{0,400}pushDockSize/.test(main)],
  ['applyDockSize 固定像素布局', /function applyDockSize\s*\(\s*\)/.test(dock)],
  ['dock.html 接收 dock-size', /onDockSize/.test(dock)],
  ['主进程发 dock-size 通道', /'dock-size'/.test(main)],
  ['MY_LOCK_KEY 自定义锁命名空间', /MY_LOCK_KEY\s*=/.test(main)],
  ['requestSingleInstanceLock 带 key', /requestSingleInstanceLock\(\s*\{\s*key\s*:/.test(main)],
  ['cleanupStaleInstances 残留清理', /function cleanupStaleInstances\s*\(/.test(main)],
  ['cleanup 用 CIM 取父子关系', /Get-CimInstance Win32_Process/.test(main) && /ParentProcessId/.test(main)],
  ['cleanup 排除自己及子孙', /mine\[String\(myProcessPid\)\] = true/.test(main)],
  // 必须用 whenReady 切片判顺序：全文件里 createWindow() 第一次出现在 second-instance
  // 的重建分支（更早），直接对全文件 indexOf 会误判。
  ['cleanup 在 whenReady 建窗之前调用',
    whenReady.indexOf('cleanupStaleInstances()') >= 0 &&
    whenReady.indexOf('createWindow()') > 0 &&
    whenReady.indexOf('cleanupStaleInstances()') < whenReady.indexOf('createWindow()')],
  ['拖动 IPC dock-drag-move', /dock-drag-move/.test(main)],
  ['拖动 IPC dock-drag-end', /dock-drag-end/.test(main)],
  ['DOCK_RECREATE_MAX 上限', /DOCK_RECREATE_MAX/.test(main)],
  ['自愈条件 = dockCrashed', /!quitting && dockOn && dockCrashed && dockRecreateCount < DOCK_RECREATE_MAX/.test(main)],
  ['render-process-gone 延迟销毁', /render-process-gone/.test(main) && /target\.destroy/.test(main)],
  ['dockStableTimer 5 分钟清零', /dockStableTimer/.test(main)],
  ['主窗右键兜底 main-show-menu', /main-show-menu/.test(main)],
  ['日历核心逻辑未被动（goto-ym / 提醒 / 农历切换）',
    /'goto-ym'/.test(main) && /checkReminders/.test(main) && /'list-reminders'/.test(main)],
];
for (const [name, ok] of MUST) check('[存在] ' + name, ok);

// =====================================================================
// 4. 嵌入方案在"代码区"必须彻底消失
// =====================================================================
const FORBID = [
  ['attachDockToTaskbar', /attachDockToTaskbar/.test(main)],
  ['verifyDockEmbedded', /verifyDockEmbedded/.test(main)],
  ['detachDock', /detachDock/.test(main)],
  ['scheduleDockVerify', /scheduleDockVerify/.test(main)],
  ['runDockScript', /runDockScript/.test(main)],
  ['dockAttachScriptPath', /dockAttachScriptPath/.test(main)],
  ['systemPrefersDark', /systemPrefersDark/.test(main)],
  ['pushDockEmbedded', /pushDockEmbedded/.test(main)],
  ['let dockEmbedded', /let dockEmbedded\b/.test(main)],
  ['dockAttachTries', /dockAttachTries/.test(main)],
  ['dockRehealCount', /dockRehealCount/.test(main)],
  ['dockNoEmbed', /dockNoEmbed/.test(main)],
  ['dockAttachTimer', /dockAttachTimer/.test(main)],
  ['dockVerifyTimer', /dockVerifyTimer/.test(main)],
  ['SetParent 调用', /SetParent/.test(main) || /SetParent/.test(dock)],
  ['ReBarWindow32 引用', /ReBarWindow32/.test(main) || /ReBarWindow32/.test(dock)],
  ['dock-attach.ps1 引用', /dock-attach\.ps1/.test(main) || /dock-attach\.ps1/.test(dock)],
  ['setSize 强制 resize', /\.setSize\s*\(/.test(main)],
  // 语义：present = 代码里确实存在"按进程名批量杀"的写法。
  // （v1.7.20 脚本曾误写成 !/…/，导致"不匹配"反而被判成存在，属于断言本身的 bug，已修）
  ['cleanup 按进程名批量杀', /tasklist\.exe[\s\S]{0,300}SimpleCalendar\.exe/.test(main)],
  ['dock-embedded 通道（主进程）', /['"]dock-embedded['"]/.test(main)],
  ['dock-embedded 通道（preload）', /['"]dock-embedded['"]/.test(preload)],
  ['onDockEmbedded（dock.html）', /onDockEmbedded/.test(dock)],
  ['body.embedded 类', /body\.embedded/.test(dock)],
  ['embedded 条件判断（dock.html）', /classList\.contains\('embedded'\)/.test(dock)],
];
for (const [name, present] of FORBID) check('[必须不存在] ' + name, !present);

// =====================================================================
// 输出
// =====================================================================
let pass = 0, fail = 0;
for (const c of checks) {
  if (c.ok) { pass++; console.log('  ✓ ' + c.name); }
  else { fail++; console.log('  ✗ ' + c.name + (c.detail ? '  [' + c.detail + ']' : '')); }
}
console.log('\n===== verify_asar_v1721: ' + pass + '/' + (pass + fail) + ' 通过 =====');

fs.rmSync(path.join(root, 'tmp'), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
