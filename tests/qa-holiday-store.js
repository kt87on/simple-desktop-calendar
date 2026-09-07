'use strict';
/* QA 独立验证：holiday-store.js（真实 http 服务 + 真实 fetch + 真实落盘） */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_PATH = path.join(ROOT, 'holiday-store.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name + (extra ? ' | ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

function freshStore() {
  delete require.cache[require.resolve(STORE_PATH)];
  return require(STORE_PATH);
}
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-hol-' + tag + '-'));
  return d;
}

/* ---------------- 本地 http 服务 ---------------- */
// routes: { '/x': {status, body|file, delay, hang} }
function serve(routes) {
  const srv = http.createServer(function (req, res) {
    const r = routes[req.url];
    if (!r) { res.writeHead(404); res.end('not found'); return; }
    if (r.hang) return;                       // 不响应，触发超时
    const send = function () {
      res.writeHead(r.status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(r.body !== undefined ? r.body : fs.readFileSync(r.file, 'utf8'));
    };
    if (r.delay) setTimeout(send, r.delay); else send();
  });
  return new Promise(function (resolve) {
    srv.listen(0, '127.0.0.1', function () { resolve(srv); });
  });
}

const CN27 = path.join(ROOT, 'fixtures', 'holiday-cn-2027.json');
const TIMOR27 = path.join(ROOT, 'fixtures', 'timor-2027.json');

(async function main() {
  const srv = await serve({
    '/cn2027': { file: CN27 },
    '/timor2027': { file: TIMOR27 },
    '/404': { status: 404, body: '<html>404</html>' },
    '/500': { status: 500, body: 'oops' },
    '/badjson': { status: 200, body: '<html><body>not json' },
    '/wrongyear': { status: 200, body: JSON.stringify({ year: 2026, days: [{ name: '元旦', date: '2026-01-01', isOffDay: true }] }) },
    '/thin': { status: 200, body: JSON.stringify({ year: 2027, days: [{ name: '元旦', date: '2027-01-01', isOffDay: true }] }) },
    '/hang': { hang: true }
  });
  const base = 'http://127.0.0.1:' + srv.address().port;

  const setEnv = function (urls) {
    if (urls === null) delete process.env.SIMPLE_CAL_HOLIDAY_URLS;
    else process.env.SIMPLE_CAL_HOLIDAY_URLS = urls;
  };

  /* ========== 1. normalize ========== */
  console.log('\n[1] normalize() 两种格式');
  {
    const st = freshStore();
    const cn = st.normalize(JSON.parse(fs.readFileSync(CN27, 'utf8')), 2027);
    ok('holiday-cn 2027 归一化成功', !!cn);
    ok('holiday-cn: 段数 >= 3', cn && cn.holidays.length >= 3, cn && JSON.stringify(cn.holidays.slice(0, 3)));
    eq('holiday-cn: 首段=元旦 2027-01-01~01-03', cn && cn.holidays[0], { name: '元旦', s: '2027-01-01', e: '2027-01-03' });
    ok('holiday-cn: 有补班日', cn && cn.workdays.length > 0, cn && JSON.stringify(cn.workdays));
    ok('holiday-cn: 补班日含 2027-01-04', cn && cn.workdays.indexOf('2027-01-04') >= 0, cn && JSON.stringify(cn.workdays));

    const tm = st.normalize(JSON.parse(fs.readFileSync(TIMOR27, 'utf8')), 2027);
    ok('timor 2027 归一化成功', !!tm);
    eq('timor: 首段=元旦 2027-01-01~01-03', tm && tm.holidays[0], { name: '元旦', s: '2027-01-01', e: '2027-01-03' });
    ok('timor: 有补班日', tm && tm.workdays.length > 0);

    ok('年份不符 → null', st.normalize({ year: 2026, days: [{ name: '元旦', date: '2026-01-01', isOffDay: true }] }, 2027) === null);
    ok('timor code!=0 → null', st.normalize({ code: 1, holiday: { '2027-01-01': { holiday: true, name: '元旦' } } }, 2027) === null);
    ok('数据过少 → null', st.normalize({ year: 2027, days: [{ name: '元旦', date: '2027-01-01', isOffDay: true }] }, 2027) === null);
    ok('null / 字符串 → null', st.normalize(null, 2027) === null && st.normalize('{}', 2027) === null);
    ok('空对象 → null', st.normalize({}, 2027) === null);
  }

  /* ========== 2. fetchYear 成功（真实 fetch）========== */
  console.log('\n[2] fetchYear() 真实 HTTP 成功路径');
  {
    const st = freshStore();
    setEnv(base + '/cn2027');
    const r = await st.fetchYear(2027);
    ok('fetchYear ok=true', r && r.ok === true, JSON.stringify(r && r.reason));
    ok('source 回传 URL', r && /127\.0\.0\.1/.test(r.source || ''), r && r.source);
    eq('首段正确', r && r.data.holidays[0], { name: '元旦', s: '2027-01-01', e: '2027-01-03' });
  }

  /* ========== 3. 多源兜底 ========== */
  console.log('\n[3] 多源兜底：404 → 500 → 好源');
  {
    const st = freshStore();
    setEnv(base + '/404,' + base + '/500,' + base + '/cn2027');
    const r = await st.fetchYear(2027);
    ok('最终成功', r && r.ok === true, JSON.stringify(r));
    ok('用的是第三个源', r && /cn2027/.test(r.source || ''), r && r.source);
  }
  console.log('\n[3b] 非法 JSON → 年份不符 → 好源');
  {
    const st = freshStore();
    setEnv(base + '/badjson,' + base + '/wrongyear,' + base + '/cn2027');
    const r = await st.fetchYear(2027);
    ok('跳过坏源后成功', r && r.ok === true, JSON.stringify(r && r.reason));
  }

  /* ========== 4. 全失败 ========== */
  console.log('\n[4] 全部源失败 → 中文原因且不抛异常');
  const failCases = [
    ['404 × 3', [base + '/404', base + '/404', base + '/404']],
    ['500 × 2', [base + '/500', base + '/500']],
    ['非法 JSON', [base + '/badjson']],
    ['数据过少', [base + '/thin']],
    ['年份不符', [base + '/wrongyear']]
  ];
  for (const [label, urls] of failCases) {
    const st = freshStore();
    setEnv(urls.join(','));
    let r = null, threw = null;
    try { r = await st.fetchYear(2027); } catch (e) { threw = e; }
    ok(label + '：不抛异常', threw === null, threw && threw.message);
    ok(label + '：ok=false', r && r.ok === false);
    ok(label + '：有中文原因', r && typeof r.reason === 'string' && /[一-龥]/.test(r.reason), r && r.reason);
  }

  /* ========== 4b. 无 fetch 环境 ========== */
  console.log('\n[4b] 缺少 fetch 时的兜底');
  {
    const st = freshStore();
    st.configure({ fetchImpl: null });
    const origFetch = global.fetch;
    global.fetch = undefined;
    setEnv('https://example.invalid/2027.json');
    let r = null, threw = null;
    try { r = await st.fetchYear(2027); } catch (e) { threw = e; }
    global.fetch = origFetch;
    ok('无 fetch 不崩', threw === null && r && r.ok === false, (threw && threw.message) || JSON.stringify(r));
    ok('无 fetch 中文原因', r && /不支持联网/.test(r.reason), r && r.reason);
  }

  /* ========== 5. 超时 ========== */
  console.log('\n[5] 单源无响应 → 8s 超时（约 8 秒）');
  {
    const st = freshStore();
    setEnv(base + '/hang');
    const t0 = Date.now();
    const r = await st.fetchYear(2027);
    const dt = Date.now() - t0;
    ok('超时后返回 ok=false', r && r.ok === false, JSON.stringify(r));
    ok('耗时在 7~11s（确实有超时保护）', dt > 7000 && dt < 11000, dt + 'ms');
    ok('原因为超时', r && /超时/.test(r.reason), r && r.reason);
  }

  /* ========== 6. 落盘 + 重读 ========== */
  console.log('\n[6] applyYear → 落盘 → 新实例重读');
  let savedDir = null;
  {
    const st = freshStore();
    savedDir = tmpDir('save');
    st.configure({ userDataDir: savedDir, nowFn: function () { return new Date('2026-09-07T10:00:00'); } });
    setEnv(base + '/cn2027');
    const r = await st.fetchYear(2027);
    const ap = st.applyYear({ holidays: r.data.holidays, workdays: r.data.workdays, source: r.source }, 2027);
    ok('applyYear ok', ap && ap.ok === true, JSON.stringify(ap && ap.reason));
    const file = path.join(savedDir, 'holidays.json');
    ok('磁盘文件已生成', fs.existsSync(file));
    ok('临时文件已清理（rename 后不存在）', !fs.existsSync(file + '.tmp'));

    // 全新实例读盘
    const st2 = freshStore();
    st2.configure({ userDataDir: savedDir });
    const d2 = st2.load();
    ok('重读后有 2027', !!(d2.years && d2.years['2027']), JSON.stringify(Object.keys(d2.years || {})));
    eq('重读首段一致', d2.years['2027'].holidays[0], { name: '元旦', s: '2027-01-01', e: '2027-01-03' });
    ok('2026 内置数据仍在', !!d2.years['2026']);
    ok('source 已更新为联网', d2.source && d2.source !== '内置', d2.source);

    // 原子写：残留 .tmp 不污染
    fs.writeFileSync(file + '.tmp', '{"垃圾":"半截写入"}', 'utf8');
    const st3 = freshStore();
    st3.configure({ userDataDir: savedDir });
    const d3 = st3.load();
    ok('残留 .tmp 不影响正式文件', d3.years['2027'] && d3.years['2027'].holidays.length >= 3);
    ok('不出现垃圾字段', Object.keys(d3).indexOf('垃圾') < 0);
  }

  /* ========== 7. 坏文件回退 ========== */
  console.log('\n[7] holidays.json 损坏 → 回退内置且不崩');
  const badContents = [
    ['截断的 JSON', '{"version":1,"years":{"2027":{"holidays":[{"na'],
    ['乱码', '\u0000\u0001\u0002 not a json at all'],
    ['空文件', ''],
    ['是数组', '[1,2,3]'],
    ['是数字', '12345'],
    ['是 null', 'null'],
    ['years 是字符串', '{"years":"oops"}'],
    ['年为 0 条', '{"years":{"abc":{}}}']
  ];
  for (const [label, content] of badContents) {
    const dir = tmpDir('bad');
    fs.writeFileSync(path.join(dir, 'holidays.json'), content, 'utf8');
    const st = freshStore();
    st.configure({ userDataDir: dir });
    let d = null, threw = null;
    try { d = st.load(); } catch (e) { threw = e; }
    ok(label + '：不抛异常', threw === null, threw && threw.message);
    ok(label + '：回退到内置（有 2026）', d && d.years && !!d.years['2026'], JSON.stringify(d && Object.keys(d.years || {})));
    ok(label + '：source=内置', d && d.source === '内置', d && d.source);
  }

  /* ========== 8. needsUpdate / targetYear ========== */
  console.log('\n[8] targetYear / needsUpdate');
  {
    const st = freshStore();
    st.configure({ userDataDir: tmpDir('nu') });
    eq('2026-10-31 → 目标年 2026', st.targetYear(new Date(2026, 9, 31)), 2026);
    eq('2026-11-01 → 目标年 2027', st.targetYear(new Date(2026, 10, 1)), 2027);
    eq('2026-12-31 → 目标年 2027', st.targetYear(new Date(2026, 11, 31)), 2027);
    eq('2027-01-01 → 目标年 2027', st.targetYear(new Date(2027, 0, 1)), 2027);

    let nu = st.needsUpdate(new Date(2026, 8, 7));
    eq('内置数据 → need(builtin)', [nu.need, nu.year, nu.reason], [true, 2026, 'builtin']);

    // 11 月：目标 2027，内置 2027 是 partial
    nu = st.needsUpdate(new Date(2026, 10, 5));
    eq('11 月内置 2027 partial → need(partial)', [nu.need, nu.year, nu.reason], [true, 2027, 'partial']);

    // 造一份"真·联网更新过"的数据
    const dir2 = tmpDir('ok');
    const st2 = freshStore();
    st2.configure({ userDataDir: dir2 });
    st2.applyYear({ holidays: [
      { name: '元旦', s: '2027-01-01', e: '2027-01-03' },
      { name: '春节', s: '2027-02-05', e: '2027-02-11' },
      { name: '清明', s: '2027-04-04', e: '2027-04-06' }
    ], workdays: ['2027-01-04'], source: 'test' }, 2027);
    const nu2 = st2.needsUpdate(new Date(2027, 5, 1));
    eq('已联网更新过 → need=false', [nu2.need, nu2.year, nu2.reason], [false, 2027, 'ok']);

    // 目标年完全缺失（BUILTIN 里没有 2028，才会走 missing）
    const st3 = freshStore();
    st3.configure({ userDataDir: tmpDir('miss') });
    const nu3 = st3.needsUpdate(new Date(2028, 5, 1));
    eq('缺年 → need(missing)', [nu3.need, nu3.year, nu3.reason], [true, 2028, 'missing']);
    // 内置 2027 是 partial，应报 partial 而不是 missing（验证 partial 分支真的被走到）
    const nu4 = st3.needsUpdate(new Date(2027, 5, 1));
    eq('内置 2027 → need(partial)', [nu4.need, nu4.year, nu4.reason], [true, 2027, 'partial']);
  }

  /* ========== 9. importFromFile ========== */
  console.log('\n[9] importFromFile');
  {
    const st = freshStore();
    st.configure({ userDataDir: tmpDir('imp'), nowFn: function () { return new Date('2027-06-01T00:00:00'); } });
    const good = await st.importFromFile(CN27);
    ok('合法 holiday-cn 文件导入成功', good && good.ok === true, JSON.stringify(good && good.reason));
    eq('猜中年份 2027', good.year, 2027);

    const good2 = await st.importFromFile(TIMOR27);
    ok('合法 timor 文件导入成功', good2 && good2.ok === true, JSON.stringify(good2 && good2.reason));

    const dir = tmpDir('impbad');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ this is not json', 'utf8');
    const r1 = await st.importFromFile(bad);
    ok('非法 JSON → ok=false + 中文原因', r1 && r1.ok === false && /JSON/.test(r1.reason), JSON.stringify(r1));

    const thin = path.join(dir, 'thin.json');
    fs.writeFileSync(thin, JSON.stringify({ year: 2027, days: [{ name: '元旦', date: '2027-01-01', isOffDay: true }] }), 'utf8');
    const r2 = await st.importFromFile(thin);
    ok('数据不足 → ok=false', r2 && r2.ok === false && /不是有效/.test(r2.reason), JSON.stringify(r2));

    const r3 = await st.importFromFile(path.join(dir, '不存在的文件.json'));
    ok('文件不存在 → ok=false 不崩', r3 && r3.ok === false, JSON.stringify(r3));
    const r4 = await st.importFromFile('');
    ok('空路径 → ok=false', r4 && r4.ok === false && /未选择/.test(r4.reason), JSON.stringify(r4));
  }

  /* ========== 10. rangeOf / segmentsOf ========== */
  console.log('\n[10] rangeOf / segmentsOf');
  {
    const st = freshStore();
    st.configure({ userDataDir: tmpDir('rng') });
    st.setData({ years: { 2026: { holidays: [{ name: '元旦', s: '2026-01-01', e: '2026-01-03' }, { name: '跨年', s: '2026-12-30', e: '2027-01-01' }], workdays: [] } } });
    // P2-3：同月段也带 em（em === m），契约统一
    eq('普通段（同月 → em === m）', st.rangeOf('元旦', 2026), { y: 2026, m: 1, s: 1, em: 1, e: 3 });
    const cross = st.rangeOf('跨年', 2026);
    eq('跨月段带回结束月 em', cross, { y: 2026, m: 12, s: 30, em: 1, e: 1 });
    ok('跨月段不再被裁到起始月月末（旧 bug：e=31）', cross && cross.e !== 31, JSON.stringify(cross));
    // 用户报的真实用例：2025 春节 1/28–2/4，旧实现会返回 1/28-1/31
    st.setData({ years: { 2025: { holidays: [{ name: '春节', s: '2025-01-28', e: '2025-02-04' }], workdays: [] } } });
    eq('2025 春节跨月区间完整', st.rangeOf('春节', 2025), { y: 2025, m: 1, s: 28, em: 2, e: 4 });
    ok('不存在的节日 → null', st.rangeOf('不存在的节', 2026) === null);
    ok('不存在的年 → null', st.rangeOf('元旦', 2030) === null);
    eq('无数据年 segmentsOf=[]', st.segmentsOf(2030), []);
  }

  /* ========== 11. setData 垃圾输入 ========== */
  console.log('\n[11] setData 非法输入不崩');
  {
    const st = freshStore();
    st.configure({ userDataDir: tmpDir('sd') });
    ok('null → false', st.setData(null) === false);
    ok('字符串 → false', st.setData('x') === false);
    ok('空对象 → 回退内置仍可 load', (function () { st.setData({}); const d = st.getData(); return !!(d && d.years && d.years['2026']); })());
  }

  /* ========== 12. sourcesFor ========== */
  console.log('\n[12] sourcesFor');
  {
    const st = freshStore();
    setEnv(null);
    const s = st.sourcesFor(2027);
    ok('默认三源', s.length === 3 && /jsdelivr/.test(s[0]) && /raw\.githubusercontent/.test(s[1]) && /timor/.test(s[2]), JSON.stringify(s));
    setEnv('http://a/{year}.json, http://b/{year}.json');
    eq('env 覆盖 + {year} 替换', st.sourcesFor(2027), ['http://a/2027.json', 'http://b/2027.json']);
    setEnv('   ,  ,');
    ok('env 全空白 → 回落默认', st.sourcesFor(2027).length === 3);
    setEnv(null);
  }

  srv.close();
  console.log('\n================ holiday-store 汇总 ================');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (fails.length) { console.log('失败用例：'); fails.forEach(function (f) { console.log('  - ' + f); }); }
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) { console.error('测试自身崩溃:', e); process.exitCode = 1; });
