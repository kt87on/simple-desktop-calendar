'use strict';

/* =====================================================================
 * holiday-store.js —— 节假日放假数据「存储 + 联网更新」模块（主进程用）
 * ---------------------------------------------------------------------
 * 设计约束（重要）：
 *   1) 本模块**必须能在纯 Node 下 require**。项目已有的 smoke-test 用 mock 拦截
 *      require('electron') 后真实执行 electron-main.js，所以顶层一旦 require('electron')
 *      就会在测试环境里拿到 mock（或在纯 Node 下直接抛错）。因此：
 *        - 顶层只 require('fs'/'path'/'os')；
 *        - userData 目录、fetch 实现、时钟一律通过 configure() 注入；
 *        - 兜底时才在函数体内懒加载 require('electron')。
 *   2) 任何异常都不许冒泡到主进程 —— 全部 try/catch 后返回可读中文原因。
 *   3) 写盘必须原子写（写 .tmp 再 rename），避免写一半断电导致数据文件损坏。
 *
 * 持久化文件：userData/holidays.json
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-09-07T00:00:00.000Z",
 *     "source": "内置",
 *     "years": {
 *       "2026": {
 *         "holidays": [ { "name": "元旦", "s": "2026-01-01", "e": "2026-01-03" } ],
 *         "workdays": [ "2026-01-04" ]
 *       }
 *     }
 *   }
 * ===================================================================== */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SCHEMA_VERSION = 1;

/* ---------------------------------------------------------------------
 * 出厂内置数据（2026 国务院办公厅安排；与 app.js 的 HOLIDAY_FALLBACK 同源）
 * 作用：联网失败 / 首次启动 / 离线环境 时的兜底，保证日历永远有假可看。
 * 2027 只有元旦（跨年兜底用），标记 partial=true —— 视为「不完整」，
 * needsUpdate() 会把它判成需要联网补全，避免用户永远看不到 2027 的春节。
 * ------------------------------------------------------------------- */
const BUILTIN = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  source: '内置',
  years: {
    '2026': {
      holidays: [
        { name: '元旦',   s: '2026-01-01', e: '2026-01-03' },
        { name: '春节',   s: '2026-02-15', e: '2026-02-23' },
        { name: '清明节', s: '2026-04-04', e: '2026-04-06' },
        { name: '劳动节', s: '2026-05-01', e: '2026-05-05' },
        { name: '端午节', s: '2026-06-19', e: '2026-06-21' },
        { name: '中秋节', s: '2026-09-25', e: '2026-09-27' },
        { name: '国庆节', s: '2026-10-01', e: '2026-10-07' }
      ],
      workdays: [
        '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'
      ]
    },
    '2027': {
      partial: true,      // 仅元旦，缺其余安排
      holidays: [
        { name: '元旦', s: '2027-01-01', e: '2027-01-03' }
      ],
      workdays: []
    }
  }
};

/* ============================ 注入配置 ============================ */
let _userDataDir = null;
let _fetchImpl = null;   // (url, opts) => Promise<{ok, status, text()}>
let _nowFn = null;       // () => Date
let _data = null;        // 内存缓存（load 后填充）

/**
 * 注入外部依赖。未注入的项走内置兜底，保证纯 Node / 测试环境可用。
 * @param {{userDataDir?:string, fetchImpl?:Function, nowFn?:Function}} opts
 */
function configure(opts) {
  try {
    const o = opts || {};
    if (o.userDataDir) _userDataDir = String(o.userDataDir);
    if (typeof o.fetchImpl === 'function') _fetchImpl = o.fetchImpl;
    if (typeof o.nowFn === 'function') _nowFn = o.nowFn;
  } catch (e) { /* 配置失败就用兜底，不影响主进程 */ }
}

/** 当前时间（可被 configure 注入，便于测试固定时钟） */
function nowDate() {
  try { if (_nowFn) { const d = _nowFn(); if (d instanceof Date) return d; } } catch (e) {}
  return new Date();
}

/** 用户数据目录（懒加载 electron，顶层不 require） */
function userDataDir() {
  if (_userDataDir) return _userDataDir;
  try {
    // eslint-disable-next-line global-require
    const elec = require('electron');
    if (elec && elec.app && typeof elec.app.getPath === 'function') {
      const p = elec.app.getPath('userData');
      if (p) return p;
    }
  } catch (e) { /* 纯 Node / 未 ready：走 tmpdir 兜底 */ }
  return path.join(os.tmpdir(), 'SimpleCalendar');
}

