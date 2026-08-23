/* 任务栏部件逻辑：实时时间(24h) + 日期(YYYY/M/D) + 悬停农历 + 点击打开日历 */
(function () {
  'use strict';
  var Solar = window.Solar, Lunar = window.Lunar;
  var tEl = document.getElementById('t');
  var dEl = document.getElementById('d');
  var tipEl = document.getElementById('tip');
  var WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  var lastDateKey = '';   // 缓存“年-月-日”，仅变化时才重算农历，避免每秒 Solar.fromYmd 开销
  var monthCache = {};    // 整月农历缓存：key = 'Y-M'，value = { day: '农历xx' }
  function lunarOf(y, m, d) {
    var key = y + '-' + m;
    if (!monthCache[key]) {
      monthCache[key] = {};
      var dim = new Date(y, m, 0).getDate();
      for (var i = 1; i <= dim; i++) {
        try {
          var s = Solar.fromYmd(y, m, i);
          var l = s.getLunar();
          monthCache[key][i] = l.getMonthInChinese() + l.getDayInChinese();
        } catch (e) { monthCache[key][i] = ''; }
      }
      // 仅保留最近 3 个月缓存，防内存泄漏
      var keys = Object.keys(monthCache);
      while (keys.length > 3) { delete monthCache[keys.shift()]; }
    }
    return monthCache[key][d] || '';
  }
  function update() {
    var now = new Date();
    tEl.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());          // 24 小时制（每秒文本更新，无 layout 重排）
    var dk = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    if (dk !== lastDateKey) {                                                   // 日期变化才更新日期+农历
      lastDateKey = dk;
      dEl.textContent = now.getFullYear() + '/' + (now.getMonth() + 1) + '/' + now.getDate();
      if (Solar && Lunar) {
        try {
          var lunar = lunarOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
          tipEl.textContent = '农历 ' + lunar + ' · ' + WEEK[now.getDay()];
        } catch (e) { tipEl.textContent = ''; }
      }
    }
  }

  // 主进程通过 executeJavaScript 调用，切换深浅主题（黑/白字）
  window.__applyTheme = function (dark) {
    document.body.className = dark ? 'theme-dark' : 'theme-light';
  };

  // 主进程在 FFI 不可用（极少数环境连原生模块都禁）时调用：进入"同色覆盖"兜底模式。
  // 此时不隐藏原生时钟，而是用与任务栏同色的不透明背景物理盖住它。
  // 背景色已由 .theme-* 提供，这里仅确保无任何半透明/模糊叠加。
  window.__coverMode = function (on) {
    document.body.classList.toggle('cover-mode', !!on);
  };

  if (window.api && window.api.openCalendar) {
    document.getElementById('cw').addEventListener('click', function () {
      window.api.openCalendar();
    });
  }

  // 右键菜单（替换系统托盘：打开 / 退出）
  var menuEl = document.getElementById('tb-menu');
  var cwEl = document.getElementById('cw');
  if (menuEl) {
    cwEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      menuEl.style.display = (menuEl.style.display === 'block') ? 'none' : 'block';
    });
    document.addEventListener('click', function (e) {
      if (!menuEl.contains(e.target) && e.target !== cwEl) menuEl.style.display = 'none';
    });
    var miOpen = document.getElementById('miOpen');
    var miExit = document.getElementById('miExit');
    if (miOpen) miOpen.addEventListener('click', function (e) {
      e.stopPropagation(); menuEl.style.display = 'none';
      if (window.api && window.api.openCalendar) window.api.openCalendar();
    });
    if (miExit && window.api && window.api.exitApp) miExit.addEventListener('click', function (e) {
      e.stopPropagation(); menuEl.style.display = 'none';
      window.api.exitApp();
    });
  }

  update();
  // 性能优化：仅当“分”变化时更新文本（时钟显示到分钟即可，避免每秒重绘）
  // 但用户可见秒级变化更自然，这里保留每秒更新但只更新文本节点（不触发 layout 重排）。
  setInterval(update, 1000);
})();
