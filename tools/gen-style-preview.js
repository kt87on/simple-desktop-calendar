'use strict';
/*
 * tools/gen-style-preview.js
 * ---------------------------------------------------------------------------
 * 「简洁桌面日历」6 套原生风格 × 浅/深 视觉验收页生成器（纯 Node，无新依赖）
 *
 * 设计原则（避免走样）：**CSS 与 body 静态骨架 100% 从 template.html 提取**，
 * 绝不手抄任何色值/圆角/阴影。本脚本只做三件事：
 *   1) 读 template.html → 抠出 <style> 全文 与 <body> 静态骨架（去掉 <script src>）
 *   2) 用真实 lunar.min.js + 项目内置 2026 法定节假日表，算出示例月份的 42 格数据
 *      （类名/结构完全照 app.js renderGrid() 生成）
 *   3) 拼成自包含页面：每套风格 × 明暗 一个 <html data-theme data-style> 文档，
 *      在总览页里以 srcdoc iframe 隔离（因为 [data-theme]/html[data-style=] 选择器
 *      必须落在根元素上，同页多套无法共存）。
 *
 * 用法：
 *   node tools/gen-style-preview.js          生成总览页 + 6 张单风格页（截图用，落在 ASCII 临时目录）
 *   node tools/gen-style-preview.js collect   把临时目录里的 <key>.png 收进 deliverables/design，
 *                                             并逐张解码验证「不是空白」（纯 Node，无需外部依赖）
 *
 * 注意：所有中文路径操作一律交给 Node（本文件是 UTF-8），不要把中文路径当 CLI 参数传进来
 * —— Windows PowerShell 5.1 传给子进程的 argv 会按 ANSI 码页转码，中文必然乱码。
 *
 * 说明：为了压缩体积，骨架里的 data-page-node-id（AI 生成工具留下的产物属性，
 * 不参与任何样式/行为）在拼接时被剥离，这是本脚本唯一的改动性转换。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'deliverables', 'design');
const TEMP_DIR = process.env.PREVIEW_TMP_DIR
  || process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';

/* ============================ 配置 ============================ */
const STYLES = [
  { key: 'default', no: '①', name: '默认融合',
    desc: '轻玻璃 blur 20px + 三段式中性阴影；中性蓝 / 朱砂双色强调。' },
  { key: 'minimal', no: '②', name: '极简',
    desc: '纯白无模糊，模糊半径 0；极细描边 + 近黑强调色；留白与圆角更大。' },
  { key: 'glass', no: '③', name: '玻璃拟态',
    desc: '页面自绘三团彩色光斑 + 斜向高光带 + 26px 假磨砂 + 高光描边；紫/粉强调。' },
  { key: 'neu', no: '④', name: '新拟态',
    desc: '同底色双向柔和阴影（右下暗 + 左上亮）把卡片「挤」出来；圆角 28px、零模糊。' },
  { key: 'tech', no: '⑤', name: '科技感',
    desc: '青(#22d3ee)/品红双霓虹 + 22px 网格底 + 四角切角(clip-path) + 等宽字 + 文字微发光。' },
  { key: 'warm', no: '⑥', name: '温润拟物',
    desc: '细纸纤维斜纹 + 暖羊皮纸渐变 + 暖棕强调 + 衬线字（SimSun/Georgia）+ 柔和立体。' }
];
const TONES = [
  { key: 'light', name: '浅色' },
  { key: 'dark', name: '深色' }
];

/* ===================== 1. 从 template.html 提取真实资源 ===================== */
const tplPath = path.join(ROOT, 'template.html');
const tpl = fs.readFileSync(tplPath, 'utf8');

const styleMatch = tpl.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error('template.html 里找不到 <style> 块');
const REAL_CSS = styleMatch[1];

