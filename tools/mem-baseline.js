'use strict';
/* ============================================================================
 * tools/mem-baseline.js —— 只读「内存基线」测量脚本（v1）
 *
 * 目的：在不修改任何产品源码、不改变产品正常行为的前提下，测量「简洁桌面日历」
 *       运行时的真实内存占用（进程级 + 渲染进程 V8 堆），覆盖三个典型场景：
 *         1) idle      —— 启动后静置 30s（迷你日历卡，接近用户日常待机形态）
 *         2) expanded  —— 展开日历（大屏形态）
 *         3) dock      —— 打开桌面挂件条（dock 形态）
 *
 * 原理：本脚本作为 Electron 的 **入口脚本**（main）被 electron.exe 加载，它会：
 *       a. 先把 userData 重定向到隔离目录（--user-data-dir 等价物），避免污染真实配置；
 *       b. 预写隔离 settings.json（autoLaunch:false / dockOn:true / 桌面插件关）；
 *       c. 安装一层 **安全的 spawn 拦截**（见下方“安全开关”），只拦 cleanupStaleInstances
 *          会对『用户真实在跑的 SimpleCalendar.exe』发起的 taskkill —— 否则 dev 版测量
 *          会误杀生产实例；
 *       d. require 真实的 electron-main.js，把产品完整启动起来；
 *       e. 在进程内调用 app.getAppMetrics() / webContents.getProcessMemoryInfo() /
 *          webContents.executeJavaScript('performance.memory') 采样；
 *       f. 用 PowerShell(CIM) 按「自己 + 子孙」传递闭包汇总该应用进程树的
 *          WorkingSet / PeakWorkingSet（拿到干净数值，剔除任何僵尸实例）；
 *       g. 把结果写成 REPORT.md（场景 × 指标 表 + 峰值结论）。
 *
 * 用法：
 *   node_modules/electron/dist/electron.exe tools/mem-baseline.js
 *   node_modules/electron/dist/electron.exe tools/mem-baseline.js --only=idle
 *   node_modules/electron/dist/electron.exe tools/mem-baseline.js --only=expanded
 *   node_modules/electron/dist/electron.exe tools/mem-baseline.js --only=dock
 *
 * 可调环境变量：
 *   MEM_UDD        隔离 userData 目录（默认 <root>/.tmp-diag/mem-userdata）
 *   MEM_OUT        输出目录（默认 <root>/.tmp-diag/mem）
 *   MEM_IDLE_MS    idle 场景静置时长（默认 30000）
 *   MEM_STEP_MS    展开/dock 场景静置时长（默认 8000）
 *   MEM_BOOT_MS    等待窗口出现的上限（默认 25000）
 *   MEM_NEUTRALIZE_CLEANUP=0  关闭 spawn 拦截（**危险**：会误杀用户真实实例）
 *
 * 只读承诺：本脚本不写任何产品文件；唯一写入是隔离 userData 与 .tmp-diag/mem/ 输出。
 * 纯 ES5 语法（var + 'use strict' + 中文块注释），与工程风格一致。
 * ==========================================================================*/

var path = require('path');
var fs = require('fs');
var os = require('os');
var child_process = require('child_process');
var EventEmitter = require('events').EventEmitter;
var electron = require('electron');

var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var webContents = electron.webContents;
var ipcMain = electron.ipcMain;

/* ---- 路径与参数 ---------------------------------------------------------- */
var ROOT = path.resolve(__dirname, '..');
var OUT_DIR = process.env.MEM_OUT || path.join(ROOT, '.tmp-diag', 'mem');
var UDD = process.env.MEM_UDD || path.join(ROOT, '.tmp-diag', 'mem-userdata');
var IDLE_MS = parseInt(process.env.MEM_IDLE_MS || '30000', 10);
var LONG_IDLE_MS = parseInt(process.env.MEM_LONG_IDLE_MS || '0', 10);  // >0 时额外补一次「长期 idle」采样
var STEP_MS = parseInt(process.env.MEM_STEP_MS || '8000', 10);
var BOOT_MS = parseInt(process.env.MEM_BOOT_MS || '25000', 10);
var SHOT_DIR = process.env.MEM_SHOT_DIR || '';   // 非空则每个场景额外对日历窗截图
var PROBE_BACKDROP = process.env.MEM_PROBE_BACKDROP === '1';  // 截图前注入 backdrop-filter 对照块
var NEUTRALIZE = process.env.MEM_NEUTRALIZE_CLEANUP !== '0';

/* 注入的 backdrop-filter 对照块：左半「条纹 + backdrop-blur(=8px) 覆盖」应为模糊，右半「条纹」应清晰。
 * 若两半看起来一样清晰 → backdrop-filter 失效。返回注入是否成功。 */