function holidaysFile() {
  return path.join(userDataDir(), 'holidays.json');
}

/* ============================ 小工具 ============================ */
function clone(o) {
  try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
}

/** '2026-01-03' → {y:2026,m:1,d:3}；非法返回 null */
function parseYmd(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s.trim());
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

function ymdOf(p) {
  const y = p.y;
  return y + '-' + (p.m < 10 ? '0' + p.m : '' + p.m) + '-' + (p.d < 10 ? '0' + p.d : '' + p.d);
}

function dayDiff(a, b) {
  const ta = new Date(a.y, a.m - 1, a.d).getTime();
  const tb = new Date(b.y, b.m - 1, b.d).getTime();
  return Math.round((tb - ta) / 86400000);
}

/* ============================ 读 / 写 ============================ */

/** 清洗外部数据：字段缺失一律补默认值，结构不对就整体退回内置 */
function sanitize(o) {
  try {
    if (!o || typeof o !== 'object') return clone(BUILTIN);
    const years = {};
    let count = 0;
    const src = (o.years && typeof o.years === 'object') ? o.years : {};
    for (const k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      if (!/^\d{4}$/.test(String(k))) continue;
      const y = src[k];
      if (!y || typeof y !== 'object') continue;
      const hs = [];
      const rawH = Array.isArray(y.holidays) ? y.holidays : [];
      for (let i = 0; i < rawH.length; i++) {
        const it = rawH[i];
        if (!it) continue;
        const a = parseYmd(it.s), b = parseYmd(it.e) || parseYmd(it.s);
        if (!a || !b) continue;
        hs.push({ name: String(it.name || '节假日'), s: ymdOf(a), e: ymdOf(b) });
      }
      const ws = [];
      const rawW = Array.isArray(y.workdays) ? y.workdays : [];
      for (let i = 0; i < rawW.length; i++) {
        const p = parseYmd(rawW[i]);
        if (p) ws.push(ymdOf(p));
      }
      years[String(k)] = {
        partial: y.partial === true,
        holidays: hs,
        workdays: ws
      };
      count++;
    }
    if (count === 0) return clone(BUILTIN);
    return {
      version: SCHEMA_VERSION,
      updatedAt: (typeof o.updatedAt === 'string') ? o.updatedAt : new Date(0).toISOString(),
      source: (typeof o.source === 'string') ? o.source : '未知',
      years: years
    };
  } catch (e) {
    return clone(BUILTIN);
  }
}

/** 读盘（JSON 坏了 / 文件不存在 → 回退内置） */
function load() {
  try {
    const f = holidaysFile();
    if (!fs.existsSync(f)) { _data = clone(BUILTIN); return _data; }
    _data = sanitize(JSON.parse(fs.readFileSync(f, 'utf8')));
    return _data;
  } catch (e) {
    _data = clone(BUILTIN);
    return _data;
  }
}

/** 原子写：写 .tmp → rename，避免半截文件 */
function save(data) {
  try {
    const d = data || _data;
    if (!d) return false;
    const dir = userDataDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const f = holidaysFile();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, f);
    _data = d;
    return true;
  } catch (e) {
    return false;
  }
}

/** 取全量数据（带内存缓存） */
function getData() {
  return _data || load();
}

/** 整体替换内存数据并落盘（主进程更新后同步给 holidays.js 用） */
function setData(data) {
  try {
    if (!data || typeof data !== 'object') return false;
    _data = sanitize(data);
    return save(_data);
  } catch (e) {
    return false;
  }
}

/** 某年数据；没有返回 null */
function yearData(y) {
  const d = getData();
  if (!d || !d.years) return null;
  return d.years[String(y)] || null;
}

/** 某年放假段数组（[{name,s,e}]），无数据返回 [] */
function segmentsOf(y) {
  const yd = yearData(y);
  return (yd && yd.holidays) ? yd.holidays : [];
}

/**
 * 某年某个节日的日期区间。
 * 返回 { y, m, s, em, e }：
 *   m / s  = 起始「月 / 日」
 *   em / e = 结束「月 / 日」（同月时 em === m）
 * 查不到返回 null。
 *
 * v2.1.0 P2-3 修复：跨月段（如 2025 春节 1/28–2/4）原来被硬裁到起始月月末，
 * 返回 1/28–1/31，托盘菜单于是显示「01/28-31」，把 2/1–2/4 丢了。
 * 现在把结束端也带上月份，由调用方决定怎么拼文案。
 */
