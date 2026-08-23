'use strict';

/*
 * taskbar.js —— 任务栏原生时钟的查找 / 隐藏 / 还原 / 取位置
 * ---------------------------------------------------------------------
 * v1.4 重写：彻底移除 PowerShell `Add-Type` 方案。
 *
 * 为什么不再用 PowerShell：
 *   目标机（Win10 企业版/教育版）很可能处于 ConstrainedLanguage 模式，
 *   AppLocker 会拦截 Add-Type 内联编译 C#，导致 runPs() 返回空字符串，
 *   pickClock() 永远返回 null，隐藏逻辑从未真正执行（表现为"时灵时不灵"）。
 *   此外每 8s 冷启动一次 PowerShell 进程 + JIT 编译 C# 也是卡顿主因。
 *
 * 新方案：用 koffi 从 Node 主进程直接调用 user32.dll（零进程创建、无编译、
 * 不受约束语言模式影响）。koffi 是预编译二进制，无需 node-gyp，在 Electron 31
 * 上开箱即用。
 *
 * 隐藏策略（针对 Win10 被 explorer 重绘复原的问题）：
 *   1) SetWindowLongPtr 去掉 WS_VISIBLE 位
 *   2) SetWindowPos 移出屏幕外(-32000,-32000) 并设 0 尺寸，SWP_HIDEWINDOW
 *      + SWP_NOZORDER + SWP_NOACTIVATE，使其不占位、不被重绘带回来
 *   3) 另提供"同色覆盖"兜底（见 electron-main 的 FALLBACK_COVER）
 */

// koffi 可能未在开发机安装（仅打包时需要）；用 try 包裹，加载失败时退化为 null
let koffi = null, user32 = null, kernel32 = null;
try {
  koffi = require('koffi');
} catch (e) {
  koffi = null;
}

const GWL_STYLE = -16;
const WS_VISIBLE = 0x10000000;
const GW_CHILD = 5;
const GW_HWNDNEXT = 2;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_HIDEWINDOW = 0x0080;
const SWP_SHOWWINDOW = 0x0040;

if (koffi) {
  try {
    user32 = koffi.load('user32.dll');
    kernel32 = koffi.load('kernel32.dll');

    // 64 位系统 HWND/句柄用 uint64_t；LONG 用 int32_t；BOOL 用 int32_t（0/非0）
    const HWND = 'uint64_t';
    const LONG = 'int32_t';
    const BOOL = 'int32_t';
    const UINT = 'uint32_t';

    // RECT 结构体（字段均为 int32）
    const RECT = koffi.struct('RECT', {
      left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t'
    });

    user32.FindWindowA = user32.func('uint64_t FindWindowA(const char* lpClassName, const char* lpWindowName)');
    user32.FindWindowExA = user32.func('uint64_t FindWindowExA(uint64_t hWndParent, uint64_t hWndChildAfter, const char* lpszClass, const char* lpszWindow)');
    user32.GetWindow = user32.func('uint64_t GetWindow(uint64_t hWnd, uint32_t uCmd)');
    user32.GetClassNameA = user32.func('int GetClassNameA(uint64_t hWnd, char* lpClassName, int nMaxCount)');
    user32.GetWindowTextA = user32.func('int GetWindowTextA(uint64_t hWnd, char* lpString, int nMaxCount)');
    user32.GetWindowRect = user32.func('int32_t GetWindowRect(uint64_t hWnd, RECT* lpRect)');
    user32.IsWindowVisible = user32.func('int32_t IsWindowVisible(uint64_t hWnd)');
    // GetWindowLongPtrA 在 64 位返回 LONG_PTR（64 位），用 int64_t
    user32.GetWindowLongPtrA = user32.func('int64_t GetWindowLongPtrA(uint64_t hWnd, int nIndex)');
    user32.SetWindowLongPtrA = user32.func('int64_t SetWindowLongPtrA(uint64_t hWnd, int nIndex, int64_t dwNewLong)');
    user32.SetWindowPos = user32.func('int32_t SetWindowPos(uint64_t hWnd, uint64_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)');
    user32.ShowWindow = user32.func('int32_t ShowWindow(uint64_t hWnd, int nCmdShow)');
  } catch (e) {
    user32 = null;
    kernel32 = null;
  }
}

// 是否已成功加载原生 API（用于上层判断是否需要退回兜底策略）
function ffiAvailable() {
  return !!(user32 && user32.GetWindow && user32.FindWindowA);
}

// 读取窗口类名（ASCII）
function getClassName(hwnd) {
  if (!user32) return '';
  const buf = Buffer.alloc(256);
  buf.fill(0);
  try {
    user32.GetClassNameA(hwnd, buf, 256);
    return buf.toString('ascii').replace(/\0+$/, '');
  } catch (e) { return ''; }
}

// 读取窗口文本（ASCII，用于判断"像时间"）
function getWindowText(hwnd) {
  if (!user32) return '';
  const buf = Buffer.alloc(512);
  buf.fill(0);
  try {
    user32.GetWindowTextA(hwnd, buf, 512);
    return buf.toString('ascii').replace(/\0+$/, '').replace(/\r/g, ' ').replace(/\n/g, ' ');
  } catch (e) { return ''; }
}

// 读取窗口矩形
function getWindowRect(hwnd) {
  if (!user32) return null;
  try {
    const r = new (koffi.struct({
      left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t'
    }))();
    const ok = user32.GetWindowRect(hwnd, r);
    if (!ok) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  } catch (e) { return null; }
}