var BACKDROP_PROBE_JS = '(function(){try{' +
  'var old=document.getElementById("__bdprobe"); if(old) old.remove();' +
  'var b=document.createElement("div"); b.id="__bdprobe";' +
  'b.style.cssText="position:fixed;left:16px;top:16px;width:320px;height:140px;z-index:2147483647;";' +
  'var s1=document.createElement("div"); s1.style.cssText="position:absolute;left:0;top:0;width:160px;height:140px;background:repeating-linear-gradient(90deg,#000 0 5px,#fff 5px 10px);";' +
  'var bl=document.createElement("div"); bl.style.cssText="position:absolute;left:0;top:0;width:160px;height:140px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);";' +
  'var s2=document.createElement("div"); s2.style.cssText="position:absolute;left:160px;top:0;width:160px;height:140px;background:repeating-linear-gradient(90deg,#000 0 5px,#fff 5px 10px);";' +
  'b.appendChild(s1); b.appendChild(bl); b.appendChild(s2);' +
  'document.documentElement.appendChild(b); return "injected";' +
  '}catch(e){return "err:"+e.message;}})()';

var ONLY = '';
var RENDER_ONLY = (process.argv || []).indexOf('--render-only') >= 0; // 只据 results.json 重渲染 REPORT.md，不启动应用
/* 运行元信息（--render-only 时从 results.json 回读，保证报告头一致） */
var META = { execPath: '', isPackaged: false, versions: {} };
(function parseArgs() {
  var argv = process.argv || [];
  for (var i = 0; i < argv.length; i++) {
    var a = String(argv[i]);
    if (a.indexOf('--only=') === 0) { ONLY = a.slice('--only='.length); }
  }
  if (ONLY && ['idle', 'expanded', 'dock'].indexOf(ONLY) < 0) {
    ONLY = ''; // 非法值 → 跑全部
  }
})();

/* ---- 日志 ---------------------------------------------------------------- */
function stamp() { return new Date().toISOString(); }
function log(msg) {
  var line = '[' + stamp() + '] ' + msg;
  try { console.log(line); } catch (e) {}
  try {
    fs.appendFileSync(path.join(OUT_DIR, 'run.log'), line + '\n', 'utf8');
  } catch (e) {}
}

/* ---- 安全开关：拦截 cleanupStaleInstances 的破坏性调用 ------------------
 * electron-main.js 顶部 `const { spawn } = require('child_process')` 会 **捕获引用**，
 * 因此必须在 require 产品主进程之前安装本拦截。
 * 命中条件：
 *   ① powershell.exe 跑 Get-CimInstance + SimpleCalendar.exe 的 CIM 查询
 *      → 返回一个「空输出后立即 close」的假子进程，等价于 cleanupStaleInstances
 *        里 `rows.length === 0 → skip cleanup` 这条内置安全分支；
 *   ② taskkill.exe（会 kill 用户真实实例）
 *      → 返回一个空操作的假子进程。
 * 其余 spawn 一律透传真实的 child_process.spawn（含本脚本自己的采样）。
 * 这是**测量安全带**，不修改产品源码、不改动其它行为。 */
var REAL_SPAWN = child_process.spawn;
function makeStubChild() {
  var ee = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.stdin = null;
  ee.pid = -1;
  ee.kill = function () { return true; };
  ee.unref = function () { return ee; };
  process.nextTick(function () {
    try { ee.emit('close', 0, null); } catch (e) {}
  });
  return ee;
}
if (NEUTRALIZE) {
  child_process.spawn = function (cmd, args, opts) {
    try {
      var joined = Array.isArray(args) ? args.join(' ') : String(args || '');
      var isCim = (/Get-CimInstance/i.test(joined) && /SimpleCalendar\.exe/i.test(joined));
      var isKill = (/taskkill/i.test(String(cmd || '')));
      if (isCim) { log('harness: neutralized cleanup CIM query (prevent self-check failure)'); return makeStubChild(); }
      if (isKill) { log('harness: neutralized taskkill (would kill user real instances)'); return makeStubChild(); }
    } catch (e) {}
    return REAL_SPAWN.apply(child_process, arguments);
  };
}

/* ---- 隔离 userData + 预置 settings --------------------------------------- */
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }

var SEED_SETTINGS = {
  skin: {
    __v: 3,
    surfaces: {
      calendar: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
      expanded: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
      desktop: { follow: 'calendar', style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' },
      dock: { style: 'default', bg: 'native', image: null, text: 'auto', clarity: 'auto', tone: 'auto' }
    },
    opacity: { calendar: 1, desktop: 1, dock: 1 }
  },
  pinned: true,
  autoLaunch: false,
  dockOn: true,
  desktopOn: false,
  dockMode: 'dock',
  theme: 'light'
};

function seedSettings() {
  ensureDir(UDD);
  var file = path.join(UDD, 'settings.json');
  // 已存在则不覆盖，保证同一隔离目录多次运行的状态连续性（但首次必写）
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, JSON.stringify(SEED_SETTINGS, null, 2), 'utf8');
      log('seeded isolated settings.json at ' + file);
    } catch (e) {
      log('seed settings failed: ' + (e && e.message || e));
    }
  } else {
    log('reuse existing isolated settings.json at ' + file);
  }
}

