'use strict';
/* QA 二轮复核：独立验证 P2-1~P2-4 修复真的生效，并反证被改过的断言没被"改软"。
 * 不复用工程师的自测文件，自己另起一套 mock / 断言。 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'electron-main.js');
const STORE = path.join(ROOT, 'holiday-store.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name + (extra ? ' | ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ A. 反证：被改过的 rangeOf 断言在「旧实现」下必须红 ============ */
console.log('\n[A] 反证：新版断言仍能抓到旧 bug（旧实现 = 跨月裁到起始月月末 + 无 em 字段）');
{
  const st = (function () { delete require.cache[require.resolve(STORE)]; return require(STORE); })();
  st.configure({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r2-old-')) });
  st.setData({
    years: {
      2026: { holidays: [{ name: '元旦', s: '2026-01-01', e: '2026-01-03' }, { name: '跨年', s: '2026-12-30', e: '2027-01-01' }], workdays: [] },
      2025: { holidays: [{ name: '春节', s: '2025-01-28', e: '2025-02-04' }], workdays: [] }
    }
  });
  // 旧实现（v2.1.0 修复前）：跨月 → e 硬裁到起始月月末，且不返回 em
  function oldRangeOf(name, year) {
    const segs = st.segmentsOf(year);
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].name !== name) continue;
      const a = st.parseYmd(segs[i].s), b = st.parseYmd(segs[i].e) || st.parseYmd(segs[i].s);
      if (!a || !b) continue;
      if (a.m !== b.m) return { y: a.y, m: a.m, s: a.d, e: new Date(a.y, a.m, 0).getDate() };
      return { y: a.y, m: a.m, s: a.d, e: b.d };
    }
    return null;
  }
  const WANT_SAME = { y: 2026, m: 1, s: 1, em: 1, e: 3 };
  const WANT_CROSS = { y: 2026, m: 12, s: 30, em: 1, e: 1 };
  const WANT_CNY = { y: 2025, m: 1, s: 28, em: 2, e: 4 };
  const oldSame = oldRangeOf('元旦', 2026);
  const oldCross = oldRangeOf('跨年', 2026);
  const oldCny = oldRangeOf('春节', 2025);
  ok('旧实现下「普通段 em===m」断言会红', JSON.stringify(oldSame) !== JSON.stringify(WANT_SAME), JSON.stringify(oldSame));
  ok('旧实现下「跨月段带回 em」断言会红', JSON.stringify(oldCross) !== JSON.stringify(WANT_CROSS), JSON.stringify(oldCross));
  ok('旧实现下「e !== 31」断言会红（旧值正是 e=31）', oldCross.e === 31, JSON.stringify(oldCross));
  ok('旧实现下「2025 春节完整区间」断言会红', JSON.stringify(oldCny) !== JSON.stringify(WANT_CNY), JSON.stringify(oldCny));
  // 新实现必须绿
  const st2 = (function () { delete require.cache[require.resolve(STORE)]; return require(STORE); })();
  st2.configure({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r2-new-')) });
  st2.setData({
    years: {
      2026: { holidays: [{ name: '元旦', s: '2026-01-01', e: '2026-01-03' }, { name: '跨年', s: '2026-12-30', e: '2027-01-01' }], workdays: [] },
      2025: { holidays: [{ name: '春节', s: '2025-01-28', e: '2025-02-04' }], workdays: [] }
    }
  });
  eq('新实现：普通段', st2.rangeOf('元旦', 2026), WANT_SAME);
  eq('新实现：跨年段', st2.rangeOf('跨年', 2026), WANT_CROSS);
  eq('新实现：2025 春节', st2.rangeOf('春节', 2025), WANT_CNY);
}

/* ============ 本地 http：/{year}.json 生成 holiday-cn 格式 ============ */
function genCn(year, segs) {
  const days = [];
  segs.forEach(function (s) {
    let cur = s[1];
    while (cur <= s[2]) {
      days.push({ name: s[0], date: cur, isOffDay: true });
      cur = new Date(new Date(cur + 'T12:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
    }
  });
  days.push({ name: '调休', date: year + '-01-04', isOffDay: false });
  return JSON.stringify({ year: year, days: days });
}
const srv = http.createServer(function (req, res) {
  const m = /^\/(\d{4})\.json/.exec(req.url);
  if (req.url === '/404') { res.writeHead(404); res.end('nope'); return; }
  if (!m) { res.writeHead(404); res.end('nope'); return; }
  const y = Number(m[1]);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(genCn(y, [
    ['元旦', y + '-01-01', y + '-01-03'],
    ['春节', y + '-02-05', y + '-02-11'],
    ['清明节', y + '-04-04', y + '-04-06'],
    ['劳动节', y + '-05-01', y + '-05-05'],
    ['国庆节', y + '-10-01', y + '-10-07'],
    ['单日节', y + '-11-11', y + '-11-11']
  ]));
});

/* ============ mock electron（独立实现，不复用工程师的） ============ */
function makeMock(userData) {
  const st = { pushes: [], winSends: [], labels: [], on: {}, handled: {}, windows: [] };
  function win() {
    const w = {
      loadFile: () => Promise.resolve(),
      once: (e, cb) => { if (e === 'did-finish-load' || e === 'ready-to-show') setTimeout(() => { try { cb(); } catch (_) {} }, 0); },
      on: () => {}, off: () => {}, removeAllListeners: () => {},
      show: () => {}, hide: () => {}, focus: () => {}, close: () => { w.__closed = true; }, destroy: () => {},
      isDestroyed: () => !!w.__closed, isVisible: () => true,
      setAlwaysOnTop: () => {}, setIgnoreMouseEvents: () => {}, setMenu: () => {}, setSkipTaskbar: () => {},
      setBounds: () => {}, getBounds: () => ({ x: 0, y: 0, width: 340, height: 430 }), getSize: () => [340, 430],
      getNativeWindowHandle: () => Buffer.alloc(8), getParentWindow: () => null,
      webContents: {
        isDestroyed: () => !!w.__closed,
        send: (ch, p) => { if (ch === 'holiday-dialog') st.pushes.push(p); else if (ch === 'holiday-data-changed') st.winSends.push(p); },
        on: () => {}, once: (e, cb) => { if (e === 'did-finish-load') setTimeout(() => { try { cb(); } catch (_) {} }, 0); },
        executeJavaScript: () => Promise.resolve()
      }
    };
    st.windows.push(w);
    return w;
  }
  const m = {
    app: {
      whenReady: () => Promise.resolve(), on: () => {}, once: () => {}, quit: () => {},
      requestSingleInstanceLock: () => true, getVersion: () => '2.1.0', getName: () => 'qa',
      getPath: () => userData, getAppPath: () => ROOT, setAppUserModelId: () => {}, setLoginItemSettings: () => {},
      getLoginItemSettings: () => ({ openAtLogin: false }),
      commandLine: { appendSwitch: () => {}, appendArgument: () => {}, hasSwitch: () => false },
      isPackaged: false, dock: null
    },
    BrowserWindow: win,
    Tray: () => ({ setToolTip: () => {}, setImage: () => {}, setContextMenu: () => {}, on: () => {}, destroy: () => {} }),
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      getDisplayMatching: () => ({ workAreaSize: { width: 1920, height: 1040 } }),
      getAllDisplays: () => [], getCursorScreenPoint: () => ({ x: 0, y: 0 }), on: () => {}
    },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, resize: () => ({}) }), createFromPath: () => ({ isEmpty: () => false }), createEmpty: () => ({ isEmpty: () => true }) },
    nativeTheme: { shouldUseDarkColors: false, on: () => {} },
    ipcMain: { on: (c, cb) => { st.on[c] = cb; }, handle: (c, cb) => { st.handled[c] = cb; }, removeHandler: () => {} },
    Menu: {
      buildFromTemplate: (tpl) => {
        tpl.forEach((it) => {
          st.labels.push(String((it && it.label) || ''));
          if (Array.isArray(it.submenu)) it.submenu.forEach((s) => st.labels.push(String((s && s.label) || '')));
        });
        return { popup: () => {} };
      }
    },
    dialog: { showMessageBox: () => Promise.resolve({ response: 0 }), showErrorBox: () => {}, showOpenDialog: () => Promise.resolve({ canceled: !st.pick, filePaths: st.pick ? [st.pick] : [] }) },
    shell: { openExternal: () => Promise.resolve(), showItemInFolder: () => {}, openPath: () => {} },
    clipboard: { writeText: () => {}, readText: () => '' },
    globalShortcut: { register: () => {}, unregister: () => {} },
    powerMonitor: { on: () => {} },
    session: { defaultSession: { setPermissionRequestHandler: () => {} } },
    process: { getSystemVersion: () => '10.0.19045' },
    net: { request: () => ({ on: () => {}, end: () => {} }) }
  };
  m.BrowserWindow.getAllWindows = () => [];
  return { st, mock: m };
}
const origLoad = Module._load;
function runMain(userData, settings) {
  [MAIN, path.join(ROOT, 'holidays.js'), STORE].forEach((f) => { delete require.cache[require.resolve(f)]; });
  if (settings) { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings), 'utf8'); }
  const { st, mock } = makeMock(userData);
  Module._load = function (r) { if (r === 'electron') return mock; return origLoad.apply(this, arguments); };
  require(MAIN);
  return st;
}
const ud = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'r2-' + t + '-'));
const settingsOf = (ud2) => JSON.parse(fs.readFileSync(path.join(ud2, 'settings.json'), 'utf8'));
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

