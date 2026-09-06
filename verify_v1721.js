// verify_v1721.js —— v1.7.21 静态改动自检
// 覆盖：v1.7.21 六项需求（热区 / 图标模式 / 拖动边界 / 弹出定位 / 清嵌入 / 去吸附）
//       + v1.7.20 崩溃修复与浮动方案回归保护
//       + v1.7.17 十条需求回归保护
// 改完主进程 / 渲染层必跑；与 smoke-test.js（mock Electron 双形态运行时冒烟）配套。

const fs = require('fs');
const path = require('path');

const root = __dirname;
function read(f) {
  try { return fs.readFileSync(path.join(root, f), 'utf8'); }
  catch (e) { return ''; }
}

const main = read('electron-main.js');
const appjs = read('app.js');
const preload = read('preload.js');
const dock = read('dock.html');
const tmpl = read('template.html');
const pkg = JSON.parse(read('package.json'));

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail: detail || '' });
}

/* 剥离注释后再匹配 —— 说明性注释里会提到历史标识符（如"已删除的 attachDockToTaskbar"），
 * 不剥离会误判成"仍然存在"。块注释和行注释都要剥。 */
const codeOnly = function (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
};
const mainCode = codeOnly(main);
const preloadCode = codeOnly(preload);
const dockCode = codeOnly(dock);

const whenReadyBody = main.slice(main.indexOf('app.whenReady'), main.indexOf("app.on('before-quit'"));

// =====================================================================
// 版本号
// =====================================================================
check('版本号=1.7.22', pkg.version === '1.7.22', 'package.json version=' + pkg.version);

// =====================================================================
// 需求1：修复点击热区（Hit Test）
// =====================================================================
check('[需求1] 插件窗口默认鼠标穿透 + forward',
  /dockWin\.setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(mainCode));