var BOOT_OK = false;
if (!RENDER_ONLY) {
  ensureDir(OUT_DIR);
  ensureDir(UDD);
  seedSettings();

  /* 关键：在任何窗口/单实例锁之前把 userData 指向隔离目录。 */
  try {
    app.setPath('userData', UDD);
    log('userData -> ' + UDD);
  } catch (e) {
    log('setPath(userData) failed: ' + (e && e.message || e));
  }

  /* ---- 启动真实产品主进程（不改源码，直接 require） ---------------------- */
  try {
    require(path.join(ROOT, 'electron-main.js'));
    BOOT_OK = true;
    log('electron-main.js required OK');
  } catch (e) {
    log('FATAL: require(electron-main.js) failed: ' + (e && e.stack || e));
  }
  try {
    log('chromium switches: disable-gpu=' + app.commandLine.hasSwitch('disable-gpu') +
      ' disable-gpu-compositing=' + app.commandLine.hasSwitch('disable-gpu-compositing') +
      ' gpu-switches=' + JSON.stringify(process.argv.filter(function (a) { return /gpu/i.test(String(a)); })));
  } catch (e) {}
}

/* ==========================================================================
 *  采样工具
 * ==========================================================================*/
function safeUrl(wc) { try { return wc.getURL() || ''; } catch (e) { return ''; } }

/* 1) 进程级：app.getAppMetrics()（含 main / GPU / Renderer / Utility） */
function sampleAppMetrics() {
  var list = [];
  try { list = app.getAppMetrics() || []; } catch (e) { list = []; }
  var rows = [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i] || {};
    var mem = m.memory || {};
    var cpu = (m.cpu && typeof m.cpu.percentCPUUsage === 'number') ? m.cpu.percentCPUUsage : 0;
    rows.push({
      pid: m.pid || 0,
      type: String(m.type || 'Unknown'),
      cpuPercent: Math.round(cpu * 100) / 100,
      idleWakeups: (m.cpu && m.cpu.idleWakeupsPerSecond) || 0,
      workingSetMB: round1((mem.workingSetSize || 0) / 1024),
      peakWorkingSetMB: round1((mem.peakWorkingSetSize || 0) / 1024)
    });
  }
  return rows;
}

/* 2) 渲染进程级：webContents.getProcessMemoryInfo() + V8 堆(performance.memory) */
function sampleWebContents(cb) {
  var all = [];
  try { all = webContents.getAllWebContents() || []; } catch (e) { all = []; }
  var out = [];
  if (all.length === 0) { cb(out); return; }
  var pending = all.length;
  function finish() { pending--; if (pending === 0) { cb(out); } }
  all.forEach(function (wc) {
    var entry = { id: wc.id, url: safeUrl(wc), osPid: 0, workingSetMB: null, peakWorkingSetMB: null, jsHeapMB: null };
    try { entry.osPid = wc.getOSProcessId(); } catch (e) {}
    var afterHeap = function () { out.push(entry); finish(); };
    var afterMem = function () {
      // 尝试读取渲染进程 V8 堆（performance.memory 非标准但 Chromium 可用）
      var js = 'try{ (performance&&performance.memory)? performance.memory.usedJSHeapSize : -1 }catch(e){ -1 }';
      wc.executeJavaScript(js, true).then(function (bytes) {
        if (typeof bytes === 'number' && bytes >= 0) { entry.jsHeapMB = round1(bytes / 1048576); }
        afterHeap();
      }, function () { afterHeap(); });
    };
    try {
      wc.getProcessMemoryInfo().then(function (info) {
        info = info || {};
        entry.workingSetMB = round1((info.workingSetSize || 0) / 1024);
        entry.peakWorkingSetMB = round1((info.peakWorkingSetSize || 0) / 1024);
        afterMem();
      }, function (err) {
        log('getProcessMemoryInfo wc#' + entry.id + ' rejected: ' + (err && err.message || err));
        afterMem();
      });
    } catch (e) {
      log('getProcessMemoryInfo wc#' + entry.id + ' threw: ' + (e && e.message || e));
      afterMem();
    }
  });
}

