/* 桌面日历 3.0 —— 在 2.0 视觉/功能基础上，新增：
   R3. 计算农历+星期字符串并推送给托盘 tooltip（ipcRenderer.send('set-tooltip', str)）
   R4. 放大按钮改为请求主进程切换 mini/expanded 双窗口；拖拽结束请求吸附；
       Electron 下跳过 DOM 拖拽（改由原生 -webkit-app-region 移动 OS 窗口）
   全部 2.0 功能（周起始、农历/节气/节假日白名单、灯效、主题、放大兼容等）原样保留。
*/
(function () {
  'use strict';
  var Solar = window.Solar, Lunar = window.Lunar;

  /* ===== 2026 国务院办公厅节假日数据 ===== */
  var HOLIDAYS_2026 = (function () {
    var H = {
      1:  [{ s: 1,  e: 3,  name: '元旦' }],
      2:  [{ s: 15, e: 23, name: '春节' }],
      4:  [{ s: 4,  e: 6,  name: '清明节' }],
      5:  [{ s: 1,  e: 5,  name: '劳动节' }],
      6:  [{ s: 19, e: 21, name: '端午节' }],
      9:  [{ s: 25, e: 27, name: '中秋节' }],
      10: [{ s: 1,  e: 7,  name: '国庆节' }]
    };
    var WK = { 1: [4], 2: [14, 28], 5: [9], 9: [20], 10: [10] };
    function find(m, d) {
      var segs = H[m];
      if (!segs) return null;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (d >= s.s && d <= s.e) return { name: s.name, idx: d - s.s + 1, total: s.e - s.s + 1, s: s.s, e: s.e };
      }
      return null;
    }
    function isWork(m, d) {
      var a = WK[m];
      return !!a && a.indexOf(d) >= 0;
    }
    return { find: find, isWork: isWork };
  })();

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

    var hol = HOLIDAYS_2026.find(m, d);
    var isHoliday = !!hol;
    var isWork = HOLIDAYS_2026.isWork(m, d);

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
  var now = new Date();
  var S = {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    selY: now.getFullYear(),
    selM: now.getMonth() + 1,
    selD: now.getDate(),
    startMon: true,
    theme: 'default'
  };

  var $ = function (id) { return document.getElementById(id); };
  var gridEl, headerEl, yearSel, monthSel, wkSwitchEl, widgetEl, lastLit = -1, bgMonthEl, calendarEl, litGlowEl, themeBtnEl;
  var lastTipKey = '';   // R3：上次推送 tooltip 的日期键，跨午夜才重新推送

  function isToday(y, m, d) { return y === now.getFullYear() && m === now.getMonth() + 1 && d === now.getDate(); }
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

      var chip = '';
      if (inf.isHoliday) chip = '<span class="chip chip-rest">休</span>';
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
    yearSel.value = S.year;
    monthSel.value = S.month;
    if (bgMonthEl) bgMonthEl.textContent = S.month;
  }

  function renderAll() { renderWeekHeader(); renderGrid(); }

  /* ===== 操作 ===== */
  function gotoMonth(delta) {
    var m = S.month + delta, y = S.year;
    if (m > 12) { m = 1; y++; }
    if (m < 1) { m = 12; y--; }
    S.year = y; S.month = m; renderAll();
  }
  function gotoToday() {
    S.year = now.getFullYear(); S.month = now.getMonth() + 1;
    S.selY = now.getFullYear(); S.selM = now.getMonth() + 1; S.selD = now.getDate();
    renderAll();
  }
  function select(y, m, d) { S.selY = y; S.selM = m; S.selD = d; renderGrid(); }
  function selectCell(div) {
    var y = +div.dataset.y, m = +div.dataset.m, d = +div.dataset.d;
    if (div.classList.contains('other')) { S.year = y; S.month = m; renderAll(); }
    select(y, m, d);
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

  /* ===== 主题：默认 / 跟随系统（仅覆盖 --accent，其余由 color-mix 派生） ===== */
  function applyTheme() {
    var root = document.documentElement;
    if (S.theme === 'system' && window.__ACCENT__) {
      root.style.setProperty('--accent', window.__ACCENT__);
      if (themeBtnEl) { themeBtnEl.title = '主题：跟随系统（点击切回默认）'; themeBtnEl.classList.add('active'); }
    } else {
      root.style.removeProperty('--accent');
      if (themeBtnEl) { themeBtnEl.title = '主题：默认（点击切换为跟随系统）'; themeBtnEl.classList.remove('active'); }
    }
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
      var d = e.target.closest('.cell'); if (d) selectCell(d);
    });
    gridEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var d = e.target.closest('.cell'); if (d) { e.preventDefault(); selectCell(d); }
    });

    // 悬停灯效：以鼠标所指单元格为中心，局部椭圆光斑覆盖「中心格 + 上下左右 4 格」，
    // 中心最亮，向外渐变至完全透明（不贯穿整行整列）
    gridEl.addEventListener('mousemove', function (e) {
      if (!litGlowEl || !calendarEl) return;
      var cell = e.target.closest('.cell');
      if (!cell) return;                       // 落在格间隙时不刷新（保留上一格光斑）
      var rect = calendarEl.getBoundingClientRect();
      var cr = cell.getBoundingClientRect();
      var ccx = (cr.left + cr.width / 2) - rect.left;
      var ccy = (cr.top + cr.height / 2) - rect.top;
      var gap = 3;
      var rx = cr.width * 1.5 + gap;           // 覆盖到左右相邻格外缘
      var ry = cr.height * 1.5 + gap;          // 覆盖到上下相邻格外缘
      litGlowEl.style.background =
        'radial-gradient(ellipse ' + rx + 'px ' + ry + 'px at ' + ccx + 'px ' + ccy + 'px,'
        + ' rgba(120,160,240,0.55) 0%, rgba(120,160,240,0.18) 35%, rgba(120,160,240,0) 100%)';
    });
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

    // 主题切换
    themeBtnEl.addEventListener('click', function () {
      S.theme = (S.theme === 'default') ? 'system' : 'default';
      applyTheme();
    });

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
      // R4. 拖拽结束（鼠标松开）请求主进程把窗口吸附到最近屏幕边（仅 expanded 模式生效）
      if (window.api && window.api.requestSnap) window.api.requestSnap();
    });
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
    var hol = HOLIDAYS_2026.find(m, d);
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
    if (t.getHours() === 0 && t.getMinutes() === 0 && t.getSeconds() === 0) updateInfo();
    // R3. 跨午夜 / 日期变化时才重新推送 tooltip（避免每秒无效 IPC）
    var dk = t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate();
    if (dk !== lastTipKey) { lastTipKey = dk; pushTooltip(); }
  }

  /* ===== 年份/月份下拉填充 ===== */
  function fillSelectors() {
    var yi = now.getFullYear(), ya = yi - 50, yb = yi + 50;
    var yh = '';
    for (var y = ya; y <= yb; y++) yh += '<option value="' + y + '"' + (y === yi ? ' selected' : '') + '>' + y + '</option>';
    yearSel.innerHTML = yh;
    var mh = '';
    for (var mm = 1; mm <= 12; mm++) mh += '<option value="' + mm + '">' + pad2(mm) + '</option>';
    monthSel.innerHTML = mh;
    yearSel.value = yi;
    monthSel.value = now.getMonth() + 1;
  }

  function init() {
    widgetEl = $('widget');
    gridEl = $('grid');
    headerEl = $('weekHeader');
    yearSel = $('yearSel');
    monthSel = $('monthSel');
    wkSwitchEl = $('wkSwitch');
    bgMonthEl = $('bgMonth');
    calendarEl = $('calendar');
    litGlowEl = $('litGlow');
    themeBtnEl = $('themeBtn');

    // R4. Electron 下去掉 body 内边距，使 430×540 的 widget 精确填满 mini 窗口
    // （expanded 窗口更大，widget 居中浮起；浏览器预览保留 24px 留白美观）
    if (window.api) {
      document.body.style.padding = '0';
      document.body.style.overflow = 'hidden';
    }

    applyTheme();
    fillSelectors();
    bind();
    updateSwitch();
    renderAll();
    updateInfo();
    updateClock();          // 内含首次 tooltip 推送
    setInterval(updateClock, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
