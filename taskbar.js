'use strict';

/*
 * taskbar.js —— 任务栏原生时钟的隐藏 / 还原 / 取位置
 * ---------------------------------------------------------------------
 * 不需要 node-gyp 原生模块：通过 PowerShell 内联 C# (Add-Type) pinvoke
 * user32.dll 实现，避免 electron-builder 在受限环境下编译原生依赖。
 *
 * 设计要点：
 *  1) 即时隐藏：ShowWindow(TrayClockWClass, SW_HIDE) —— 无需重启 explorer。
 *  2) 持久化：写入 HKCU\...\Policies\Explorer\HideClock=1，保证重启后
 *     原生时钟仍被系统隐藏（本程序开机自启会再次叠加窗口级隐藏）。
 *  3) 退出还原：ShowWindow(..., SW_SHOWNOACTIVATE) + 删除注册表值，
 *     让原生时钟在下次 explorer 启动时恢复。
 *  4) 取矩形：GetWindowRect 返回物理像素，交由主进程按显示器缩放换算为
 *     逻辑像素后定位部件窗口，实现"同位置同尺寸"替换。
 */

const { spawnSync } = require('child_process');

// PowerShell 内联 C#：定位并操作原生时钟窗口
const PINVOKE = [
  'Add-Type @">',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class TB {',
  '  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);',
  '  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  public struct RECT { public int L, T, R, B; }',
  '  public static IntPtr Clock() {',
  '    IntPtr tray = FindWindow("Shell_TrayWnd", null);',
  '    if (tray == IntPtr.Zero) return IntPtr.Zero;',
  '    IntPtr notify = FindWindowEx(tray, IntPtr.Zero, "TrayNotifyWnd", null);',
  '    if (notify == IntPtr.Zero) notify = tray;',
  '    return FindWindowEx(notify, IntPtr.Zero, "TrayClockWClass", null);',
  '  }',
  '}',
  '"@'
].join('\n');

function runPs(script) {
  try {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return (r.stdout || '') + (r.stderr || '');
  } catch (e) {
    return '';
  }
}

// 返回原生时钟的物理像素矩形 {x,y,width,height}；找不到返回 null
function getClockRect() {
  const script = PINVOKE + '\n' +
    '$clk = [TB]::Clock()\n' +
    'if ($clk -eq [IntPtr]::Zero) { Write-Output "NONE"; exit }\n' +
    '$r = New-Object TB+RECT\n' +
    '[void][TB]::GetWindowRect($clk, [ref]$r)\n' +
    'Write-Output ("{0},{1},{2},{3}" -f $r.L, $r.T, $r.R, $r.B)\n';
  const out = runPs(script).trim();
  if (!out || out === 'NONE') return null;
  const p = out.split(',').map(Number);
  if (p.length !== 4 || p.some(function (n) { return isNaN(n); })) return null;
  return { x: p[0], y: p[1], width: p[2] - p[0], height: p[3] - p[1] };
}

// visible=true 显示，false 隐藏原生时钟
function setClockVisible(visible) {
  const script = PINVOKE + '\n' +
    '$clk = [TB]::Clock()\n' +
    'if ($clk -eq [IntPtr]::Zero) { exit }\n' +
    '[void][TB]::ShowWindow($clk, ' + (visible ? '4' : '0') + ')\n';
  runPs(script);
}

// on=true 写入 HideClock 策略；false 删除（退出时调用，重启后原生恢复）
function setHideClockPolicy(on) {
  const script = on
    ? 'New-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" -Name "HideClock" -Value 1 -PropertyType DWord -Force | Out-Null'
    : 'Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" -Name "HideClock" -ErrorAction SilentlyContinue';
  runPs(script);
}

module.exports = { getClockRect, setClockVisible, setHideClockPolicy };
