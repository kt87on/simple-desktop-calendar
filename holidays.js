'use strict';

/*
 * holidays.js —— 法定节假日数据（主进程用，供托盘右键菜单「节日」子菜单）
 * ---------------------------------------------------------------------
 * 数据来源：与 app.js 内 HOLIDAYS_2026 保持一致（2026 国务院办公厅安排）。
 * 只取「节首日」用于展示与跳转；调休补班日不进本模块。
 * 跨年兜底：当前年所有节首日已过完则追加次年元旦（1/1）。
 *
 * 说明：本模块不依赖农历库，仅做纯公历日期比对，主进程零额外依赖。
 */

// 2026 法定节假日（起始日）
var HOLIDAY_STARTS_2026 = [
  { y: 2026, m: 1, d: 1, name: '元旦' },
  { y: 2026, m: 2, d: 15, name: '春节' },
  { y: 2026, m: 4, d: 4, name: '清明节' },
  { y: 2026, m: 5, d: 1, name: '劳动节' },
  { y: 2026, m: 6, d: 19, name: '端午节' },
  { y: 2026, m: 9, d: 25, name: '中秋节' },
  { y: 2026, m: 10, d: 1, name: '国庆节' }
];

// 跨年兜底（次年元旦）
var HOLIDAY_NEXT_YEAR = [
  { y: 2027, m: 1, d: 1, name: '元旦' }
];

var ALL = HOLIDAY_STARTS_2026.concat(HOLIDAY_NEXT_YEAR);

// 某天的「当天零点」时间戳（用于稳定比较，忽略时分秒）
function midnight(y, m, d) {
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

// 当前年份的所有节首日（不过滤已过）
function thisYearHolidays(now) {
  var curYear = now.getFullYear();
  return ALL.filter(function (h) { return h.y === curYear; });
}

// 当前年份还未过的节首日，最多 n 个（按时间顺序，剩几个返回几个）
function nextHolidaysThisYear(now, n) {
  n = n || 3;
  var curYear = now.getFullYear();
  var today = midnight(curYear, now.getMonth() + 1, now.getDate());
  var out = [];
  for (var i = 0; i < ALL.length && out.length < n; i++) {
    var h = ALL[i];
    if (h.y !== curYear) continue;       // 只看当前年份
    var t = midnight(h.y, h.m, h.d);
    if (t < today) continue;              // 已过
    var diff = Math.round((t - today) / 86400000);
    out.push({ name: h.name, diffDays: diff, y: h.y, m: h.m, d: h.d });
  }
  return out;
}

// 计算从 now（Date 实例）起，未来 n 个节日的 {name, diffDays, y, m, d}
// diffDays：距今天的天数（0 = 今天，1 = 明天，依此类推）
function nextHolidays(now, n) {
  n = n || 5;
  var today = midnight(now.getFullYear(), now.getMonth() + 1, now.getDate());
  var out = [];
  for (var i = 0; i < ALL.length && out.length < n; i++) {
    var h = ALL[i];
    var t = midnight(h.y, h.m, h.d);
    if (t < today) continue;      // 已过
    var diff = Math.round((t - today) / 86400000);
    out.push({ name: h.name, diffDays: diff, y: h.y, m: h.m, d: h.d });
  }
  return out;
}

module.exports = {
  nextHolidays: nextHolidays,
  thisYearHolidays: thisYearHolidays,
  nextHolidaysThisYear: nextHolidaysThisYear
};