function rangeOf(name, year) {
  try {
    const segs = segmentsOf(year);
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].name !== name) continue;
      const a = parseYmd(segs[i].s), b = parseYmd(segs[i].e) || parseYmd(segs[i].s);
      if (!a || !b) continue;
      return { y: a.y, m: a.m, s: a.d, em: b.m, e: b.d };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/* ============================ 更新判定 ============================ */

/**
 * 目标年份：当前年；11 月及以后（国务院通常 11 月发布次年安排）再 +1。
 * @param {Date} [now]
 * @returns {number}
 */
function targetYear(now) {
  const t = now || nowDate();
  let y = t.getFullYear();
  if (t.getMonth() + 1 >= 11) y += 1;   // getMonth() 0 基
  return y;
}

/**
 * 是否需要更新。
 * @param {Date} [now]
 * @returns {{need:boolean, year:number, reason:string}}
 *          reason: 'missing' 缺数据 | 'partial' 只有部分（内置跨年兜底）
 *                  | 'builtin' 仍是出厂内置 | 'ok' 已是联网获取的完整数据
 */
function needsUpdate(now) {
  const y = targetYear(now);
  try {
    const d = getData();
    const yd = yearData(y);
    if (!yd) return { need: true, year: y, reason: 'missing' };
    if (yd.partial === true) return { need: true, year: y, reason: 'partial' };
    // 出厂内置数据只对得上年号，未必是最终版 → 联网拿到真值后就不再提示
    if (d.source === '内置' || d.source === '未知') return { need: true, year: y, reason: 'builtin' };
    const segs = yd.holidays || [];
    let days = 0;
    for (let i = 0; i < segs.length; i++) {
      const a = parseYmd(segs[i].s), b = parseYmd(segs[i].e) || parseYmd(segs[i].s);
      if (a && b) days += Math.max(1, dayDiff(a, b) + 1);
    }
    if (segs.length < 3 && days < 5) return { need: true, year: y, reason: 'partial' };
    return { need: false, year: y, reason: 'ok' };
  } catch (e) {
    return { need: true, year: y, reason: 'missing' };
  }
}

/* ============================ 数据源 ============================ */

/**
 * 数据源 URL 列表（按序尝试）。
 * 支持环境变量 SIMPLE_CAL_HOLIDAY_URLS（逗号分隔）覆盖，便于离线/内网部署。
 */
function sourcesFor(year) {
  try {
    const env = (process.env && process.env.SIMPLE_CAL_HOLIDAY_URLS || '').trim();
    if (env) {
      const list = env.split(',').map(function (s) { return s.trim(); })
        .filter(function (s) { return !!s; })
        .map(function (s) { return s.replace(/\{year\}/g, String(year)); });
      if (list.length) return list;
    }
  } catch (e) {}
  return [
    'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/' + year + '.json',
    'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/' + year + '.json',
    'https://timor.tech/api/holiday/year/' + year
  ];
}

/** file:// 或裸绝对路径 → 本地文件；否则走 fetch */
function readLocal(url) {
  let p = null;
  if (/^file:\/\//i.test(url)) {
    p = decodeURIComponent(url.replace(/^file:\/\/\/?/i, '').replace(/^\/+([A-Za-z]:)/, '$1'));
    p = p.replace(/\//g, path.sep);
  } else if (/^[A-Za-z]:[\\/]/.test(url) || url.charAt(0) === path.sep) {
    p = url;
  }
  if (!p) return null;
  return fs.readFileSync(p, 'utf8');
}

/** 单个 URL 抓取（8s 超时） */
function fetchOne(url) {
  const local = readLocal(url);
  if (local !== null) return Promise.resolve(local);

  const impl = _fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!impl) return Promise.reject(new Error('NO_FETCH'));

  return new Promise(function (resolve, reject) {
    let settled = false;
    let timer = null;
    let ctrl = null;
    const done = function (fn, arg) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };
    try {
      const opts = {};
      // Node 18+ / 现代浏览器都有 AbortController；没有就退化成「只靠 Promise.race 放弃等待」
      if (typeof AbortController === 'function') {
        ctrl = new AbortController();
        opts.signal = ctrl.signal;
      }
      timer = setTimeout(function () {
        try { if (ctrl) ctrl.abort(); } catch (e) {}
        done(reject, new Error('TIMEOUT'));
      }, 8000);
      Promise.resolve(impl(url, opts)).then(function (res) {
        if (!res || (typeof res.ok === 'boolean' && !res.ok)) {
          done(reject, new Error('HTTP_' + ((res && res.status) || 0)));
          return;
        }
        if (typeof res.text === 'function') {
          Promise.resolve(res.text()).then(function (t) { done(resolve, String(t)); },
            function (e) { done(reject, e); });
          return;
        }
        done(resolve, String(res));
      }, function (e) { done(reject, e); });
    } catch (e) {
      done(reject, e);
    }
  });
}

