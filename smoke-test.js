// mock Electron 冒烟测试（v1.7.21）
// 用 Module._load 拦截 require('electron')，真实执行 electron-main.js，
// 逼出所有只在运行时才炸的错误。
//
// v1.7.21 起跑**两轮**（用 settings.json 预置不同形态）：
//   轮 1 dockMode='dock'（默认）→ 断言：不建托盘、插件窗口建好且默认鼠标穿透
//   轮 2 dockMode='icon'      → 断言：建托盘图标、插件窗口仍建好但不 show
// 这样需求2 的"两种显示形态"两条路径都被真实执行到。

const path = require('path');
const fs = require('fs');
const Module = require('module');

const MAIN = path.join(process.cwd(), 'electron-main.js');
const USERDATA = path.join(process.cwd(), '_mock_userdata');

let stats = null;
const ipcHandlers = {};

function freshStats() {
  return {
    browserWindow: 0, tray: 0,
    loadedFiles: [], ipcChannels: [],
    menuBuilt: 0, menuItemCount: 0, menuLabels: [],
    ignoreMouseCalls: [], alwaysOnTopCalls: [],
    shown: 0, hidden: 0
  };
}

function noop() {}
function makeWin(winOpts) {
  const w = {
    __opts: winOpts || {},
    loadFile: function (f) { stats.loadedFiles.push(f); return Promise.resolve(); },
    loadURL: function () { return Promise.resolve(); },
    // ready-to-show 必须真的回调，否则插件的 show/hide 逻辑跑不到（真实环境会触发）
    once: function (evt, cb) {
      if (evt === 'ready-to-show') setTimeout(function () { try { cb(); } catch (e) {} }, 0);
    },
    on: noop, off: noop, removeAllListeners: noop,
    show: function () { stats.shown++; }, hide: function () { stats.hidden++; },
    focus: noop, blur: noop, close: noop, destroy: noop,
    isDestroyed: function () { return false; },
    isVisible: function () { return true; },
    isResizable: function () { return false; },
    isAlwaysOnTop: function () { return false; },
    setResizable: noop, setAspectRatio: noop,
    setAlwaysOnTop: function (on, level) { stats.alwaysOnTopCalls.push({ on: on, level: level || null }); },
    setIgnoreMouseEvents: function (ig, opt) {
      stats.ignoreMouseCalls.push({ ignore: !!ig, forward: !!(opt && opt.forward) });
    },
    setMenu: noop, setSkipTaskbar: noop,
    setPosition: noop, setSize: noop, setBounds: noop, setContentBounds: noop,
    setFullScreen: noop, setMinimumSize: noop, setMaximumSize: noop,
    setBackgroundColor: noop, setTitle: noop,
    getBounds: function () { return { x: 0, y: 0, width: 340, height: 430 }; },
    getContentBounds: function () { return { x: 0, y: 0, width: 340, height: 430 }; },
    getSize: function () { return [340, 430]; },
    getNativeWindowHandle: function () { return Buffer.alloc(8); },
    getParentWindow: function () { return null; },
    webContents: { send: noop, on: noop, once: noop, executeJavaScript: function () { return Promise.resolve(); } },
    setWindowButtonVisibility: noop
  };
  return w;
}

