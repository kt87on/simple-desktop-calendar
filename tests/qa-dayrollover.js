'use strict';
/* QA 独立验证：v2.1.0 跨天 / 跨月 / 跨年修复（真跑 app.js + 假时钟 + DOM shim） */
const { boot } = require('./qa-harness');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name + (extra ? ' | ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function key(c) { return c.y + '-' + c.m + '-' + c.d; }

/* ============ A1. 常规跨午夜 ============ */
console.log('\n[A1] 09-06 23:59:55 → 09-07 00:00:01（每秒 tick）');
{
  const app = boot('2026-09-06T23:59:55');
  const before = app.todayCells();
  eq('启动日高亮=2026-9-6', before.map(key), ['2026-9-6']);
  eq('启动视图月=9', [app.S().year, app.S().month], [2026, 9]);
  for (let i = 0; i < 6; i++) { app.clock.add(1000); app.tick(); }
  const after = app.todayCells();
  eq('跨天后高亮=2026-9-7', after.map(key), ['2026-9-7']);
  eq('高亮格只有 1 个', after.length, 1);
  eq('视图月仍为 9', [app.S().year, app.S().month], [2026, 9]);
  ok('isToday(2026,9,7)=true', app.CAL.isToday(2026, 9, 7) === true);
  ok('isToday(2026,9,6)=false', app.CAL.isToday(2026, 9, 6) === false);
}

/* ============ A2. 休眠跳过定时器 → tick 自愈 ============ */
console.log('\n[A2] 休眠：23:50 直接跳到次日 08:00 后再 tick');
{
  const app = boot('2026-09-06T23:50:00');
  eq('跳前高亮=9-6', app.todayCells().map(key), ['2026-9-6']);
  app.jump('2026-09-07T08:00:00');       // 中间不 tick
  eq('跳完未 tick 时仍停在 9-6（说明定时器确实没跑）', app.todayCells().map(key), ['2026-9-6']);
  app.tick();
  eq('一次 tick 后自愈到 9-7', app.todayCells().map(key), ['2026-9-7']);
}

/* ============ A3. 休眠 → focus 自愈 ============ */
console.log('\n[A3] 休眠后只靠 focus 自愈（无 tick）');
{
  const app = boot('2026-09-06T23:50:00');
  app.jump('2026-09-07T08:00:00');
  app.fireFocus();
  eq('focus 后高亮=9-7', app.todayCells().map(key), ['2026-9-7']);
}

/* ============ A4. 休眠 → visibilitychange 自愈 ============ */
console.log('\n[A4] 休眠后只靠 visibilitychange 自愈（无 tick）');
{
  const app = boot('2026-09-06T23:50:00');
  app.jump('2026-09-07T08:00:00');
  app.fireVisibility();
  eq('visibilitychange 后高亮=9-7', app.todayCells().map(key), ['2026-9-7']);
}

/* ============ A5. hidden 状态下 visibilitychange 不应误触发 ============ */
console.log('\n[A5] document.hidden=true 时不触发（避免后台窗口乱跳）');
{
  const app = boot('2026-09-06T23:50:00');
  app.jump('2026-09-07T08:00:00');
  app.document.hidden = true;
  app.fireVisibility();
  eq('hidden 时 tick 前不变', app.todayCells().map(key), ['2026-9-6']);
  app.document.hidden = false;
  app.fireVisibility();
  eq('恢复可见后补正', app.todayCells().map(key), ['2026-9-7']);
}

/* ============ B1. 跨月 09-30 → 10-01 ============ */
console.log('\n[B1] 2026-09-30 → 2026-10-01 视图跟随');
{
  const app = boot('2026-09-30T23:59:58');
  eq('启动视图=2026-9', [app.S().year, app.S().month], [2026, 9]);
  app.jump('2026-10-01T00:00:02');
  app.tick();
  eq('视图跟随到 2026-10', [app.S().year, app.S().month], [2026, 10]);
  eq('高亮=10-1', app.todayCells().map(key), ['2026-10-1']);
  eq('选中日跟随到 10-1', [app.S().selY, app.S().selM, app.S().selD], [2026, 10, 1]);
  eq('信息条日期=2026年10月01日', app.els.infoDate && app.els.infoDate.textContent, '2026 年 10 月 01 日');
}

/* ============ B2. 跨年 2026-12-31 → 2027-01-01 ============ */
console.log('\n[B2] 2026-12-31 → 2027-01-01 视图跟随');
{
  const app = boot('2026-12-31T23:59:58');
  app.jump('2027-01-01T00:00:02');
  app.tick();
  eq('视图跟随到 2027-1', [app.S().year, app.S().month], [2027, 1]);
  eq('高亮=2027-1-1', app.todayCells().map(key), ['2027-1-1']);
  eq('选中日=2027-1-1', [app.S().selY, app.S().selM, app.S().selD], [2027, 1, 1]);
  eq('年份下拉=2027', String(app.els.yearSel.value), '2027');
}

/* ============ B3. 用户已翻到别的月（12 月），跨天不得抢视图 ============ */
console.log('\n[B3] 用户主动翻到 12 月，09-06→09-07 不得抢走视图');
{
  const app = boot('2026-09-06T23:59:58');
  app.S().year = 2026; app.S().month = 12;
  app.CAL.onDayRollover === undefined;
  app.jump('2026-09-07T00:00:02');
  app.fireFocus();
  eq('视图仍停在 2026-12', [app.S().year, app.S().month], [2026, 12]);
  eq('高亮格在 12 月网格中不存在（不越界渲染）', app.todayCells().length, 0);
}

/* ============ B4. 用户已翻到"新今天所在月" ============ */
console.log('\n[B4] 用户提前翻到 10 月，09-30→10-01');
{
  const app = boot('2026-09-30T23:59:58');
  app.S().year = 2026; app.S().month = 10;
  app.jump('2026-10-01T00:00:02');
  app.fireFocus();
  eq('视图仍在 2026-10', [app.S().year, app.S().month], [2026, 10]);
  eq('高亮=10-1', app.todayCells().map(key), ['2026-10-1']);
}

/* ============ C1. 选中日不是今天 → 不得被改 ============ */
console.log('\n[C1] 选中 9-20，跨天到 9-7 后选中日不变');
{
  const app = boot('2026-09-06T23:59:58');
  app.S().selY = 2026; app.S().selM = 9; app.S().selD = 20;
  app.jump('2026-09-07T00:00:02');
  app.fireFocus();
  eq('选中日仍为 9-20', [app.S().selY, app.S().selM, app.S().selD], [2026, 9, 20]);
  eq('选中格=9-20', app.selectedCells().map(key), ['2026-9-20']);
}

/* ============ C2. 选中日就是旧今天 → 跟随 ============ */
console.log('\n[C2] 选中 9-6（=旧今天），跨月到 10-1 后选中日跟随');
{
  const app = boot('2026-09-30T23:59:58');
  eq('初始选中=9-30', [app.S().selY, app.S().selM, app.S().selD], [2026, 9, 30]);
  app.jump('2026-10-01T00:00:02');
  app.fireFocus();
  eq('选中跟随到 10-1', [app.S().selY, app.S().selM, app.S().selD], [2026, 10, 1]);
}

/* ============ D. 幂等 ============ */
console.log('\n[D] checkDayRollover() 幂等');
{
  const app = boot('2026-09-06T23:50:00');
  app.jump('2026-09-07T08:00:00');
  const w0 = app.grid.writes;
  const r1 = app.CAL.checkDayRollover();
  const w1 = app.grid.writes;
  const r2 = app.CAL.checkDayRollover();
  const r3 = app.CAL.checkDayRollover();
  eq('第一次返回 true', r1, true);
  eq('第二/三次返回 false', [r2, r3], [false, false]);
  ok('第 2、3 次不再重渲染', app.grid.writes === w1, 'writes ' + w1 + ' -> ' + app.grid.writes);
  ok('第一次确实重渲染了', w1 > w0);
  eq('高亮仍=9-7', app.todayCells().map(key), ['2026-9-7']);
}

/* ============ E. 连续多天休眠（跨 3 天）============ */
console.log('\n[E] 休眠跨 3 天（09-06 → 09-09）');
{
  const app = boot('2026-09-06T23:50:00');
  app.jump('2026-09-09T10:00:00');
  app.tick();
  eq('高亮=9-9', app.todayCells().map(key), ['2026-9-9']);
  eq('视图=2026-9', [app.S().year, app.S().month], [2026, 9]);
}

/* ============ F. tooltip 跨天重推 ============ */
console.log('\n[F] 跨天后 tooltip 重新推送');
{
  const app = boot('2026-09-06T23:59:58');
  const n0 = app.tooltip.length;
  app.jump('2026-09-07T00:00:02');
  app.tick();
  ok('跨天后 tooltip 有新推送', app.tooltip.length > n0, 'n0=' + n0 + ' n1=' + app.tooltip.length);
}

console.log('\n================ 跨天测试汇总 ================');
console.log('PASS ' + pass + ' / FAIL ' + fail);
if (fails.length) { console.log('失败用例：'); fails.forEach(function (f) { console.log('  - ' + f); }); }
process.exitCode = fail ? 1 : 0;
