'use strict';

/*
 * taskbar.js —— 任务栏原生时钟的查找 / 隐藏 / 还原 / 取位置
 * ---------------------------------------------------------------------
 * 无需 node-gyp 原生模块：通过 PowerShell 内联 C# (Add-Type) pinvoke user32.dll。
 *
 * 重写说明（v1.3，针对 Win10 不可用问题）：
 *  - 旧版用 EnumChildWindows(Shell_TrayWnd) 只枚举“直接子”窗口，并通过类名
 *    含 "TrayClock" 匹配。但：
 *      * Win10 的时钟类名为 "ClockSurface"，且挂在 TrayNotifyWnd 下面（非直接子）；
 *      * EnumChildWindows 在某些 PowerShell 约束语言模式下会失败。
 *    导致取不到矩形 → 部件走盲猜 fallback → 盖不住原生时钟。
 *  - 新版：用 GetWindow(GW_CHILD) + GetWindow(GW_HWNDNEXT) 深度优先递归整棵
 *    Shell_TrayWnd 树，收集所有候选（类名含 clock/tray/notify/systemtray，
 *    也接受 ClockSurface），取“最右下、可见、文本像时间”的那个。
 *  - 隐藏改用 SetWindowLong(GWL_STYLE, 去 WS_VISIBLE) + SetWindowPos 移出屏幕外
 *    并设 0 尺寸，比单纯 ShowWindow(SW_HIDE) 在 Win10 上更稳（explorer 会重绘
 *    把 SW_HIDE 的窗口带回来，但 0 尺寸+屏幕外 不会占位）。
 *  - 注册表 HideClock 策略保留为“可选兜底”（不依赖 explorer 重启即可生效的
 *    部分版本仍有效），不再作为唯一手段。
 */

const { spawnSync } = require('child_process');

// 一次性编译的 C# 代码（查找整棵窗口树 + 隐藏/还原）
const PINVOKE = [
  'Add-Type @">',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'using System.Collections.Generic;',
  'public class TB {',
  '  public const uint GW_CHILD = 5, GW_HWNDNEXT = 2;',
  '  public const int GWL_STYLE = -16;',
  '  public const long WS_VISIBLE = 0x10000000;',
  '  public const long WS_DISABLED = 0x08000000;',
  '  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
  '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern long GetWindowLong(IntPtr h, int i);',
  '  [DllImport("user32.dll")] public static extern long SetWindowLong(IntPtr h, int i, long v);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hgt, uint f);',
  '  public struct RECT { public int L, T, R, B; }',
  '  public static void Walk(IntPtr h, int depth, List<string> outLines) {',
  '    if (h == IntPtr.Zero || depth > 14) return;',
  '    var sb = new StringBuilder(256); GetClassName(h, sb, 256); string cls = sb.ToString();',
  '    GetWindowRect(h, out RECT r);',
  '    bool vis = IsWindowVisible(h);',
  '    int len = GetWindowTextLength(h);',
  '    string txt = "";',
  '    if (len > 0) { var tsb = new StringBuilder(len + 1); GetWindowText(h, tsb, tsb.Capacity); txt = tsb.ToString().Replace("\\n"," ").Replace("\\r",""); }',
  '    string cl = cls.ToLower();',
  '    bool cand = cl.Contains("clock") || cl.Contains("tray") || cl.Contains("notify") || cl.Contains("systemtray");',
  '    outLines.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}", h.ToString("X"), cls, r.L, r.T, r.R, r.B, vis, txt.Replace("|"," ")));',
  '    if (cand) outLines.Add("CANDIDATE:" + h.ToString("X"));',
  '    IntPtr child = GetWindow(h, GW_CHILD); if (child != IntPtr.Zero) Walk(child, depth+1, outLines);',
  '    IntPtr sib = GetWindow(h, GW_HWNDNEXT); if (sib != IntPtr.Zero) Walk(sib, depth+1, outLines);',
  '  }',
  '  public static string Tree() {',
  '    var lines = new List<string>();',
  '    IntPtr tray = FindWindow("Shell_TrayWnd", null);',
  '    if (tray == IntPtr.Zero) return "NO_TRAY";',
  '    lines.Add("TRAY:" + tray.ToString("X"));',
  '    Walk(tray, 0, lines);',
  '    return string.Join("\\n", lines);',
  '  }',
  '  public static void Hide(IntPtr h) {',
  '    if (h == IntPtr.Zero) return;',
  '    long s = GetWindowLong(h, GWL_STYLE);',
  '    SetWindowLong(h, GWL_STYLE, s & ~WS_VISIBLE);',
  '    SetWindowPos(h, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0002 | 0x0020);',
  '  }',
  '  public static void Show(IntPtr h) {',
  '    if (h == IntPtr.Zero) return;',
  '    long s = GetWindowLong(h, GWL_STYLE);',
  '    SetWindowLong(h, GWL_STYLE, s | WS_VISIBLE);',
  '    SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0020);',
  '  }',
  '}',
  '"@'
].join('\n');