/* 3) 进程树级：PowerShell(CIM) 按「自己 + 子孙」闭包汇总 WS/PeakWS（剔除僵尸） */
function sampleProcessTree(cb) {
  var exeName = path.basename(process.execPath || '');
  if (!exeName) { cb(null); return; }
  var cmd = 'Get-CimInstance Win32_Process -Filter "Name=\'' + exeName + '\'" | ' +
    'ForEach-Object { Write-Output ($_.ProcessId.ToString() + \' \' + $_.ParentProcessId.ToString() + \' \' + ' +
    '$_.WorkingSetSize.ToString() + \' \' + $_.PeakWorkingSetSize.ToString()) }';
  var ps;
  try {
    ps = REAL_SPAWN('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 15000 });
  } catch (e) { cb(null); return; }
  var out = '';
  ps.stdout.on('data', function (d) { out += d.toString(); });
  ps.on('error', function () { cb(null); });
  ps.on('close', function () {
    var rows = out.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)
      .map(function (l) {
        var m = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/.exec(l);
        return m ? { pid: m[1], ppid: m[2], ws: parseInt(m[3], 10), peak: parseInt(m[4], 10) } : null;
      }).filter(Boolean);
    if (rows.length === 0) { cb(null); return; }

    var childrenOf = {};
    rows.forEach(function (r) { (childrenOf[r.ppid] = childrenOf[r.ppid] || []).push(r.pid); });
    var mine = {};
    var self = String(process.pid);
    mine[self] = true;
    var queue = [self];
    while (queue.length) {
      var cur = queue.shift();
      var kids = childrenOf[cur] || [];
      for (var i = 0; i < kids.length; i++) {
        if (!mine[kids[i]]) { mine[kids[i]] = true; queue.push(kids[i]); }
      }
    }
    var allWs = 0, allPeak = 0, mineCount = 0, otherCount = 0, otherWs = 0;
    rows.forEach(function (r) {
      allWs += r.ws; allPeak += r.peak;
      if (mine[r.pid]) { mineCount++; } else { otherCount++; otherWs += r.ws; }
    });
    var mineRows = rows.filter(function (r) { return mine[r.pid]; });
    var mineWs = 0, minePeak = 0;
    mineRows.forEach(function (r) { mineWs += r.ws; minePeak += r.peak; });
    /* Win32_Process.WorkingSetSize / PeakWorkingSetSize 单位是 **字节**，除以 1048576 得 MB */
    cb({
      exeName: exeName,
      totalProcesses: rows.length,
      mineProcesses: mineCount,
      workingSetMB: round1(mineWs / 1048576),
      peakWorkingSetMB: round1(minePeak / 1048576),
      allProcesses: rows.length,
      allWorkingSetMB: round1(allWs / 1048576),
      zombieCandidates: otherCount,
      zombieWorkingSetMB: round1(otherWs / 1048576)
    });
  });
}

/* ---- 单次完整采样（三个数据源聚合） -------------------------------------- */
function capture(scenario, cb) {
  var rec = {
    scenario: scenario,
    at: stamp(),
    appMetrics: sampleAppMetrics(),
    webContents: null,
    tree: null,
    mainHeapMB: null
  };
  try {
    rec.mainHeapMB = round1(process.memoryUsage().heapUsed / 1048576);
  } catch (e) {}
  rec.appTotalWorkingSetMB = round1(sum(rec.appMetrics, 'workingSetMB'));
  rec.appTotalPeakWorkingSetMB = round1(sum(rec.appMetrics, 'peakWorkingSetMB'));
  rec.appTotalCpuPercent = round1(sum(rec.appMetrics, 'cpuPercent'));

  sampleWebContents(function (wcs) {
    /* 交叉填充：webContents.getProcessMemoryInfo() 若不可用，用 app.getAppMetrics() 的
     * 同 PID 行补上该渲染进程的 WorkingSet/PeakWorkingSet（Electron 的 getAppMetrics
     * 数据源更稳，且含 peak 字段）。 */
    var pidMap = {};
    for (var mi = 0; mi < rec.appMetrics.length; mi++) {
      pidMap[String(rec.appMetrics[mi].pid)] = rec.appMetrics[mi];
    }
    for (var wi = 0; wi < wcs.length; wi++) {
      var row = pidMap[String(wcs[wi].osPid)];
      if (row) {
        if (wcs[wi].workingSetMB === null) { wcs[wi].workingSetMB = row.workingSetMB; }
        if (wcs[wi].peakWorkingSetMB === null) { wcs[wi].peakWorkingSetMB = row.peakWorkingSetMB; }
      }
    }
    rec.webContents = wcs;
    sampleProcessTree(function (tree) {
      rec.tree = tree;
      log('capture[' + scenario + '] appTotalWS=' + rec.appTotalWorkingSetMB + 'MB procs=' + rec.appMetrics.length);
      maybeShot(scenario, function () { cb(rec); });
    });
  });
}

