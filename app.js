/* 桌面日历 3.0 —— 在 2.0 视觉/功能基础上，新增：
   R3. 计算农历+星期字符串并推送给托盘 tooltip（ipcRenderer.send('set-tooltip', str)）
   R4. 放大按钮改为请求主进程切换 mini/expanded 双窗口；拖拽结束请求吸附；
       Electron 下跳过 DOM 拖拽（改由原生 -webkit-app-region 移动 OS 窗口）
   全部 2.0 功能（周起始、农历/节气/节假日白名单、灯效、主题、放大兼容等）原样保留。
*/
(function () {
  'use strict';
  var Solar = window.Solar, Lunar = window.Lunar;

  /* ===== v2.2.0 需求4：桌面插件模式 =====
   * calendar.html 被主进程以 query `mode=desktopWidget` 加载时进入桌面模式：
   * 只显示「日历板块」（隐藏顶部时间信息条），换肤键替换为锁定键，
   * 拖动改为 IPC 绝对定位 + 工作区夹取。 */
  var IS_DESKTOP = (function () {
    try { return new URLSearchParams(location.search).get('mode') === 'desktopWidget'; } catch (e) { return false; }
  })();
  var desktopLocked = false;   // 桌面插件锁定态（锁定时不可拖动，其余正常）

  /* ===== 节假日放假数据（按年索引） =====
   * v2.1.0：原来只有一份 2026 硬编码表，看 2025/2027 也拿 2026 的去套（附带 bug）。
   * 现在按年存表：HOLIDAY_FALLBACK 是出厂内置（浏览器预览 + 首帧），
   * HOLIDAY_YEARS 是运行时真值（Electron 下由主进程 holidays.json 下发覆盖）。
   * 某年无数据 → 该年既不放假也不补班，不再误套别年的表。 */
  var HOLIDAY_FALLBACK = {
    2026: {
      holidays: [
        { name: '元旦',   s: '2026-01-01', e: '2026-01-03' },
        { name: '春节',   s: '2026-02-15', e: '2026-02-23' },
        { name: '清明节', s: '2026-04-04', e: '2026-04-06' },
        { name: '劳动节', s: '2026-05-01', e: '2026-05-05' },
        { name: '端午节', s: '2026-06-19', e: '2026-06-21' },
        { name: '中秋节', s: '2026-09-25', e: '2026-09-27' },
        { name: '国庆节', s: '2026-10-01', e: '2026-10-07' }
      ],
      workdays: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
    }
  };
  // 运行时数据表（引用稳定，applyHolidayData 只改属性不改引用，方便测试钩子持有）
  var HOLIDAY_YEARS = {};
  (function seedFallback() {
    for (var k in HOLIDAY_FALLBACK) {
      if (Object.prototype.hasOwnProperty.call(HOLIDAY_FALLBACK, k)) HOLIDAY_YEARS[k] = HOLIDAY_FALLBACK[k];
    }
  })();

  var _holidayCache = {};   // y -> { find(m,d), isWork(m,d) }，避免每次翻月重复解析字符串

  function parseYmd(s) {
    if (typeof s !== 'string') return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3] };
  }
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
  function dayDiff(a, b) {
    return Math.round((new Date(b.y, b.m - 1, b.d) - new Date(a.y, a.m - 1, a.d)) / 86400000);
  }

  /* 把某年的 {holidays:[{name,s,e}], workdays:[...]} 编译成按月索引的查询器。
   * 放假期段可能跨月（如 12/30–1/1），这里按月裁剪成「月内子段」，
   * 但 idx/total 仍按整段算，保证节首日只显示一次节日名。 */
  function buildYearTable(t) {
    var segs = {}, wk = {}, i, m;
    var hs = (t && t.holidays) || [];
    for (i = 0; i < hs.length; i++) {
      var a = parseYmd(hs[i].s), b = parseYmd(hs[i].e) || parseYmd(hs[i].s);
      if (!a || !b) continue;
      for (m = a.m; m <= b.m; m++) {
        var ms = (m === a.m) ? a.d : 1;
        var me = (m === b.m) ? b.d : daysInMonth(b.y, m);
        if (!segs[m]) segs[m] = [];
        segs[m].push({ s: ms, e: me, name: String(hs[i].name || '节假日'), sAbs: hs[i].s, eAbs: hs[i].e });
      }
    }
    var ws = (t && t.workdays) || [];
    for (i = 0; i < ws.length; i++) {
      var w = parseYmd(ws[i]);
      if (!w) continue;
      if (!wk[w.m]) wk[w.m] = {};
      wk[w.m][w.d] = true;
    }
    return {
      find: function (m, d) {
        var arr = segs[m];
        if (!arr) return null;
        for (var k = 0; k < arr.length; k++) {
          var s = arr[k];
          if (d < s.s || d > s.e) continue;
          var pa = parseYmd(s.sAbs), pb = parseYmd(s.eAbs) || parseYmd(s.sAbs);
          var total = dayDiff(pa, pb) + 1;
          var idx = dayDiff(pa, { y: pa.y, m: m, d: d }) + 1;
          return { name: s.name, idx: idx, total: total, s: s.s, e: s.e };
        }
        return null;
      },
      isWork: function (m, d) { return !!(wk[m] && wk[m][d]); }
    };
  }

  /** 取某年的放假查询器；该年无数据返回 null（调用方按"无假无补班"处理） */
  function holidayTable(y) {
    if (_holidayCache[y]) return _holidayCache[y];
    var t = HOLIDAY_YEARS[y];
    if (!t) return null;
    var api = buildYearTable(t);
    _holidayCache[y] = api;
    return api;
  }

  /** 主进程下发 holidays.json → 合并进运行时表并重绘 */
  function applyHolidayData(payload) {
    if (!payload || typeof payload !== 'object') return false;
    var years = payload.years || (payload.data && payload.data.years);
    if (!years) return false;
    for (var y in years) {
      if (Object.prototype.hasOwnProperty.call(years, y)) HOLIDAY_YEARS[y] = years[y];
    }
    _holidayCache = {};
    // DOM 还没准备好时（首帧之前收到推送）只更新数据，等 init 自己 renderAll
    if (!gridEl) return true;
    renderAll();
    updateInfo();
    return true;
  }

  /* ===== 法定节假日（仅用于副字显示节日名，不依赖放假年） ===== */
  var NATIONAL = {
    1:  { 1: '元旦' },
    4:  { 4: '清明节', 5: '清明节' },
    5:  { 1: '劳动节' },
    10: { 1: '国庆节' }
  };

  /* ===== 节日白名单：24 节气 + 法定 + 中国传统 + 国外主流民俗（过滤国际/全国/行业类） ===== */
  var KEEP = {
    '元旦':1,'春节':1,'元宵节':1,'龙头节':1,'二月二':1,'上巳节':1,'寒食节':1,'清明节':1,
    '端午节':1,'七夕节':1,'中元节':1,'中秋节':1,'重阳节':1,'寒衣节':1,'下元节':1,'腊八节':1,
    '小年':1,'除夕':1,'情人节':1,'愚人节':1,'万圣节':1,'圣诞节':1,'感恩节':1,
    '劳动节':1,'国庆节':1
  };
  function isKeep(name) {
    if (!name) return false;
    if (KEEP[name]) return true;
    for (var k in KEEP) { if (name.indexOf(k) === 0) return true; }
    return false;
  }
  var ALIAS = { '万圣节前夜': '万圣节' };   // 西方节日别名归一

  /* ===== 通用工具 ===== */
  var CN = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  function cnNum(s) {
    if (!s) return 0;
    s = String(s).replace('初', '');
    if (s.indexOf('廿') === 0) { var r = s.slice(1); return 20 + (CN[r] || 0); }
    if (s === '三十') return 30;
    if (s.indexOf('十') === 0) return 10 + (CN[s[1]] || 0);
    if (s.indexOf('十') === 1) return CN[s[0]] * 10 + (s.length > 2 ? (CN[s[2]] || 0) : 0);
    if (s.length === 1) return CN[s] || 0;
    return 0;
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* ===== 每日单元格数据 ===== */
  function info(y, m, d) {
    var solar = Solar.fromYmd(y, m, d);
    var lunar = solar.getLunar();
    var dayCn = lunar.getDayInChinese();
    var dayNum = cnNum(dayCn);
    var jq = lunar.getJieQi() || '';
    var sF = solar.getFestivals() || [];
    var lF = lunar.getFestivals() || [];

    // v2.1.0：按年份取表 —— 该年没有放假数据就不再拿别年的表去套
    var tbl = holidayTable(y);
    var hol = tbl ? tbl.find(m, d) : null;
    var isHoliday = !!hol;
    var isWork = tbl ? tbl.isWork(m, d) : false;

    // 副文字优先级：
    //  1) 24 节气始终显示
    //  2) 放假期内仅节首日显示假期名，其余回退农历
    //  3) 非放假日才走白名单
    //  4) 农历日
    var sub, kind = 'lunar';
    if (jq) {
      sub = jq; kind = 'festival';
    } else if (isHoliday && hol.idx === 1) {
      sub = hol.name; kind = 'festival';
    } else if (!isHoliday) {
      if (NATIONAL[m] && NATIONAL[m][d]) { sub = NATIONAL[m][d]; kind = 'festival'; }
      else if (sF[0] && isKeep(sF[0])) { sub = ALIAS[sF[0]] || sF[0]; kind = 'festival'; }
      else if (lF[0] && isKeep(lF[0])) { sub = ALIAS[lF[0]] || lF[0]; kind = 'festival'; }
      else sub = (dayNum === 1) ? (lunar.getMonthInChinese() + '月初一') : dayCn;
    } else {
      sub = (dayNum === 1) ? (lunar.getMonthInChinese() + '月初一') : dayCn;
    }

    var week = solar.getWeek();
    return {
      y: y, m: m, d: d,
      sub: sub, kind: kind,
      holidayName: hol ? hol.name : '',
      isHoliday: isHoliday, isWork: isWork,
      weekend: week === 0 || week === 6
    };
  }

/* ===== 状态 ===== */
/* v2.1.0 跨天修复：`now` 曾只在启动时算一次，跨过午夜后 isToday() 仍认昨天，
 * 而且 9/30→10/1、12/31→1/1 连月/年都不跟随。现在 now 仅作"启动时刻"保留，
 * 所有"今天"判定一律走实时 todayParts()。 */
var now = new Date();
function refreshNow() { now = new Date(); }
function todayParts() {
  var t = new Date();
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
}
var S = {
  year: now.getFullYear(),
  month: now.getMonth() + 1,
  selY: now.getFullYear(),
  selM: now.getMonth() + 1,
  selD: now.getDate(),
  startMon: true,
  theme: 'light'
};

/* ===== v1.6.2 特别关注（renderer state） ===== */
var reminders = [];             // [{ id, y, m, d, text, createdAt, snoozeUntil }]
var pendingRemind = null;      // { y, m, d } 当前右键打开的关注输入栏目标

/* ===== v1.7.11 特别关注字数限制（需求 1） =====
 * v2.3.0：移除「最多 10 条」数量上限（用户要求不限制），仅保留单条 15 字限制。
 * 渲染层用 maxlength + 截断拦截，主进程 add-reminder 里再兜底一次，双保险防止绕过。 */
var MAX_REMINDER_TEXT = 15;    // 单条最多 15 字

var $ = function (id) { return document.getElementById(id); };
var gridEl, headerEl, yearSel, monthSel, wkSwitchEl, widgetEl, lastLit = -1, bgMonthEl, calendarEl, litGlowEl, themeBtnEl;
var lastTipKey = '';   // R3：上次推送 tooltip 的日期键，跨午夜才重新推送
var remindInputEl, remindDateLabelEl, remindTextEl, remindOkEl, remindCancelEl, toastEl;
// v1.7.12：关注列表已改为独立窗口（remindlist.html），主窗口内不再有弹窗 DOM
var bookBtnEl;

  // 实时计算：不再读冻结的 now（跨天/跨月/跨年后今日高亮自动跟随）
  function isToday(y, m, d) {
    var t = todayParts();
    return y === t.y && m === t.m && d === t.d;
  }
  function isSel(y, m, d) { return y === S.selY && m === S.selM && d === S.selD; }

  /* ===== 单元格序列（42 = 6 周 × 7 天） ===== */
  function buildCells() {
    var y = S.year, m = S.month;
    var firstWd = new Date(y, m - 1, 1).getDay();
    var lead = S.startMon ? (firstWd === 0 ? 6 : firstWd - 1) : firstWd;
    var dim = new Date(y, m, 0).getDate();
    var prevDays = new Date(y, m - 1, 0).getDate();
    var cells = [];
    for (var i = lead - 1; i >= 0; i--) cells.push({ t: 'other', y: m === 1 ? y - 1 : y, m: m === 1 ? 12 : m - 1, d: prevDays - i });
    for (var d = 1; d <= dim; d++) cells.push({ t: 'cur', y: y, m: m, d: d });
    var ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1, nd = 1;
    while (cells.length < 42) cells.push({ t: 'other', y: ny, m: nm, d: nd++ });
    return cells;
  }

  /* ===== 渲染：表头 ===== */
  function renderWeekHeader() {
    var labels = S.startMon ? ['一', '二', '三', '四', '五', '六', '日']
                             : ['日', '一', '二', '三', '四', '五', '六'];
    var html = '';
    for (var i = 0; i < 7; i++) {
      var isWk = S.startMon ? (i >= 5) : (i === 0 || i === 6);
      html += '<div class="wcell' + (isWk ? ' weekend' : '') + '">' + labels[i] + '</div>';
    }
    headerEl.innerHTML = html;
  }

  /* ===== 渲染：月历 ===== */
  function renderGrid() {
    var cells = buildCells(), html = '';
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i], inf = info(c.y, c.m, c.d);
      var cls = 'cell';
      if (c.t === 'other') cls += ' other';
      if (inf.isHoliday) cls += ' holiday';          // 跨月节假日也标红（整体透明化由 CSS 控制）
      if (inf.isWork && c.t === 'cur') cls += ' workday';
      if (inf.weekend && c.t === 'cur') cls += ' weekend';
      if (isToday(c.y, c.m, c.d)) cls += ' today';
      if (isSel(c.y, c.m, c.d)) cls += ' selected';
      // v1.6.2：特别关注单元格标黄 + 角标（v1.7.17 需求10：关→注）
      var reminderItem = findReminder(c.y, c.m, c.d);
      if (reminderItem) cls += ' reminder';

      var chip = '';
      if (reminderItem) chip = '<span class="chip-focus" title="' + escapeAttr(reminderItem.text) + '">注</span>';
      else if (inf.isHoliday) chip = '<span class="chip chip-rest">休</span>';
      else if (c.t === 'cur' && inf.isWork) chip = '<span class="chip chip-work">班</span>';

      var subCls = 'sub' + (inf.kind === 'festival' ? ' sub-festival' : '');
      html +=
        '<div class="' + cls + '" data-y="' + c.y + '" data-m="' + c.m + '" data-d="' + c.d + '" role="button" tabindex="0" aria-label="' + c.y + '年' + c.m + '月' + c.d + '日 ' + inf.sub + '">' +
          chip +
          '<span class="d">' + (c.d < 10 ? '0' + c.d : c.d) + '</span>' +
          '<span class="' + subCls + '">' + inf.sub + '</span>' +
        '</div>';
    }
    gridEl.innerHTML = html;
    lastLit = -1;
    markRange();                                   // 渲染后标记已选 range 格
    yearSel.value = S.year;
    monthSel.value = S.month;
    if (bgMonthEl) bgMonthEl.textContent = S.month;
  }

  /* ===== v2.1.0 跨天（跨月 / 跨年）自动跟随 =====
   * 三重保险，覆盖「系统休眠」「窗口隐藏被浏览器节流」两种定时器不可靠场景：
   *   1) updateClock() 按日期键比较（不再赌"恰好 00:00:00 那一秒"会被执行到）
   *   2) visibilitychange / focus 回来时补一次
   *   3) 每秒 setInterval 兜底
   * 幂等：checkDayRollover() 一天内重复调用只会真正执行一次。 */
  function dayKeyOf(y, m, d) { return y + '-' + m + '-' + d; }

  var _t0 = todayParts();
  var lastDayKey = dayKeyOf(_t0.y, _t0.m, _t0.d);
  var prevToday = { y: _t0.y, m: _t0.m, d: _t0.d };

  function onDayRollover() {
    var prev = prevToday || todayParts();
    refreshNow();
    var t = todayParts();
    prevToday = t;
    // 用户正在看"旧今天所在的月" → 跟随滚到新月/新年（否则不打扰用户翻的月份）
    if (S.year === prev.y && S.month === prev.m) { S.year = t.y; S.month = t.m; }
    // 选中的就是旧今天 → 选中日跟随（不然跨月后选中态落在上个月）
    if (S.selY === prev.y && S.selM === prev.m && S.selD === prev.d) {
      S.selY = t.y; S.selM = t.m; S.selD = t.d;
    }
    renderAll();
    updateInfo();
    // 强制刷新托盘 tooltip（原来靠 lastTipKey 变化才推，跨天时这里直接清空重推）
    lastTipKey = '';
    pushTooltip();
    if (rangeSel.length === 2) showDayCount();   // 天数浮层跟着重排
    return true;
  }

  function checkDayRollover() {
    var t = todayParts();
    var dk = dayKeyOf(t.y, t.m, t.d);
    if (dk === lastDayKey) return false;
    lastDayKey = dk;
    return onDayRollover();
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function findReminder(y, m, d) {
    for (var i = 0; i < reminders.length; i++) {
      var r = reminders[i];
      if (r.y === y && r.m === m && r.d === d) return r;
    }
    return null;
  }

  function renderAll() { renderWeekHeader(); renderGrid(); }

  /* ===== 操作 ===== */
function gotoMonth(delta) {
  var m = S.month + delta, y = S.year;
  if (m > 12) { m = 1; y++; }
  if (m < 1) { m = 12; y--; }
  S.year = y; S.month = m; renderAll();
  // v1.6.2：翻月后保留已选的两格，刷新「天数」浮层位置（仍指向当前可见月份内的两个 cell）
  if (rangeSel.length === 2) showDayCount();
}
  function gotoToday() {
    var t = todayParts();     // 实时：不能用冻结的 now
    S.year = t.y; S.month = t.m;
    S.selY = t.y; S.selM = t.m; S.selD = t.d;
    renderAll();
  }
  // v1.5：跳到指定年/月/日（托盘「下一节日」点击跳转用）
  function gotoYm(y, m, d) {
    S.year = y; S.month = m;
    S.selY = y; S.selM = m; S.selD = d || 1;
    renderAll();
  }
  function select(y, m, d) { S.selY = y; S.selM = m; S.selD = d; renderGrid(); }

  /* ===== 需求5：日期区间选择（点一格变绿；再点另一格变绿并显示共计天数；
     第三下点击只解除前两个选择、不选中当前格；点空白处/窗外取消选中 ===== */
  var rangeSel = [];          // 已选 {y,m,d} 数组
  var dayCountEl = null;

  function dateKey(o) { return o.y + '-' + o.m + '-' + o.d; }
  function daysBetween(a, b) {
    var da = new Date(a.y, a.m - 1, a.d), db = new Date(b.y, b.m - 1, b.d);
    var diff = Math.round((db - da) / 86400000);
    return Math.abs(diff) + 1;   // 包含首尾
  }
  function clearRange() {
    rangeSel = [];
    if (dayCountEl) { dayCountEl.classList.remove('show'); dayCountEl.textContent = ''; }
    renderGrid();
  }
  function addRange(y, m, d) {
    var key = dateKey({ y: y, m: m, d: d });
    // 已选则取消该格
    var idx = -1;
    for (var i = 0; i < rangeSel.length; i++) if (dateKey(rangeSel[i]) === key) { idx = i; break; }
    if (idx >= 0) { rangeSel.splice(idx, 1); if (dayCountEl) dayCountEl.classList.remove('show'); renderGrid(); return; }
    rangeSel.push({ y: y, m: m, d: d });
    renderGrid();
    if (rangeSel.length === 2) showDayCount();
  }
  function showDayCount() {
    var a = rangeSel[0], b = rangeSel[1];
    if (!a || !b || !dayCountEl || !calendarEl) return;
    var n = daysBetween(a, b);
    // 浮层定位 —— v1.7.2 容忍跨月：两格可能都不在当前可见网格
    var ca = findCellEl(a.y, a.m, a.d);
    var cb = findCellEl(b.y, b.m, b.d);
    var rect = calendarEl.getBoundingClientRect();
    var x, y;
    if (ca && cb) {
      // 两格都可见 → 定位到两格中点
      var ra = ca.getBoundingClientRect(), rb = cb.getBoundingClientRect();
      x = (ra.left + ra.width / 2 + rb.left + rb.width / 2) / 2 - rect.left;
      y = (ra.top + ra.height / 2 + rb.top + rb.height / 2) / 2 - rect.top;
    } else if (ca) {
      var ra = ca.getBoundingClientRect();
      x = ra.left + ra.width / 2 - rect.left;
      y = ra.top + ra.height / 2 - rect.top;
    } else if (cb) {
      var rb = cb.getBoundingClientRect();
      x = rb.left + rb.width / 2 - rect.left;
      y = rb.top + rb.height / 2 - rect.top;
    } else {
      // 两格都不可见（罕见：用户翻了一个不包含任一格的月份）
      // 浮层定到 #grid 中部偏上，让用户知道"已选但要翻回去看"
      x = rect.width / 2;
      y = rect.height / 2 - 20;
    }
    dayCountEl.style.left = x + 'px';
    dayCountEl.style.top = y + 'px';
    dayCountEl.textContent = '共计 ' + n + ' 天';
    dayCountEl.classList.add('show');
  }
  // 在 renderGrid 后标记 range 格：两个端点深绿（.range），端点之间的日期更浅绿（.range-between）
  function markRange() {
    if (!gridEl) return;
    var cells = gridEl.querySelectorAll('.cell');
    if (rangeSel.length === 0) return;
    // 端点集合
    var endpoints = {};
    for (var j = 0; j < rangeSel.length; j++) endpoints[dateKey(rangeSel[j])] = true;
    // 两个端点之间的时间区间（含跨月；strict 中间不含端点）
    var tStart = null, tEnd = null;
    if (rangeSel.length === 2) {
      var ta = new Date(rangeSel[0].y, rangeSel[0].m - 1, rangeSel[0].d).getTime();
      var tb = new Date(rangeSel[1].y, rangeSel[1].m - 1, rangeSel[1].d).getTime();
      tStart = Math.min(ta, tb);
      tEnd = Math.max(ta, tb);
    }
    for (var i = 0; i < cells.length; i++) {
      var k = dateKey({ y: +cells[i].dataset.y, m: +cells[i].dataset.m, d: +cells[i].dataset.d });
      if (endpoints[k]) {
        cells[i].classList.add('range');
      } else if (tStart !== null) {
        var tc = new Date(+cells[i].dataset.y, +cells[i].dataset.m - 1, +cells[i].dataset.d).getTime();
        if (tc > tStart && tc < tEnd) cells[i].classList.add('range-between');
      }
    }
  }

function selectCell(div) {
  var y = +div.dataset.y, m = +div.dataset.m, d = +div.dataset.d;
  if (div.classList.contains('other')) {
    // v1.7.2 需求 8：跨月其他格 → 切到目标月，并 addRange 该日
    // 让"9月 X + 10月 2"这类跨月选择一次点完，算天数不卡住
    S.year = y; S.month = m;
    renderAll();
    // v1.7.5：已选两格时清空重选，同时清掉天数浮层（否则旧的「共计 N 天」残留显示）
    if (rangeSel.length >= 2) {
      rangeSel = [];
      if (dayCountEl) { dayCountEl.classList.remove('show'); dayCountEl.textContent = ''; }
    }
    addRange(y, m, d);
    return;
  }
  // 需求6：已选两格时，第三下点击只解除、不选中新格
  if (rangeSel.length >= 2) { clearRange(); return; }
  addRange(y, m, d);
}

/* ===== v1.6.2 特别关注输入栏 =====
 * 设计要点：
 *   1) #remindInput 是 #widget 的直接子元素（position:absolute 相对 #widget 定位），
 *      所以坐标参考系应该是 widgetEl 不是 calendarEl（v1.7.0 初版误用后者导致输入栏偏移）
 *   2) 跨月 other 单元格右键会触发 renderAll()，原 cellDiv 已被销毁，
 *      必须按 (y,m,d) 重新查询当前 grid 里的 cell 元素再定位 */
function findCellEl(y, m, d) {
  if (!gridEl) return null;
  var cells = gridEl.querySelectorAll('.cell');
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i];
    if (+c.dataset.y === y && +c.dataset.m === m && +c.dataset.d === d) return c;
  }
  return null;
}
function openRemindInput(y, m, d) {
  pendingRemind = { y: y, m: m, d: d };
  if (remindDateLabelEl) remindDateLabelEl.textContent = y + '/' + pad2(m) + '/' + pad2(d);
  if (remindTextEl) remindTextEl.value = '';
  if (remindInputEl) {
    remindInputEl.classList.add('show');
    var cell = findCellEl(y, m, d);
    if (cell) positionRemindInput(cell);
  }
  // 自动聚焦
  setTimeout(function () { if (remindTextEl) remindTextEl.focus(); }, 30);
}
function hideRemindInput() {
  if (!remindInputEl) return;
  remindInputEl.classList.remove('show');
  pendingRemind = null;
}
function positionRemindInput(cellDiv) {
  if (!remindInputEl || !widgetEl || !cellDiv) return;
  // v1.7.0 bugfix：参考系改为 widgetEl（#remindInput 的真正 offsetParent）
  var rect = widgetEl.getBoundingClientRect();
  var cr = cellDiv.getBoundingClientRect();
  // v1.7.3：改用输入栏实际尺寸（offsetWidth/Height），
  // 放大模式下 #remindInput 是 260px 宽 + 更大 padding/输入框/按钮，
  // 硬编码 200×110 会让右侧格子右键时输入栏越界被 overflow:hidden 裁掉。
  var w = remindInputEl.offsetWidth || 200;
  var h = remindInputEl.offsetHeight || 110;
  var x = cr.right - rect.left + 6;          // 默认放单元格右侧
  if (x + w > rect.width - 4) x = cr.left - rect.left - w - 6;   // 溢出则放左侧
  if (x < 4) x = 4;
  var y = cr.top - rect.top + (cr.height - h) / 2;               // 垂直居中
  if (y < 4) y = 4;
  if (y + h > rect.height - 4) y = rect.height - h - 4;
  remindInputEl.style.left = x + 'px';
  remindInputEl.style.top = y + 'px';
}
function localAddReminder(y, m, d, text) {
  // 浏览器预览（无 Electron api）下的本地内存模拟：单元格同样会变黄，方便预览验证
  reminders.push({
    id: 'local_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    y: y, m: m, d: d,
    text: String(text || '').slice(0, MAX_REMINDER_TEXT),
    createdAt: Date.now(), snoozeUntil: 0, ackedDate: ''
  });
  renderGrid();
}