const bodyMatch = tpl.match(/<body[^>]*>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('template.html 里找不到 <body>');
let SKELETON = bodyMatch[1]
  .replace(/<script[\s\S]*?<\/script>/g, '')    // 去掉 /*__LUNAR_LIB__*/ 与 /*__APP__*/ 两个占位脚本
  .replace(/\s+data-page-node-id="[^"]*"/g, '') // 剥离 AI 产物属性（不参与样式/行为）
  .trim();

/* ===================== 2. 示例数据（真实农历 / 节气 / 2026 节假日） ===================== */
/* 2026 年国务院安排，与 holiday-store.js 出厂内置数据、app.js HOLIDAY_FALLBACK 同源 */
const HOLIDAY_SEGS_2026 = [
  { name: '元旦', m: 1, s: 1, e: 3 },
  { name: '春节', m: 2, s: 15, e: 23 },
  { name: '清明节', m: 4, s: 4, e: 6 },
  { name: '劳动节', m: 5, s: 1, e: 5 },
  { name: '端午节', m: 6, s: 19, e: 21 },
  { name: '中秋节', m: 9, s: 25, e: 27 },
  { name: '国庆节', m: 10, s: 1, e: 7 }
];
const WORKDAYS_2026 = [[1, 4], [2, 14], [2, 28], [5, 9], [9, 20], [10, 10]];

/* 与 app.js 同源的常量 */
const NATIONAL = { 1: { 1: '元旦' }, 4: { 4: '清明节', 5: '清明节' }, 5: { 1: '劳动节' }, 10: { 1: '国庆节' } };
const KEEP = {
  '元旦': 1, '春节': 1, '元宵节': 1, '龙头节': 1, '二月二': 1, '上巳节': 1, '寒食节': 1, '清明节': 1,
  '端午节': 1, '七夕节': 1, '中元节': 1, '中秋节': 1, '重阳节': 1, '寒衣节': 1, '下元节': 1, '腊八节': 1,
  '小年': 1, '除夕': 1, '情人节': 1, '愚人节': 1, '万圣节': 1, '圣诞节': 1, '感恩节': 1,
  '劳动节': 1, '国庆节': 1
};
const ALIAS = { '万圣节前夜': '万圣节' };
const CN = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

function isKeep(name) {
  if (!name) return false;
  if (KEEP[name]) return true;
  for (const k in KEEP) { if (name.indexOf(k) === 0) return true; }
  return false;
}
function cnNum(s) {
  if (!s) return 0;
  s = String(s).replace('初', '');
  if (s.indexOf('廿') === 0) { const r = s.slice(1); return 20 + (CN[r] || 0); }
  if (s === '三十') return 30;
  if (s.indexOf('十') === 0) return 10 + (CN[s[1]] || 0);
  if (s.indexOf('十') === 1) return CN[s[0]] * 10 + (s.length > 2 ? (CN[s[2]] || 0) : 0);
  if (s.length === 1) return CN[s] || 0;
  return 0;
}
function findHoliday(m, d) {
  for (const seg of HOLIDAY_SEGS_2026) {
    if (seg.m === m && d >= seg.s && d <= seg.e) return { name: seg.name, idx: d - seg.s + 1 };
  }
  return null;
}
function isWorkday(m, d) {
  return WORKDAYS_2026.some(function (p) { return p[0] === m && p[1] === d; });
}

/* 用项目自带的 lunar.min.js（在 vm 沙箱里）算真实农历/节气/节日 —— 与 app.js 同库同用法 */
function loadSolar() {
  const src = fs.readFileSync(path.join(ROOT, 'lunar.min.js'), 'utf8');
  const sandbox = {};
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'lunar.min.js' });
  if (!sandbox.Solar) throw new Error('lunar.min.js 未导出 Solar');
  return sandbox.Solar;
}
const Solar = loadSolar();

/* 逐日信息：完全照 app.js info() 的优先级（app.js:165-207） */
function dayInfo(y, m, d) {
  const solar = Solar.fromYmd(y, m, d);
  const lunar = solar.getLunar();
  const dayCn = lunar.getDayInChinese();
  const dayNum = cnNum(dayCn);
  const jq = lunar.getJieQi() || '';
  const sF = solar.getFestivals() || [];
  const lF = lunar.getFestivals() || [];
  const hol = (y === 2026) ? findHoliday(m, d) : null;
  const isHoliday = !!hol;
  const isWork = (y === 2026) ? isWorkday(m, d) : false;

  let sub, kind = 'lunar';
  const fallback = function () {
    return (dayNum === 1) ? (lunar.getMonthInChinese() + '月初一') : dayCn;
  };
  if (jq) { sub = jq; kind = 'festival'; }
  else if (isHoliday && hol.idx === 1) { sub = hol.name; kind = 'festival'; }
  else if (!isHoliday) {
    if (NATIONAL[m] && NATIONAL[m][d]) { sub = NATIONAL[m][d]; kind = 'festival'; }
    else if (sF[0] && isKeep(sF[0])) { sub = ALIAS[sF[0]] || sF[0]; kind = 'festival'; }
    else if (lF[0] && isKeep(lF[0])) { sub = ALIAS[lF[0]] || lF[0]; kind = 'festival'; }
    else sub = fallback();
  } else sub = fallback();

  const week = solar.getWeek();
  return { y, m, d, sub, kind, isHoliday, isWork, weekend: week === 0 || week === 6 };
}

