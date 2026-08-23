# diag-taskbar.ps1  (v3 - 保证写文件 / 全局 trap)
# 在 Win10 本机运行：右键 -> 用 PowerShell 运行。结果保存到桌面 diag-taskbar-result.txt
# 本脚本用 trap 全局捕获任何异常，并在 finally 强制写文件，避免“空文件”。

$tmpLog = [System.Collections.Generic.List[string]]::new()
function L($s){ $script:tmpLog.Add([string]$s) }

$outFile = Join-Path $env:USERPROFILE "Desktop\diag-taskbar-result.txt"

trap {
    L("=== TRAP 捕获到异常 ===")
    L($_)
    L($_.ScriptStackTrace)
    # 无论如何写文件
    try { [System.IO.File]::WriteAllText($outFile, ($script:tmpLog -join "`r`n"), [System.Text.Encoding]::UTF8) } catch {}
    return
}

L("PowerShell 版本: $($PSVersionTable.PSVersion)")
L("OS: $((Get-CimInstance Win32_OperatingSystem).Caption) Build $((Get-CimInstance Win32_OperatingSystem).BuildNumber)")
L("")

# 编译 C# P/Invoke
L("正在编译 P/Invoke ...")
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class DT {
    public const uint GW_CHILD = 5;
    public const uint GW_HWNDNEXT = 2;
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    public struct RECT { public int L, T, R, B; }

    public static void Walk(IntPtr h, int depth, List<string> outLines) {
        if (h == IntPtr.Zero || depth > 14) return;
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        string cls = sb.ToString();
        GetWindowRect(h, out RECT r);
        bool vis = IsWindowVisible(h);
        int len = GetWindowTextLength(h);
        string txt = "";
        if (len > 0) {
            var tsb = new StringBuilder(len + 1);
            GetWindowText(h, tsb, tsb.Capacity);
            txt = tsb.ToString().Replace("\n"," ").Replace("\r","");
            if (txt.Length > 40) txt = txt.Substring(0,40) + "...";
        }
        string indent = new string(' ', depth * 2);
        string mark = "";
        string cl = cls.ToLower();
        if (cl.Contains("clock") || cl.Contains("tray") || cl.Contains("notify") || cl.Contains("systemtray"))
            mark = "  <== 候选";
        outLines.Add(string.Format("{0}hwnd={1} cls=\"{2}\" rect=[{3},{4} {5}x{6}] vis={7} txt=\"{8}\"{9}",
            indent, h.ToString("X"), cls, r.L, r.T, r.R - r.L, r.B - r.T, vis, txt, mark));
        IntPtr child = GetWindow(h, GW_CHILD);
        if (child != IntPtr.Zero) Walk(child, depth + 1, outLines);
        IntPtr sib = GetWindow(h, GW_HWNDNEXT);
        if (sib != IntPtr.Zero) Walk(sib, depth + 1, outLines);
    }

    public static string Run() {
        var lines = new List<string>();
        IntPtr tray = FindWindow("Shell_TrayWnd", null);
        lines.Add("Shell_TrayWnd hwnd = " + (tray == IntPtr.Zero ? "NOT FOUND" : tray.ToString("X")));
        if (tray != IntPtr.Zero) Walk(tray, 0, lines);
        else lines.Add("(未找到任务栏窗口——本环境可能没有桌面 explorer 进程)");
        return string.Join("\n", lines);
    }
}
'@ -ReferencedAssemblies "System.dll"
L("编译完成。")
L("")

$tree = [DT]::Run()
L("=== 任务栏窗口树（GetWindow 遍历，缩进=层级深度）===")
L($tree)
L("")
L("=== 候选时钟相关窗口（类名含 clock/tray/notify）===")
$found = $false
foreach ($line in ($tree -split "`n")) {
    if ($line -like "*<== 候选*") { L($line); $found = $true }
}
if (-not $found) { L "(无候选——时钟可能用其他类名，请按 rect 位置(右下角)和 txt 手动识别)" }

L("")
L("=== 完成 ===")
[System.IO.File]::WriteAllText($outFile, ($script:tmpLog -join "`r`n"), [System.Text.Encoding]::UTF8)
L("结果已保存到: $outFile")
Write-Host "完成，结果在桌面 diag-taskbar-result.txt"
