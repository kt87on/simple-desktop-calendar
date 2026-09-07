'use strict';
/* QA 独立验证：渲染层（app.js）节假日按年取表 —— 无该年数据不得误套别年表 */
const { boot } = require('./qa-harness');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name + (extra ? ' | ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}

/* ===== 1. 出厂：只有 2026 有数据，2027 不得再套 2026 的表 ===== */
console.log('\n[1] 出厂表：2027 无数据 → 不标休/班（旧版 bug：任何年都套 2026 表）');
{
  const app = boot('2027-01-05T10:00:00');
  ok('HOLIDAY_YEARS 只有 2026（出厂兜底）', JSON.stringify(Object.keys(app.CAL.HOLIDAY_YEARS)) === '["2026"]', JSON.stringify(Object.keys(app.CAL.HOLIDAY_YEARS)));
  const jan = app.cells().filter(function (c) { return c.y === 2027 && c.m === 1; });
  const rest = jan.filter(function (c) { return c.cls.indexOf('holiday') >= 0; });
  ok('2027 年 1 月无「休」格', rest.length === 0, JSON.stringify(rest.map(function (c) { return c.d; })));
  const work = jan.filter(function (c) { return c.cls.indexOf('workday') >= 0; });
  ok('2027 年 1 月无「班」格', work.length === 0, JSON.stringify(work.map(function (c) { return c.d; })));
  ok('2027-01-01 没有 chip-rest', app.grid.innerHTML.indexOf('chip-rest') < 0);
}

/* ===== 2. 2026 有数据 → 正常标休/班 ===== */
console.log('\n[2] 2026 有数据 → 休/班正常');
{
  const app = boot('2026-09-07T10:00:00');
  app.CAL.S.year = 2026; app.CAL.S.month = 10;
  app.CAL.onDayRollover();          // 借道触发一次重绘（同一天，视图不变）
  const oct = app.cells().filter(function (c) { return c.y === 2026 && c.m === 10; });
  const rest = oct.filter(function (c) { return c.cls.indexOf('holiday') >= 0; }).map(function (c) { return c.d; });
  ok('2026-10-01~07 标休', JSON.stringify(rest) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]), JSON.stringify(rest));
  const work = oct.filter(function (c) { return c.cls.indexOf('workday') >= 0; }).map(function (c) { return c.d; });
  ok('2026-10-10 标班', JSON.stringify(work) === JSON.stringify([10]), JSON.stringify(work));
}

/* ===== 3. 主进程下发 2027 数据后 → 2027 才标休，且不影响 2026 ===== */
console.log('\n[3] applyHolidayData 下发 2027 → 2027 立刻生效，2026 不受影响');
{
  const app = boot('2027-01-05T10:00:00');
  const r = app.CAL.applyHolidayData({
    years: {
      2027: {
        holidays: [{ name: '元旦', s: '2027-01-01', e: '2027-01-03' },
                   { name: '春节', s: '2027-02-05', e: '2027-02-11' }],
        workdays: ['2027-01-04']
      }
    }
  });
  ok('applyHolidayData 返回 true', r === true);
  ok('HOLIDAY_YEARS 现在有 2026+2027', Object.keys(app.CAL.HOLIDAY_YEARS).sort().join(',') === '2026,2027', JSON.stringify(Object.keys(app.CAL.HOLIDAY_YEARS)));
  const jan = app.cells().filter(function (c) { return c.y === 2027 && c.m === 1; });
  const rest = jan.filter(function (c) { return c.cls.indexOf('holiday') >= 0; }).map(function (c) { return c.d; });
  ok('2027-01-01~03 标休', JSON.stringify(rest) === JSON.stringify([1, 2, 3]), JSON.stringify(rest));
  const work = jan.filter(function (c) { return c.cls.indexOf('workday') >= 0; }).map(function (c) { return c.d; });
  ok('2027-01-04 标班', JSON.stringify(work) === JSON.stringify([4]), JSON.stringify(work));

  app.CAL.S.year = 2026; app.CAL.S.month = 10; app.CAL.onDayRollover();
  const oct = app.cells().filter(function (c) { return c.y === 2026 && c.m === 10; });
  ok('2026-10-01 仍标休（未被 2027 覆盖）', oct.filter(function (c) { return c.cls.indexOf('holiday') >= 0; }).length === 7);
}

/* ===== 4. 数据热替换：同一年覆盖 ===== */
console.log('\n[4] 同一年数据被覆盖 → 旧缓存必须失效');
{
  const app = boot('2026-09-07T10:00:00');
  app.CAL.S.year = 2026; app.CAL.S.month = 10; app.CAL.onDayRollover();
  ok('覆盖前 10/1~10/7 休', app.cells().filter(function (c) { return c.m === 10 && c.cls.indexOf('holiday') >= 0; }).length === 7);
  app.CAL.applyHolidayData({ years: { 2026: { holidays: [{ name: '国庆节', s: '2026-10-01', e: '2026-10-10' }], workdays: [] } } });
  const rest = app.cells().filter(function (c) { return c.m === 10 && c.cls.indexOf('holiday') >= 0; }).map(function (c) { return c.d; });
  ok('覆盖后 10/1~10/10 休（缓存已失效）', JSON.stringify(rest) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), JSON.stringify(rest));
}

/* ===== 5. 非法 payload 不崩 ===== */
console.log('\n[5] applyHolidayData 非法输入');
{
  const app = boot('2026-09-07T10:00:00');
  ok('null → false', app.CAL.applyHolidayData(null) === false);
  ok('字符串 → false', app.CAL.applyHolidayData('x') === false);
  ok('无 years → false', app.CAL.applyHolidayData({ foo: 1 }) === false);
  ok('years 为 null → false', app.CAL.applyHolidayData({ years: null }) === false);
  ok('调用后仍可正常渲染', app.cells().length === 42);
}

/* ===== 6. 跨天 + 节假日：跨年后 2027 的休/班要出现在新视图 ===== */
console.log('\n[6] 2026-12-31 → 2027-01-01 跨年后，新视图显示 2027 的休');
{
  const app = boot('2026-12-31T23:59:58');
  app.CAL.applyHolidayData({ years: { 2027: { holidays: [{ name: '元旦', s: '2027-01-01', e: '2027-01-03' }], workdays: [] } } });
  app.jump('2027-01-01T00:00:02');
  app.fireFocus();
  ok('视图已切到 2027-01', app.CAL.S.year === 2027 && app.CAL.S.month === 1);
  const jan = app.cells().filter(function (c) { return c.y === 2027 && c.m === 1; });
  const rest = jan.filter(function (c) { return c.cls.indexOf('holiday') >= 0; }).map(function (c) { return c.d; });
  ok('2027-01-01~03 标休', JSON.stringify(rest) === JSON.stringify([1, 2, 3]), JSON.stringify(rest));
  ok('今日高亮 2027-1-1', app.todayCells().map(function (c) { return c.d; }).join(',') === '1');
}

console.log('\n================ 渲染层节假日汇总 ================');
console.log('PASS ' + pass + ' / FAIL ' + fail);
if (fails.length) { console.log('失败用例：'); fails.forEach(function (f) { console.log('  - ' + f); }); }
process.exitCode = fail ? 1 : 0;