/* ---- 示例场景参数（一个「好看的」月份，覆盖全部状态） ---- */
const DEMO = {
  year: 2026, month: 10, startMon: true,
  clock: '09:41:26',
  today: { y: 2026, m: 10, d: 15 },     // 今日（周四）
  selected: { y: 2026, m: 10, d: 13 },  // 单选
  reminder: { y: 2026, m: 10, d: 22, text: '项目上线' },  // 特别关注（琥珀 + 注）
  range: [{ y: 2026, m: 10, d: 19 }, { y: 2026, m: 10, d: 21 }], // 日期区间（端深中浅）
  toast: '已关注 · 项目上线 09:30'
};

function sameDay(a, b) { return a.y === b.y && a.m === b.m && a.d === b.d; }

function buildCells() {
  const y = DEMO.year, m = DEMO.month;
  const firstWd = new Date(y, m - 1, 1).getDay();
  const lead = DEMO.startMon ? (firstWd === 0 ? 6 : firstWd - 1) : firstWd;
  const dim = new Date(y, m, 0).getDate();
  const prevDays = new Date(y, m - 1, 0).getDate();
  const cells = [];
  for (let i = lead - 1; i >= 0; i--) cells.push({ t: 'other', y: m === 1 ? y - 1 : y, m: m === 1 ? 12 : m - 1, d: prevDays - i });
  for (let d = 1; d <= dim; d++) cells.push({ t: 'cur', y: y, m: m, d: d });
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  let nd = 1;
  while (cells.length < 42) cells.push({ t: 'other', y: ny, m: nm, d: nd++ });
  return cells;
}

function buildGridHtml() {
  const cells = buildCells();
  const r0 = DEMO.range[0], r1 = DEMO.range[1];
  const tA = new Date(r0.y, r0.m - 1, r0.d).getTime();
  const tB = new Date(r1.y, r1.m - 1, r1.d).getTime();
  const tS = Math.min(tA, tB), tE = Math.max(tA, tB);

  let html = '';
  for (const c of cells) {
    const inf = dayInfo(c.y, c.m, c.d);
    let cls = 'cell';
    if (c.t === 'other') cls += ' other';
    if (inf.isHoliday) cls += ' holiday';
    if (inf.isWork && c.t === 'cur') cls += ' workday';
    if (inf.weekend && c.t === 'cur') cls += ' weekend';
    if (sameDay(c, DEMO.today)) cls += ' today';
    if (sameDay(c, DEMO.selected)) cls += ' selected';
    if (sameDay(c, DEMO.reminder)) cls += ' reminder';
    const tc = new Date(c.y, c.m - 1, c.d).getTime();
    if (sameDay(c, r0) || sameDay(c, r1)) cls += ' range';
    else if (tc > tS && tc < tE) cls += ' range-between';

    let chip = '';
    if (sameDay(c, DEMO.reminder)) chip = '<span class="chip-focus" title="' + DEMO.reminder.text + '">注</span>';
    else if (inf.isHoliday) chip = '<span class="chip chip-rest">休</span>';
    else if (c.t === 'cur' && inf.isWork) chip = '<span class="chip chip-work">班</span>';

    const subCls = 'sub' + (inf.kind === 'festival' ? ' sub-festival' : '');
    const dd = c.d < 10 ? '0' + c.d : '' + c.d;
    html += '<div class="' + cls + '" data-y="' + c.y + '" data-m="' + c.m + '" data-d="' + c.d
      + '" role="button" tabindex="0">' + chip
      + '<span class="d">' + dd + '</span>'
      + '<span class="' + subCls + '">' + inf.sub + '</span>'
      + '</div>';
  }
  return html;
}