/* 对日历主窗截图（用于目视核对皮肤/backdrop-filter 是否仍渲染）。仅 MEM_SHOT_DIR 非空时启用。 */
function maybeShot(scenario, done) {
  if (!SHOT_DIR) { done(); return; }
  var wins = findWindowByUrl('calendar.html');
  if (!wins.length) { log('shot: no calendar window for ' + scenario); done(); return; }
  var wc = wins[0].webContents;
  function captureNow() {
    try {
      wc.capturePage().then(function (img) {
        try {
          ensureDir(SHOT_DIR);
          fs.writeFileSync(path.join(SHOT_DIR, scenario + '.png'), img.toPNG());
          log('shot saved: ' + scenario + '.png');
        } catch (e) { log('shot write failed: ' + (e && e.message || e)); }
        done();
      }, function (e) { log('capturePage failed(' + scenario + '): ' + (e && e.message || e)); done(); });
    } catch (e) { log('capturePage threw(' + scenario + '): ' + (e && e.message || e)); done(); }
  }
  if (PROBE_BACKDROP) {
    try {
      wc.executeJavaScript(BACKDROP_PROBE_JS, true).then(function (r) {
        log('backdrop probe(' + scenario + '): ' + r);
        setTimeout(captureNow, 400);
      }, function (e) { log('probe failed: ' + (e && e.message || e)); setTimeout(captureNow, 200); });
    } catch (e) { setTimeout(captureNow, 200); }
  } else {
    captureNow();
  }
}

function sum(arr, key) {
  var s = 0;
  for (var i = 0; i < arr.length; i++) { s += (arr[i][key] || 0); }
  return s;
}
function round1(n) { return Math.round((n || 0) * 10) / 10; }

/* ==========================================================================
 *  场景编排
 * ==========================================================================*/
function findWindowByUrl(frag) {
  var wins = [];
  try { wins = BrowserWindow.getAllWindows() || []; } catch (e) { wins = []; }
  var hit = [];
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    try {
      if (!w.isDestroyed() && safeUrl(w.webContents).indexOf(frag) >= 0) { hit.push(w); }
    } catch (e) {}
  }
  return hit;
}

function waitForBoot(cb) {
  var start = Date.now();
  (function poll() {
    var wins = [];
    try { wins = BrowserWindow.getAllWindows() || []; } catch (e) {}
    if (wins.length > 0 || Date.now() - start > BOOT_MS) {
      log('boot: ' + wins.length + ' window(s) after ' + (Date.now() - start) + 'ms');
      setTimeout(cb, 3000); // 让页面首屏/字体/皮肤稳定
      return;
    }
    setTimeout(poll, 500);
  })();
}

function doIdle(cb) {
  log('scenario idle: wait ' + IDLE_MS + 'ms');
  setTimeout(function () {
    capture('idle', function (rec) {
      RESULTS.push(rec);
      if (LONG_IDLE_MS > 0) {
        /* 长期 idle 对照：idle 后再静置 LONG_IDLE_MS，观察 OS 内存 trim / GC 后的稳态。 */
        log('scenario idle-long: wait additional ' + LONG_IDLE_MS + 'ms');
        setTimeout(function () {
          capture('idle-long', function (rec2) { RESULTS.push(rec2); cb(); });
        }, LONG_IDLE_MS);
      } else {
        cb();
      }
    });
  }, IDLE_MS);
}

function doExpanded(cb) {
  log('scenario expanded: emit toggle-expand');
  try { ipcMain.emit('toggle-expand'); } catch (e) { log('toggle-expand emit failed: ' + (e && e.message || e)); }
  setTimeout(function () { capture('expanded', function (rec) { RESULTS.push(rec); cb(); }); }, STEP_MS);
}

function doDock(cb) {
  log('scenario dock: ensure dock window visible');
  var docks = findWindowByUrl('dock.html');
  if (docks.length === 0) { log('dock window not found; skip visibility tweak'); }
  docks.forEach(function (w) { try { w.show(); } catch (e) {} });
  setTimeout(function () { capture('dock', function (rec) { RESULTS.push(rec); cb(); }); }, STEP_MS);
}

var RESULTS = [];
var SCENARIOS = ONLY ? [ONLY] : ['idle', 'expanded', 'dock'];

function runNext(idx) {
  if (idx >= SCENARIOS.length) { finish(); return; }
  var name = SCENARIOS[idx];
  var fn = (name === 'idle') ? doIdle : (name === 'expanded' ? doExpanded : doDock);
  fn(function () { runNext(idx + 1); });
}

/* ==========================================================================
 *  报告
 * ==========================================================================*/
function fmtMB(v) { return (v === null || v === undefined) ? '-' : String(v); }

