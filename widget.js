/* 任务栏部件逻辑：实时时间(24h) + 日期(YYYY/M/D) + 悬停农历 + 点击打开日历 */
(function () {
  'use strict';
  var Solar = window.Solar, Lunar = window.Lunar;
  var tEl = document.getElementById('t');
  var dEl = document.getElementById('d');
  var tipEl = document.getElementById('tip');
  var WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function update() {
    var now = new Date();
    tEl.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());          // 24 小时制
    dEl.textContent = now.getFullYear() + '/' + (now.getMonth() + 1) + '/' + now.getDate(); // 年/月/日
    if (Solar && Lunar) {
      try {
        var s = Solar.fromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
        var l = s.getLunar();
        tipEl.textContent = '农历 ' + l.getMonthInChinese() + l.getDayInChinese() + ' · ' + WEEK[s.getWeek()];
      } catch (e) { tipEl.textContent = ''; }
    }
  }

  // 主进程通过 executeJavaScript 调用，切换深浅主题（黑/白字）
  window.__applyTheme = function (dark) {
    document.body.className = dark ? 'theme-dark' : 'theme-light';
  };

  if (window.api && window.api.openCalendar) {
    document.getElementById('cw').addEventListener('click', function () {
      window.api.openCalendar();
    });
  }

  update();
  setInterval(update, 1000);
})();