/** 把网络异常翻译成用户看得懂的中文 */
function humanReason(err, url) {
  const msg = (err && err.message) || String(err || '');
  if (msg === 'TIMEOUT') return '网络超时（8 秒无响应），请检查网络后重试';
  if (msg === 'NO_FETCH') return '当前环境不支持联网（缺少 fetch）';
  if (/^HTTP_/.test(msg)) return '数据源返回异常（' + msg.slice(5) + '）';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|certificate/i.test(msg)) {
    return '网络不可用，请检查网络后重试';
  }
  return '网络不可用，请检查网络后重试（' + msg.slice(0, 60) + '）';
}

/**
 * 归一化：把 holiday-cn / timor 两种格式统一成 {holidays:[{name,s,e}], workdays:['YYYY-MM-DD']}
 * 校验失败（段 < 3 且放假日 < 5）返回 null，调用方据此换下一个源。
 * @param {object} sourceJson
 * @param {number|string} year
 * @returns {{holidays:Array, workdays:Array}|null}
 */
function normalize(sourceJson, year) {
  try {
    if (!sourceJson || typeof sourceJson !== 'object') return null;
    const y = Number(year);
    // 数据源自带年份时必须对得上，否则说明拿错了文件
    if (sourceJson.year != null && Number(sourceJson.year) !== y) return null;

    const items = [];   // { date:'YYYY-MM-DD', name, off:boolean }

    // ---- 格式 A：holiday-cn { year, days:[{name,date,isOffDay}] } ----
    if (Array.isArray(sourceJson.days)) {
      for (let i = 0; i < sourceJson.days.length; i++) {
        const it = sourceJson.days[i];
        if (!it) continue;
        const p = parseYmd(it.date);
        if (!p) continue;
        items.push({ p: p, name: String(it.name || '节假日'), off: it.isOffDay !== false });
      }
    }

    // ---- 格式 B：timor.tech { code, holiday: { '2026-01-01': {holiday:true,name} } } ----
    if (items.length === 0 && sourceJson.holiday && typeof sourceJson.holiday === 'object') {
      const h = sourceJson.holiday;
      for (const k in h) {
        if (!Object.prototype.hasOwnProperty.call(h, k)) continue;
        const v = h[k];
        if (!v || typeof v !== 'object') continue;
        const p = parseYmd(k) || parseYmd(v.date);
        if (!p) continue;
        if (String(p.y) !== String(y)) continue;
        items.push({ p: p, name: String(v.name || '节假日'), off: v.holiday !== false });
      }
    }

    if (items.length === 0) return null;

    // timor 的 API 用 code !== 0 表示失败（如年份不存在）
    if (sourceJson.code != null && Number(sourceJson.code) !== 0 && !Array.isArray(sourceJson.days)) return null;

    items.sort(function (a, b) {
      return new Date(a.p.y, a.p.m - 1, a.p.d) - new Date(b.p.y, b.p.m - 1, b.p.d);
    });

    // 同名 + 日期连续 → 合并成一段
    const holidays = [];
    const workdays = [];
    let cur = null;
    let offCount = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.off) { workdays.push(ymdOf(it.p)); continue; }
      offCount++;
      if (cur && cur.name === it.name && dayDiff(cur.last, it.p) === 1) {
        cur.last = it.p;
      } else {
        if (cur) holidays.push({ name: cur.name, s: ymdOf(cur.first), e: ymdOf(cur.last) });
        cur = { name: it.name, first: it.p, last: it.p };
      }
    }
    if (cur) holidays.push({ name: cur.name, s: ymdOf(cur.first), e: ymdOf(cur.last) });

    // 太少的放假数据基本等于抓错了东西（404 页面被当成 JSON 之类）
    if (holidays.length < 3 && offCount < 5) return null;

    return { holidays: holidays, workdays: workdays };
  } catch (e) {
    return null;
  }
}

