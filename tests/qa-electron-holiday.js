'use strict';
/* QA 独立验证：electron-main.js 节假日链路（mock electron 真实执行主进程）
 * 覆盖：7 个 IPC 通道、真实 http 抓取、落盘、主窗推送、托盘菜单、失败/节流/免打扰。 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'electron-main.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name + (extra ? ' | ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 造 2026 / 2027 的 holiday-cn 格式数据（故意与内置硬编码不同，便于区分） ---------- */
function genHolidayCn(year) {
  const days = [];
  const segs = [
    ['元旦', year + '-01-01', year + '-01-03'],
    ['春节', year + '-02-01', year + '-02-07'],     // 内置写的是 2/15-2/23，故意不同
    ['清明节', year + '-04-04', year + '-04-06'],
    ['劳动节', year + '-05-01', year + '-05-05'],
    ['端午节', year + '-06-19', year + '-06-21'],
    ['中秋节', year + '-09-20', year + '-09-22'],   // 内置写的是 9/25-9/27，故意不同
    ['国庆节', year + '-10-01', year + '-10-10']    // 内置写的是 10/1-10/7，故意不同
  ];
  const workdays = [year + '-01-04', year + '-02-14'];
  segs.forEach(function (s) {
    // 纯字符串推进，避免 toISOString 的时区偏移把日期挪一天
    let cur = s[1];
    while (cur <= s[2]) {
      days.push({ name: s[0], date: cur, isOffDay: true });
      cur = new Date(new Date(cur + 'T12:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
    }
  });
  workdays.forEach(function (w) { days.push({ name: '调休', date: w, isOffDay: false }); });
  return JSON.stringify({ year: year, papers: ['QA 测试用'], days: days });
}

let port = 0;
const srv = http.createServer(function (req, res) {
  const m = /^\/(\d{4})\.json/.exec(req.url);
  if (req.url === '/404') { res.writeHead(404); res.end('nope'); return; }
  if (req.url === '/500') { res.writeHead(500); res.end('err'); return; }
  if (!m) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(genHolidayCn(Number(m[1])));
});

/* ---------- mock electron ---------- */
function makeMock(userData) {
  const st = {
    windows: [], winSends: [], dialogPushes: [], menuLabels: [], handled: {}, on: {},
    loadedFiles: [], trayCount: 0
  };
  function makeWin(opts) {
    const w = {
      __opts: opts || {},
      loadFile: function (f) { st.loadedFiles.push(String(f)); return Promise.resolve(); },
      loadURL: function () { return Promise.resolve(); },
      once: function (evt, cb) {
        if (evt === 'ready-to-show' || evt === 'did-finish-load') setTimeout(function () { try { cb(); } catch (e) {} }, 0);
      },
      on: function () {}, off: function () {}, removeAllListeners: function () {},
      show: function () { w.__shown = true; }, hide: function () {}, focus: function () {}, blur: function () {},
      close: function () { w.__closed = true; }, destroy: function () {},
      isDestroyed: function () { return !!w.__closed; },
      isVisible: function () { return true; }, isResizable: function () { return false; },
      isAlwaysOnTop: function () { return false; },
      setResizable: function () {}, setAspectRatio: function () {},
      setAlwaysOnTop: function () {}, setIgnoreMouseEvents: function () {},
      setMenu: function () {}, setSkipTaskbar: function () {},
      setPosition: function () {}, setSize: function () {}, setBounds: function () {}, setContentBounds: function () {},
      setFullScreen: function () {}, setMinimumSize: function () {}, setMaximumSize: function () {},
      setBackgroundColor: function () {}, setTitle: function () {},
      getBounds: function () { return { x: 0, y: 0, width: 340, height: 430 }; },
      getContentBounds: function () { return { x: 0, y: 0, width: 340, height: 430 }; },
      getSize: function () { return [340, 430]; },
      getNativeWindowHandle: function () { return Buffer.alloc(8); },
      getParentWindow: function () { return null; },
      setWindowButtonVisibility: function () {},
      webContents: {
        isDestroyed: function () { return !!w.__closed; },
        send: function (ch, payload) {
          if (ch === 'holiday-dialog') st.dialogPushes.push(payload);
          else if (ch === 'holiday-data-changed') st.winSends.push(payload);
        },
        on: function () {},
        once: function (evt, cb) {
          // 真实 Electron 会触发 did-finish-load，主进程靠它推送弹窗状态
          if (evt === 'did-finish-load') setTimeout(function () { try { cb(); } catch (e) {} }, 0);
        },
        executeJavaScript: function () { return Promise.resolve(); }
      }
    };
    st.windows.push(w);
    return w;
  }
  const electronMock = {
    app: {
      whenReady: function () { return Promise.resolve(); },
      on: function () {}, once: function () {}, quit: function () {}, exit: function () {}, relaunch: function () {},
      requestSingleInstanceLock: function () { return true; },
      getVersion: function () { return '2.1.0'; },
      getName: function () { return '简洁桌面日历'; },
      getPath: function () { return userData; },
      getAppPath: function () { return ROOT; },
      setAppUserModelId: function () {}, setLoginItemSettings: function () {},
      getLoginItemSettings: function () { return { openAtLogin: false }; },
      commandLine: { appendSwitch: function () {}, appendArgument: function () {}, hasSwitch: function () { return false; } },
      isPackaged: false, dock: null
    },
    BrowserWindow: function (o) { return makeWin(o); },
    Tray: function () { st.trayCount++; return { setToolTip: function () {}, setImage: function () {}, setContextMenu: function () {}, on: function () {}, destroy: function () {} }; },
    screen: {
      getPrimaryDisplay: function () { return { bounds: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, workAreaSize: { width: 1920, height: 1040 } }; },
      getDisplayMatching: function () { return { bounds: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, workAreaSize: { width: 1920, height: 1040 } }; },
      getAllDisplays: function () { return []; },
      getCursorScreenPoint: function () { return { x: 900, y: 500 }; },
      on: function () {}
    },
    nativeImage: {
      createFromBuffer: function () { return { isEmpty: function () { return false; }, resize: function () { return {}; } }; },
      createFromPath: function () { return { isEmpty: function () { return false; } }; },
      createEmpty: function () { return { isEmpty: function () { return true; } }; }
    },
    nativeTheme: { shouldUseDarkColors: false, on: function () {} },
    ipcMain: {
      on: function (ch, cb) { st.on[ch] = cb; },
      handle: function (ch, cb) { st.handled[ch] = cb; },
      removeHandler: function () {}
    },
    Menu: {
      buildFromTemplate: function (tpl) {
        tpl.forEach(function (it) {
          st.menuLabels.push(String(it.label || ''));
          if (Array.isArray(it.submenu)) {
            it.submenu.forEach(function (s) { st.menuLabels.push(String((s && s.label) || '')); });
          }
        });
        return { popup: function () {} };
      }
    },
    dialog: {
      showMessageBox: function () { return Promise.resolve({ response: 0 }); },
      showErrorBox: function () {},
      showOpenDialog: function () { return Promise.resolve({ canceled: !st.pickFile, filePaths: st.pickFile ? [st.pickFile] : [] }); }
    },
    shell: { openExternal: function () { return Promise.resolve(); }, showItemInFolder: function () {}, openPath: function () {} },
    clipboard: { writeText: function () {}, readText: function () { return ''; } },
    globalShortcut: { register: function () {}, unregister: function () {} },
    powerMonitor: { on: function () {} },
    session: { defaultSession: { setPermissionRequestHandler: function () {} } },
    process: { getSystemVersion: function () { return '10.0.19045'; } },
    net: { request: function () { return { on: function () {}, end: function () {} }; } }
  };
  electronMock.BrowserWindow.getAllWindows = function () { return []; };
  return { st: st, mock: electronMock };
}

const origLoad = Module._load;
function installMock(m) { Module._load = function (r) { if (r === 'electron') return m; return origLoad.apply(this, arguments); }; }

function freshUserData(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-main-' + tag + '-')); }

/** 重新执行一次 electron-main.js */
function runMain(userData, settings) {
  [MAIN, path.join(ROOT, 'holidays.js'), path.join(ROOT, 'holiday-store.js')].forEach(function (f) {
    delete require.cache[require.resolve(f)];
  });
  if (settings) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings), 'utf8');
  }
  const { st, mock } = makeMock(userData);
  installMock(mock);
  require(MAIN);
  return st;
}