const electronMock = {
  app: {
    whenReady: function () { return Promise.resolve(); },
    on: noop, once: noop, quit: noop, exit: noop, relaunch: noop,
    requestSingleInstanceLock: function () { return true; },
    getVersion: function () { return '1.7.22'; },
    getName: function () { return '简洁桌面日历'; },
    getPath: function (k) { return USERDATA; },
    getAppPath: function () { return process.cwd(); },
    setAppUserModelId: noop,
    setLoginItemSettings: noop,
    getLoginItemSettings: function () { return { openAtLogin: false }; },
    commandLine: { appendSwitch: noop, appendArgument: noop, hasSwitch: function () { return false; } },
    isPackaged: false,
    dock: null
  },
  BrowserWindow: function (opts) {
    stats.browserWindow++;
    return makeWin(opts);
  },
  Tray: function () {
    stats.tray++;
    return { setToolTip: noop, setImage: noop, setContextMenu: noop, on: noop, destroy: noop };
  },
  screen: {
    getPrimaryDisplay: function () {
      return {
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 860 }
      };
    },
    getDisplayMatching: function () {
      return {
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 860 }
      };
    },
    getAllDisplays: function () { return []; },
    getCursorScreenPoint: function () { return { x: 700, y: 400 }; },
    on: noop
  },
  nativeImage: {
    createFromBuffer: function () { return { isEmpty: function () { return false; }, resize: function () { return {}; } }; },
    createFromPath: function () { return { isEmpty: function () { return false; } }; },
    createEmpty: function () { return { isEmpty: function () { return true; } }; }
  },
  nativeTheme: { shouldUseDarkColors: false, on: noop },
  ipcMain: {
    on: function (ch, cb) { stats.ipcChannels.push(ch); ipcHandlers[ch] = cb; },
    handle: noop, removeHandler: noop
  },
  Menu: {
    buildFromTemplate: function (tpl) {
      stats.menuBuilt++;
      stats.menuItemCount = tpl.length;
      stats.menuLabels = tpl.map(function (it) { return it.label || ''; });
      return { popup: noop, template: tpl };
    }
  },
  dialog: { showMessageBox: function () { return Promise.resolve({ response: 0 }); }, showErrorBox: noop },
  shell: { openExternal: function () { return Promise.resolve(); }, showItemInFolder: noop, openPath: noop },
  clipboard: { writeText: noop, readText: function () { return ''; } },
  globalShortcut: { register: noop, unregister: noop },
  powerMonitor: { on: noop },
  session: { defaultSession: { setPermissionRequestHandler: noop } },
  process: { getSystemVersion: function () { return '10.0.19045'; } },
  net: { request: function () { return { on: noop, end: noop }; } }
};
electronMock.BrowserWindow.getAllWindows = function () { return []; };

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronMock;
  return origLoad.apply(this, arguments);
};

/* ---------- 执行一轮 ---------- */
function runOnce(mode) {
  stats = freshStats();
  Object.keys(ipcHandlers).forEach(function (k) { delete ipcHandlers[k]; });

  // 预置用户设置（决定启动形态）
  try {
    if (!fs.existsSync(USERDATA)) fs.mkdirSync(USERDATA, { recursive: true });
    fs.writeFileSync(path.join(USERDATA, 'settings.json'),
      JSON.stringify({ theme: 'light', pinned: true, autoLaunch: false, dockOn: true, dockMode: mode }), 'utf8');
  } catch (e) {
    console.error('[smoke] 写 settings.json 失败: ' + e.message);
    process.exit(1);
  }

  // 每次都要真正重新执行一遍主进程代码
  delete require.cache[MAIN];
  require(MAIN);
  console.log('[smoke] 形态=' + mode + ' electron-main.js 顶层加载 OK');
  return stats;
}

/* ---------- 断言 ---------- */
const ok = [];
const bad = [];
function assert(cond, msg) { if (cond) ok.push(msg); else bad.push(msg); }

// ============ 轮 1：桌面插件形态（默认） ============
let s = runOnce('dock');

