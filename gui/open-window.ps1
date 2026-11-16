# agent-watch: opens the agents window (an Edge app window) without taking the
# keyboard. Windows lets a window that just opened take the foreground, so a
# window that opens while you type would catch your keystrokes. This opens it,
# hands the keyboard straight back to the window that had it, and lifts the new
# window above the others without activating it, so it is in sight.
#
# Run by the mod when the window opens by itself (two agents at work):
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File open-window.ps1 -Url <file url> -Size 1280,840 -Title Agents
# Only Windows' own user32 calls; nothing is downloaded, installed or kept.
param([Parameter(Mandatory = $true)][string]$Url, [string]$Size = '1280,840', [string]$Title = 'Agents')
$ErrorActionPreference = 'Stop'

try {
  Add-Type -Namespace AgentWatchOpen -Name Win -MemberDefinition @'
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] public static extern uint ProcessOf(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
  $w = [AgentWatchOpen.Win]
} catch {
  # Where Windows will not load these calls, the window still opens, as it always did.
  Start-Process -FilePath 'msedge' -ArgumentList @("--app=$Url", "--window-size=$Size")
  exit 0
}

# The visible top-level windows; with $Title, only those whose title starts with it.
function Visible([string]$Prefix = '') {
  $found = New-Object System.Collections.Generic.List[IntPtr]
  $each = [AgentWatchOpen.Win+EnumProc] {
    param($h, $l)
    if ($w::IsWindowVisible($h)) {
      $text = New-Object System.Text.StringBuilder 256
      [void]$w::GetWindowText($h, $text, 256)
      if ($Prefix -eq '' -or $text.ToString().StartsWith($Prefix)) { $found.Add($h) }
    }
    $true
  }
  [void]$w::EnumWindows($each, [IntPtr]::Zero)
  return $found.ToArray()
}

# True for a window of Edge's that was not there before the launch.
function IsNewEdge([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero -or $all -contains $h) { return $false }
  $id = [uint32]0
  [void]$w::ProcessOf($h, [ref]$id)
  return $id -ne 0 -and (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName -eq 'msedge'
}

$before = $w::GetForegroundWindow()
# Every window there before: another session's agents window, or one of your own, is not this one.
$all = @(Visible)
$old = @(Visible $Title)
Start-Process -FilePath 'msedge' -ArgumentList @("--app=$Url", "--window-size=$Size")

$win = [IntPtr]::Zero
$until = (Get-Date).AddSeconds(10)
$settled = $null
while ((Get-Date) -lt $until) {
  Start-Sleep -Milliseconds 40
  # The new window may take the foreground before its title has loaded, and again a
  # moment after it shows: whenever a new Edge window has it, hand it straight back.
  $now = $w::GetForegroundWindow()
  if ($before -ne [IntPtr]::Zero -and $now -ne $before -and (IsNewEdge $now)) {
    $mine = $w::GetCurrentThreadId()
    $theirs = $w::GetWindowThreadProcessId($now, [IntPtr]::Zero)
    [void]$w::AttachThreadInput($mine, $theirs, $true)
    [void]$w::SetForegroundWindow($before)
    [void]$w::AttachThreadInput($mine, $theirs, $false)
  }
  if ($win -eq [IntPtr]::Zero) {
    $new = @(Visible $Title) | Where-Object { $old -notcontains $_ } | Select-Object -First 1
    if ($new) { $win = $new; $settled = (Get-Date).AddMilliseconds(900) }
    continue
  }
  if ((Get-Date) -ge $settled) { break }
}

if ($win -ne [IntPtr]::Zero) {
  # In sight, without the keyboard: above every window, then let go of that at
  # once (SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE).
  [void]$w::SetWindowPos($win, [IntPtr]-1, 0, 0, 0, 0, 0x0013)
  [void]$w::SetWindowPos($win, [IntPtr]-2, 0, 0, 0, 0, 0x0013)
}
exit 0