/* v1.7.11：轻量提示条（数量/字数上限等） */
var toastTimer = null;
function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    if (toastEl) toastEl.classList.remove('show');
    toastTimer = null;
  }, 2200);
}

function confirmRemindInput() {
  if (!pendingRemind) return;
  var text = (remindTextEl && remindTextEl.value || '').trim();
  if (!text) { if (remindTextEl) remindTextEl.focus(); return; }
  // v1.7.11 需求 1：硬截到 15 字（主进程也会截一次）
  text = text.slice(0, MAX_REMINDER_TEXT);
  if (window.api && window.api.addReminder) {
    window.api.addReminder({
      y: pendingRemind.y, m: pendingRemind.m, d: pendingRemind.d, text: text
    }).then(function () {}).catch(function () {});
  } else {
    // 浏览器预览：本地内存模拟
    localAddReminder(pendingRemind.y, pendingRemind.m, pendingRemind.d, text);
  }
  hideRemindInput();
}

  /* ===== v1.7.12 关注列表：改为独立窗口 =====
     原实现是 #widget 内的绝对定位 DOM 浮层，无论怎么放开夹紧逻辑都渲染不到 #widget 之外
     （会被主窗口边界裁掉）。现改为独立 BrowserWindow（remindlist.html），
     表头用 -webkit-app-region: drag 交给 Electron 原生拖动，**可拖到屏幕任意位置**。
     数据由主进程经 query 注入，操作（跳转 / 删除）经 IPC 回传，列表变更由主进程推送刷新。 */
  function openReminderList() {
    if (remindInputEl) remindInputEl.classList.remove('show');   // 互斥：隐藏输入栏
    if (window.api && window.api.openReminderListWindow) {
      window.api.openReminderListWindow();
      return;
    }
    // 浏览器预览降级：没有主进程时给个提示（预览模式本就不含桌面特性）
    showToast('关注列表独立窗口需在桌面端运行');
  }
  function closeReminderList() {
    if (window.api && window.api.remindlistClose) window.api.remindlistClose();
  }
  function removeReminderById(id) {
    if (!id) return;
    if (window.api && window.api.removeReminder) {
      window.api.removeReminder(id);
    } else {
      // 浏览器预览：本地内存删（列表窗口在预览模式下不可用，只需刷新日历）
      reminders = reminders.filter(function (r) { return r.id !== id; });
      renderGrid();
    }
  }

  /* ===== 每周起始切换 ===== */
  function updateSwitch() {
    if (wkSwitchEl) wkSwitchEl.className = 'wk-switch ' + (S.startMon ? 'mon' : 'sun');
  }
  function toggleStart() {
    S.startMon = !S.startMon;
    updateSwitch();
    renderAll();
  }

  /* ===== 主题：白日 / 黑夜 两态（v1.6：衣服形状按钮 + 太阳/月亮图标） ===== */
  function syncThemeIcon() {
    var g = document.getElementById('themeIcon');
    if (!g) return;
    if (S.theme === 'dark') {
      // 黑夜：月亮（新月）
      g.innerHTML = '<path d="M14.6 12.4 a 3.6 3.6 0 1 0 -2.4 5.6 a 2.7 3.6 0 1 1 2.4 -5.6 z" fill="currentColor" stroke="none"></path>';
    } else {
      // 白日：太阳（圆 + 4 道光芒，贴胸口大小）
      g.innerHTML = '<circle cx="12" cy="13.5" r="2.2" fill="currentColor" stroke="none"></circle>' +
        '<path d="M12 9.4 L12 10.8"></path>' +
        '<path d="M12 16.2 L12 17.6"></path>' +
        '<path d="M8.4 13.5 L7.6 13.5"></path>' +
        '<path d="M16.4 13.5 L15.6 13.5"></path>';
    }
  }
  function applyTheme() {
    var root = document.documentElement;
    if (S.theme === 'dark') {
      root.dataset.theme = 'dark';
      if (!IS_DESKTOP && themeBtnEl) { themeBtnEl.title = '主题：黑夜（点击切回白日）'; themeBtnEl.classList.add('active'); }
    } else {
      root.dataset.theme = 'light';
      if (!IS_DESKTOP && themeBtnEl) { themeBtnEl.title = '主题：白日（点击切换为黑夜）'; themeBtnEl.classList.remove('active'); }
    }
    if (!IS_DESKTOP) syncThemeIcon();   // v2.2.0：桌面模式下换肤键已改为锁键，图标由锁逻辑接管
  }

  /* ===== R3. 托盘 tooltip：农历 + 星期字符串 ===== */
  var WEEK_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  function tooltipString(y, m, d) {
    var solar = Solar.fromYmd(y, m, d);
    var lunar = solar.getLunar();
    var md = lunar.getMonthInChinese() + lunar.getDayInChinese();
    return '农历 ' + md + ' · ' + WEEK_CN[solar.getWeek()];
  }
  function pushTooltip() {
    if (!(window.api && window.api.setTooltip)) return;   // 浏览器预览无 api 时跳过
    var t = new Date();
    window.api.setTooltip(tooltipString(t.getFullYear(), t.getMonth() + 1, t.getDate()));
  }

  /* ===== 事件绑定 ===== */
  function bind() {
    yearSel.addEventListener('change', function () { S.year = +yearSel.value; renderAll(); });
    monthSel.addEventListener('change', function () { S.month = +monthSel.value; renderAll(); });
    $('prevBtn').addEventListener('click', function () { gotoMonth(-1); });
    $('nextBtn').addEventListener('click', function () { gotoMonth(1); });
    $('todayBtn').addEventListener('click', gotoToday);

    wkSwitchEl.addEventListener('click', toggleStart);
    wkSwitchEl.addEventListener('mousedown', function (e) { e.stopPropagation(); });  // 阻止冒泡到标题栏拖拽

    gridEl.addEventListener('click', function (e) {
      var d = e.target.closest('.cell');
      if (d) { selectCell(d); return; }
      // 需求5：点击网格间隙（非单元格）= 取消选中（窗口不关闭）
      if (rangeSel.length) clearRange();
    });
    gridEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var d = e.target.closest('.cell'); if (d) { e.preventDefault(); selectCell(d); }
    });

    // 需求5：点击日历窗口空白区（非格非控件）取消选中
    var bodyEl = $('body');
    if (bodyEl) bodyEl.addEventListener('click', function (e) {
      if (e.target.closest('.cell')) return;
      if (e.target.closest('button, select, #wkSwitch, #dragBar')) return;
      if (e.target.closest('#remindInput')) return;
      if (rangeSel.length) clearRange();
      // 点击空白区时关闭可能打开的关注输入栏
      hideRemindInput();
    });

    /* v2.1.0 跨天保险 2/3：从休眠恢复 / 窗口重新可见 / 重新获得焦点时补一次判定。
     * 后台标签页的 setInterval 会被节流到分钟级甚至停摆，只靠 tick 不够。 */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkDayRollover();
    });
    window.addEventListener('focus', function () { checkDayRollover(); });

    // v1.7.2 需求 9：Esc 键 → 清除日期范围选择 + 关闭关注输入栏
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      // 输入框/弹窗内的 Esc 已有自己处理（remindInput、弹窗）
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (rangeSel.length) { e.preventDefault(); clearRange(); }
      hideRemindInput();
    });

    // v1.6.2 需求 6：单元格右键 → 弹出"定时关注栏"输入关注内容
    gridEl.addEventListener('contextmenu', function (e) {
      var d = e.target.closest('.cell');
      if (!d) return;
      e.preventDefault();
      var y = +d.dataset.y, m = +d.dataset.m, dd = +d.dataset.d;
      // 如果该日期已有关注项：右键等于取消选择（删除）
      var existing = findReminder(y, m, dd);
      if (existing) {
        if (window.api && window.api.removeReminder) {
          window.api.removeReminder(existing.id);
        } else {
          // 浏览器预览：本地删除，单元格恢复原色
          reminders = reminders.filter(function (r) { return r.id !== existing.id; });
          renderGrid();
        }
        return;
      }
      // 跨月 other 单元格：先切到该月，再打开输入栏。
      // 注意：renderAll 后原 d 已脱离 DOM，openRemindInput 会按 (y,m,d) 重新查询 cell。
      if (d.classList.contains('other')) {
        S.year = y; S.month = m; renderAll();
        if (rangeSel.length === 2) showDayCount();
      }
      openRemindInput(y, m, dd);
    });

    // 需求2补充：v1.6.2 需求 5 — 主界面 ✕ 关闭按钮已删除；退出请走托盘右键「⏻ 退出软件」

    // 悬停灯效（性能优化 v1.2）：不再用 JS 逐帧重设 radial-gradient（每帧重排/重绘卡顿），
    // 改为纯 CSS :hover 边框高亮（见 template.html .cell:hover）。litGlow 层保留但不再逐帧写入。
    // 保留：鼠标离开网格时确保无残留（实际上 CSS 已处理）。
    gridEl.addEventListener('mouseleave', function () {
      if (litGlowEl) litGlowEl.style.background = '';
    });

    // R4. 放大 / 还原（双窗口切换）：优先请求主进程 toggleExpand；
    // 浏览器预览无 api 时退回 class toggle 兼容（保留 2.0 无障碍放大）
    $('maxBtn').addEventListener('click', function () {
      if (window.api && window.api.toggleExpand) {
        window.api.toggleExpand();
      } else {
        widgetEl.classList.toggle('max');
      }
    });

    // 主题切换（白日/黑夜两态）；v2.2.0 桌面模式下换肤键已改为锁定键
    themeBtnEl.addEventListener('click', function () {
      if (IS_DESKTOP) { onLockClick(); return; }
      S.theme = (S.theme === 'light') ? 'dark' : 'light';
      applyTheme();
      if (window.api && window.api.setTheme) window.api.setTheme(S.theme);
    });

    // v1.7.12：关注列表按钮点击 → 打开独立窗口（主进程负责去重聚焦）
    if (bookBtnEl) {
      bookBtnEl.addEventListener('click', function (e) {
        e.stopPropagation();
        openReminderList();
      });
    }

    // 顶部拖拽
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    $('dragBar').addEventListener('mousedown', function (e) {
      // R4. Electron 下（window.api 存在）提前退出：改由原生 -webkit-app-region: drag
      // 移动整个 OS 窗口，避免 DOM 拖拽与原生拖拽双重位移抖动。
      if (window.api) return;
      if (e.target.closest('button, #wkSwitch, select')) return;
      if (widgetEl.classList.contains('max')) return;
      dragging = true;
      var r = widgetEl.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      widgetEl.style.position = 'fixed';
      widgetEl.style.left = ox + 'px'; widgetEl.style.top = oy + 'px';
      widgetEl.style.right = 'auto'; widgetEl.style.bottom = 'auto'; widgetEl.style.margin = '0';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      widgetEl.style.left = (ox + e.clientX - sx) + 'px';
      widgetEl.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', function () {
      dragging = false;
      document.body.style.userSelect = '';
    });
  }

  /* ===== v1.6：放大模式窗口边缘 resize 手柄（保证比例不变） =====
     透明无边框窗口在 Windows 上 DWM 常禁用 thickFrame，系统层 resize 不生效。
     这里在渲染层监听 3 个手柄（右下角 + 右边缘 + 下边缘），通过 IPC 让主进程 setBounds，
     比例锁定：'e' / 'se' 按宽度驱动，'s' 按高度驱动，统一折算成宽度再传主进程。 */
  var RESIZE_ASPECT = 340 / 430;
  // v2.2.0 需求2：放大模式内容按 760 设计（与主进程 EXP_DEF_W 一致），zoom = 窗口宽/760。
  var EXPAND_BASE_W = 760;
  // 主进程下发的窗口物理宽高（resize 手柄按物理像素算，zoom 只影响视觉不影响坐标）
  var winSize = { w: EXPAND_BASE_W, h: Math.round(EXPAND_BASE_W / RESIZE_ASPECT) };
  function bindResize() {
    if (!window.api || !window.api.resizeWindow) return;
    var handles = document.querySelectorAll('.resize-handle');
    var active = null;
    handles.forEach(function (h) {
      h.addEventListener('mousedown', function (e) {
        e.preventDefault(); e.stopPropagation();
        active = {
          dir: h.dataset.dir,
          sx: e.screenX, sy: e.screenY,
          // v2.2.0：zoom 会让 offsetWidth 恒等于 760 设计值，改用主进程下发的物理宽
          startW: winSize.w, startH: winSize.h
        };
      });
    });
    window.addEventListener('mousemove', function (e) {
      if (!active) return;
      var dx = e.screenX - active.sx, dy = e.screenY - active.sy;
      var newW;
      if (active.dir === 's') {
        // 下边缘：高度驱动 → 按比例折算宽度
        var newH = active.startH + dy;
        newW = Math.round(newH * RESIZE_ASPECT);
      } else {
        // 'e' / 'se'：宽度驱动
        newW = active.startW + dx;
      }
      newW = Math.max(340, Math.min(newW, 1400));
      window.api.resizeWindow(newW);
    });
    window.addEventListener('mouseup', function () { active = null; });
  }

  /* ===== 信息条：时钟 / 日期 / 农历 ===== */
  function infoBarLunar(y, m, d) {
    var solar = Solar.fromYmd(y, m, d);
    var lunar = solar.getLunar();
    var monthCn = lunar.getMonthInChinese();
    var dayCn = lunar.getDayInChinese();
    var jq = lunar.getJieQi() || '';
    var lF = lunar.getFestivals() || [];
    var sF = solar.getFestivals() || [];
    var tbl = holidayTable(y);
    var hol = tbl ? tbl.find(m, d) : null;
    if (hol && hol.idx === 1) return monthCn + ' · ' + hol.name;        // 节首日
    if (jq) return monthCn + dayCn + ' · ' + jq;                        // 节气
    if (!(hol && hol.idx === 1)) {
      if (NATIONAL[m] && NATIONAL[m][d]) return monthCn + ' · ' + NATIONAL[m][d];
      if (lF[0] && isKeep(lF[0])) return monthCn + ' · ' + (ALIAS[lF[0]] || lF[0]);
      if (sF[0] && isKeep(sF[0])) return monthCn + ' · ' + (ALIAS[sF[0]] || sF[0]);
    }
    return monthCn + dayCn;
  }
  function updateInfo() {
    var t = new Date();
    var y = t.getFullYear(), m = t.getMonth() + 1, d = t.getDate();
    var dateEl = $('infoDate');
    if (dateEl) dateEl.textContent = y + ' 年 ' + pad2(m) + ' 月 ' + pad2(d) + ' 日';
    var lunarEl = $('infoLunar');
    if (lunarEl) lunarEl.textContent = infoBarLunar(y, m, d);
  }
  function updateClock() {
    var t = new Date();
    var clk = $('clkTime');
    if (clk) clk.textContent = pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
    // R3. 跨午夜 / 日期变化时才重新推送 tooltip（避免每秒无效 IPC）
    var dk = dayKeyOf(t.getFullYear(), t.getMonth() + 1, t.getDate());
    if (dk !== lastTipKey) { lastTipKey = dk; pushTooltip(); }
    /* v2.1.0：原来是 `if (时===0 && 分===0 && 秒===0) updateInfo()` —— 系统休眠或
     * 定时器被节流时会整个跳过那一秒，日历就永远停在昨天。改成日期键比较后，
     * 只要这 1 秒的 tick 有任意一次落在"新的一天"就会自愈。 */
    if (dk !== lastDayKey) { lastDayKey = dk; onDayRollover(); }
  }

  /* ===== 年份/月份下拉填充 ===== */
  function fillSelectors() {
    var t = todayParts();     // 实时：不能用冻结的 now
    var yi = t.y, ya = yi - 50, yb = yi + 50;
    var yh = '';
    for (var y = ya; y <= yb; y++) yh += '<option value="' + y + '"' + (y === yi ? ' selected' : '') + '>' + y + '</option>';
    yearSel.innerHTML = yh;
    var mh = '';
    for (var mm = 1; mm <= 12; mm++) mh += '<option value="' + mm + '">' + pad2(mm) + '</option>';
    monthSel.innerHTML = mh;
    yearSel.value = yi;
    monthSel.value = t.m;
  }

  /* ===== v1.6：托盘右键菜单驱动（订阅主进程下发的事件） ===== */
  function bindTrayEvents() {
    if (!window.api) return;
    if (window.api.onThemeChanged) {
      window.api.onThemeChanged(function (mode) {
        S.theme = (mode === 'dark') ? 'dark' : 'light';
        applyTheme();
      });
    }
    if (window.api.onGotoYm) {
      window.api.onGotoYm(function (y, m, d) { gotoYm(y, m, d); });
    }
    // v2.2.0 需求7：每次打开日历回到当前月份（只重置年/月，不打扰用户选中的日期）
    if (window.api.onResetMonth) {
      window.api.onResetMonth(function () {
        var t = new Date();
        if (S.year !== t.getFullYear() || S.month !== t.getMonth() + 1) {
          S.year = t.getFullYear();
          S.month = t.getMonth() + 1;
          renderAll();
        }
      });
    }
    if (window.api.onRemindersChanged) {
      window.api.onRemindersChanged(function (list) {
        reminders = (list || []).slice();
        renderGrid();
        // 关注列表已改为独立窗口，主进程会直接推送数据给 remindlist.html，这里无需处理
      });
    }
    // v1.7.9：托盘"查看/管理" → 已在主进程直接 openReminderListWindow()，此处无需订阅
    /* v1.7.11 严重 bug 修复（放大一直无效）：
     * 之前放大只让主进程把 OS 窗口撑大，渲染层的 #widget 却没被加上 .max 类，
     * 于是内容还是 340×430 缩在大透明窗中间，看起来就是"没放大"。
     * 现在由主进程在尺寸状态变化后推送 expand-changed，这里只负责同步类名。 */
    if (window.api.onExpandChanged) {
      window.api.onExpandChanged(function (expanded) {
        if (!widgetEl) return;
        widgetEl.classList.toggle('max', !!expanded);
        // v2.3.2 需求3：放大镜图标按钮的 title / aria 随状态切换（加号=放大、减号=缩小）
        var mb = $('maxBtn');
        if (mb) {
          var on = !!expanded;
          mb.title = on ? '缩小' : '放大';
          mb.setAttribute('aria-label', on ? '缩小' : '放大');
        }
        // 关注列表已改独立窗口，此处无需重定位；输入栏在显示中时重新定位即可
        if (remindInputEl && remindInputEl.classList.contains('show')) {
          var k = pendingRemind;
          if (k) { var c = findCellEl(k.y, k.m, k.d); if (c) positionRemindInput(c); }
        }
      });
    }
    // v2.2.0 需求2：放大模式等比缩放 —— 主进程每次 resize/showMini/showExpanded 都会
    // 下发窗口物理宽高；这里据此设 CSS 变量 --uizoom，配合 CSS 的 #widget.max{zoom:...}
    // 让固定 760 设计的内容随窗口等比缩放（修掉"窗口缩小内容不变被裁"）。
    if (window.api.onWinSize) {
      window.api.onWinSize(function (s) {
        if (!s || typeof s.width !== 'number') return;
        winSize.w = s.width;
        winSize.h = (typeof s.height === 'number') ? s.height : Math.round(s.width / RESIZE_ASPECT);
        document.documentElement.style.setProperty('--uizoom', (s.width / EXPAND_BASE_W).toFixed(5));
      });
    }
  }

  /* ===== v1.6.2：特别关注输入栏 DOM 绑定 ===== */
  function bindRemindInput() {
    if (!remindInputEl) return;
    if (remindOkEl) remindOkEl.addEventListener('click', confirmRemindInput);
    if (remindCancelEl) remindCancelEl.addEventListener('click', hideRemindInput);
    if (remindTextEl) {
      remindTextEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); confirmRemindInput(); }
        else if (e.key === 'Escape') { e.preventDefault(); hideRemindInput(); }
      });
    }
  }

  /* ===== v2.2.0 需求4：桌面插件模式 =====
   * 桌面模式下：隐藏信息条 + 放大按钮，把换肤键改成锁定键，绑定 IPC 拖动。
   * 拖动只认顶部功能栏（#dragBar），锁定态拒绝；移动按屏幕坐标绝对定位（主进程夹取）。 */
  var LOCKED_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="5" y="11" width="14" height="9" rx="2.5"></rect>' +
    '<path d="M8 11 V7.5 a4 4 0 0 1 8 0 V11"></path></svg>';
  var UNLOCKED_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="5" y="11" width="14" height="9" rx="2.5"></rect>' +
    '<path d="M8 11 V7.5 a4 4 0 0 1 7.6 -1.4"></path></svg>';
  function onLockClick() {
    if (window.api && window.api.desktopLockToggle) window.api.desktopLockToggle();
  }
  function setDesktopLocked(locked) {
    desktopLocked = !!locked;
    if (!themeBtnEl) return;
    themeBtnEl.innerHTML = locked ? LOCKED_SVG : UNLOCKED_SVG;
    themeBtnEl.classList.toggle('active', !!locked);
    themeBtnEl.title = locked ? '已锁定（点击解锁后可拖动）' : '未锁定（点击锁定后不可拖动）';
  }
  function bindDesktopDrag() {
    if (!window.api || !window.api.desktopDragStart) return;
    var bar = $('dragBar');
    if (!bar) return;
    var dragging = false;
    bar.addEventListener('mousedown', function (e) {
      if (desktopLocked) return;
      if (e.target && e.target.closest && e.target.closest('button, select, #wkSwitch')) return;
      dragging = true;
      window.api.desktopDragStart(e.screenX, e.screenY);
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      window.api.desktopDragMove(e.screenX, e.screenY);
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      window.api.desktopDragEnd();
    });
  }
  function setupDesktopMode() {
    if (!IS_DESKTOP) return;
    document.body.classList.add('desktop-mode');
    var infoBar = $('infoBar');
    if (infoBar) infoBar.style.display = 'none';
    var maxBtn = $('maxBtn');
    if (maxBtn) maxBtn.style.display = 'none';
    setDesktopLocked(false);
    bindDesktopDrag();
    if (window.api && window.api.onDesktopLocked) {
      window.api.onDesktopLocked(function (locked) { setDesktopLocked(locked); });
    }
  }

  function init() {
    // 供主进程在窗口失焦（点击软件外）时清除日期选中（需求5）
    window.__clearRange = function () { if (rangeSel.length) clearRange(); };

    widgetEl = $('widget');
    gridEl = $('grid');
    headerEl = $('weekHeader');
    yearSel = $('yearSel');
    monthSel = $('monthSel');
    wkSwitchEl = $('wkSwitch');
    bgMonthEl = $('bgMonth');
    calendarEl = $('calendar');
    litGlowEl = $('litGlow');
    dayCountEl = $('dayCount');
    themeBtnEl = $('themeBtn');
    remindInputEl = $('remindInput');
    remindDateLabelEl = $('remindDateLabel');
    remindTextEl = $('remindText');
    remindOkEl = $('remindOk');
    remindCancelEl = $('remindCancel');
    // v1.7.12 关注列表已改独立窗口，主窗口内仅保留书按钮
    bookBtnEl = $('bookBtn');
    toastEl = $('toast');

    // v1.6：Electron 下去掉 body 内边距，使 340×430 的 widget 精确填满 mini 窗口
    // （expanded 窗口更大，widget 居中浮起；浏览器预览保留 24px 留白美观）
    if (window.api) {
      document.body.style.padding = '0';
      document.body.style.overflow = 'hidden';
      // v1.7.2：标记 Electron 环境，放大模式下 widget 精确填满窗口（区别于浏览器预览的等比收拢）
      document.body.classList.add('electron');
    }

    applyTheme();
    fillSelectors();
    bind();
    setupDesktopMode();    // v2.2.0 需求4：桌面模式下隐藏信息条/放大键、换肤键改锁定键
    bindResize();           // v1.6：放大模式窗口边缘 resize（保证比例不变）
    bindTrayEvents();       // v1.6：订阅主进程（托盘右键菜单）下发的事件
    bindRemindInput();      // v1.6.2：特别关注输入栏事件
    // v1.7.17 需求8：主窗右键弹菜单（去托盘后的菜单入口）。
    // 排除单元格（右键=特别关注输入/删除）与输入框（右键=系统编辑菜单）。
    document.addEventListener('contextmenu', function (e) {
      if (e.target && e.target.closest && e.target.closest('.cell')) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      if (window.api && window.api.mainShowMenu) window.api.mainShowMenu();
    });
    updateSwitch();
    renderAll();
    updateInfo();
    updateClock();
    // v1.7.2 预览演示：无 Electron 时预置一个"特别关注"示例格，让黄格效果一眼可见（右键可删）
    if (!window.api && reminders.length === 0) {
      var _now = new Date();
      var _last = new Date(_now.getFullYear(), _now.getMonth() + 1, 0).getDate();
      var _dd = Math.min(_now.getDate() + 3, _last);
      localAddReminder(_now.getFullYear(), _now.getMonth() + 1, _dd, '预览示例（右键可删）');
    }
    // v1.6.2：从主进程拉取已有列表（首次启动时同步）
    if (window.api && window.api.listReminders) {
      window.api.listReminders().then(function (list) {
        reminders = (list || []).slice();
        renderGrid();
      });
    }
    // v2.1.0：Electron 下拉取运行时节假日数据（内置表只是首帧/预览兜底）
    if (window.api && window.api.getHolidayData) {
      window.api.getHolidayData().then(function (res) {
        if (res && res.data) applyHolidayData(res.data);
      }).catch(function () {});
    }
    if (window.api && window.api.onHolidayDataChanged) {
      window.api.onHolidayDataChanged(function (payload) {
        if (payload && payload.data) applyHolidayData(payload.data);
      });
    }

    setInterval(updateClock, 1000);
  }
  /* v2.1.0 自测钩子（无害）：暴露内部状态与跨天/节假日函数，
   * 便于 QA 在 DevTools 里直接触发 __CAL__.onDayRollover() 验证跨天，
   * 或 __CAL__.applyHolidayData({years:{...}}) 验证数据热替换。 */
  window.__CAL__ = {
    S: S,
    isToday: isToday,
    onDayRollover: onDayRollover,
    checkDayRollover: checkDayRollover,
    applyHolidayData: applyHolidayData,
    todayParts: todayParts,
    HOLIDAY_YEARS: HOLIDAY_YEARS
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