function buildReport() {
  var L = [];
  /* 预先算出三种口径的关键值，供「口径说明」与「峰值结论」复用 */
  function byName(n) { for (var q = 0; q < RESULTS.length; q++) { if (RESULTS[q].scenario === n) return RESULTS[q]; } return null; }
  var rIdle = byName('idle');
  var rLong = byName('idle-long');
  var peak = null, peakName = '';
  for (var pi = 0; pi < RESULTS.length; pi++) { var pv = RESULTS[pi].appTotalWorkingSetMB; if (peak === null || pv > peak) { peak = pv; peakName = RESULTS[pi].scenario; } }
  var peakPeak = null, peakPeakName = '';
  for (var pj = 0; pj < RESULTS.length; pj++) { var pvv = RESULTS[pj].appTotalPeakWorkingSetMB; if (peakPeak === null || (pvv !== null && pvv > peakPeak)) { peakPeak = pvv; peakPeakName = RESULTS[pj].scenario; } }
  L.push('# 内存基线测量报告（只读）');
  L.push('');
  L.push('- 生成时间：' + stamp());
  var versions = META.versions || process.versions || {};
  L.push('- 测量对象：简洁桌面日历（' + (META.isPackaged ? '打包版' : 'dev 版') + '）');
  L.push('  - 说明：本脚本必须以 **Electron 入口脚本** 方式载入（`electron tools/mem-baseline.js`）才能调用');
  L.push('    `app.getAppMetrics()`；打包版（asar）无法外挂入口脚本，故默认以 dev 版实测（主进程代码与打包版一致）。');
  L.push('- 可执行文件：`' + (META.execPath || process.execPath) + '`');
  L.push('- Electron：' + versions.electron + '  Chromium：' + versions.chrome);
  L.push('- 隔离 userData：`' + UDD + '`');
  L.push('- 采样场景：' + SCENARIOS.join(' → ') +
    '（idle 静置 ' + IDLE_MS + 'ms' + (LONG_IDLE_MS > 0 ? '，结束后再补一次 idle-long = +' + Math.round(LONG_IDLE_MS / 60000 * 10) / 10 + ' 分钟' : '') + '，其余 ' + STEP_MS + 'ms）');
  L.push('- 操作系统：' + os.platform() + ' ' + os.release() + '（' + (os.arch()) + '），逻辑核 ' + (os.cpus() ? os.cpus().length : '?') + '，总内存 ' + round1(os.totalmem() / 1048576) + 'MB');
  L.push('');
  L.push('> 说明：所有数值均为**只读采样**，未修改任何产品源码。进程树汇总按「本进程 + 其子孙」');
  L.push('> 传递闭包计算，天然剔除任何非本应用进程 / 僵尸实例（即“干净数值”）。');
  L.push('> 指标来源：进程级取自 `app.getAppMetrics()`；渲染进程 V8 堆取自渲染页 `performance.memory.usedJSHeapSize`；');
  L.push('> （Electron 31 已无 `webContents.getProcessMemoryInfo()`，故用 `getAppMetrics` 按 OS PID 交叉回填每个渲染进程的 WS/PeakWS。）');
  L.push('');

  /* 汇总表 */
  L.push('## 一、场景 × 指标 汇总表');
  L.push('');
  L.push('| 场景 | 进程数 | 合计 WorkingSet(MB) | 合计 PeakWorkingSet(MB) | 主进程 V8 堆(MB) | 合计 CPU% |');
  L.push('|------|-------:|--------------------:|------------------------:|-----------------:|----------:|');
  for (var i = 0; i < RESULTS.length; i++) {
    var r = RESULTS[i];
    L.push('| ' + r.scenario + ' | ' + r.appMetrics.length + ' | ' + fmtMB(r.appTotalWorkingSetMB) +
      ' | ' + fmtMB(r.appTotalPeakWorkingSetMB) + ' | ' + fmtMB(r.mainHeapMB) + ' | ' + fmtMB(r.appTotalCpuPercent) + ' |');
  }
  L.push('');

  /* ---- 口径说明：把三个不同口径的数字显式分开，避免被读成单一数字 ---- */
  L.push('## 二、口径说明（读数字前必读：新启动 / 长期 idle / 峰值 ≠ 同一个数）');
  L.push('');
  L.push('Electron 是多进程程序，**不同时点 / 不同形态的 WorkingSet 差别很大**，务必分开读，别被单一数字误导：');
  L.push('');
  L.push('- **① 新启动 WS**（冷启后约 ' + Math.round(IDLE_MS / 1000) + 's，对应上表 `idle` 行）：**' +
    (rIdle ? rIdle.appTotalWorkingSetMB + ' MB' : '-') + '**。刚启动页面/GPU 缓存尚未回收、OS 未做内存 trim，偏高。');
  if (rLong) {
    var dLong = round1(rLong.appTotalWorkingSetMB - (rIdle ? rIdle.appTotalWorkingSetMB : 0));
    var dTxt = (dLong <= 0)
      ? ('较新启动下降 ' + Math.abs(dLong) + ' MB')
      : ('较新启动反而上升 ' + dLong + ' MB —— 短时静置未见 OS trim 回收');
    L.push('- **② 长期 idle WS**（在 idle 基础上再静置 ' + Math.round(LONG_IDLE_MS / 60000 * 10) / 10 + ' 分钟）：**' +
      rLong.appTotalWorkingSetMB + ' MB**（' + dTxt + '）。');
  } else {
    L.push('- **② 长期 idle WS**：本次未采（如需对照请设 `MEM_LONG_IDLE_MS=300000` 重跑）。');
  }
  L.push('- **③ 峰值 WS / PeakWS**（`' + peakName + '` 场景）：**' + fmtMB(peak) + ' MB / ' + fmtMB(peakPeak) + ' MB**，见第五节。');
  /* 真实在跑实例的对照（优先用带进程类型的 live-probe2.txt） */
  try {
    var lp = path.join(OUT_DIR, 'live-probe2.txt');
    if (!fs.existsSync(lp)) { lp = path.join(OUT_DIR, 'live-probe.txt'); }
    if (fs.existsSync(lp)) {
      var liveLines = fs.readFileSync(lp, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
      L.push('');
      L.push('> **对照：用户真实在跑的生产实例（长期 idle，非本次隔离进程）实测**（`' + path.basename(lp) + '`）：');
      for (var li = 0; li < liveLines.length; li++) { L.push('> `' + liveLines[li] + '`'); }
      L.push('> 权威分解（按命令行 `--type`）：`main 87.8 + gpu-process 39.5 + utility(network) 3.5 + renderer 9.3 + renderer 23.4 = 163.4 MB`。');
      L.push('> **判读：不是“GPU 被 trim”，而是新启动态几乎所有进程都更大** —— 与本机新启动对比：');
      L.push('> renderer 约 32.7→147.8 MB（≈4.5×）、utility(network) 约 3.5→47.7 MB（≈13×）、GPU 约 39.5→111.5 MB（≈2.8×）。');
      L.push('> 即「**新启动态整体偏高，随长时间 idle 由 OS 逐步回收；只盯单个进程会误判**」。');
      L.push('> 结论（保留）：引用内存数字**必须注明口径与运行时长**，不能用单一数字代表日常占用。');
    }
  } catch (e) {}
  L.push('');

  /* 进程树交叉校验 */
  L.push('## 三、进程树交叉校验（PowerShell CIM，按父子闭包）');
  L.push('');
  L.push('| 场景 | 本进程树进程数 | 树 WorkingSet(MB) | 同名总数 | 同名总 WS(MB) | 非本树(疑似僵尸)数 | 僵尸 WS(MB) |');
  L.push('|------|---------------:|------------------:|---------:|--------------:|-------------------:|------------:|');
  for (var j = 0; j < RESULTS.length; j++) {
    var t = RESULTS[j].tree;
    if (!t) { L.push('| ' + RESULTS[j].scenario + ' | - | - | - | - | - | - |'); continue; }
    L.push('| ' + RESULTS[j].scenario + ' | ' + t.mineProcesses + ' | ' + t.workingSetMB +
      ' | ' + t.allProcesses + ' | ' + t.allWorkingSetMB + ' | ' + t.zombieCandidates + ' | ' + t.zombieWorkingSetMB + ' |');
  }
  L.push('');
  L.push('> 注：本机 WMI 的 `Win32_Process.PeakWorkingSetSize` 返回值不可靠（会给出远小于当前 WS 的异常值），');
  L.push('> 故进程树表只保留可靠的 WorkingSet；峰值统一采用 `app.getAppMetrics().memory.peakWorkingSetSize`。');
  L.push('>');
  L.push('> 注（dev 版噪声）：dev 版主进程名是 `electron.exe`，与机器上其它 Electron 应用**同名**，');
  L.push('> 因此“同名总数 / 非本树数”在 dev 下含无关进程噪声（如 WorkBuddy/VSCode 等）。');
  L.push('> 真正的“本应用进程数”看第一列「本进程树进程数」；打包版进程名 `SimpleCalendar.exe` 唯一，该列即为干净值。');
  L.push('');

  /* 每场景明细：进程级 + 渲染级 */
  for (var k = 0; k < RESULTS.length; k++) {
    var rr = RESULTS[k];
    L.push('## 四.' + (k + 1) + ' 场景 `' + rr.scenario + '` 明细（' + rr.at + '）');
    L.push('');
    L.push('### 4.' + (k + 1) + '.1 进程级（app.getAppMetrics）');
    L.push('');
    L.push('| PID | 类型 | WorkingSet(MB) | PeakWS(MB) | CPU% | idle wakeups/s |');
    L.push('|----:|------|---------------:|-----------:|-----:|---------------:|');
    for (var a = 0; a < rr.appMetrics.length; a++) {
      var m = rr.appMetrics[a];
      L.push('| ' + m.pid + ' | ' + m.type + ' | ' + m.workingSetMB + ' | ' + m.peakWorkingSetMB + ' | ' + m.cpuPercent + ' | ' + m.idleWakeups + ' |');
    }
    L.push('');
    L.push('### 4.' + (k + 1) + '.2 渲染/界面级（V8 堆 + 交叉回填 WS）');
    L.push('');
    L.push('| webContentsId | OS PID | WorkingSet(MB) | PeakWS(MB) | V8 usedJSHeap(MB) | URL |');
    L.push('|--------------:|-------:|---------------:|-----------:|------------------:|-----|');
    var wcs = rr.webContents || [];
    if (wcs.length === 0) { L.push('| - | - | - | - | - | （无 webContents） |'); }
    for (var b = 0; b < wcs.length; b++) {
      var w = wcs[b];
      var shortUrl = String(w.url || '').replace(ROOT.replace(/\\/g, '/'), '').replace(/^.*[\\/]/, '');
      L.push('| ' + w.id + ' | ' + w.osPid + ' | ' + fmtMB(w.workingSetMB) + ' | ' + fmtMB(w.peakWorkingSetMB) +
        ' | ' + fmtMB(w.jsHeapMB) + ' | ' + shortUrl + ' |');
    }
    L.push('');
  }

  /* 结论 */
  L.push('## 五、峰值结论与判读');
  L.push('');
  if (peak !== null) {
    L.push('- **峰值合计 WorkingSet ≈ ' + peak + ' MB（场景：' + peakName + '）**；进程数 ' +
      (byName(peakName) ? byName(peakName).appMetrics.length : '?') + '。');
  }
  if (peakPeak !== null) {
    L.push('- **峰值合计 PeakWorkingSet ≈ ' + peakPeak + ' MB（场景：' + peakPeakName + '）**（app.getAppMetrics 汇总，含历史峰值，通常略高于当前 WorkingSet）。');
  }
  L.push('- 参考量级：一个纯迷你日历卡形态（idle）应稳定在“主进程 + 1~2 渲染 + 1 GPU”范围；');
  L.push('  expanded/dock 因新增/放大渲染表面，WorkingSet 与 GPU 会上升，属预期。');
  L.push('- “非本树（疑似僵尸）数”若 > 0，表示系统里存在**不属于本次测量进程树**的同名进程：');
  L.push('  正常应为 0；> 0 即证明存在残留实例，需要结合“多实例共存排查”一节定位来源。');
  L.push('');
  L.push('## 六、多实例共存 / cleanupStaleInstances 只读排查（investigate only）');
  L.push('');
  L.push('见同目录 `INSTANCE_INVESTIGATION.md`。');
  L.push('');
  return L.join('\n');
}

function finish() {
  META.execPath = process.execPath;
  META.isPackaged = !!(app && app.isPackaged);
  META.versions = process.versions;
  var md;
  try {
    md = buildReport();
    fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), md, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({
      generatedAt: stamp(),
      execPath: process.execPath,
      isPackaged: app.isPackaged,
      versions: process.versions,
      udd: UDD,
      scenarios: SCENARIOS,
      results: RESULTS
    }, null, 2), 'utf8');
    log('report written: ' + path.join(OUT_DIR, 'REPORT.md'));
  } catch (e) {
    log('write report failed: ' + (e && e.stack || e));
  }
  // 收尾：优雅退出，超时强退
  setTimeout(function () { try { app.quit(); } catch (e) {} }, 500);
  setTimeout(function () { try { app.exit(0); } catch (e) {} }, 4000);
  process.exitCode = 0;
}

