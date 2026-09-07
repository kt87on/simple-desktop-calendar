'use strict';
/* QA 专用：在纯 Node 下真跑 app.js 的最小 DOM shim + 假时钟。
 * 只用来验证跨天逻辑，不依赖 lunar.min.js（Solar/Lunar 用确定性替身）。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

/* ---------------- 假时钟 ---------------- */
function makeClock(iso) {
  const state = { t: new Date(iso).getTime() };
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(state.t); else super(...a); }
    static now() { return state.t; }
  }
  return {
    state,
    Date: FakeDate,
    set(iso2) { state.t = new Date(iso2).getTime(); },
    add(ms) { state.t += ms; }
  };
}

/* ---------------- DOM shim ---------------- */
function makeEl(id, doc) {
  let _html = '';
  const el = {
    id: id || '',
    tagName: 'DIV',
    style: {},
    dataset: {},
    title: '',
    value: '',
    textContent: '',
    className: '',
    writes: 0,
    listeners: {},
    classList: {
      _s: {},
      add(c) { this._s[c] = true; },
      remove(c) { delete this._s[c]; },
      toggle(c, on) { if (on === undefined) { this._s[c] ? delete this._s[c] : (this._s[c] = true); } else if (on) this._s[c] = true; else delete this._s[c]; },
      contains(c) { return !!this._s[c]; }
    },
    addEventListener(t, cb) { (el.listeners[t] = el.listeners[t] || []).push(cb); },
    removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    focus() {}, blur() {}, click() {},
    setAttribute() {}, getAttribute() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 340, height: 430, right: 340, bottom: 430 }; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    get innerHTML() { return _html; },
    set innerHTML(v) { _html = String(v); el.writes++; }
  };
  if (id === 'yearSel' || id === 'monthSel') el.tagName = 'SELECT';
  return el;
}

/**
 * 启动一个 app.js 实例。
 * @param {string} iso 本地时间字符串，如 '2026-09-06T23:59:55'
 */
function boot(iso, opts) {
  const o = opts || {};
  const clock = makeClock(iso);
  const els = {};
  const docListeners = {};
  const winListeners = {};
  const intervals = [];
  const tooltip = [];
  const holidayPushes = [];

  const document = {
    readyState: 'complete',
    hidden: false,
    body: makeEl('body'),
    documentElement: makeEl('html'),
    activeElement: null,
    getElementById(id) { return (els[id] = els[id] || makeEl(id, document)); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement(t) { const e = makeEl(''); e.tagName = String(t).toUpperCase(); return e; },
    addEventListener(t, cb) { (docListeners[t] = docListeners[t] || []).push(cb); }
  };

  function api() {
    return {
      setTooltip: function (s) { tooltip.push(s); },
      getHolidayData: function () { return Promise.resolve({ data: null, meta: null }); },
      onHolidayDataChanged: function (cb) { holidayPushes.push(cb); },
      listReminders: function () { return Promise.resolve([]); },
      onRemindersChanged: function () {},
      onThemeChanged: function () {},
      onGotoYm: function () {},
      onExpandChanged: function () {},
      mainShowMenu: function () {}
    };
  }

  const window = {
    Solar: {
      fromYmd: function (y, m, d) {
        return {
          getLunar: function () {
            return {
              getDayInChinese: function () { return '初' + d; },
              getMonthInChinese: function () { return m + '月'; },
              getJieQi: function () { return ''; },
              getFestivals: function () { return []; }
            };
          },
          getFestivals: function () { return []; },
          getWeek: function () { return new Date(y, m - 1, d).getDay(); }
        };
      }
    },
    Lunar: {},
    api: (o.noApi ? null : api()),
    addEventListener: function (t, cb) { (winListeners[t] = winListeners[t] || []).push(cb); },
    removeEventListener: function () {}
  };

  const sandbox = {
    window, document, Date: clock.Date,
    console,
    setInterval: function (fn, ms) { intervals.push(fn); return intervals.length; },
    clearInterval: function () {},
    setTimeout: function (fn) { return 0; },
    clearTimeout: function () {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox, { filename: 'app.js' });

  const CAL = window.__CAL__;
  const gridEl = document.getElementById('grid');

  return {
    CAL, clock, window, document, tooltip, holidayPushes, els,
    grid: gridEl,
    /** 模拟 setInterval 的一次 tick（updateClock） */
    tick(n) { for (let i = 0; i < (n || 1); i++) { const fn = intervals[intervals.length - 1]; if (fn) fn(); } },
    /** 模拟窗口重新可见 */
    fireVisibility() { (docListeners.visibilitychange || []).forEach(function (cb) { cb({}); }); },
    /** 模拟窗口获得焦点 */
    fireFocus() { (winListeners.focus || []).forEach(function (cb) { cb({}); }); },
    /** 把假时钟推进到某个时刻（中间不 tick，模拟休眠） */
    jump(iso2) { clock.set(iso2); },
    /* ---- 断言辅助 ---- */
    cells(cls) {
      const out = [];
      const re = /<div class="([^"]*)" data-y="(-?\d+)" data-m="(\d+)" data-d="(\d+)"/g;
      let m;
      while ((m = re.exec(gridEl.innerHTML))) {
        const list = m[1].split(/\s+/);
        if (!cls || list.indexOf(cls) >= 0) {
          out.push({ cls: list, y: +m[2], m: +m[3], d: +m[4] });
        }
      }
      return out;
    },
    todayCells() { return this.cells('today'); },
    selectedCells() { return this.cells('selected'); },
    S() { return window.__CAL__.S; }
  };
}

module.exports = { boot };