function buildWeekHeaderHtml() {
  const labels = DEMO.startMon ? ['一', '二', '三', '四', '五', '六', '日'] : ['日', '一', '二', '三', '四', '五', '六'];
  let html = '';
  for (let i = 0; i < 7; i++) {
    const isWk = DEMO.startMon ? (i >= 5) : (i === 0 || i === 6);
    html += '<div class="wcell' + (isWk ? ' weekend' : '') + '">' + labels[i] + '</div>';
  }
  return html;
}

const GRID_HTML = buildGridHtml();
const WEEK_HEADER_HTML = buildWeekHeaderHtml();

/* ===================== 3. 注入脚本（填示例数据，不改结构/样式） ===================== */
const DEMO_JS = [
  '(function () {',
  "  var $ = function (id) { return document.getElementById(id); };",
  "  $('clkTime').textContent = " + JSON.stringify(DEMO.clock) + ';',
  "  $('infoDate').textContent = " + JSON.stringify('2026 年 10 月 15 日') + ';',
  "  $('infoLunar').textContent = " + JSON.stringify('九月初六 · 丙午年') + ';',
  "  var yh = '';",
  "  for (var y = 1976; y <= 2076; y++) yh += '<option value=\"' + y + '\"' + (y === 2026 ? ' selected' : '') + '>' + y + '</option>';",
  "  $('yearSel').innerHTML = yh;",
  "  var mh = '';",
  "  for (var m = 1; m <= 12; m++) mh += '<option value=\"' + m + '\"' + (m === 10 ? ' selected' : '') + '>' + (m < 10 ? '0' + m : m) + '</option>';",
  "  $('monthSel').innerHTML = mh;",
  "  $('bgMonth').textContent = '10';",
  "  $('weekHeader').innerHTML = " + JSON.stringify(WEEK_HEADER_HTML) + ';',
  "  $('grid').innerHTML = " + JSON.stringify(GRID_HTML) + ';',
  "  var t = $('toast'); t.textContent = " + JSON.stringify(DEMO.toast) + "; t.classList.add('show');",
  '})();'
].join('\n');

/* ===================== 4. 单份风格文档（真实 CSS + 真实骨架 + 示例数据） ===================== */
function buildDocHtml(styleKey, toneKey) {
  const head = '<!DOCTYPE html>\n<html lang="zh-CN" data-theme="' + toneKey + '" data-style="' + styleKey + '">\n'
    + '<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + '<title>简洁桌面日历预览 · ' + styleKey + ' · ' + toneKey + '</title>\n'
    + '<style>\n' + REAL_CSS + '\n</style>\n</head>\n<body>\n';
  return head + SKELETON + '\n<script>\n' + DEMO_JS + '\n</script>\n</body>\n</html>\n';
}

function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/* ===================== 5. 外层容器页（深色台面，仅用于摆放卡片） ===================== */
const WRAP_CSS = `
  * { box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    margin: 0; padding: 26px 32px 34px;
    background: #0e1014;
    color: #e7e9ef;
    font: 13px/1.55 "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  h1 { margin: 0 0 8px; font-size: 19px; font-weight: 700; letter-spacing: .2px; color: #fff; }
  .sub { margin: 0 0 14px; max-width: 1000px; color: #98a1b2; font-size: 12.5px; line-height: 1.7; }
  .legend {
    margin: 0 0 22px; padding: 10px 14px; max-width: 1000px;
    border: 1px solid #262b35; border-radius: 8px; background: #14171d;
    color: #aeb6c4; font-size: 12px; line-height: 1.8;
  }
  .legend b { color: #e7e9ef; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(2, 480px); gap: 22px 24px; align-items: start; }
  .item { display: flex; flex-direction: column; gap: 7px; }
  .cap { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .cap b { font-size: 14px; color: #fff; font-weight: 700; }
  .cap u { text-decoration: none; font-size: 11px; color: #6f7a8c; font-family: Consolas, monospace; }
  .cap span { font-size: 11.5px; color: #7f8a9c; }
  .desc { font-size: 11.5px; color: #8d97a8; line-height: 1.6; min-height: 2.6em; }
  iframe { width: 480px; height: 600px; border: 1px solid #232833; border-radius: 10px; display: block; background: #1a1d24; }
  .note { margin-top: 26px; max-width: 1000px; color: #7c8697; font-size: 12px; line-height: 1.8; }
  .note code { color: #a9b4c6; font-family: Consolas, monospace; }
`;