(async function main() {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  process.env.SIMPLE_CAL_HOLIDAY_URLS = 'http://127.0.0.1:' + port + '/{year}.json';
  console.log('[env] SIMPLE_CAL_HOLIDAY_URLS=' + process.env.SIMPLE_CAL_HOLIDAY_URLS);

  /* ========== 1. IPC 通道注册 ========== */
  console.log('\n[1] IPC 通道注册');
  const ud1 = freshUserData('ipc');
  const st1 = runMain(ud1, { theme: 'light', dockOn: true, dockMode: 'dock' });
  const need = ['holiday-check-update', 'holiday-do-update', 'holiday-postpone', 'holiday-import-file', 'holiday-dialog-close'];
  need.forEach(function (ch) { ok('ipcMain.on 注册 ' + ch, typeof st1.on[ch] === 'function'); });
  ok('ipcMain.handle 注册 holiday-get-data', typeof st1.handled['holiday-get-data'] === 'function');

  /* ========== 2. holiday-get-data ========== */
  console.log('\n[2] holiday-get-data');
  const gd = await st1.handled['holiday-get-data']();
  ok('返回 data 非空', gd && gd.data && gd.data.years, JSON.stringify(gd && gd.meta));
  ok('meta.targetYear=2026（9 月，未到 11 月）', gd && gd.meta && gd.meta.targetYear === 2026, JSON.stringify(gd && gd.meta));
  ok('meta.need=true（内置数据）', gd && gd.meta && gd.meta.need === true);

  /* ========== 3. 成功更新链路 ========== */
  console.log('\n[3] holiday-do-update 成功链路（真实 http → 落盘 → 推主窗）');
  st1.on['holiday-check-update']();            // 真实流程：先由「检查节假日更新」开弹窗
  await sleep(300);
  ok('手动检查 → 弹窗 confirm', st1.dialogPushes.some(function (p) { return p && p.state === 'confirm'; }), JSON.stringify(st1.dialogPushes));
  st1.dialogPushes.length = 0;
  st1.on['holiday-do-update']({}, 2027);
  await sleep(1500);
  const states = st1.dialogPushes.map(function (p) { return p && p.state; });
  ok('弹窗状态机 = updating → success', JSON.stringify(states) === JSON.stringify(['updating', 'success']), JSON.stringify(st1.dialogPushes));
  const okPush = st1.dialogPushes.filter(function (p) { return p && p.state === 'success'; })[0];
  ok('success 带中文明细', okPush && /共 \d+ 天假期/.test(okPush.detail || ''), okPush && okPush.detail);
  ok('明细含春节 2/1–2/7（=新数据，非内置）', okPush && /春节 2\/1–2\/7/.test(okPush.detail || ''), okPush && okPush.detail);
  ok('主窗收到 holiday-data-changed', st1.winSends.length >= 1, JSON.stringify(st1.winSends.length));
  ok('推送体含 2027', st1.winSends[0] && st1.winSends[0].data && !!st1.winSends[0].data.years['2027']);

  const hf = path.join(ud1, 'holidays.json');
  ok('holidays.json 已落盘', fs.existsSync(hf));
  const disk = JSON.parse(fs.readFileSync(hf, 'utf8'));
  ok('盘上 2027 有 7 段', disk.years['2027'] && disk.years['2027'].holidays.length === 7, JSON.stringify((disk.years['2027'] || {}).holidays));
  ok('盘上 2026 内置数据仍在', !!disk.years['2026']);
  ok('source 已不是"内置"', disk.source && disk.source.indexOf('127.0.0.1') >= 0, disk.source);

  /* ========== 4. 托盘菜单读到新数据 ========== */
  console.log('\n[4] 托盘菜单「本年最近节日」用新数据');
  const ud2 = freshUserData('menu');
  const st2 = runMain(ud2, { theme: 'light', dockOn: true, dockMode: 'dock' });
  st2.on['holiday-do-update']({}, 2026);      // 更新 2026（今年），数据里 中秋=9/20-9/22、国庆=10/1-10/10
  await sleep(1200);
  st2.menuLabels.length = 0;
  // 触发一次菜单构建（主窗右键菜单）
  if (st2.on['main-show-menu']) st2.on['main-show-menu']({});
  await sleep(50);
  const labels = st2.menuLabels.join(' | ');
  ok('菜单出现「本年最近节日」', /本年最近节日/.test(labels), labels.slice(0, 300));
  // 注意：holidayRangeLabel 的格式是「MM/DD-DD」（末位不重复月份），与旧版一致
  ok('菜单用新数据：中秋 09/20-22（内置是 09/25-27）', /09\/20-22/.test(labels), labels.slice(0, 400));
  ok('菜单用新数据：国庆 10/01-10（内置是 10/01-07）', /10\/01-10(?![0-9])/.test(labels), labels.slice(0, 400));
  ok('菜单没再用内置的 10/01-07', !/10\/01-07/.test(labels));
  ok('菜单没再用内置的 09/25-09/27', !/09\/25-09\/27/.test(labels));

  /* ========== 5. 失败链路 ========== */
  console.log('\n[5] 全部源失败 → failed 态 + 中文原因 + 不崩 + 不推主窗');
  const ud3 = freshUserData('fail');
  process.env.SIMPLE_CAL_HOLIDAY_URLS = 'http://127.0.0.1:' + port + '/404';
  const st3 = runMain(ud3, { theme: 'light', dockOn: true, dockMode: 'dock' });
  st3.on['holiday-check-update']();            // 走真实流程：先开弹窗
  await sleep(300);
  const before3 = st3.winSends.length;
  let threw = null;
  try { st3.on['holiday-do-update']({}, 2027); } catch (e) { threw = e; }
  await sleep(1500);
  ok('do-update 不抛异常', threw === null, threw && threw.message);
  const fs3 = st3.dialogPushes.filter(function (p) { return p && p.state === 'failed'; })[0];
  ok('推了 failed 态', !!fs3, JSON.stringify(st3.dialogPushes));
  ok('failed 带中文原因', fs3 && /[一-龥]/.test(fs3.detail || ''), fs3 && fs3.detail);
  ok('失败时不推 holiday-data-changed', st3.winSends.length === before3);
  ok('失败时不写坏 holidays.json', !fs.existsSync(path.join(ud3, 'holidays.json')) || !!JSON.parse(fs.readFileSync(path.join(ud3, 'holidays.json'), 'utf8')).years['2026']);
  const set3 = JSON.parse(fs.readFileSync(path.join(ud3, 'settings.json'), 'utf8'));
  ok('失败后也写了 holidayLastCheck（7 天不重弹）', typeof set3.holidayLastCheck === 'string' && set3.holidayLastCheck.length > 10, JSON.stringify(set3.holidayLastCheck));
  process.env.SIMPLE_CAL_HOLIDAY_URLS = 'http://127.0.0.1:' + port + '/{year}.json';

  /* ========== 6. 从文件导入 ========== */
  console.log('\n[6] holiday-import-file');
  const ud4 = freshUserData('imp');
  const st4 = runMain(ud4, { theme: 'light', dockOn: true, dockMode: 'dock' });
  st4.on['holiday-check-update']();            // 真实流程：先开弹窗
  await sleep(300);
  ok('导入前弹窗已打开', st4.dialogPushes.length >= 1, JSON.stringify(st4.dialogPushes));
  st4.dialogPushes.length = 0;
  st4.pickFile = path.join(ROOT, 'fixtures', 'holiday-cn-2027.json');
  st4.on['holiday-import-file']();
  await sleep(600);
  const imp = st4.dialogPushes.filter(function (p) { return p && p.state === 'success'; })[0];
  ok('导入合法文件 → success', !!imp, JSON.stringify(st4.dialogPushes));
  ok('导入后写入 2027', fs.existsSync(path.join(ud4, 'holidays.json')) && !!JSON.parse(fs.readFileSync(path.join(ud4, 'holidays.json'), 'utf8')).years['2027']);

  st4.dialogPushes.length = 0;
  const badFile = path.join(ud4, 'bad.json');
  fs.writeFileSync(badFile, '{ not json', 'utf8');
  st4.pickFile = badFile;
  st4.on['holiday-import-file']();
  await sleep(400);
  const impBad = st4.dialogPushes.filter(function (p) { return p && p.state === 'failed'; })[0];
  ok('导入非法 JSON → failed + 中文原因', impBad && /JSON/.test(impBad.detail || ''), JSON.stringify(st4.dialogPushes));

  st4.dialogPushes.length = 0;
  st4.pickFile = null;                          // 模拟用户在「选择文件」对话框里点取消
  st4.on['holiday-import-file']();
  await sleep(400);
  ok('导入取消 → 无新状态推送（留在原态）', st4.dialogPushes.length === 0, JSON.stringify(st4.dialogPushes));

  /* ========== 7. 以后再说 ========== */
  console.log('\n[7] holiday-postpone（以后再说）');
  const ud5 = freshUserData('post');
  const st5 = runMain(ud5, { theme: 'light', dockOn: true, dockMode: 'dock' });
  st5.on['holiday-postpone']({}, 2026);
  await sleep(100);
  const set5 = JSON.parse(fs.readFileSync(path.join(ud5, 'settings.json'), 'utf8'));
  eq('settings.holidayDismissedYear=2026', set5.holidayDismissedYear, 2026);

  /* ========== 8. 自动提示的节流 / 免打扰 ========== */
  console.log('\n[8] 启动 5s 自动检查：节流与免打扰（每轮约 6 秒）');
  const isoAgo = function (ms) { return new Date(Date.now() - ms).toISOString(); };

  // 8a：全新用户（无 holidayLastCheck）→ 应弹 confirm
  {
    const ud = freshUserData('auto1');
    const st = runMain(ud, { theme: 'light', dockOn: true, dockMode: 'dock' });
    await sleep(6000);
    const c = st.dialogPushes.filter(function (p) { return p && p.state === 'confirm'; })[0];
    ok('8a 首次启动 → 弹 confirm（目标年 2026）', !!c && c.year === 2026, JSON.stringify(st.dialogPushes));
  }
  // 8b：1 小时前刚查过 → 7 天节流生效，不弹
  {
    const ud = freshUserData('auto2');
    const st = runMain(ud, { theme: 'light', dockOn: true, dockMode: 'dock', holidayLastCheck: isoAgo(3600e3), holidayDismissedYear: 0 });
    await sleep(6000);
    ok('8b 距上次检查 1 小时 → 不弹（7 天节流生效）', st.dialogPushes.length === 0, JSON.stringify(st.dialogPushes));
  }
  // 8c：8 天前查过，但用户当年点过「以后再说」→ 不弹
  {
    const ud = freshUserData('auto3');
    const st = runMain(ud, { theme: 'light', dockOn: true, dockMode: 'dock', holidayLastCheck: isoAgo(8 * 86400e3), holidayDismissedYear: 2026 });
    await sleep(6000);
    ok('8c 用户已「以后再说」当年 → 不弹', st.dialogPushes.length === 0, JSON.stringify(st.dialogPushes));
  }
  // 8d：8 天前查过且未推迟 → 会再弹一次（确认不是"永不提示"）
  {
    const ud = freshUserData('auto4');
    const st = runMain(ud, { theme: 'light', dockOn: true, dockMode: 'dock', holidayLastCheck: isoAgo(8 * 86400e3), holidayDismissedYear: 0 });
    await sleep(6000);
    ok('8d 超 7 天且未推迟 → 再弹一次（不会永远沉默）', st.dialogPushes.length >= 1, JSON.stringify(st.dialogPushes));
  }
  // 8e：数据已是最新（source 非内置）→ 不弹
  {
    const ud = freshUserData('auto5');
    const st = runMain(ud, { theme: 'light', dockOn: true, dockMode: 'dock' });
    st.on['holiday-do-update']({}, 2026);
    await sleep(1500);
    st.dialogPushes.length = 0;
    st.on['holiday-check-update']();          // 手动：数据已新
    await sleep(500);
    // P2-2：已是最新时不能零反馈（用户会以为菜单失灵），改为弹 uptodate 态
    const up = st.dialogPushes.filter(function (p) { return p && p.state === 'uptodate'; })[0];
    ok('8e 数据已是最新 → 弹 uptodate 态（不再是零反馈）', !!up, JSON.stringify(st.dialogPushes));
    ok('8e uptodate 带年份', up && up.year === 2026, JSON.stringify(up));
    ok('8e uptodate 副行显示数据来源', up && /已联网获取/.test(up.detail || ''), up && up.detail);
  }

  /* ========== 8f. 跨月节日的托盘文案不得丢后半段（P2-3） ========== */
  console.log('\n[8f] 跨月节日区间文案（元旦 12/30–1/5）');
  {
    const ud = freshUserData('cross');
    // 造一份「2026 元旦跨月 2026-12-30 ~ 2027-01-05」的 holiday-cn 数据，经 file:// 源更新
    const crossFile = path.join(ud, 'cross-2026.json');
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(crossFile, JSON.stringify({
      year: 2026,
      days: ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05']
        .map(function (d) { return { name: '元旦', date: d, isOffDay: true }; })
    }), 'utf8');
    process.env.SIMPLE_CAL_HOLIDAY_URLS = 'file:///' + crossFile.replace(/\\/g, '/');
    const st = runMain(ud, { theme: 'light', dockOn: true, dockMode: 'dock' });
    st.on['holiday-do-update']({}, 2026);
    await sleep(1500);
    st.menuLabels.length = 0;
    if (st.on['main-show-menu']) st.on['main-show-menu']({});
    await sleep(50);
    const labels = st.menuLabels.join(' | ');
    ok('跨月段输出 M1/D1-M2/D2（不丢 1 月那半截）', /12\/30-1\/05/.test(labels), labels.slice(0, 400));
    ok('不再出现被裁到月末的 12/30-31', !/12\/30-31/.test(labels), labels.slice(0, 400));
    process.env.SIMPLE_CAL_HOLIDAY_URLS = 'http://127.0.0.1:' + port + '/{year}.json';
  }

  /* ========== 8g. 连续失败 → 节流窗口拉长（P2-4） ========== */
  console.log('\n[8g] holidayFailCount：失败累计 → 节流窗口 7 天 → 28 天');
  {
    const ud = freshUserData('failcnt');
    process.env.SIMPLE_CAL_HOLIDAY_URLS = 'http://127.0.0.1:' + port + '/404';
    const st = runMain(ud, { theme: 'light', dockOn: true, dockMode: 'dock' });
    st.on['holiday-check-update']();
    await sleep(300);
    st.on['holiday-do-update']({}, 2026);
    await sleep(1500);
    let set = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
    eq('首次失败 → holidayFailCount=1', set.holidayFailCount, 1);
    st.on['holiday-do-update']({}, 2026);
    await sleep(1500);
    set = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
    eq('第 2 次失败 → holidayFailCount=2（节流拉长到 28 天）', set.holidayFailCount, 2);
    // 恢复好源后成功一次 → 清零
    process.env.SIMPLE_CAL_HOLIDAY_URLS = 'http://127.0.0.1:' + port + '/{year}.json';
    st.on['holiday-do-update']({}, 2026);
    await sleep(1500);
    set = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
    eq('成功后 → holidayFailCount=0', set.holidayFailCount, 0);
  }

  srv.close();
  console.log('\n================ electron-main 节假日汇总 ================');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (fails.length) { console.log('失败用例：'); fails.forEach(function (f) { console.log('  - ' + f); }); }
  process.exitCode = fail ? 1 : 0;
  setTimeout(function () { process.exit(process.exitCode || 0); }, 300);
})().catch(function (e) { console.error('测试自身崩溃:', e); process.exit(1); });
