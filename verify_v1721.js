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
check('版本号=2.4.0', pkg.version === '2.4.0', 'package.json version=' + pkg.version);

// =====================================================================
// v2.3.0 Phase 3：设置窗口拖动 / 解除特别关注数量限制 / 安装后说明弹出
// =====================================================================
const settingsHtml = read('settings.html');
const settingsCode = codeOnly(settingsHtml);
const remindlistHtml = read('remindlist.html');
const installerNsh = read('installer.nsh');

check('[v2.3.0] 设置窗口表头可拖动（#head -webkit-app-region: drag）',
  /#head\s*\{[\s\S]{0,300}-webkit-app-region:\s*drag/.test(settingsCode));
check('[v2.3.0] 设置窗口关闭按钮排除拖动（#btnClose no-drag）',
  /#btnClose\s*\{[\s\S]{0,300}-webkit-app-region:\s*no-drag/.test(settingsCode));
check('[v2.3.0] 主进程解除特别关注数量上限（无 MAX_REMINDERS / limit）',
  !/MAX_REMINDERS/.test(mainCode) && !/error:\s*'limit'/.test(mainCode));
check('[v2.3.0] 渲染层无数量上限拦截（无 MAX_REMINDERS）',
  !/MAX_REMINDERS/.test(codeOnly(appjs)));
check('[v2.3.0] 关注列表不再显示 /10 上限',
  !/MAX_REMINDERS/.test(remindlistHtml) && !/0\/10/.test(remindlistHtml));
check('[v2.3.0] 使用说明作为独立文件打进安装目录（extraFiles）',
  /"extraFiles"/.test(read('package.json')) && /"to":\s*"使用说明\.html"/.test(read('package.json')));
check('[v2.3.0] 安装完成默认勾选「查看说明文档」',
  /MUI_FINISHPAGE_SHOWREADME_CHECKED/.test(installerNsh));

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
  /mouseleave[\s\S]{0,300}resetHit\(\)/.test(dockCode) &&
  /function resetHit[\s\S]{0,300}dockSetMouse\(true\)/.test(dockCode));
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
check('[v2.2.0] 形态切换移入设置（菜单无形态项，settings-set 支持 dockMode）',
  !/缩小至桌面图标/.test(mainCode) && !/切回桌面插件/.test(mainCode) &&
  /ipcMain\.on\('settings-set'/.test(mainCode) && /case 'dockMode'/.test(mainCode));
check('[需求2] 菜单含「显示 / 隐藏日历」（图标态也能开日历）',
  /'显示 \/ 隐藏日历'/.test(main));
check('[需求2] 菜单项带单色图标（v2.0 去 emoji）',
  /icon:\s*menuIcon\('calendar'\)/.test(main) && !/📅/.test(mainCode));
check('[需求2] 左键单击托盘切回插件',
  /tray\.on\('click'[\s\S]{0,300}dockMode === 'icon'\) setDockMode\('dock'\)/.test(mainCode));
check('[需求2] 不再同时绑 double-click（避免与 click 打架）',
  !/tray\.on\('double-click'/.test(mainCode));
check('[需求2] 切回插件时恢复到之前的位置',
  /function applyDockMode[\s\S]{0,900}pickDockRestore\(/.test(mainCode) &&
  /dockClamped\(restoreRect\.x, restoreRect\.y\)/.test(mainCode));
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
  /ready-to-show[\s\S]{0,900}pickDockRestore\(/.test(mainCode) &&
  /dockClamped\(restoreRect\.x, restoreRect\.y\)/.test(mainCode));
check('[v1.7.22.7] applyDockMode 恢复时同样走 dockClamped',
  /applyDockMode[\s\S]{0,900}pickDockRestore\(/.test(mainCode) &&
  /dockClamped\(restoreRect\.x, restoreRect\.y\)/.test(mainCode));

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
  /dockBounds = \{ x: nb\.x, y: nb\.y, width: dockW, height: dockH \};[\s\S]{0,600}clearTimeout\(_dockSaveTimer\)/.test(mainCode));
check('[v1.7.22.6] 退出前 flushDockBounds 兜底（防抖不能丢最后一次落点）',
  /function flushDockBounds\(\)/.test(mainCode) &&
  /before-quit[\s\S]{0,2000}flushDockBounds\(\)/.test(mainCode));
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
 * 那是合法的。要卡的是"外部调用点"—— 只允许 dockClamped / desktopClamped 两个包装器
 * （v2.2.0 桌面插件复用了同一套夹取）+ v2.3.2 放大模式拖动夹取（win.on('move')），
 * 不该再有别的调用。 */
check('[v1.7.22.7] clampDockToWorkArea 的外部调用点只剩 dockClamped / desktopClamped / 放大拖动夹取三处',
  (function () {
    const all = (mainCode.match(/clampDockToWorkArea\(/g) || []).length;
    // 1 处定义 + dockClamped/desktopClamped 各 1 处内部调用 + 放大拖动夹取 1 处 = 4，多出来就是有人绕过包装器直接调
    return all === 4 && /function clampDockToWorkArea\(/.test(mainCode) &&
      /return clampDockToWorkArea\(\{ x: x, y: y, width: dockW, height: dockH \}\)/.test(mainCode) &&
      /return clampDockToWorkArea\(\{ x: x, y: y, width: DESKTOP_W, height: DESKTOP_H \}\)/.test(mainCode);
  })());
check('[v2.3.2] 放大模式拖动夹取到工作区（win.on move + isResizable 判断 + 防重入）',
  /win\.on\('move'/.test(mainCode) && /win\.isResizable\(\)/.test(mainCode) && /mainClampLock/.test(mainCode));
check('[v1.7.22.7] [关键·反向] 插件定位已无 width: cur.width / b.width 写法',
  !/dockWin\.setBounds\(\{[\s\S]{0,200}width:\s*(b|cur)\.width/.test(mainCode));
check('[v1.7.22.6] 无 extraResources 残留', !/extraResources/.test(mainCode));
check('[v1.7.22.5] 4px 阈值改为基于 dragDownX/Y 的曼哈顿距离',
  /dist\s*<\s*4\s*\)\s*return;\s*dragMoved\s*=\s*true/.test(dock));

check('[回归] 需求5 拖动 IPC 仍在',
  /dock-drag-move/.test(main) && /dock-drag-end/.test(main) &&
  /dockDragMove/.test(preload) && /dockDragMove/.test(dock));
check('[v2.2.0] 需求3 显示秒 + 星期',
  /getSeconds\(\)/.test(dock) && /--:--:--/.test(dock) && /周/.test(dock));
check('[回归] 需求8 去托盘改为按需托盘 + 主窗右键',
  /main-show-menu/.test(main) && /mainShowMenu/.test(preload) && /mainShowMenu/.test(appjs));
check('[回归] 需求9 放大图标（v2.3.2 改为放大镜 + 镜片内加号/减号随状态切换）',
  /zoom-sign-plus/.test(tmpl) && /zoom-sign-minus/.test(tmpl) &&
  /<circle cx="11" cy="11" r="7"/.test(tmpl));
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
// v2.4.0 第二轮：皮肤 per-surface 重构 + 图片皮肤 + A-bug1/A-bug2
// =====================================================================

/* ---- 皮肤数据模型（主进程唯一真相，per-surface） ---- */
check('[v2.4.0 R2] skin 新结构 __v:2 + surfaces{calendar,expanded,desktop,dock}',
  /let skin = \{/.test(mainCode) && /__v:\s*2,/.test(mainCode) &&
  /surfaces:\s*\{/.test(mainCode) && /calendar:\s*\{\s*type: 'light'/.test(mainCode));
check('[v2.4.0 R2] opacity 收敛为 skin.opacity{calendar,desktop,dock}',
  /opacity:\s*\{\s*calendar: 1, desktop: 1, dock: 1\s*\}/.test(mainCode));
check('[v2.4.0 R2][关键] 旧皮肤散落变量已删除（skinMode/nativeSkin/skinColor/跟随/透明度全局）',
  !/let skinMode = /.test(mainCode) && !/let nativeSkin = /.test(mainCode) &&
  !/let skinColor = /.test(mainCode) && !/let desktopFollowCalendar = /.test(mainCode) &&
  !/let dockFollowCalendar = /.test(mainCode) && !/let mainOpacity = /.test(mainCode) &&
  !/let desktopOpacity = /.test(mainCode) && !/let dockOpacity = /.test(mainCode));

check('[v2.4.0 R2] normalizeSkin + migrateSkin 一次性迁移',
  /function normalizeSkin\(raw\)/.test(mainCode) && /function migrateSkin\(o\)/.test(mainCode) &&
  /o\.skin && o\.skin\.__v === 2 && o\.skin\.surfaces/.test(mainCode));
// saveSettings 作用域精确自检：只在函数体内查。文件其它位置 `theme: themeMode` 是
// 设置/关注列表/提醒窗口的 query/IPC 载荷（跟随 baseTheme，属合法残留），不应误判。
const saveSettingsBody = main.slice(main.indexOf('function saveSettings'), main.indexOf('function clampOpacity'));
check('[v2.4.0 R2][关键] 迁移后 saveSettings 只写 skin（不再写 theme 镜像/旧键）',
  /skin:\s*skin,/.test(codeOnly(saveSettingsBody)) &&
  !/theme:\s*themeMode/.test(codeOnly(saveSettingsBody)) &&
  !/skinMode:\s*skinMode/.test(codeOnly(saveSettingsBody)) &&
  !/nativeSkin:\s*nativeSkin/.test(codeOnly(saveSettingsBody)) &&
  !/skinColor:\s*skinColor/.test(codeOnly(saveSettingsBody)) &&
  !/desktopFollowCalendar:\s*desktopFollowCalendar/.test(codeOnly(saveSettingsBody)) &&
  !/dockFollowCalendar:\s*dockFollowCalendar/.test(codeOnly(saveSettingsBody)));

/* ---- per-surface 明暗中枢 ---- */
check('[v2.4.0 R2] resolveSurfaceConfig（expanded/desktop follow→calendar）',
  /function resolveSurfaceConfig\(surface\)/.test(mainCode) &&
  /follow === 'calendar'/.test(mainCode) && /return skin\.surfaces\.calendar;/.test(mainCode));
check('[v2.4.0 R2] surfaceTheme 五类 type 推导（text 字段决定 color/image 明暗）',
  /function surfaceTheme\(surface\)/.test(mainCode) && /c\.text === 'light'/.test(mainCode) &&
  /c\.text === 'dark'/.test(mainCode) && /nativeTheme\.shouldUseDarkColors/.test(mainCode));
check('[v2.4.0 R2] surfaceBg（native/color/image 三态）',
  /function surfaceBg\(surface\)/.test(mainCode) && /kind: 'color'/.test(mainCode) &&
  /kind: 'image'/.test(mainCode) && /kind: 'native'/.test(mainCode));
check('[v2.4.0 R2] baseTheme = surfaceTheme("calendar")（非表面窗口基准）',
  /function baseTheme\(\)\s*\{\s*return surfaceTheme\('calendar'\);/.test(mainCode));
check('[v2.4.0 R2] resolvedSurfaceState 下发 type/theme/bg/color/image',
  /function resolvedSurfaceState\(surface\)/.test(mainCode) && /theme: surfaceTheme\(surface\)/.test(mainCode) &&
  /bg: bg\.kind/.test(mainCode));

/* ---- skin:// 特权协议 + 图片导入 ---- */
check('[v2.4.0 R2] registerSchemesAsPrivileged 注册 skin://（app ready 前）',
  /protocol\.registerSchemesAsPrivileged\(\[/.test(mainCode) && /scheme:\s*'skin'/.test(mainCode) &&
  /standard: true, secure: true/.test(mainCode));
check('[v2.4.0 R2] protocol.handle("skin") 映射 userData/skins（net.fetch + pathToFileURL）',
  /protocol\.handle\('skin'/.test(mainCode) && /path\.join\(skinsDir\(\), name\)/.test(mainCode) &&
  /net\.fetch\(pathToFileURL\(file\)\.toString\(\)\)/.test(mainCode));
check('[v2.4.0 R2][v2.4.1] importSkinImage 校验：surface 白名单 + 扩展名白名单，取消大小/像素上限',
  /function importSkinImage\(surface, srcPath\)/.test(mainCode) &&
  /validSurfaces\[surface\]/.test(mainCode) && /okExts\[ext\]/.test(mainCode) &&
  !/图片超过 20MB/.test(mainCode) && !/最长边超过 4096/.test(mainCode) && !/maxEdge/.test(mainCode));
check('[v2.4.0 R2] 图片亮度采样 64px resize.toBitmap',
  /resize\(\{ width: 64 \}\)/.test(mainCode) && /toBitmap\(\)/.test(mainCode));
check('[v2.4.2] GIF 导入跳过 nativeImage 解码（readGifSize + isGif 分支）',
  /function readGifSize\(filePath\)/.test(mainCode) && /var isGif = \(ext === '\.gif'\)/.test(mainCode) &&
  /size = readGifSize\(srcPath\) \|\| \{ width: 0, height: 0 \}/.test(mainCode));
check('[v2.4.2] GIF 亮度采样 + 首帧快照均已移除（不再 toPNG/_frame.png）',
  !/toPNG\(\)/.test(mainCode) && !/_frame\.png/.test(mainCode) && /var snapshot = null/.test(mainCode));
check('[v2.4.0 R2] 原子复制（copyFileSync → renameSync）',
  /copyFileSync\(srcPath, tmp\)/.test(mainCode) && /renameSync\(tmp, dest\)/.test(mainCode));

/* ---- v2.4.1 图片皮肤回归：防透明 / 防 auto 误判黑夜 / 修复图片 404 / 去方框边 ---- */
check('[v2.4.1 C] surfaceBg image 但无图 → 回退纯色兜底（不再透明）',
  /function solidFallbackFor\(c, surface\)/.test(mainCode) &&
  /c\.image && c\.image\.file/.test(mainCode) && /kind: 'color', color: solidFallbackFor/.test(mainCode));
check('[v2.4.1 E] 亮度采样跳过透明像素（alpha=0 不计入均值）',
  /bmp\[i \+ 3\] === 0/.test(mainCode) && /continue/.test(mainCode));
check('[v2.4.1 D] skinUrlToName 提取 skin:// 文件名（含尾斜杠兼容）',
  /function skinUrlToName\(url\)/.test(mainCode));
check('[v2.4.1 D] protocol.handle("skin") 改用 skinUrlToName 取文件名',
  /skinUrlToName\(request && request\.url\)/.test(mainCode));
check('[v2.4.2] dock.html 纯色/图片复用原生描边+阴影（不再单独 border-color: transparent）',
  !/\[data-skin="color"\] #card,/.test(dockCode) && !/border-color: transparent/.test(dockCode) &&
  /\[data-skin="color"\] #card \{ background: var\(--skin-bg-solid\); \}/.test(dockCode) &&
  /\[data-skin="image"\] #card \{ background: transparent; \}/.test(dockCode));
check('[v2.4.2] dock.html hover 锁住自选背景（body.hit + data-skin，不闪黑）',
  /body\.hit\[data-skin="color"\] #card:hover/.test(dockCode) &&
  /body\.hit\[data-skin="image"\] #card:hover/.test(dockCode));
check('[v2.4.2] bgColorFor 始终返回透明（窗口不再做方形色块底子）',
  /function bgColorFor\(surface\)\s*\{\s*return '#00000000';/.test(mainCode));

/* ---- 皮肤写操作 + IPC + 独立皮肤窗口 ---- */
check('[v2.4.0 R2] applySkinSet 统一写入口 + copy-on-write 物化（取消跟随深拷贝日历配置）',
  /function applySkinSet\(payload\)/.test(mainCode) && /c\.follow = 'calendar';/.test(mainCode) &&
  /JSON\.parse\(JSON\.stringify\(cal\.image\)\)/.test(mainCode));
check('[v2.4.0 R2] skin-set / skin-action / skin-import IPC 注册',
  /ipcMain\.on\('skin-set'/.test(mainCode) && /ipcMain\.on\('skin-action'/.test(mainCode) &&
  /ipcMain\.handle\('skin-import'/.test(mainCode));
check('[v2.4.0 R2] settings-action 扩展 open-skin → openSkinWindow',
  /action === 'open-skin'/.test(mainCode) && /openSkinWindow\(\)/.test(mainCode));
check('[v2.4.0 R2] 独立皮肤窗口 openSkinWindow + skinWin + skin.html',
  /let skinWin = null;/.test(mainCode) && /function openSkinWindow\(\)/.test(mainCode) &&
  /skin\.html/.test(mainCode));

/* ---- skin-state 载荷升级（per-surface） ---- */
check('[v2.4.0 R2] 主窗 skin-state 下发 {calendar,expanded}',
  /pushSkinToRenderer[\s\S]{0,400}\{ calendar: resolvedSurfaceState\('calendar'\), expanded: resolvedSurfaceState\('expanded'\) \}/.test(mainCode));
check('[v2.4.0 R2] 桌面 skin-state 下发 {desktop}',
  /pushSkinToDesktop[\s\S]{0,200}\{ desktop: resolvedSurfaceState\('desktop'\) \}/.test(mainCode));
check('[v2.4.0 R2] 浮动 skin-state 下发 {dock}',
  /pushSkinToDock[\s\S]{0,200}\{ dock: resolvedSurfaceState\('dock'\) \}/.test(mainCode));
check('[v2.4.0 R2][关键] 已删除 pushThemeToRenderer/Dock/Desktop（主题改走 skin-state.theme）',
  !/function pushThemeToRenderer/.test(mainCode) && !/function pushThemeToDock/.test(mainCode) &&
  !/function pushThemeToDesktop/.test(mainCode));
check('[v2.4.0 R2] pushThemeToAll 只广播托盘/关注列表/设置（不再推日历/桌面/浮动 theme-changed）',
  /function pushThemeToAll\(\)[\s\S]{0,500}pushThemeToRemindlist/.test(mainCode) &&
  /function pushThemeToAll\(\)[\s\S]{0,500}tray\.setImage/.test(mainCode));

/* ---- 透明度统一读 skin.opacity ---- */
check('[v2.4.0 R2] 透明度窗口级应用 applyOpacity 读 skin.opacity',
  /function applyOpacity\(key\)/.test(mainCode) && /skin\.opacity\[key\]/.test(mainCode) &&
  /win\.setOpacity\(v\)/.test(mainCode) && /desktopWin\.setOpacity\(v\)/.test(mainCode) &&
  /dockWin\.setOpacity\(v\)/.test(mainCode));
check('[v2.4.0 R2] 主窗/桌面/浮动建窗时读 skin.opacity.*',
  /win\.setOpacity\(skin\.opacity\.calendar\)/.test(mainCode) &&
  /desktopWin\.setOpacity\(skin\.opacity\.desktop\)/.test(mainCode) &&
  /dockWin\.setOpacity\(skin\.opacity\.dock\)/.test(mainCode));

/* ---- A-bug1 / A-bug2 ---- */
check('[v2.4.0 R2 A-bug1] 桌面插件 blur → 下发 win-hidden 清 range',
  /desktopWin\.on\('blur'/.test(mainCode) && /send\('win-hidden'\)/.test(mainCode));
check('[v2.4.0 R2 A-bug2][关键] 已删除 getFocusedWindow() 宽松判定',
  !/getFocusedWindow/.test(mainCode));
check('[v2.4.0 R2 A-bug2] 显式 isFocused() 判断已知兄弟窗口',
  /dockWin\.isFocused\(\)/.test(mainCode) && /desktopWin\.isFocused\(\)/.test(mainCode) &&
  /settingsWin\.isFocused\(\)/.test(mainCode) && /skinWin\.isFocused\(\)/.test(mainCode) &&
  /remindlistWin\.isFocused\(\)/.test(mainCode) && /reminderWin\.isFocused\(\)/.test(mainCode));
check('[v2.4.0 R2] nativeTheme.on(updated) 只注册一次：基准主题变才 pushThemeToAll，恒 pushSkinToAll',
  (mainCode.match(/nativeTheme\.on\('updated'/g) || []).length === 1 &&
  /pushSkinToAll\(\);/.test(mainCode) && /pushThemeToAll\(\);/.test(mainCode));

/* ---- preload 桥 ---- */
check('[v2.4.0 R2] preload 新增 skinSet/skinAction/skinImport/onSkinConfigState/onSkinImportResult',
  /skinSet:\s*function/.test(preloadCode) && /skinAction:\s*function/.test(preloadCode) &&
  /skinImport:\s*function/.test(preloadCode) && /onSkinConfigState:\s*function/.test(preloadCode) &&
  /onSkinImportResult:\s*function/.test(preloadCode));
check('[v2.4.0 R2] preload 保留 onSkinState / onWinHidden',
  /onSkinState:/.test(preloadCode) && /onWinHidden:/.test(preloadCode) && /'skin-state'/.test(preloadCode));

/* ---- 渲染层应用（app.js / template.html / dock.html） ---- */
check('[v2.4.0 R2] app.js applySkinState + applySkinImage + skinViewport + setSkinFrozen',
  /function applySkinState\(state\)/.test(codeOnly(appjs)) && /function applySkinImage\(image\)/.test(codeOnly(appjs)) &&
  /function skinViewport\(\)/.test(codeOnly(appjs)) && /function setSkinFrozen\(frozen\)/.test(codeOnly(appjs)));
check('[v2.4.0 R2] app.js 持有 skinCalendar/skinExpanded 并按 .max 切换',
  /var skinCalendar = null;/.test(codeOnly(appjs)) && /var skinExpanded = null;/.test(codeOnly(appjs)) &&
  /applySkinState\(expanded \? skinExpanded : skinCalendar\)/.test(codeOnly(appjs)));
check('[v2.4.0 R2] app.js 已移除 onThemeChanged 订阅（主题改由 skin-state.theme 驱动）',
  !/onThemeChanged\(function \(mode\)/.test(codeOnly(appjs)));
// 桌面插件失焦（blur 仍可见）只清 range、不冻结 GIF；冻结改由 visibilitychange 驱动（与 dock 一致）
check('[v2.4.0 R2] app.js onWinHidden 桌面模式跳过 setSkinFrozen（GIF 失焦不冻结）',
  /if \(!IS_DESKTOP\) setSkinFrozen\(true\)/.test(codeOnly(appjs)) &&
  /setSkinFrozen\(document\.hidden\)/.test(codeOnly(appjs)));
check('[v2.4.0 R2] template.html 新增 #skinImg 层 + [data-skin=color/image]',
  /id="skinImg"/.test(tmpl) && /#skinImg\s*\{/.test(tmpl) &&
  /\[data-skin="color"\] #widget/.test(tmpl) && /\[data-skin="image"\] #widget/.test(tmpl));
check('[v2.4.0 R2] template.html 已删除旧 [data-skin="custom"] 与 --skin-ink',
  !/\[data-skin="custom"\]/.test(tmpl) && !/--skin-ink:/.test(tmpl));
check('[v2.4.0 R2] dock.html 新增 #skinImg + [data-skin=color/image] #card',
  /id="skinImg"/.test(dock) && /\[data-skin="color"\] #card/.test(dock) &&
  /\[data-skin="image"\] #card/.test(dock));
check('[v2.4.0 R2] dock.html 升级 dockApplySkin/dockApplyImage + GIF 冻结 dockSetFrozen',
  /function dockApplySkin\(state\)/.test(dockCode) && /function dockApplyImage\(image\)/.test(dockCode) &&
  /dockSetFrozen/.test(dockCode));

/* ---- A1/A3/A4/A5/A6（第二轮沿用，回归保护） ---- */
check('[v2.4.0 R2 A1] blurGraceUntil 时间戳 + guardBlur(ms)（无 suppressBlur 布尔）',
  /let blurGraceUntil = 0;/.test(mainCode) && /function guardBlur\(ms\)/.test(mainCode) &&
  !/let suppressBlur = false;/.test(mainCode));
check('[v2.4.0 R2 A1] hideMain() 统一收口 + win.on(show) 清 grace',
  /function hideMain\(\)/.test(mainCode) &&
  /win\.on\('show', function \(\) \{ blurGraceUntil = 0; \}\)/.test(mainCode));
check('[v2.4.0 R2 A3] pickDockRestore 纯函数存在（displayId keying）',
  /function pickDockRestore\(displays, map, displayId, fallbackRect\)/.test(mainCode) &&
  /map\[String\(displayId\)\]/.test(mainCode));
check('[v2.4.0 R2 A4] dock.html resetHit + contextmenu/blur 复位',
  /function resetHit\(\)/.test(dockCode) &&
  /contextmenu[\s\S]{0,200}resetHit\(\)/.test(dockCode) &&
  /addEventListener\('blur'[\s\S]{0,120}resetHit\(\)/.test(dockCode));
check('[v2.4.0 R2 A5] #infoBar 顶部时间栏可拖动',
  /#infoBar\s*\{[\s\S]{0,400}-webkit-app-region:\s*drag/.test(tmpl));
check('[v2.4.0 R2 A6] dock 日期拆「星期 + 日期」两 span + gap 放宽',
  /id="dockWeek"/.test(dock) && /id="dockDateNum"/.test(dock) &&
  /#dockDate\s*\{[\s\S]{0,300}gap: 6px/.test(dock));

/* ---- 皮肤窗口 + 设置入口 ---- */
const skinHtml = read('skin.html');
check('[v2.4.0 R2] skin.html 存在', skinHtml.length > 0);
check('[v2.4.0 R2] skin.html 4 界面分段 + 5 皮肤类型',
  /data-surface="calendar"/.test(skinHtml) && /data-surface="dock"/.test(skinHtml) &&
  /data-surface="desktop"/.test(skinHtml) && /data-surface="expanded"/.test(skinHtml) &&
  /data-type="light"/.test(skinHtml) && /data-type="dark"/.test(skinHtml) &&
  /data-type="system"/.test(skinHtml) && /data-type="color"/.test(skinHtml) &&
  /data-type="image"/.test(skinHtml));
check('[v2.4.0 R2] skin.html 色盘 + 取景 + 文字明暗 + 透明度 + 跟随开关',
  /paletteGrid/.test(skinHtml) && /dropZone/.test(skinHtml) && /cropBox/.test(skinHtml) &&
  /data-text="auto"/.test(skinHtml) && /opacityRange/.test(skinHtml) && /followSwitch/.test(skinHtml));
check('[v2.4.0 R2] skin.html 走 skin-set 即时回写 + skin-import + choose-file',
  /skinSet\(/.test(skinHtml) && /skinImport\(/.test(skinHtml) && /skinAction\('choose-file'/.test(skinHtml));

check('[v2.4.0 R2] settings.html 仅留「皮肤设置」入口（无内联皮肤选择器）',
  /btnSkin/.test(settingsCode) && /open-skin/.test(settingsCode) &&
  !/data-seg="skinMode"/.test(settingsCode) && !/data-seg="nativeSkin"/.test(settingsCode) &&
  !/data-surface=/.test(settingsCode) && !/skinReset/.test(settingsCode));
check('[v2.4.0 R2] settings.html 保留四分区',
  /功能区/.test(settingsCode) && /桌面插件区/.test(settingsCode) &&
  /浮动插件区/.test(settingsCode) && /日历窗口区/.test(settingsCode));

check('[v2.4.0 R2] package.json build.files 含 skin.html',
  /"skin\.html"/.test(JSON.stringify((pkg.build && pkg.build.files) || [])));

/* =====================================================================
 * v2.4.3：图片皮肤文字描边 + 图片不透明度 + 功能栏按钮调淡
 * ===================================================================== */

/* ---- 主进程：图片不透明度数据模型 ---- */
check('[v2.4.3] clampImageOpacity 存在并夹取到 [0.2, 1.0]',
  /function clampImageOpacity\(v\)/.test(mainCode) &&
  /Math\.max\(0\.2, Math\.min\(1, n\)\)/.test(mainCode));
check('[v2.4.3] normalizeImageSpec 输出 opacity 字段（默认 1）',
  /function normalizeImageSpec\(img\)[\s\S]{0,1500}opacity: clampImageOpacity\(img\.opacity\)/.test(mainCode));
check('[v2.4.3] importSkinImage 返回 image 含 opacity: 1',
  /var image = \{[\s\S]{0,320}opacity: 1,/.test(mainCode));
check('[v2.4.3] applySkinSet image 分支 merge 保留 opacity',
  /opacity: \(value\.opacity !== undefined\) \? value\.opacity : prev\.opacity/.test(mainCode));

/* ---- template.html：文字真描边 + 柔和阴影 + 按钮玻璃 ---- */
check('[v2.4.3] template.html 声明 --stroke-color / --shadow-extra 默认值',
  /--stroke-color:\s*transparent/.test(tmpl) && /--shadow-extra:\s*none/.test(tmpl));
check('[v2.4.3] template.html 文字真描边（-webkit-text-stroke 0.5px var(--stroke-color)）',
  /-webkit-text-stroke:\s*0\.5px var\(--stroke-color\)/.test(tmpl));
check('[v2.4.3] template.html 描边选择器仅 data-skin 限定（原生皮肤不描边）',
  (function () {
    var i = tmpl.indexOf('-webkit-text-stroke');
    return i >= 0 && /\[data-skin=/.test(tmpl.slice(Math.max(0, i - 600), i));
  })());
check('[v2.4.3] template.html 柔和阴影 text-shadow: var(--shadow-extra)',
  /text-shadow:\s*var\(--shadow-extra\)/.test(tmpl));
check('[v2.4.3] template.html 功能栏按钮玻璃 0.10/0.16（对齐 v4 .fn-btn）',
  /\[data-skin="color"\] #dragBar \.sel,[\s\S]{0,400}background-color: rgba\(255, 255, 255, 0\.10\);[\s\S]{0,160}border-color: rgba\(255, 255, 255, 0\.16\);/.test(tmpl));

/* ---- app.js：同步写描边/阴影 + 图片不透明度 ---- */
check('[v2.4.3] app.js applySkinState 同步写 --stroke-color/--shadow-extra',
  /applyTextStroke\(root, S\.theme\)/.test(codeOnly(appjs)) &&
  /setProperty\('--stroke-color'/.test(codeOnly(appjs)) &&
  /setProperty\('--shadow-extra'/.test(codeOnly(appjs)));
check('[v2.4.3] app.js 原生皮肤清除描边变量（clearTextStroke）',
  /clearTextStroke\(root\)/.test(codeOnly(appjs)) &&
  /removeProperty\('--stroke-color'\)/.test(codeOnly(appjs)));
check('[v2.4.3] app.js applySkinImage 直接写元素 style.opacity',
  /el\.style\.opacity = \(typeof image\.opacity === 'number' && isFinite\(image\.opacity\)\) \? String\(image\.opacity\) : '1'/.test(codeOnly(appjs)));

/* ---- dock.html：文字描边 + 图片不透明度 ---- */
check('[v2.4.3] dock.html 声明 --stroke-color / --shadow-extra',
  /--stroke-color:\s*transparent/.test(dock) && /--shadow-extra:\s*none/.test(dock));
check('[v2.4.3] dock.html 文字真描边（data-skin 限定）',
  /\[data-skin="color"\] #dockTime, \[data-skin="image"\] #dockTime/.test(dock) &&
  /-webkit-text-stroke:\s*0\.5px var\(--stroke-color\)/.test(dock));
check('[v2.4.3] dock.html dockApplySkin 写/清描边变量',
  /dockSetStroke\(root, theme\)/.test(dockCode) && /dockClearStroke\(root\)/.test(dockCode) &&
  /setProperty\('--stroke-color'/.test(dockCode) && /removeProperty\('--stroke-color'\)/.test(dockCode));
check('[v2.4.3] dock.html dockApplyImage 直接写元素 style.opacity',
  /el\.style\.opacity = \(typeof image\.opacity === 'number' && isFinite\(image\.opacity\)\) \? String\(image\.opacity\) : '1'/.test(dockCode));

/* ---- skin.html：图片不透明度滑块 ---- */
check('[v2.4.3] skin.html 图片不透明度滑块（20%~100%）',
  /id="imageOpacityRange"/.test(skinHtml) && /min="0\.2"/.test(skinHtml) && /max="1"/.test(skinHtml) &&
  /id="imageOpacityVal"/.test(skinHtml));
check('[v2.4.3] skin.html 图片不透明度即时回写 file+opacity',
  /setField\(S\.surface, 'image', \{ file: img\.file, opacity: v \}\)/.test(skinHtml));
check('[v2.4.3] skin.html renderCrop 回显 opacity 值',
  /imageOpacityRange'\)\.value = op/.test(skinHtml) && /imageOpacityVal'\)\.textContent = pct\(op\)/.test(skinHtml));


let pass = 0, fail = 0;
for (const c of checks) {
  if (c.ok) { pass++; console.log('  ✓ ' + c.name); }
  else { fail++; console.log('  ✗ ' + c.name + (c.detail ? '  [' + c.detail + ']' : '')); }
}
console.log('\n===== verify_v1721: ' + pass + '/' + (pass + fail) + ' 通过 =====');
process.exit(fail === 0 ? 0 : 1);