function buildWrapperHtml(title, subtitle, items, note) {
  const cells = items.map(function (it) {
    return '  <div class="item">\n'
      + '    <div class="cap"><b>' + it.caption + '</b><u>' + it.tag + '</u><span>' + it.tone + '</span></div>\n'
      + '    <div class="desc">' + it.desc + '</div>\n'
      + '    <iframe scrolling="no" title="' + it.caption + ' ' + it.tone + '" srcdoc="' + escAttr(it.doc) + '"></iframe>\n'
      + '  </div>';
  }).join('\n');
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + '<title>' + title + '</title>\n<style>' + WRAP_CSS + '</style>\n</head>\n<body>\n'
    + '<h1>' + title + '</h1>\n'
    + '<p class="sub">' + subtitle + '</p>\n'
    + '<div class="legend">每格内部均含：<b>① 顶部工具栏（拖动条）</b> — 年月下拉 / ‹ › 翻月 / 「今」/ 周一·周日开关 / 关注·放大图标；'
    + '<b>② 时钟 + 日期 + 农历</b>；<b>③ 日期网格</b>（今日实心蓝、周末红字、节假日红底「休」、调休上班绿字「班」、上下月灰格、'
    + '特别关注琥珀底「注」、选中框、日期区间浅绿带）；<b>④ 底部提醒条</b>（#toast）。</div>\n'
    + '<div class="grid">\n' + cells + '\n</div>\n'
    + (note ? '<p class="note">' + note + '</p>\n' : '')
    + '</body>\n</html>\n';
}

/* ===================== 6. 落盘 ===================== */
function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function writeIndex() {
  const items = [];
  STYLES.forEach(function (st) {
    TONES.forEach(function (tn) {
      items.push({
        caption: st.no + ' ' + st.name,
        tag: 'data-style="' + st.key + '"',
        tone: '· ' + tn.name + '（data-theme="' + tn.key + '"）',
        desc: st.desc,
        doc: buildDocHtml(st.key, tn.key)
      });
    });
  });
  const html = buildWrapperHtml(
    '简洁桌面日历 · v3.1.0 六风格视觉验收',
    'CSS 与 DOM 骨架 <b>逐字取自 template.html</b>（本页不含任何手抄样式）；示例数据为 2026 年 10 月，'
    + '农历 / 节气 / 法定节假日由项目自带 lunar.min.js 与内置 2026 放假表真实算出。每行一套风格：左浅色、右深色，便于并排比对。',
    items,
    '生成器：<code>tools/gen-style-preview.js</code>　·　源样式：<code>template.html</code> 的 &lt;style&gt; 块　·　'
    + '状态类名与格子结构照 <code>app.js</code> 的 renderGrid()。骨架中仅剥离了 <code>data-page-node-id</code> 属性（AI 产物属性，不参与样式/行为）。'
  );
  const out = path.join(OUT_DIR, 'v3.1.0-风格验收.html');
  fs.writeFileSync(out, html, 'utf8');
  return out;
}

function writeStylePages() {
  const written = [];
  STYLES.forEach(function (st) {
    const items = TONES.map(function (tn) {
      return {
        caption: st.no + ' ' + st.name,
        tag: 'data-style="' + st.key + '"',
        tone: '· ' + tn.name,
        desc: st.desc,
        doc: buildDocHtml(st.key, tn.key)
      };
    });
    const html = buildWrapperHtml(
      '风格验收 · ' + st.no + ' ' + st.name + '（' + st.key + '）',
      '左：浅色（data-theme="light"）　右：深色（data-theme="dark"）。样式逐字取自 template.html，示例数据为 2026 年 10 月。',
      items, ''
    );
    const out = path.join(TEMP_DIR, 'wbf-style-' + st.key + '.html');
    fs.writeFileSync(out, html, 'utf8');
    written.push(out);
  });
  return written;
}