/**
 * 联网抓取某年数据（多源兜底）。
 * @param {number|string} year
 * @returns {Promise<{ok:boolean, data?:object, source?:string, reason?:string}>}
 */
function fetchYear(year) {
  const urls = sourcesFor(year);
  let lastReason = '网络不可用，请检查网络后重试';
  let idx = 0;

  function attempt() {
    if (idx >= urls.length) {
      return Promise.resolve({ ok: false, reason: lastReason });
    }
    const url = urls[idx++];
    return fetchOne(url).then(function (raw) {
      let json = null;
      try { json = JSON.parse(raw); } catch (e) {
        lastReason = '数据格式异常（不是合法 JSON）';
        return attempt();
      }
      const norm = normalize(json, year);
      if (!norm) {
        lastReason = '数据源暂无 ' + year + ' 年数据或数据格式异常';
        return attempt();
      }
      return { ok: true, data: norm, source: url };
    }, function (err) {
      lastReason = humanReason(err, url);
      return attempt();
    });
  }

  return Promise.resolve().then(attempt);
}

/**
 * 写入某年数据（原子写）。
 * @param {{holidays:Array, workdays:Array, source?:string}} payload
 * @param {number|string} year
 * @returns {{ok:boolean, data?:object, reason?:string}}
 */
function applyYear(payload, year) {
  try {
    if (!payload || !payload.holidays) return { ok: false, reason: '数据为空或格式不正确' };
    const y = String(year);
    const d = getData();
    if (!d.years || typeof d.years !== 'object') d.years = {};
    d.years[y] = {
      holidays: payload.holidays || [],
      workdays: payload.workdays || []
    };
    d.version = SCHEMA_VERSION;
    d.updatedAt = new Date().toISOString();
    d.source = payload.source || '联网';
    if (!save(d)) return { ok: false, reason: '写入本地数据失败（磁盘不可写？）' };
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, reason: '写入本地数据失败：' + ((e && e.message) || e) };
  }
}

/** 从文件名 / 内容里猜年份，猜不出就用目标年 */
function guessYear(json, absPath) {
  try {
    if (json && json.year != null) { const n = Number(json.year); if (n > 1900 && n < 3000) return n; }
  } catch (e) {}
  try {
    const m = /(\d{4})/.exec(String(absPath || '').replace(/^.*[\\/]/, ''));
    if (m) { const n = Number(m[1]); if (n > 1900 && n < 3000) return n; }
  } catch (e) {}
  try {
    if (json && json.holiday) {
      for (const k in json.holiday) {
        const p = parseYmd(k);
        if (p) return p.y;
      }
    }
    if (json && Array.isArray(json.days) && json.days[0]) {
      const p = parseYmd(json.days[0].date);
      if (p) return p.y;
    }
  } catch (e) {}
  return targetYear(nowDate());
}

/**
 * 从本地 JSON 文件导入（离线兜底路径）。
 * @param {string} absPath
 * @returns {Promise<{ok:boolean, year?:number, data?:object, source?:string, reason?:string}>}
 */
function importFromFile(absPath) {
  return new Promise(function (resolve) {
    try {
      if (!absPath) { resolve({ ok: false, reason: '未选择文件' }); return; }
      const raw = fs.readFileSync(absPath, 'utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch (e) {
        resolve({ ok: false, reason: '文件不是合法的 JSON' }); return;
      }
      const y = guessYear(json, absPath);
      const norm = normalize(json, y);
      if (!norm) { resolve({ ok: false, reason: '文件内容不是有效的节假日数据' }); return; }
      resolve({ ok: true, year: y, data: norm, source: '本地文件' });
    } catch (e) {
      resolve({ ok: false, reason: '读取文件失败：' + ((e && e.message) || e) });
    }
  });
}

module.exports = {
  configure: configure,
  load: load,
  save: save,
  getData: getData,
  setData: setData,
  yearData: yearData,
  segmentsOf: segmentsOf,
  rangeOf: rangeOf,
  targetYear: targetYear,
  needsUpdate: needsUpdate,
  fetchYear: fetchYear,
  normalize: normalize,
  applyYear: applyYear,
  importFromFile: importFromFile,
  sourcesFor: sourcesFor,
  parseYmd: parseYmd,
  BUILTIN: BUILTIN
};