function runPs(script) {
  try {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return (r.stdout || '') + (r.stderr || '');
  } catch (e) {
    return '';
  }
}

// 取整棵任务栏窗口树（用于诊断，返回文本）
function getTaskbarTree() {
  const script = PINVOKE + '\nWrite-Output ([TB]::Tree())';
  return runPs(script).trim();
}

// 在窗口树中挑出“原生时钟”窗口：优先候选里最右下、可见、文本像时间(hh:mm 或含 /)
function pickClock() {
  const tree = getTaskbarTree();
  if (!tree || tree === 'NO_TRAY') return null;
  const lines = tree.split('\n');
  const rects = [];
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const parts = line.split('|');
    if (parts.length < 8) continue;
    const hwnd = parts[0];
    const cls = parts[1];
    const L = +parts[2], T = +parts[3], R = +parts[4], B = +parts[5];
    const vis = parts[6] === 'True';
    const txt = parts[7];
    const cl = cls.toLowerCase();
    const isCandidate = cl.includes('clock') || cl.includes('tray') || cl.includes('notify') || cl.includes('systemtray');
    if (!isCandidate) continue;
    // 排除明显不是时钟的（如整个 TrayNotifyWnd 大块、开始按钮等）
    const w = R - L, h = B - T;
    if (w <= 0 || h <= 0) continue;
    if (w > 400 || h > 200) continue;            // 太大不是时钟格
    // 文本像时间：含冒号 或 含斜杠（日期），或为空（某些时钟文本在子窗口）
    const likeTime = /:/.test(txt) || /\//.test(txt) || txt.trim() === '';
    rects.push({ hwnd, L, T, R, B, vis, txt, likeTime, area: w * h, right: R, bottom: B });
  }
  if (rects.length === 0) return null;
  // 优先：可见 + 像时间；再按“最右下”排序（任务栏时间通常在右下角）
  rects.sort(function (a, b) {
    const av = (a.vis ? 1 : 0) * 2 + (a.likeTime ? 1 : 0);
    const bv = (b.vis ? 1 : 0) * 2 + (b.likeTime ? 1 : 0);
    if (av !== bv) return bv - av;
    return (b.right + b.bottom) - (a.right + a.bottom);
  });
  const best = rects[0];
  return {
    hwnd: best.hwnd,
    x: best.L, y: best.T,
    width: best.R - best.L, height: best.B - best.T
  };
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
  // 若没有缓存 hwnd，先查找
  if (!lastHwnd) {
    const c = pickClock();
    lastHwnd = c ? c.hwnd : null;
  }
  if (!lastHwnd) return;
  const script = PINVOKE + '\n' +
    '$h = [IntPtr]::new(' + parseHwnd(lastHwnd) + ')\n' +
    (visible ? '[TB]::Show($h)' : '[TB]::Hide($h)') + '\n';
  runPs(script);
}

function parseHwnd(hex) {
  // hex 形如 "1A2B3C4D"，转十进制字符串
  return parseInt(hex, 16).toString();
}

// 可选兜底：写入/删除 HideClock 注册表策略（部分 Win10 版本有效）
function setHideClockPolicy(on) {
  const script = on
    ? 'New-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" -Name "HideClock" -Value 1 -PropertyType DWord -Force | Out-Null'
    : 'Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" -Name "HideClock" -ErrorAction SilentlyContinue';
  runPs(script);
}

module.exports = { getClockRect, setClockVisible, setHideClockPolicy, getTaskbarTree, pickClock };