// 深度优先遍历整棵窗口树（纯 Node，零进程创建）
function walkTree(root, depth, out) {
  if (!user32 || !root || depth > 14) return;
  let child = user32.GetWindow(root, GW_CHILD);
  while (child) {
    const cls = getClassName(child);
    const rect = getWindowRect(child);
    const vis = user32.IsWindowVisible(child) ? true : false;
    const txt = getWindowText(child);
    if (rect) {
      out.push({
        hwnd: child, class: cls, rect: rect,
        visible: vis, text: txt,
        isCandidate: isCandidateClass(cls)
      });
    }
    walkTree(child, depth + 1, out);
    child = user32.GetWindow(child, GW_HWNDNEXT);
  }
}

function isCandidateClass(cls) {
  const cl = (cls || '').toLowerCase();
  return cl.includes('clock') || cl.includes('tray') || cl.includes('notify') || cl.includes('systemtray') || cl === 'clock' || cl === 'clockface';
}

// 取整棵任务栏窗口树（用于诊断，返回文本）
function getTaskbarTree() {
  if (!ffiAvailable()) return 'FFI_UNAVAILABLE';
  const tray = user32.FindWindowA('Shell_TrayWnd', null);
  if (!tray) return 'NO_TRAY';
  const all = [];
  walkTree(tray, 0, all);
  const lines = ['TRAY:' + tray.toString(16)];
  for (const w of all) {
    lines.push([
      w.hwnd.toString(16), w.class,
      w.rect.left, w.rect.top, w.rect.right, w.rect.bottom,
      w.visible ? 'True' : 'False',
      w.text.replace(/\|/g, ' ')
    ].join('|'));
    if (w.isCandidate) lines.push('CANDIDATE:' + w.hwnd.toString(16));
  }
  return lines.join('\n');
}

// 挑出"原生时钟"窗口：优先候选里最右下、可见、文本像时间(hh:mm 或含 /)
function pickClock() {
  if (!ffiAvailable()) return null;
  const tray = user32.FindWindowA('Shell_TrayWnd', null);
  if (!tray) return null;
  const all = [];
  walkTree(tray, 0, all);
  const rects = [];
  for (const w of all) {
    if (!w.isCandidate) continue;
    const L = w.rect.left, T = w.rect.top, R = w.rect.right, B = w.rect.bottom;
    const ww = R - L, hh = B - T;
    if (ww <= 0 || hh <= 0) continue;
    if (ww > 400 || hh > 200) continue;        // 太大不是时钟格
    const likeTime = /:/.test(w.text) || /\//.test(w.text) || (w.text || '').trim() === '';
    rects.push({ hwnd: w.hwnd, L, T, R, B, vis: w.visible, txt: w.text, likeTime, right: R, bottom: B });
  }
  if (rects.length === 0) return null;
  rects.sort(function (a, b) {
    const av = (a.vis ? 1 : 0) * 2 + (a.likeTime ? 1 : 0);
    const bv = (b.vis ? 1 : 0) * 2 + (b.likeTime ? 1 : 0);
    if (av !== bv) return bv - av;
    return (b.right + b.bottom) - (a.right + a.bottom);
  });
  const best = rects[0];
  return { hwnd: best.hwnd, x: best.L, y: best.T, width: best.R - best.L, height: best.B - best.T };
}

// 返回原生时钟的物理像素矩形；找不到返回 null
function getClockRect() {
  const c = pickClock();
  if (!c) return null;
  return { x: c.x, y: c.y, width: c.width, height: c.height };
}

// 隐藏 / 显示指定 hwnd（缓存最近一次找到的 hwnd，避免重复遍历）
let lastHwnd = null;
function setClockVisible(visible) {
  if (!ffiAvailable()) return;
  if (!lastHwnd) {
    const c = pickClock();
    lastHwnd = c ? c.hwnd : null;
  }
  if (!lastHwnd) return;
  const hwnd = lastHwnd;
  try {
    const style = user32.GetWindowLongPtrA(hwnd, GWL_STYLE);
    if (visible) {
      user32.SetWindowLongPtrA(hwnd, GWL_STYLE, style | WS_VISIBLE);
      user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW | SWP_NOACTIVATE);
      user32.ShowWindow(hwnd, SW_SHOW);
    } else {
      // 方案1：彻底移除 WS_VISIBLE（explorer 重绘不会把占位带回来）
      user32.SetWindowLongPtrA(hwnd, GWL_STYLE, (style & ~WS_VISIBLE));
      // 方案2：移出屏幕外 + 0 尺寸（双保险，防止 explorer 重绘复原）
      user32.SetWindowPos(hwnd, 0, -32000, -32000, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW);
    }
  } catch (e) { /* 静默失败 */ }
}

// 强制重新查找（分辨率变化 / 睡眠恢复时调用）
function resetCache() {
  lastHwnd = null;
}

// 可选兜底：写入/删除 HideClock 注册表策略（部分 Win10 版本有效）
// 注册表操作仍走 PowerShell，但这只是"可选兜底、低频、一次性"，不影响主路径性能。
function setHideClockPolicy(on) {
  const { spawnSync } = require('child_process');
  const script = on
    ? 'New-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" -Name "HideClock" -Value 1 -PropertyType DWord -Force | Out-Null'
    : 'Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" -Name "HideClock" -ErrorAction SilentlyContinue';
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 8000 });
  } catch (e) {}
}

module.exports = {
  getClockRect, setClockVisible, setHideClockPolicy,
  getTaskbarTree, pickClock, ffiAvailable, resetCache
};
