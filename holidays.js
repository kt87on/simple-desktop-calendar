'use strict';

/*
 * holidays.js —— 法定节假日数据（主进程用，供托盘右键菜单「节日」子菜单）
 * ---------------------------------------------------------------------
 * v2.1.0 重构：数据不再硬编码在本文件，改由 holiday-store.js 统一持有
 *   （userData/holidays.json，联网可更新；读不到时回退出厂内置 2026 数据）。
 * 这样「每年自动检测 → 弹窗确认 → 联网更新」之后，托盘菜单与日历主体拿到的
 * 是同一份数据，不会再出现"日历更新了、菜单还是旧的"。
 *
 * 对外导出签名保持 100% 兼容（nextHolidays / thisYearHolidays / nextHolidaysThisYear），
 * 另增 rangeOf(name, year)（供 electron-main.js 菜单文案取日期区间）与
 * setData(data)（主进程更新后热替换）。
 *
 * 说明：本模块不依赖农历库，仅做纯公历日期比对，主进程零额外依赖。
 */

const store = require('./holiday-store');

/* ALL 的缓存：数据源被替换（setData）后必须置空重算 */
let _allCache = null;

/**
 * 把 store 里的「年 → 放假期段」展开成扁平的节首日列表。
 * 每年每个放假期段只取起始日（菜单只需要"还有几天到 X 节"）。
 * partial 年份（内置跨年兜底）同样列出 —— 用户至少要能看到元旦。
 */
function buildAll() {
  if (_allCache) return _allCache;
  const out = [];
  try {
    const data = store.getData();
    const years = (data && data.years) || {};
    for (const yk in years) {
      if (!Object.prototype.hasOwnProperty.call(years, yk)) continue;
      const yd = years[yk];
      if (!yd || !Array.isArray(yd.holidays)) continue;
      for (let i = 0; i < yd.holidays.length; i++) {
        const seg = yd.holidays[i];
        const p = store.parseYmd(seg.s);
        if (!p) continue;
        out.push({ y: p.y, m: p.m, d: p.d, name: String(seg.name || '节假日') });
      }
    }
  } catch (e) { /* 拿不到数据就返回空列表，菜单会显示「无」 */ }
  out.sort(function (a, b) {
    return new Date(a.y, a.m - 1, a.d) - new Date(b.y, b.m - 1, b.d);
  });
  _allCache = out;
  return out;
}

// 某天的「当天零点」时间戳（用于稳定比较，忽略时分秒）
function midnight(y, m, d) {
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

// 当前年份的所有节首日（不过滤已过）
function thisYearHolidays(now) {
  const curYear = now.getFullYear();
  return buildAll().filter(function (h) { return h.y === curYear; });
}

// 当前年份还未过的节首日，最多 n 个（按时间顺序，剩几个返回几个）
function nextHolidaysThisYear(now, n) {
  n = n || 3;
  const curYear = now.getFullYear();
  const today = midnight(curYear, now.getMonth() + 1, now.getDate());
  const out = [];
  const all = buildAll();
  for (let i = 0; i < all.length && out.length < n; i++) {
    const h = all[i];
    if (h.y !== curYear) continue;       // 只看当前年份
    const t = midnight(h.y, h.m, h.d);
    if (t < today) continue;              // 已过
    const diff = Math.round((t - today) / 86400000);
    out.push({ name: h.name, diffDays: diff, y: h.y, m: h.m, d: h.d });
  }
  return out;
}

// 计算从 now（Date 实例）起，未来 n 个节日的 {name, diffDays, y, m, d}
// diffDays：距今天的天数（0 = 今天，1 = 明天，依此类推）
function nextHolidays(now, n) {
  n = n || 5;
  const today = midnight(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const out = [];
  const all = buildAll();
  for (let i = 0; i < all.length && out.length < n; i++) {
    const h = all[i];
    const t = midnight(h.y, h.m, h.d);
    if (t < today) continue;      // 已过
    const diff = Math.round((t - today) / 86400000);
    out.push({ name: h.name, diffDays: diff, y: h.y, m: h.m, d: h.d });
  }
  return out;
}

/**
 * 某年某个节日的日期区间，形如 { y, m, s, e }（m=月，s/e=该月内的起止日）。
 * 查不到（该年无数据 / 无此节日）返回 null —— 调用方回退到内置常量。
 */
function rangeOf(name, year) {
  try { return store.rangeOf(name, year); } catch (e) { return null; }
}

/**
 * 主进程数据被替换后调用：清缓存并落盘，让菜单立即用上新数据。
 * @param {object} [data] 完整 holidays.json 结构；不传只清缓存
 */
function setData(data) {
  _allCache = null;
  if (data && typeof data === 'object') {
    try { store.setData(data); } catch (e) {}
  }
}

module.exports = {
  nextHolidays: nextHolidays,
  thisYearHolidays: thisYearHolidays,
  nextHolidaysThisYear: nextHolidaysThisYear,
  rangeOf: rangeOf,
  setData: setData
};