setTimeout(function () {
  try {
    if (ipcHandlers['dock-show-menu']) ipcHandlers['dock-show-menu']();
  } catch (e) { bad.push('菜单触发崩溃: ' + (e && e.message)); }

  assert(s.tray === 0, '插件形态不建托盘(new Tray=0)');
  assert(s.browserWindow >= 2, '窗口创建=' + s.browserWindow + '(主窗+插件)');
  assert(s.loadedFiles.some(function (f) { return /dock\.html/.test(String(f)); }), '插件 dock.html 已加载');
  assert(s.shown >= 1, '插件形态下窗口被 show(' + s.shown + ')');

  // 需求1：插件窗口必须默认「鼠标穿透 + forward」，热区才交给页面判定
  const initIgnore = s.ignoreMouseCalls.filter(function (c) { return c.ignore && c.forward; });
  assert(initIgnore.length >= 1, '需求1 插件默认鼠标穿透+forward(' + initIgnore.length + ')');

  // 置顶等级必须是 'floating'（不得再是 'screen-saver'，否则会盖住全屏视频/游戏）
  const ssLevel = s.alwaysOnTopCalls.filter(function (c) { return c.level === 'screen-saver'; });
  assert(ssLevel.length === 0, '置顶等级不再是 screen-saver(不抢全屏应用层)');
  assert(s.alwaysOnTopCalls.length >= 1, '插件已设置置顶(' + s.alwaysOnTopCalls.length + '次)');

  // v2.2.0 需求5：菜单瘦身 —— 形态切换收进「设置」，菜单只保留「设置」入口
  const hasSettings = s.menuLabels.some(function (l) { return /设置/.test(l); });
  assert(hasSettings, 'v2.2.0 菜单含「设置」入口');
  const hasShrink = s.menuLabels.some(function (l) { return /缩小至桌面图标/.test(l); });
  assert(!hasShrink, 'v2.2.0 菜单已无「缩小至桌面图标」（移入设置）');
  // 需求6：菜单里不得再有「贴回任务栏上沿」
  const hasSnap = s.menuLabels.some(function (l) { return /贴回任务栏/.test(l); });
  assert(!hasSnap, '需求6 菜单已删除「贴回任务栏上沿」');

  // 需求1：dock-set-mouse IPC 必须注册
  assert(s.ipcChannels.indexOf('dock-set-mouse') !== -1, '需求1 IPC dock-set-mouse 已注册');
  // 需求5：不得再有 dock-embedded 通道
  assert(s.ipcChannels.indexOf('dock-embedded') === -1, '需求5 无 dock-embedded 通道');

  const need = ['dock-toggle-main', 'dock-show-menu', 'main-show-menu',
    'dock-drag-move', 'dock-drag-end', 'dock-set-mouse', 'remindlist-goto-ym'];
  const missing = need.filter(function (ch) { return s.ipcChannels.indexOf(ch) === -1; });
  assert(missing.length === 0, 'IPC 注册齐全(' + need.length + ')');

  assert(s.menuBuilt >= 1 && s.menuItemCount > 0, '菜单构建成功(条目=' + s.menuItemCount + ')');

  // ============ 轮 2：桌面图标形态 ============
  let s2 = null;
  try { s2 = runOnce('icon'); } catch (e) {
    bad.push('icon 形态加载崩溃: ' + (e && e.message));
  }

  setTimeout(function () {
    if (s2) {
      assert(s2.tray === 1, '需求2 图标形态建托盘图标(new Tray=1)');
      // 图标形态下插件窗口依旧被创建（切回时零延迟），但不应该 show
      assert(s2.browserWindow >= 2, '图标形态插件窗口仍预建(' + s2.browserWindow + ')');
      assert(s2.hidden >= 1, '图标形态下插件窗口被隐藏(' + s2.hidden + ')');
      const hasBack = s2.menuLabels.some(function (l) { return /切回桌面插件/.test(l); });
      // 轮 2 还没触发菜单构建的话这里会 false，主动触发一次
      if (ipcHandlers['dock-show-menu']) {
        try { ipcHandlers['dock-show-menu'](); } catch (e) {}
        const hasBack2 = s2.menuLabels.some(function (l) { return /切回桌面插件/.test(l); });
        assert(!hasBack2, 'v2.2.0 菜单已无「切回桌面插件」（移入设置）');
      } else {
        assert(!hasBack, 'v2.2.0 菜单已无「切回桌面插件」（移入设置）');
      }
    }

    // 清理 mock 目录（避免污染真实 userData / 仓库）
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch (e) {}

    console.log('\n===== 冒烟测试结果（v1.7.22 双形态）=====');
    ok.forEach(function (t) { console.log('  ✓ ' + t); });
    if (bad.length) {
      bad.forEach(function (t) { console.log('  ✗ ' + t); });
      console.log('\n[smoke] FAIL (' + bad.length + ' 项失败)');
      process.exit(1);
    }
    console.log('\n[smoke] ALL PASS (' + ok.length + ' 项断言)');
    process.exit(0);
  }, 300);
}, 300);