/* ===================== 7. PNG 验证（纯 Node 解码，确认没截空） ===================== */
function decodePng(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG（签名不符）');
  let off = 8, w = 0, h = 0, bd = 0, ct = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8 || interlace !== 0) throw new Error('不支持的 PNG（bitDepth=' + bd + ' interlace=' + interlace + '）');
  const bppMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const bpp = bppMap[ct];
  if (!bpp) throw new Error('不支持的颜色类型 ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) throw new Error('IDAT 数据不完整');
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : zero;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255; break;
        }
        default: throw new Error('未知行滤波器 ' + filter);
      }
      cur[x] = v;
    }
  }
  return { w, h, bpp, data: out };
}

function analyzePng(file) {
  const buf = fs.readFileSync(file);
  const img = decodePng(buf);
  const { w, h, bpp, data } = img;
  const bg = [data[0], data[1], data[2]];
  const total = w * h;
  const step = Math.max(1, Math.floor(total / 250000));
  const colors = new Set();
  let sampled = 0, nonBg = 0, sumR = 0, sumG = 0, sumB = 0;
  for (let i = 0; i < total; i += step) {
    const o = i * bpp, r = data[o], g = data[o + 1], b = data[o + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) nonBg++;
    sumR += r; sumG += g; sumB += b;
    sampled++;
  }
  return {
    file: path.basename(file),
    bytes: buf.length,
    size: w + 'x' + h,
    sampledPixels: sampled,
    uniqueColors: colors.size,
    nonBackgroundRatio: +(nonBg / sampled).toFixed(4),
    avgColor: '#' + [sumR, sumG, sumB].map(function (v) {
      return Math.round(v / sampled).toString(16).padStart(2, '0');
    }).join('')
  };
}

/* ===================== 8. CLI ===================== */
function main() {
  const args = process.argv.slice(2);

  /* collect：把 ASCII 临时目录里的截图收进 deliverables/design 并逐张校验 */
  if (args[0] === 'collect') {
    ensureDirs();
    const rows = [];
    STYLES.forEach(function (st) {
      const src = path.join(TEMP_DIR, 'wbf-shot-' + st.key + '.png');
      const dst = path.join(OUT_DIR, 'v3.1.0-风格验收-' + st.key + '.png');
      if (!fs.existsSync(src)) { rows.push({ style: st.key, name: st.name, error: '缺少截图 ' + src }); return; }
      fs.copyFileSync(src, dst);
      let r;
      try { r = analyzePng(dst); } catch (e) { r = { file: path.basename(dst), error: String(e.message || e) }; }
      r.style = st.key;
      r.name = st.name;
      r.savedAs = path.basename(dst);
      r.verdict = (r.uniqueColors > 800 && r.nonBackgroundRatio > 0.25) ? '非空白 OK' : '可疑（疑似截空/纯色）';
      rows.push(r);
    });
    const lines = rows.map(function (r) { return JSON.stringify(r); });
    const dstTxt = path.join(TEMP_DIR, 'wbf-png-verify.txt');
    fs.writeFileSync(dstTxt, lines.join('\n'), 'utf8');
    console.log(lines.join('\n'));
    console.log('校验报告: ' + dstTxt);
    return;
  }

  /* verify：解析任意 PNG（路径必须是 ASCII，否则 Windows 下 argv 会被转码） */
  if (args[0] === 'verify') {
    const files = args.slice(1);
    if (!files.length) { console.error('用法: node tools/gen-style-preview.js verify <png> [...]'); process.exit(2); }
    const results = files.map(function (f) {
      try { return analyzePng(f); } catch (e) { return { file: path.basename(f), error: String(e.message || e) }; }
    });
    const lines = results.map(function (r) { return JSON.stringify(r); });
    console.log(lines.join('\n'));
    const dst = path.join(TEMP_DIR, 'wbf-png-verify.txt');
    fs.writeFileSync(dst, lines.join('\n'), 'utf8');
    console.log('已写出: ' + dst);
    return;
  }

  ensureDirs();
  const idx = writeIndex();
  const pages = writeStylePages();
  console.log('总览页: ' + idx + '  (' + fs.statSync(idx).size + ' 字节)');
  pages.forEach(function (p) { console.log('单风格页: ' + p + '  (' + fs.statSync(p).size + ' 字节)'); });
  console.log('CSS 提取自: ' + tplPath + '  (style ' + REAL_CSS.length + ' 字符, 骨架 ' + SKELETON.length + ' 字符)');
}

main();
