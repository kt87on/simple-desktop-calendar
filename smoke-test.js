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
let createdWindows = [];      // 按创建顺序记录所有 mock BrowserWindow（识别主窗/插件）

function freshStats() {
  return {
    browserWindow: 0, tray: 0,
    loadedFiles: [], ipcChannels: [],
    menuBuilt: 0, menuItemCount: 0, menuLabels: [],
    ignoreMouseCalls: [], alwaysOnTopCalls: [],
    shown: 0, hidden: 0,
    protocolRegistered: 0, protocolHandlers: {}
  };
}

function noop() {}
function makeWin(winOpts) {
  const w = {
    __opts: winOpts || {},
    _handlers: {},   // 记录 on(evt, cb)，供测试手动触发 blur/close 等事件
    loadFile: function (f) { stats.loadedFiles.push(f); return Promise.resolve(); },
    loadURL: function () { return Promise.resolve(); },
    // ready-to-show 必须真的回调，否则插件的 show/hide 逻辑跑不到（真实环境会触发）
    once: function (evt, cb) {
      if (evt === 'ready-to-show') setTimeout(function () { try { cb(); } catch (e) {} }, 0);
    },
    on: function (evt, cb) {
      if (!w._handlers[evt]) w._handlers[evt] = [];
      w._handlers[evt].push(cb);
    },
    off: noop, removeAllListeners: noop,
    show: function () { stats.shown++; }, hide: function () { stats.hidden++; },
    focus: noop, blur: noop, close: noop, destroy: noop,
    isDestroyed: function () { return false; },
    isVisible: function () { return true; },
    isFocused: function () { return false; },
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
  createdWindows.push(w);
  return w;
}

// v2.4.0 第二轮：nativeImage 走 importSkinImage 完整链路（getSize / resize().toBitmap() / toPNG()）
function makeNativeImage() {
  return {
    isEmpty: function () { return false; },
    getSize: function () { return { width: 100, height: 100 }; },
    resize: function () { return { toBitmap: function () { return Buffer.alloc(64 * 64 * 4); } }; },
    toPNG: function () { return Buffer.from('fake-png'); }
  };
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
    createFromBuffer: function () { return makeNativeImage(); },
    createFromPath: function () { return makeNativeImage(); },
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
  dialog: {
    showMessageBox: function () { return Promise.resolve({ response: 0 }); },
    showErrorBox: noop,
    showOpenDialog: function () { return Promise.resolve({ canceled: true, filePaths: [] }); }
  },
  shell: { openExternal: function () { return Promise.resolve(); }, showItemInFolder: noop, openPath: noop },
  clipboard: { writeText: noop, readText: function () { return ''; } },
  globalShortcut: { register: noop, unregister: noop },
  powerMonitor: { on: noop },
  session: { defaultSession: { setPermissionRequestHandler: noop } },
  process: { getSystemVersion: function () { return '10.0.19045'; } },
  // v2.4.0 第二轮：skin:// 特权协议（registerSchemesAsPrivileged 在模块顶层调用，handle 在 whenReady 注册）
  protocol: {
    registerSchemesAsPrivileged: function (list) { stats.protocolRegistered += (list ? list.length : 0); },
    handle: function (scheme, cb) { stats.protocolHandlers[scheme] = cb; }
  },
  net: {
    request: function () { return { on: noop, end: noop }; },
    fetch: function () { return Promise.resolve({}); }
  }
};
electronMock.BrowserWindow.getAllWindows = function () { return []; };
// v2.4.0 第二轮 A-bug2：已删除 BrowserWindow.getFocusedWindow 宽松判定。此处故意不注册该 API ——
// 若主进程仍调用它，blur 分支会抛 TypeError，冒烟测试即可当场暴露回归。

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronMock;
  return origLoad.apply(this, arguments);
};

/* ---------- 执行一轮 ---------- */
function runOnce(mode) {
  stats = freshStats();
  createdWindows = [];
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
  // ============ v2.4.0 第二轮 A-bug2 blur 冒烟：显式逐个 isFocused 判定兄弟窗口 ============
  // 必须在 dock-show-menu 触发前跑（否则 guardBlur(800) 会设置 blurGraceUntil 导致 blur 早退）。
  (function () {
    // 主窗是 whenReady 里第一个创建的窗口（顺序：createWindow → createDock）
    const mainWin = createdWindows[0];
    const dockMock = createdWindows[1];
    const blurH = mainWin && mainWin._handlers.blur && mainWin._handlers.blur[0];
    assert(!!blurH, 'A-bug2 主窗 blur 处理器已注册');
    if (blurH) {
      // 分支 1：所有兄弟窗口都不在焦点 → 应隐藏主窗
      const hiddenBefore = s.hidden;
      blurH();
      assert(s.hidden === hiddenBefore + 1, 'A-bug2 分支1 无兄弟窗口在焦点 → 隐藏主窗');

      // 分支 2：dock 插件窗口在焦点 → 不隐藏（显式 isFocused 命中）
      if (dockMock) dockMock.isFocused = function () { return true; };
      const hiddenBefore2 = s.hidden;
      blurH();
      assert(s.hidden === hiddenBefore2, 'A-bug2 分支2 dock 插件在焦点 → 不隐藏');
      if (dockMock) dockMock.isFocused = function () { return false; };
    }
    // getFocusedWindow 必须已删除：mock 未注册该 API，主进程若仍调用会在 blur 时抛 TypeError
    assert(typeof electronMock.BrowserWindow.getFocusedWindow !== 'function',
      'A-bug2 已删除 getFocusedWindow 宽松判定（不再调用）');
  })();

  // ============ v2.4.0 第二轮：skin:// 特权协议注册 + handler 挂载 ============
  assert(s.protocolRegistered === 1, 'skin:// 特权协议已注册(1 个 scheme)');
  assert(typeof s.protocolHandlers.skin === 'function', 'skin:// protocol.handle 已挂载 handler');

  // ============ v2.4.0 第二轮：启动即完成一次性皮肤迁移（settings.json 只写 skin、停写旧键） ============
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(USERDATA, 'settings.json'), 'utf8'));
    assert(saved && saved.skin && saved.skin.__v === 2 && saved.skin.surfaces,
      '迁移后 settings.json 写入 skin.__v===2 结构');
    assert(!('theme' in saved), 'saveSettings 已停写旧字段 theme');
    assert(!('skinMode' in saved) && !('nativeSkin' in saved) && !('skinColor' in saved),
      'saveSettings 已停写 skinMode/nativeSkin/skinColor');
    assert(!('desktopFollowCalendar' in saved) && !('dockFollowCalendar' in saved),
      'saveSettings 已停写 desktopFollowCalendar/dockFollowCalendar');
  } catch (e) { bad.push('读取迁移后 settings.json 失败: ' + (e && e.message)); }

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