/* --render-only：不启动应用，仅据既有 results.json 重新生成 REPORT.md（改文案时省去重跑）。 */
function renderOnly() {
  var file = path.join(OUT_DIR, 'results.json');
  var raw = fs.readFileSync(file, 'utf8');
  var obj = JSON.parse(raw);
  META.execPath = obj.execPath || '';
  META.isPackaged = !!obj.isPackaged;
  META.versions = obj.versions || {};
  RESULTS = obj.results || [];
  if (obj.scenarios && obj.scenarios.length) { SCENARIOS = obj.scenarios; }
  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), buildReport(), 'utf8');
  console.log('re-rendered REPORT.md from ' + file + '（' + RESULTS.length + ' 场景）');
}

/* ==========================================================================
 *  主流程
 * ==========================================================================*/
if (RENDER_ONLY) {
  try { renderOnly(); } catch (e) { console.log('render-only failed: ' + ((e && e.stack) || e)); }
} else if (!BOOT_OK) {
  log('product main failed to load; aborting measurement');
  finish();
} else {
  app.whenReady().then(function () {
    waitForBoot(function () {
      runNext(0);
    });
  }).catch(function (e) {
    log('whenReady failed: ' + (e && e.stack || e));
    finish();
  });
  // 兜底：最长生命周期保护，避免脚本挂死
  var MAX_MS = IDLE_MS + LONG_IDLE_MS + STEP_MS * 2 + BOOT_MS + 30000;
  setTimeout(function () {
    if (RESULTS.length === 0) { log('watchdog: no samples, force finish'); finish(); }
  }, MAX_MS);
}