(async function main() {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const GOOD = 'http://127.0.0.1:' + port + '/{year}.json';
  const BAD = 'http://127.0.0.1:' + port + '/404';
  process.env.SIMPLE_CAL_HOLIDAY_URLS = GOOD;

  /* ============ B. P2-1：弹窗高度 300 + line-clamp + :empty 仍生效 ============ */
  console.log('\n[B] P2-1 弹窗高度与明细裁剪');
  {
    const main = fs.readFileSync(MAIN, 'utf8');
    ok('electron-main.js 弹窗高度已改为 300', /const W = 400,\s*H = 300;/.test(main), (main.match(/const W = 400[^\n]*/) || [''])[0]);
    ok('不再残留 H = 252', !/H = 252/.test(main));
    const html = fs.readFileSync(path.join(ROOT, 'holidayupd.html'), 'utf8');
    const iClamp = html.indexOf('-webkit-line-clamp');
    const iEmpty = html.indexOf('#detail:empty');
    ok('#detail 有 -webkit-line-clamp', iClamp > 0);
    ok('#detail:empty{display:none} 仍在（空明细不留空行）', iEmpty > 0 && /#detail:empty\s*\{\s*display:\s*none;/.test(html));
    ok(':empty 规则写在 line-clamp 之后且选择器更具体（不会被 line-clamp 覆盖）', iEmpty > iClamp, 'clamp@' + iClamp + ' empty@' + iEmpty);
    // 高度算式：H=300 → head 52 + actions≈64 → body 184，减 padding 32 → 152；
    // badge34+gap8+msg22+gap8=72 → detail 可用 80px ≥ line-clamp 3 行≈53px
    ok('H=300 时 detail 可用高度(≈80px) > 3 行(≈53px)', 300 - 52 - 64 - 32 - 72 >= 53, String(300 - 52 - 64 - 32 - 72));
  }

  /* ============ C. P2-3：跨月 / 同月 / 单日 三种区间文案 ============ */
  console.log('\n[C] P2-3 托盘菜单区间文案（真实主进程 + 真实菜单构建）');
  {
    const dir = ud('cross');
    const crossFile = path.join(dir, 'cross-2026.json');
    fs.writeFileSync(crossFile, JSON.stringify({
      year: 2026,
      days: ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05']
        .map((d) => ({ name: '元旦', date: d, isOffDay: true }))
        .concat([{ name: '国庆', date: '2026-10-01', isOffDay: true }, { name: '国庆', date: '2026-10-02', isOffDay: true },
                 { name: '国庆', date: '2026-10-03', isOffDay: true }, { name: '单日节', date: '2026-11-11', isOffDay: true },
                 { name: '清明', date: '2026-04-04', isOffDay: true }, { name: '清明', date: '2026-04-05', isOffDay: true },
                 { name: '清明', date: '2026-04-06', isOffDay: true }])
    }), 'utf8');
    process.env.SIMPLE_CAL_HOLIDAY_URLS = 'file:///' + crossFile.replace(/\\/g, '/');
    const st = runMain(dir, { theme: 'light', dockOn: true, dockMode: 'dock' });
    st.on['holiday-check-update']();
    await sleep(300);
    st.on['holiday-do-update']({}, 2026);
    await sleep(1200);
    const suc = st.pushes.filter((p) => p && p.state === 'success')[0];
    ok('跨月数据更新成功（确认真的走了跨月段）', !!suc, JSON.stringify(st.pushes));
    st.labels.length = 0;
    st.on['main-show-menu']({});
    await sleep(60);
    const labels = st.labels.join(' | ');
    ok('跨月段输出「12/30-1/05」（两端都带月份）', /12\/30-1\/05/.test(labels), labels.slice(0, 400));
    ok('不再出现被裁到月末的「12/30-31」', !/12\/30-31/.test(labels), labels.slice(0, 400));
    ok('同月多日段仍是旧格式「10/01-03」', /10\/01-03/.test(labels), labels.slice(0, 400));
    ok('单日段仍是旧格式「11/11」（s===e 不带尾段）', /11\/11/.test(labels) && !/11\/11-11\/11/.test(labels), labels.slice(0, 400));
    // 2025 春节那类跨月（1/28-2/4）也要对
    const st2 = (function () { delete require.cache[require.resolve(STORE)]; return require(STORE); })();
    st2.configure({ userDataDir: ud('cny') });
    st2.setData({ years: { 2025: { holidays: [{ name: '春节', s: '2025-01-28', e: '2025-02-04' }], workdays: [] } } });
    const r = st2.rangeOf('春节', 2025);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const label = (r.em !== r.m) ? (r.m + '/' + pad(r.s) + '-' + r.em + '/' + pad(r.e)) : (pad(r.m) + '/' + pad(r.s) + '-' + pad(r.e));
    eq('2025 春节文案 = 1/28-2/04（旧实现会输出 01/28-31）', label, '1/28-2/04');
  }

  /* ============ D. P2-2：uptodate 态 ============ */
  console.log('\n[D] P2-2 手动检查且已是最新 → uptodate 态（含三要素 + 数据来源）');
  {
    process.env.SIMPLE_CAL_HOLIDAY_URLS = GOOD;
    const dir = ud('up');
    const st = runMain(dir, { theme: 'light', dockOn: true, dockMode: 'dock' });
    st.on['holiday-do-update']({}, 2026);
    await sleep(1500);
    st.pushes.length = 0;
    st.on['holiday-check-update']();      // 手动，此时 need=false
    await sleep(400);
    const up = st.pushes.filter((p) => p && p.state === 'uptodate')[0];
    ok('推了 uptodate 态', !!up, JSON.stringify(st.pushes));
    ok('三要素 state 正确', up && up.state === 'uptodate');
    ok('三要素 year=2026', up && up.year === 2026, JSON.stringify(up));
    ok('三要素 detail 非空', up && typeof up.detail === 'string' && up.detail.length > 0, up && up.detail);
    ok('detail 含「已联网获取」', up && /已联网获取/.test(up.detail), up && up.detail);
    ok('detail 含来源域名', up && /来源\s*127\.0\.0\.1/.test(up.detail), up && up.detail);
    ok('uptodate 没有多余状态（不是 confirm/failed）', st.pushes.filter((p) => p && (p.state === 'confirm' || p.state === 'failed')).length === 0, JSON.stringify(st.pushes));
  }
  /* 本地文件导入来源下的文案（副行是否说错成"已联网获取"） */
  {
    process.env.SIMPLE_CAL_HOLIDAY_URLS = BAD;
    const dir = ud('upimp');
    const st = runMain(dir, { theme: 'light', dockOn: true, dockMode: 'dock' });
    st.on['holiday-check-update']();
    await sleep(300);
    st.pick = path.join(ROOT, 'fixtures', 'holiday-cn-2027.json');
    st.on['holiday-import-file']();
    await sleep(800);
    st.pushes.length = 0;
    st.on['holiday-check-update']();
    await sleep(400);
    const up = st.pushes.filter((p) => p && p.state === 'uptodate')[0];
    console.log('       （本地导入来源下的 uptodate 副行：' + (up ? up.detail : '未弹 uptodate') + '）');
    // 记录事实，不作为硬失败；供 team-lead 判断要不要改文案
    ok('本地导入后 uptodate 副行不含"已联网获取"这种错误措辞', !(up && /已联网获取/.test(up.detail)), up && up.detail);
    process.env.SIMPLE_CAL_HOLIDAY_URLS = GOOD;
  }

  /* ============ E. P2-4：失败计数 ============ */
  console.log('\n[E] P2-4 holidayFailCount');
  {
    process.env.SIMPLE_CAL_HOLIDAY_URLS = BAD;
    const dir = ud('fc-close');
    const st = runMain(dir, { theme: 'light', dockOn: true, dockMode: 'dock' });
    st.on['holiday-check-update']();
    await sleep(300);
    st.on['holiday-do-update']({}, 2026);
    await sleep(1200);
    eq('失败 1 次 → count=1', settingsOf(dir).holidayFailCount, 1);
    st.on['holiday-dialog-close']();        // 失败后关窗：close + closed 双路径不得双记
    await sleep(300);
    eq('关窗后仍为 1（close/closed 不双记）', settingsOf(dir).holidayFailCount, 1);
  }
  {
    process.env.SIMPLE_CAL_HOLIDAY_URLS = BAD;
    const dir = ud('fc-retry');
    const st = runMain(dir, { theme: 'light', dockOn: true, dockMode: 'dock' });
    st.on['holiday-check-update']();
    await sleep(300);
    st.on['holiday-do-update']({}, 2026);
    await sleep(1200);
    eq('首次失败 → 1', settingsOf(dir).holidayFailCount, 1);
    st.on['holiday-do-update']({}, 2026);   // 重试
    await sleep(1200);
    eq('重试再失败 → 2（不是"同会话只记一次"）', settingsOf(dir).holidayFailCount, 2);
    process.env.SIMPLE_CAL_HOLIDAY_URLS = GOOD;
    st.on['holiday-do-update']({}, 2026);
    await sleep(1500);
    eq('成功 → 清零 0', settingsOf(dir).holidayFailCount, 0);
  }
  /* P3-2：「以后再说」是用户主动推迟，不是更新失败 → 不得计入 holidayFailCount */
  {
    process.env.SIMPLE_CAL_HOLIDAY_URLS = BAD;
    const dir = ud('fc-postpone');
    const st = runMain(dir, { theme: 'light', dockOn: true, dockMode: 'dock' });
    st.on['holiday-check-update']();          // 开弹窗（confirm 态，此时还未尝试更新）
    await sleep(300);
    st.on['holiday-postpone']({}, 2026);      // 点「以后再说」
    await sleep(300);
    eq('以后再说 → count 保持 0（推迟不算失败）', settingsOf(dir).holidayFailCount, 0);
    eq('以后再说 → 仍写 holidayDismissedYear', settingsOf(dir).holidayDismissedYear, 2026);
    // 对照组：真失败后点「以后再说」不应被清零、也不应被双记
    st.on['holiday-check-update']();
    await sleep(300);
    st.on['holiday-do-update']({}, 2026);     // 真失败 → count=1
    await sleep(1200);
    eq('真失败 → count=1', settingsOf(dir).holidayFailCount, 1);
    st.on['holiday-postpone']({}, 2026);
    await sleep(300);
    eq('真失败后再点以后再说 → 仍为 1（不双记）', settingsOf(dir).holidayFailCount, 1);
    process.env.SIMPLE_CAL_HOLIDAY_URLS = GOOD;
  }

  /* ============ F. P2-4：28 天节流窗口真的生效 ============ */
  console.log('\n[F] P2-4 连续失败后自动提示窗口 7 天 → 28 天（各约 6 秒）');
  {
    process.env.SIMPLE_CAL_HOLIDAY_URLS = BAD;
    // F1：count=2 + 上次检查 10 天前（>7 天但 <28 天）→ 必须不弹
    const d1 = ud('t28');
    const s1 = runMain(d1, { theme: 'light', dockOn: true, dockMode: 'dock', holidayLastCheck: isoAgo(10 * 86400e3), holidayDismissedYear: 0, holidayFailCount: 2 });
    await sleep(6000);
    ok('count=2 且上次检查 10 天前 → 不弹（28 天窗口生效）', s1.pushes.length === 0, JSON.stringify(s1.pushes));
    // F2：对照组 count=0 + 10 天前 → 应该弹
    const d2 = ud('t7');
    const s2 = runMain(d2, { theme: 'light', dockOn: true, dockMode: 'dock', holidayLastCheck: isoAgo(10 * 86400e3), holidayDismissedYear: 0, holidayFailCount: 0 });
    await sleep(6000);
    ok('对照：count=0 且 10 天前 → 弹（7 天窗口）', s2.pushes.length >= 1, JSON.stringify(s2.pushes));
    process.env.SIMPLE_CAL_HOLIDAY_URLS = GOOD;
  }

  srv.close();
  console.log('\n================ 二轮复核汇总 ================');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (fails.length) { console.log('失败用例：'); fails.forEach((f) => console.log('  - ' + f)); }
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})().catch((e) => { console.error('复核脚本自身崩溃:', e); process.exit(1); });