check('[需求1] 新增 dock-set-mouse IPC 主进程处理',
  /ipcMain\.on\('dock-set-mouse'/.test(mainCode) &&
  /setIgnoreMouseEvents\(false\)/.test(mainCode));
check('[需求1] preload 暴露 dockSetMouse',
  /dockSetMouse:\s*function/.test(preloadCode) && /'dock-set-mouse'/.test(preloadCode));
check('[需求1] dock.html 有卡片矩形命中判定 isInCard',
  /function isInCard\(/.test(dockCode) && /getBoundingClientRect\(\)/.test(dockCode));
check('[需求1] dock.html 有 updateHit（含 force 强制复判参数）',
  /function updateHit\(x,\s*y,\s*force\)/.test(dockCode));
check('[需求1] 拖动中不切换穿透（防掉手）',
  /function updateHit[\s\S]{0,200}if \(dragging\) return;/.test(dockCode));
check('[需求1] 未拖动时的 mousemove 走热区判定',
  /if \(!dragging\) \{\s*updateHit\(e\.clientX, e\.clientY\); return; \}/.test(dockCode));
// v1.7.21 收口：松手统一走 endDrag(e)，由它内部调 updateHit(x, y, true) 强制复判
check('[需求1] 松手后 force 复判一次',
  /function endDrag[\s\S]{0,400}updateHit\(e\.clientX, e\.clientY, true\)/.test(dockCode) &&
  /mouseup[\s\S]{0,120}endDrag\(e\)/.test(dockCode));
check('[需求1] 鼠标移出窗口恢复穿透',
  /mouseleave[\s\S]{0,300}dockSetMouse\(true\)/.test(dockCode));
check('[需求1] hover 高亮只在实际可点时出现（body.hit）',
  /body\.hit #card:hover/.test(dock) &&
  !/(^|\n)\s*#card:hover/.test(dock.replace(/\/\*[\s\S]*?\*\//g, '')));
check('[需求1] 拖动中主进程强制收回鼠标响应',
  /dock-drag-move[\s\S]{0,700}setIgnoreMouseEvents\(false\)/.test(mainCode));

// =====================================================================
// 需求2：桌面插件 ⇄ 桌面图标
// =====================================================================
check('[需求2] 新增 dockMode 状态（dock / icon）',
  /let dockMode = 'dock';/.test(mainCode));
check('[需求2] setDockMode 实现存在', /function setDockMode\(/.test(mainCode));
check('[需求2] applyDockMode 实现存在', /function applyDockMode\(/.test(mainCode));
check('[需求2] destroyTray 实现存在（收起托盘图标）', /function destroyTray\(/.test(mainCode));
check('[需求2] 图标形态下才建托盘',
  /function createTray\(\)[\s\S]{0,200}dockMode !== 'icon'\) return;/.test(mainCode));
check('[需求2] 托盘失效重试也只在图标形态进行',
  /function scheduleTrayRetry[\s\S]{0,200}dockMode !== 'icon'\) return;/.test(mainCode));
check('[需求2] tooltip 看门狗只在图标形态跑',
  /if \(!tray \|\| dockMode !== 'icon'\) return;/.test(mainCode));
check('[需求2] 菜单含「缩小至桌面图标」', /缩小至桌面图标/.test(main));
check('[需求2] 菜单含「切回桌面插件」', /切回桌面插件/.test(main));
check('[需求2] 菜单含「显示 / 隐藏日历」（图标态也能开日历）',
  /'显示 \/ 隐藏日历'/.test(main));
check('[需求2] 菜单项带单色图标（v2.0 去 emoji）',
  /icon:\s*menuIcon\('calendar'\)/.test(main) && !/📅/.test(mainCode));
check('[需求2] 左键单击托盘切回插件',
  /tray\.on\('click'[\s\S]{0,300}dockMode === 'icon'\) setDockMode\('dock'\)/.test(mainCode));
check('[需求2] 不再同时绑 double-click（避免与 click 打架）',
  !/tray\.on\('double-click'/.test(mainCode));
check('[需求2] 切回插件时恢复到之前的位置',
  /function applyDockMode[\s\S]{0,900}dockBounds\.x, dockBounds\.y\)/.test(mainCode));
check('[需求2] dockMode 持久化（存）', /dockMode:\s*dockMode,/.test(mainCode));
check('[需求2] dockMode 持久化（读）',
  /dockMode = \(o\.dockMode === 'icon'\) \? 'icon' : 'dock';/.test(mainCode));
check('[需求2] 启动时按形态决定要不要建托盘',
  /if \(dockOn && dockMode === 'icon'\) createTray\(\);/.test(mainCode));
check('[需求2] 图标形态下 ready-to-show 不 show 插件',
  /ready-to-show[\s\S]{0,400}dockMode === 'icon'\)[\s\S]{0,80}dockWin\.hide\(\)/.test(mainCode));

// =====================================================================
// 需求3：拖动边界限制在屏幕工作区
// =====================================================================
check('[需求3] clampDockToWorkArea 实现存在', /function clampDockToWorkArea\(/.test(mainCode));
check('[需求3] 用 display.workArea（已自动排除任务栏）',
  /screen\.getDisplayMatching\(b\)\.workArea/.test(mainCode));
check('[需求3] 四条边都夹取（x/y 双向 Math.max+Math.min）',
  /x: Math\.max\(wa\.x, Math\.min\(b\.x, maxX\)\)/.test(mainCode) &&
  /y: Math\.max\(wa\.y, Math\.min\(b\.y, maxY\)\)/.test(mainCode));
// v1.7.22.7：拖动/落点/分辨率变化统一改走 dockClamped（内部用意图尺寸 dockW×dockH）
check('[需求3] 拖动中实时夹取',
  /dock-drag-move[\s\S]{0,800}dockClamped\(newX, newY\)/.test(mainCode));
check('[需求3] 松手再夹一次并记为落点',
  /dock-drag-end[\s\S]{0,600}dockClamped\(cur\.x, cur\.y\)/.test(mainCode) &&
  /dockBounds = \{ x: nb\.x, y: nb\.y, width: dockW, height: dockH \}/.test(mainCode));
check('[需求3] 显示器/任务栏变化只做越界纠正（不拽回默认位）',
  /display-metrics-changed[\s\S]{0,300}dockClamped\(cur\.x, cur\.y\)/.test(mainCode));
check('[需求3] display-metrics-changed 只注册一次（不放在 createDock 内）',
  (mainCode.match(/screen\.on\('display-metrics-changed'/g) || []).length === 1,
  '出现次数=' + (mainCode.match(/screen\.on\('display-metrics-changed'/g) || []).length);
check('[需求3] 插件位置持久化（存）', /dockBounds:\s*dockBounds,/.test(mainCode));
check('[需求3] 插件位置持久化（读）',
  /if \(o\.dockBounds && typeof o\.dockBounds\.x === 'number'/.test(mainCode));

/* v1.7.22.3 修复（"卡在半空"回归）：loadSettings 校验尺寸合理区间 + 恢复位置时强制用真实尺寸 */
check('[v1.7.22.3] loadSettings 校验 dockBounds 宽度在 DOCK_W±4',
  /Math\.abs\(bw - DOCK_W\) <= 4/.test(mainCode));
check('[v1.7.22.3] loadSettings 校验 dockBounds 高度在 [36, 60]',
  /bh >= 36 && bh <= 60/.test(mainCode));
check('[v1.7.22.3] loadSettings 异常尺寸记日志并丢弃（dockBounds=null）',
  /ignore invalid dockBounds size/.test(mainCode) && /dockBounds = null;/.test(mainCode));
/* v1.7.22.3 原语义是"尺寸用 dockWin.getBounds()"（防磁盘脏数据撑大窗口）；
 * v1.7.22.7 升级为"尺寸用意图常量 dockW×dockH" —— 连 getBounds() 都不再采信，
 * 因为实测发现物理窗口本身就会被引擎/OS 撑大（232×164 vs 意图 116×40）。
 * 新语义更强：既不认磁盘，也不认被撑大的窗口。 */
check('[v1.7.22.7] ready-to-show 恢复时只取 dockBounds.x/y，尺寸用意图常量',
  /ready-to-show[\s\S]{0,900}dockClamped\(dockBounds\.x, dockBounds\.y\)/.test(mainCode));
check('[v1.7.22.7] applyDockMode 恢复时同样走 dockClamped',
  /applyDockMode[\s\S]{0,900}dockClamped\(dockBounds\.x, dockBounds\.y\)/.test(mainCode));

/* v1.7.22.4 修复（"弹窗没挨着插件 / 插件和任务栏有空白"） */
check('[v1.7.22.4] below 方位 x 右对齐（dockRect.x+dockRect.width-W）',
  /n: 'below',\s*x:\s*dockRect\.x \+ dockRect\.width - W/.test(mainCode));
check('[v1.7.22.4] above 方位 x 右对齐（dockRect.x+dockRect.width-W）',
  /n: 'above',\s*x:\s*dockRect\.x \+ dockRect\.width - W/.test(mainCode));
// v1.7.22.7：b.width → dockW（意图宽度），否则被撑大的窗口会让落点离右沿差一大截
check('[v1.7.22.4] positionDock 右边距为 0（完全贴工作区右沿）',
  /Math\.round\(wa\.x \+ wa\.width - dockW\)/.test(mainCode));
check('[v1.7.22.7] positionDock 用意图高度 dockH 压任务栏上沿',
  /Math\.round\(wa\.y \+ wa\.height - dockH\)/.test(mainCode));

// =====================================================================
// 需求4：日历弹出定位（按形态分流）
// =====================================================================
check('[需求4] placeMainNearDock 实现存在', /function placeMainNearDock\(/.test(mainCode));
check('[需求4] 四方位候选 right/left/below/above',
  /n: 'right'/.test(mainCode) && /n: 'left'/.test(mainCode) &&
  /n: 'below'/.test(mainCode) && /n: 'above'/.test(mainCode));
check('[需求4] 候选位置夹回工作区（完整可见）',
  /const cx = Math\.max\(wa\.x, Math\.min\(c\.x, maxX\)\);/.test(mainCode) &&
  /const cy = Math\.max\(wa\.y, Math\.min\(c\.y, maxY\)\);/.test(mainCode));
check('[需求4] 按纠偏位移择优，放得下就直接用',
  /if \(best\.shift === 0\) break;/.test(mainCode));
check('[需求4] showMini 按形态分流定位',
  /if \(dockMode === 'dock' && dockOn && dockWin[\s\S]{0,200}placeMainNearDock/.test(mainCode));
check('[需求4] 图标形态沿用原有右下角逻辑（未改动）',
  /x: wa\.width - MINI_W/.test(mainCode) && /y: wa\.height - MINI_H/.test(mainCode));
check('[需求4] 日历只按 MINI 尺寸定位，不 resize 主窗',
  !/placeMainNearDock[\s\S]{0,1500}setSize/.test(mainCode));

// =====================================================================
// 需求5：彻底清除"嵌入任务栏"遗留代码
// =====================================================================
const FORBIDDEN_FUNCTIONS = [
  'attachDockToTaskbar', 'verifyDockEmbedded', 'detachDock', 'scheduleDockVerify',
  'runDockScript', 'dockAttachScriptPath', 'systemPrefersDark', 'pushDockEmbedded',
  'dockHwnd'
];
const forbiddenFns = FORBIDDEN_FUNCTIONS.filter(function (fn) {
  return new RegExp('function\\s+' + fn + '\\s*\\(').test(mainCode);
});
check('[需求5][关键] 嵌入相关函数定义全部不存在',
  forbiddenFns.length === 0, '仍存在: ' + forbiddenFns.join(','));
check('[需求5][关键] 嵌入状态变量全部不存在',
  !/let dockEmbedded\b/.test(mainCode) && !/let dockAttachTries\b/.test(mainCode) &&
  !/let dockRehealCount\b/.test(mainCode) && !/let dockNoEmbed\b/.test(mainCode));
check('[需求5][关键] 嵌入 timer 全部不存在',
  !/dockAttachTimer\b/.test(mainCode) && !/dockVerifyTimer\b/.test(mainCode) &&
  !/dockVerifyTimer2\b/.test(mainCode));
check('[需求5][关键] 无 dock-embedded IPC',
  !/'dock-embedded'/.test(mainCode) && !/onDockEmbedded/.test(mainCode));
check('[需求5][关键] 无 SetParent / ReBarWindow32 调用',
  !/SetParent/.test(mainCode) && !/ReBarWindow32/.test(mainCode));
check('[需求5][关键] preload 无 dock-embedded 通道',
  !/onDockEmbedded/.test(preloadCode) && !/'dock-embedded'/.test(preloadCode));
check('[需求5][关键] dock.html 无 embedded 逻辑',
  !/onDockEmbedded/.test(dockCode) && !/body\.embedded/.test(dockCode) &&
  !/classList\.contains\('embedded'\)/.test(dockCode));
check('[需求5][关键] dock-attach.ps1 文件已删除',
  !fs.existsSync(path.join(root, 'dock-attach.ps1')));
check('[需求5] package.json 无 extraResources(dock-attach.ps1)',
  !pkg.build || !pkg.build.extraResources || pkg.build.extraResources.length === 0);
check('[需求5] package.json 无 dock-attach 相关 files',
  !/"dock-attach\.ps1"/.test(JSON.stringify(pkg.build || {})));
check('[需求5] 主窗日历核心逻辑未被改动（goto-ym / 主题 / 提醒仍在）',
  /'goto-ym'/.test(mainCode) && /'set-theme'/.test(mainCode) &&
  /checkReminders/.test(mainCode) && /'list-reminders'/.test(mainCode));

// =====================================================================
// 需求6：移除无效吸附
// =====================================================================
check('[需求6][关键] 删除"自动吸附任务栏"日志与逻辑',
  !/snap to top of taskbar/.test(main) && !/dock drag near taskbar/.test(main));
check('[需求6][关键] drag-end 不再计算与任务栏的 gap',
  !/taskbarTopY/.test(mainCode));
// 说明性注释里会提到"已删除的贴回任务栏"，所以正文用剥注释后的 mainCode 判；
// 菜单 label 再用字面量兜一道，确保不是藏在哪条菜单项里。
check('[需求6][关键] 菜单不再有「贴回任务栏上沿」',
  !/贴回任务栏/.test(mainCode) && !/label:[\s\S]{0,80}贴回任务栏/.test(main));
check('[需求6] drag-end 只做夹取+落库',
  /dock dropped at/.test(main));
check('[需求6] positionDock 仅作为默认/复位落点（非吸附）',
  /function positionDock\(/.test(mainCode) &&
  (mainCode.match(/positionDock\(\)/g) || []).length <= 3,
  '调用次数=' + (mainCode.match(/positionDock\(\)/g) || []).length);

// =====================================================================
// 置顶等级：不高于全屏应用
// =====================================================================
check('[置顶] 插件用 floating 等级（不再 screen-saver）',
  /dockWin\.setAlwaysOnTop\(dockPinned, 'floating'\)/.test(mainCode) &&
  !/dockWin\.setAlwaysOnTop\(true, 'screen-saver'\)/.test(mainCode));
check('[置顶] 新增 dockPinned 开关与菜单项',
  /function toggleDockPinned\(/.test(mainCode) && /插件总在最前/.test(main));
check('[置顶] dockPinned 持久化',
  /dockPinned:\s*dockPinned,/.test(mainCode) && /dockPinned = o\.dockPinned !== false;/.test(mainCode));

// =====================================================================
// v1.7.20 崩溃修复 / 浮动方案回归保护
// =====================================================================
check('[回归] positionDock 实现存在', /function positionDock\s*\(/.test(mainCode));
check('[回归] pushDockSize 实现存在', /function pushDockSize\s*\(/.test(mainCode));
check('[回归] did-finish-load 调 pushDockSize',
  /did-finish-load[\s\S]{0,300}pushDockSize/.test(mainCode));
check('[回归] ready-to-show 调 pushDockSize',
  /ready-to-show[\s\S]{0,400}pushDockSize/.test(mainCode));
check('[回归] 崩溃重建有次数上限',
  /DOCK_RECREATE_MAX/.test(mainCode) && /dockRecreateCount >= DOCK_RECREATE_MAX/.test(mainCode));
check('[回归] render-process-gone 延迟销毁',
  /render-process-gone/.test(mainCode) && /target\.destroy/.test(mainCode));
check('[回归] closed 自愈条件=dockCrashed',
  /!quitting && dockOn && dockCrashed && dockRecreateCount < DOCK_RECREATE_MAX/.test(mainCode));
check('[回归] 稳定运行 5 分钟重置崩溃计数',
  /dockStableTimer/.test(mainCode) && /reset recreate count/.test(mainCode));
check('[回归] 全程无 setSize（崩溃元凶之一）',
  !/\.setSize\s*\(/.test(mainCode));
check('[回归] 自定义单实例锁命名空间',
  /requestSingleInstanceLock\(\s*\{\s*key\s*:/.test(mainCode) && /MY_LOCK_KEY\s*=/.test(mainCode));
check('[回归] cleanup 不用 tasklist 按进程名批量杀',
  !/tasklist\.exe[\s\S]{0,300}SimpleCalendar\.exe/.test(mainCode));
check('[回归] cleanup 用 CIM 父子关系 + 传递闭包',
  /Get-CimInstance Win32_Process/.test(mainCode) &&
  /childrenOf/.test(mainCode) && /no process info, skip/.test(mainCode));
const cleanupIdx = whenReadyBody.indexOf('cleanupStaleInstances()');
const createWinIdx = whenReadyBody.indexOf('createWindow()');
check('[回归] cleanup 在建窗之前调用',
  cleanupIdx >= 0 && createWinIdx > 0 && cleanupIdx < createWinIdx);

// =====================================================================
// v1.7.17 十条需求回归保护
// =====================================================================
check('[回归] 需求1 blur 子窗判断',
  /remindlistWin && !remindlistWin\.isDestroyed/.test(main) && /reminderWin && !reminderWin\.isDestroyed/.test(main));
check('[回归] 需求3 菜单合并', /查看 \/ 管理特别关注/.test(main));
check('[v1.7.22.5] 拖拽改绝对定位（mouse - offset，禁止 b.x + dy 累加）',
  /ipcMain\.on\('dock-drag-start'/.test(mainCode) &&
  /ipcMain\.on\('dock-drag-move'/.test(mainCode) &&
  /dragOffsetX\s*=\s*Math\.round\(mouseX\)\s*-\s*b\.x/.test(mainCode) &&
  /Math\.round\(mouseY\)\s*-\s*dragOffsetY/.test(mainCode) &&
  /const newX = Math\.round\(mouseX\)\s*-\s*dragOffsetX/.test(mainCode) &&
  /const newY = Math\.round\(mouseY\)\s*-\s*dragOffsetY/.test(mainCode) &&
  !/dock-drag-move[\s\S]{0,800}b\.x\s*\+\s*Math\.round\(dx\)/.test(mainCode));
check('[v1.7.22.5] preload.dockDragStart + dockDragMove 签名改为鼠标坐标',
  /dockDragStart:\s*function\s*\(mouseX,\s*mouseY\)/.test(preload) &&
  /dockDragMove:\s*function\s*\(mouseX,\s*mouseY\)/.test(preload));
check('[v1.7.22.5] dock.html 不再累加 dx/dy（不再有 dragStartX/Y 参与位置计算）',
  /function endDrag/.test(dock) &&
  /dragDownX\s*=\s*e\.screenX/.test(dock) &&
  /dockDragMove\(e\.screenX,\s*e\.screenY\)/.test(dock) &&
  !/var\s+dx\s*=\s*e\.screenX\s*-\s*dragStartX/.test(dock) &&
  !/var\s+dy\s*=\s*e\.screenY\s*-\s*dragStartY/.test(dock));
check('[v1.7.22.6] dock-drag-end 落盘 500ms 防抖（内存 dockBounds 立即更新）',
  /let _dockSaveTimer = null;/.test(mainCode) &&
  /_dockSaveTimer = setTimeout\(function \(\) \{[\s\S]{0,200}saveSettings\(\)/.test(mainCode) &&
  /\}, 500\);/.test(mainCode) &&
  /dockBounds = \{ x: nb\.x, y: nb\.y, width: dockW, height: dockH \};[\s\S]{0,120}clearTimeout\(_dockSaveTimer\)/.test(mainCode));
check('[v1.7.22.6] 退出前 flushDockBounds 兜底（防抖不能丢最后一次落点）',
  /function flushDockBounds\(\)/.test(mainCode) &&
  /before-quit[\s\S]{0,900}flushDockBounds\(\)/.test(mainCode));
check('[v1.7.22.6] Win11 像素补偿套 Math.round（防高 DPI 1px 白边）',
  /Math\.round\(best\.x \+ compX\)/.test(mainCode) &&
  /Math\.round\(best\.y \+ compY\)/.test(mainCode));
// 注意：注释型断言必须用原始源码 main（mainCode 已剥离注释）
check('[v1.7.22.6] makeTrayIcon 保留且标注"勿删"（历史托盘崩溃 bug 防护）',
  /function makeTrayIcon/.test(mainCode) &&
  /请勿删除 makeTrayIcon/.test(main) &&
  /makeTrayIcon\(themeMode === 'dark'/.test(mainCode));

/* =====================================================================
 * v1.7.22.7 —— 物理窗口被撑大导致"拖不到底/拖不到右/弹窗错位"的根治
 * 取证：calendar.log 里 `dock dropped at 1208,756`，反推 1440-1208=232、920-756=164，
 *      而代码请求的是 116×40 —— 物理窗口确实被撑大，且同一次运行内从 230×152 变到 232×164。
 * 对策：dockW/dockH 成为唯一真值，任何布局/夹取都不再采信 getBounds() 的 width/height。
 * ===================================================================== */
check('[v1.7.22.7] 意图尺寸 dockW/dockH 状态变量已声明',
  /let dockW = DOCK_W;/.test(mainCode) && /let dockH = DOCK_H;/.test(mainCode));
check('[v1.7.22.7] createDock 用 dockW/dockH 建窗（不再直接用 DOCK_W/局部变量 H）',
  /dockH = Math\.max\(40, Math\.min\(tb, 56\)\);/.test(mainCode) &&
  /width: dockW, height: dockH,/.test(mainCode));
check('[v1.7.22.7] dockClamped 是插件定位的唯一入口',
  /function dockClamped\(x, y\)/.test(mainCode) &&
  /clampDockToWorkArea\(\{ x: x, y: y, width: dockW, height: dockH \}\)/.test(mainCode));
check('[v1.7.22.7] pushDockSize 下发意图尺寸（不再把撑大的尺寸发给页面）',
  /dockWin\.webContents\.send\('dock-size', \{ w: dockW, h: dockH \}\)/.test(mainCode));
check('[v1.7.22.7] [关键·反向] pushDockSize 已不读 getBounds()',
  !/function pushDockSize[\s\S]{0,300}getBounds\(\)/.test(mainCode));
check('[v1.7.22.7] placeMainNearDock 传意图矩形（弹窗不错位）',
  /placeMainNearDock\(\{ x: db\.x, y: db\.y, width: dockW, height: dockH \}\)/.test(mainCode));
check('[v1.7.22.7] [关键·反向] placeMainNearDock 不再直接传 getBounds()',
  !/placeMainNearDock\(dockWin\.getBounds\(\)\)/.test(mainCode));
check('[v1.7.22.7] 建窗后自诊断：记录实际 vs 意图尺寸',
  /dock size INFLATED by OS/.test(mainCode));
check('[v1.7.22.7] resize 事件记录尺寸漂移（不强制回弹，避免死循环）',
  /dockWin\.on\('resize'[\s\S]{0,300}dock resized to/.test(mainCode));
/* 注意：clampDockToWorkArea 自身体里有 `width: b.width`（它按契约原样回传入参尺寸），
 * 那是合法的。要卡的是"外部调用点"—— 除了 dockClamped 内那一次，不该再有别的调用。 */
check('[v1.7.22.7] [关键·反向] clampDockToWorkArea 的外部调用点只剩 dockClamped 一处',
  (function () {
    const all = (mainCode.match(/clampDockToWorkArea\(/g) || []).length;
    // 1 处定义 + 1 处 dockClamped 内部调用 = 2，多出来就是有人绕过 dockClamped 直接调
    return all === 2 && /function clampDockToWorkArea\(/.test(mainCode) &&
      /return clampDockToWorkArea\(\{ x: x, y: y, width: dockW, height: dockH \}\)/.test(mainCode);
  })());
check('[v1.7.22.7] [关键·反向] 插件定位已无 width: cur.width / b.width 写法',
  !/dockWin\.setBounds\(\{[\s\S]{0,200}width:\s*(b|cur)\.width/.test(mainCode));
check('[v1.7.22.6] 无 extraResources 残留', !/extraResources/.test(mainCode));
check('[v1.7.22.5] 4px 阈值改为基于 dragDownX/Y 的曼哈顿距离',
  /dist\s*<\s*4\s*\)\s*return;\s*dragMoved\s*=\s*true/.test(dock));

check('[回归] 需求5 拖动 IPC 仍在',
  /dock-drag-move/.test(main) && /dock-drag-end/.test(main) &&
  /dockDragMove/.test(preload) && /dockDragMove/.test(dock));
check('[回归] 需求6 去秒',
  /lastTimeText/.test(dock) && /id="dockTime"[^>]*>--:--</.test(dock) && !/--:--:--/.test(dock));
check('[回归] 需求8 去托盘改为按需托盘 + 主窗右键',
  /main-show-menu/.test(main) && /mainShowMenu/.test(preload) && /mainShowMenu/.test(appjs));
check('[回归] 需求9 放大图标', />大</.test(tmpl) && />小</.test(tmpl));
check('[回归] 需求10 角标注', />注</.test(appjs) && !/chip-focus[\s\S]{0,120}>关</.test(appjs));
check('[回归] 固定像素布局（applyDockSize）仍在',
  /function applyDockSize\(\)/.test(dock) && /style\.height = \(sizeH - padT - padB\)/.test(dock));
check('[v1.7.22.4] applyDockSize 右下 inset=0（卡片底/右贴窗口边缘）',
  /var padL = 2, padT = 2, padR = 0, padB = 0/.test(dock));
check('[回归] dock-size 通道仍在',
  /onDockSize/.test(dock) && /onDockSize/.test(preload) && /'dock-size'/.test(preload));

// =====================================================================
// v1.7.22 三处微调
// =====================================================================
// 需求1：日历与插件间距紧贴（MAIN_GAP = 1）
check('[v1.7.22] 间距紧贴 MAIN_GAP=1', /const MAIN_GAP = 1\b/.test(mainCode));
// 需求2：今日深蓝 + 白字（独立于选中态）
/* v2.0：今日色已 Token 化。链路 = --blue-600:#1976d2 → --accent-strong → .cell.today
 * 白日保持用户确认的 #1976D2；黑夜提亮为 #4a86ef（深底上 #1976D2 太闷，刻意设计）。 */
check('[v1.7.22] 今日单元格深蓝 #1976D2（Token 链 --blue-600 → --accent-strong）',
  /--blue-600:\s*#1976d2/.test(tmpl) && /--accent-strong:\s*var\(--blue-600\)/.test(tmpl) &&
  /\.cell\.today:not\(\.other\)[\s\S]{0,200}var\(--accent-strong\)/.test(tmpl));
check('[v1.7.22] 今日单元格描边（inset 1.5px 同色环）',
  /\.cell\.today:not\(\.other\)\s*\{[\s\S]{0,240}inset 0 0 0 1\.5px/.test(tmpl));
check('[v1.7.22] 今日单元格白字（.d 与 .sub）',
  /\.cell\.today:not\(\.other\)[\s\S]{0,200}color:\s*#fff/.test(tmpl));
check('[v1.7.22] 选中态保持浅蓝（今日与选中已拆分）',
  /\.cell\.selected:not\(\.other\)[\s\S]{0,120}var\(--accent-soft\)/.test(tmpl) &&
  !/\.cell\.today,\s*\.cell\.selected/.test(tmpl));
// 需求3：Win10/Win11 检测
check('[v1.7.22] 引入 os 模块', /require\('os'\)/.test(main));
check('[v1.7.22] detectWin11 检测函数存在', /function detectWin11\s*\(/.test(mainCode));
check('[v1.7.22] build>=22000 判定 Win11', /parseInt\(m\[1\],\s*10\)\s*>=\s*22000/.test(mainCode));
check('[v1.7.22] isWin11 持久化写入 settings', /isWin11:\s*isWin11/.test(main));
check('[v1.7.22] 启动时检测并写回', /isWin11 = detectWin11\(\)/.test(mainCode));
check('[v1.7.22] 不硬编码任务栏高度（仍用 workArea）',
  /function taskbarHeight[\s\S]{0,300}workArea\.height/.test(mainCode));

// =====================================================================
// v2.0 视觉系统（UI Design System「纸与光」）
// =====================================================================
// 三层 Token：L1 色板/字阶/圆角/阴影/动效 → L2 语义 → L3 组件只消费 var()
check('[v2.0] 日历主体接入 Token（L1 基础层存在）',
  /--ink-800:\s*#1f2430/.test(tmpl) && /--blue-500:\s*#3b6fd4/.test(tmpl) &&
  /--red-500:\s*#d6453f/.test(tmpl) && /--amber-500:\s*#f59e0b/.test(tmpl) &&
  /--green-500:\s*#22c55e/.test(tmpl));
check('[v2.0] 黑夜主题整组替换（data-theme="dark"）',
  /\[data-theme="dark"\]\s*\{[\s\S]{0,600}--paper:/.test(tmpl));
check('[v2.0] 字阶 14 级（mini 到放大模式全覆盖）',
  /--fs-3xs:\s*8px/.test(tmpl) && /--fs-8xl:\s*76px/.test(tmpl));
check('[v2.0] 4pt 间距网格', /--s-1:\s*4px/.test(tmpl) && /--s-10:\s*40px/.test(tmpl));
check('[v2.0] 圆角 5 级 + 胶囊',
  /--r-xs:\s*4px/.test(tmpl) && /--r-xl:\s*24px/.test(tmpl) && /--r-pill:\s*999px/.test(tmpl));
check('[v2.0] 阴影 5 级 elevation', /--e-1:/.test(tmpl) && /--e-5:/.test(tmpl));
check('[v2.0] 动效 4 档 + 缓动 3 套',
  /--dur-instant:\s*80ms/.test(tmpl) && /--dur-slow:\s*340ms/.test(tmpl) &&
  /--ease-spring:/.test(tmpl));
check('[v2.0] 等宽数字（时钟/日期不抖动）', /tnum/.test(tmpl));
check('[v2.0] 悬浮插件接入 Token 且贴边约束保留',
  /--ink-800/.test(dock) && /padR = 0/.test(dock) && /padB = 0/.test(dock));
check('[v2.0] 提醒弹窗补齐黑夜模式',
  /data-theme.*dark|dark.*data-theme/.test(fs.readFileSync(path.join(__dirname, 'reminder.html'), 'utf8')));
check('[v2.0] 菜单图标系统（SDF 掩码 + 超采样抗锯齿）',
  /function _glyphMask/.test(main) && /GLYPH_SS = 64/.test(main) && /GLYPH_OUT = 16/.test(main));
check('[v2.0] 菜单图标缓存与失败降级',
  /_menuIconCache/.test(main) && /return null;\s*\/\/ 图标失败不应影响菜单可用性/.test(main));
check('[v2.0] 菜单图标跟系统深浅色（非软件主题）',
  /shouldUseDarkColors/.test(main));
check('[v2.0] 主进程无 emoji 菜单标签（注释除外）', !/📅|📒|📋|🗂|⏻/.test(mainCode));
check('[v2.0] 设计规范文档存在',
  fs.existsSync(path.join(__dirname, 'UI_DESIGN_SYSTEM.md')));

// =====================================================================
// 输出
// =====================================================================
let pass = 0, fail = 0;
for (const c of checks) {
  if (c.ok) { pass++; console.log('  ✓ ' + c.name); }
  else { fail++; console.log('  ✗ ' + c.name + (c.detail ? '  [' + c.detail + ']' : '')); }
}
console.log('\n===== verify_v1721: ' + pass + '/' + (pass + fail) + ' 通过 =====');
process.exit(fail === 0 ? 0 : 1);
