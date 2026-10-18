#Requires -Version 5.1
<#
  Výkonnostní měření sestaveného Kaleida (spec 13; cíle a postup v docs/m1/checklist.md → Výkon,
  výsledky M0 v docs/m0/report.md → Výkon).

  Měří: čas od spuštění do viditelného okna, CPU při přehrávání proti referenční libmpv
  (kaleido-mpv.exe ve vlastním okně se stejnými volbami), CPU v pauze po dohrání (keep-open),
  paměť WebView2 a dobu zavření přes WM_CLOSE. CPU je podíl ze všech logických procesorů
  (jako Správce úloh) a sčítá Kaleido.exe s celým jeho stromem procesů.

  Měří se místní instalace (scripts/install-local.ps1): vedle target\release\Kaleido.exe chybí
  libmpv-2.dll a přibalené soubory. Klip se pokaždé pouští od začátku (--start=0), i když si
  Kaleido pamatuje pozici (save-position-on-quit).

  Během měření nehýbej myší a nepiš do okna: ovládání se po 2,5 s skryje a UI má být v klidu.
  Zařízení D3D11 a hwdec se čtou z logu mpv; integrovaná GPU se volí ve Windows
  (Nastavení → Grafika → Kaleido.exe a kaleido-mpv.exe → Úspora energie).

  Příklady:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure.ps1 `
      -Clip "$env:USERPROFILE\Videos\kaleido-m0\uhd-2160p.mkv"
#>
param(
    # Složka s Kaleido.exe, kaleido-mpv.exe a libmpv-2.dll (místní instalace ze scripts/install-local.ps1).
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Kaleido-M0'),
    [string]$Clip = (Join-Path $env:USERPROFILE 'Videos\kaleido-m0\sdr-1080p.mkv'),
    [int]$StartupRuns = 5,
    [int]$CompareRuns = 2,
    [int]$PlaySeconds = 20,
    [int]$PauseSeconds = 60,
    # Délka klipu v sekundách; 0 = přečíst z vlastností souboru ve Windows.
    [double]$ClipSeconds = 0,
    # Log mpv, který zapisuje Kaleido (spec 4.3; src-tauri/src/player/options.rs: log-file).
    [string]$KaleidoLog = (Join-Path $env:LOCALAPPDATA 'Kaleido\logs\mpv.log')
)
$ErrorActionPreference = 'Stop'
$Exe = Join-Path $InstallDir 'Kaleido.exe'
$Helper = Join-Path $InstallDir 'kaleido-mpv.exe'
# Název hlavního okna (src-tauri/tauri.conf.json).
$WindowTitle = 'Kaleido'
$RefLog = Join-Path ([System.IO.Path]::GetTempPath()) 'kaleido-reference-mpv.log'
$Cores = [Environment]::ProcessorCount
$SettleSeconds = 6   # soubor načtený, ovládání skryté po 2,5 s bez pohybu myši

foreach ($Path in $Exe, $Helper, $Clip) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "Chybí $Path" }
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class M0Win {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    // Visible top-level window of the process. PowerShell passes $null as "" to string
    // parameters, so an empty title means "any title".
    public static IntPtr Find(uint pid, string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p != pid || !IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, 256);
            if (!string.IsNullOrEmpty(title) && sb.ToString() != title) return true;
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }
}
'@

function Get-ClipSeconds {
    if ($ClipSeconds -gt 0) { return $ClipSeconds }
    $item = Get-Item -LiteralPath $Clip
    $shell = New-Object -ComObject Shell.Application
    $duration = $shell.Namespace($item.DirectoryName).ParseName($item.Name).ExtendedProperty('System.Media.Duration')
    if (-not $duration) { throw 'Délku klipu nejde přečíst; zadej -ClipSeconds.' }
    [double]$duration / 1e7   # jednotky 100 ns
}

function Get-Tree([int]$Root) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
    $ids = @($Root); $frontier = @($Root)
    while ($frontier.Count) {
        $next = @($all | Where-Object { ($frontier -contains $_.ParentProcessId) -and ($ids -notcontains $_.ProcessId) } | ForEach-Object { $_.ProcessId })
        $ids += $next; $frontier = $next
    }
    @($all | Where-Object { $ids -contains $_.ProcessId })
}

function Start-Kaleido([string[]]$Arguments) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $proc = if ($Arguments) { Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru } else { Start-Process -FilePath $Exe -PassThru }
    $hwnd = [IntPtr]::Zero
    while ($hwnd -eq [IntPtr]::Zero -and $sw.ElapsedMilliseconds -lt 15000) {
        $hwnd = [M0Win]::Find([uint32]$proc.Id, $WindowTitle)
        if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 2 }
    }
    if ($hwnd -eq [IntPtr]::Zero) { throw 'Okno Kaleida se do 15 s neobjevilo.' }
    [pscustomobject]@{ Proc = $proc; Hwnd = $hwnd; WindowMs = $sw.ElapsedMilliseconds }
}

# Quoted so that paths with spaces stay one argument. In an array literal the comma binds
# tighter than +, so the concatenation must stay in parentheses. --start=0: Kaleido resumes a clip
# where the last run closed it (save-position-on-quit), and each run must play the same part.
function Get-ClipArguments { @('--start=0', '--', ('"' + $Clip + '"')) }

function Measure-Cpu([int[]]$Ids, [int]$Seconds) {
    $procs = @($Ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Where-Object { $_ })
    $t0 = @{}
    foreach ($p in $procs) { $t0[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds $Seconds
    $wall = $sw.Elapsed.TotalMilliseconds
    foreach ($p in $procs) {
        try { $cpu = $p.TotalProcessorTime.TotalMilliseconds - $t0[$p.Id] } catch { $cpu = [double]::NaN }
        [pscustomobject]@{ Id = $p.Id; Name = $p.ProcessName; CpuPct = [math]::Round(100 * $cpu / ($wall * $Cores), 2) }
    }
}

function Show-Cpu([string]$Label, $Rows) {
    $total = [double]($Rows | Measure-Object CpuPct -Sum).Sum
    $main = [double]($Rows | Where-Object { $_.Name -in 'Kaleido', 'kaleido-mpv' } | Measure-Object CpuPct -Sum).Sum
    $webview = [double]($Rows | Where-Object Name -eq 'msedgewebview2' | Measure-Object CpuPct -Sum).Sum
    "{0}: hlavní={1:N2} %  webview2={2:N2} %  celkem={3:N2} %  (procesy: {4})" -f $Label, $main, $webview, $total, @($Rows).Count
}

function Get-PrivateWorkingSetMb([int[]]$Ids) {
    $rows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $Ids -contains [int]$_.IDProcess })
    ($rows | Measure-Object WorkingSetPrivate -Sum).Sum / 1MB
}

function Show-Memory($Run) {
    $tree = Get-Tree $Run.Proc.Id
    $ids = @($tree | Where-Object Name -eq 'msedgewebview2.exe' | ForEach-Object { [int]$_.ProcessId })
    $webview = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Where-Object { $_ })
    $own = Get-Process -Id $Run.Proc.Id
    "  WebView2 ({0} procesů): soukromá pracovní sada {1:N0} MB, soukromé bajty {2:N0} MB, pracovní sada {3:N0} MB" -f `
        $webview.Count, (Get-PrivateWorkingSetMb $ids), (($webview | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB), (($webview | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
    "  Kaleido.exe: soukromá pracovní sada {0:N0} MB, soukromé bajty {1:N0} MB, pracovní sada {2:N0} MB" -f `
        (Get-PrivateWorkingSetMb @($Run.Proc.Id)), ($own.PrivateMemorySize64 / 1MB), ($own.WorkingSet64 / 1MB)
}

function Close-Kaleido($Run, [string]$Label) {
    $tree = Get-Tree $Run.Proc.Id
    $sw = [Diagnostics.Stopwatch]::StartNew()
    [void][M0Win]::PostMessage($Run.Hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) # WM_CLOSE
    [void]$Run.Proc.WaitForExit(10000)
    $mainMs = $sw.ElapsedMilliseconds
    do {
        # Same PID and name = still the same process, not a reused PID.
        $alive = @($tree | Where-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; $p -and ($p.ProcessName + '.exe') -eq $_.Name })
        if ($alive.Count) { Start-Sleep -Milliseconds 20 }
    } while ($alive.Count -and $sw.ElapsedMilliseconds -lt 10000)
    $names = ($alive | ForEach-Object Name) -join ', '
    if (-not $names) { $names = 'nic' }
    "{0}: Kaleido.exe skončil za {1} ms, celý strom ({2} procesů) za {3} ms, stále běží: {4}" -f $Label, $mainMs, $tree.Count, $sw.ElapsedMilliseconds, $names
}

function Assert-NotRunning {
    $left = @(Get-Process -Name Kaleido, kaleido-mpv -ErrorAction SilentlyContinue)
    if ($left.Count) { throw "Kaleido už běží (PID $($left.Id -join ', ')). Nejdřív ho zavři." }
}

# D3D11 device and hardware decoder from an mpv log (-v level, as log-file writes it).
function Get-VideoPath([string]$Log) {
    if (-not (Test-Path -LiteralPath $Log)) { return "log $Log chybí" }
    $text = Get-Content -LiteralPath $Log -Encoding UTF8
    $device = ($text | Select-String -Pattern '\[vo/gpu-next/d3d11\] Device Name: (.+)$' | Select-Object -First 1)
    $hwdec = ($text | Select-String -Pattern 'Using hardware decoding \((.+)\)' | Select-Object -First 1)
    $warp = [bool]($text | Select-String -SimpleMatch 'Using a software adapter' | Select-Object -First 1)
    "GPU {0}{1}, hwdec {2}" -f `
        $(if ($device) { $device.Matches[0].Groups[1].Value.Trim() } else { 'neznámá' }),
        $(if ($warp) { ' (WARP)' } else { '' }),
        $(if ($hwdec) { $hwdec.Matches[0].Groups[1].Value } else { 'ne' })
}

$Length = Get-ClipSeconds
# A short clip (the 20 s 4K one) must not reach EOF during the playback sample.
$PlaySample = [int][math]::Min($PlaySeconds, [math]::Floor($Length - $SettleSeconds - 1))
if ($PlaySample -lt 3) { throw "Klip má jen $Length s; na měření přehrávání je krátký." }

"== Prostředí"
"Logické procesory: $Cores"
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Exe).Hash
"Exe: $Exe ($((Get-Item -LiteralPath $Exe).LastWriteTime), SHA-256 $($hash.Substring(0, 16))…)"
$RepoExe = Join-Path $PSScriptRoot '..\target\release\Kaleido.exe'
if (Test-Path -LiteralPath $RepoExe) {
    "Shoda s target/release/Kaleido.exe: $(if ((Get-FileHash -Algorithm SHA256 -LiteralPath $RepoExe).Hash -eq $hash) { 'ano' } else { 'ne' })"
}
"Klip: {0} ({1:N1} s)" -f $Clip, $Length
Get-CimInstance Win32_VideoController | ForEach-Object { "Grafika: $($_.Name), $($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution) @ $($_.CurrentRefreshRate) Hz" }
Assert-NotRunning

"== 1. Spuštění → viditelné okno (bez souboru)"
$times = @()
for ($i = 1; $i -le $StartupRuns; $i++) {
    $run = Start-Kaleido @()
    $times += $run.WindowMs
    "běh ${i}: okno viditelné za $($run.WindowMs) ms"
    Start-Sleep -Milliseconds 1500
    Close-Kaleido $run "běh $i, zavření bez souboru"
    Start-Sleep -Milliseconds 800
}
$sorted = @($times | Sort-Object)
"medián $($sorted[[int][math]::Floor($sorted.Count / 2)]) ms, min $($sorted[0]) ms, max $($sorted[-1]) ms"

"== 2. Přehrávání: Kaleido proti referenční libmpv, $CompareRuns × $PlaySample s"
for ($i = 1; $i -le $CompareRuns; $i++) {
    Assert-NotRunning
    $run = Start-Kaleido (Get-ClipArguments)
    Start-Sleep -Seconds $SettleSeconds
    Show-Cpu "Kaleido, běh $i" (Measure-Cpu ((Get-Tree $run.Proc.Id).ProcessId) $PlaySample)
    Show-Memory $run
    Close-Kaleido $run '  zavření při přehrávání'
    "  $(Get-VideoPath $KaleidoLog)"
    Start-Sleep -Milliseconds 800

    $ref = Start-Process -FilePath $Helper -PassThru -ArgumentList (@(
        '--vo=gpu-next', '--gpu-api=d3d11', '--hwdec=auto-safe', '--target-colorspace-hint=yes',
        '--keep-open=yes', '--force-window=yes', '--osc=no', '--geometry=1280x720',
        ('"--log-file=' + $RefLog + '"')) + (Get-ClipArguments))
    Start-Sleep -Seconds $SettleSeconds
    $refWindow = [M0Win]::Find([uint32]$ref.Id, $null)
    Show-Cpu "Reference, běh $i (okno: $($refWindow -ne [IntPtr]::Zero))" (Measure-Cpu ((Get-Tree $ref.Id).ProcessId) $PlaySample)
    if ($refWindow -ne [IntPtr]::Zero) { [void][M0Win]::PostMessage($refWindow, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    if (-not $ref.WaitForExit(5000)) { Stop-Process -Id $ref.Id -Force -ErrorAction SilentlyContinue }
    "  $(Get-VideoPath $RefLog)"
    Start-Sleep -Milliseconds 800
}

"== 3. Pauza po dohrání (keep-open), $PauseSeconds s"
Assert-NotRunning
$run = Start-Kaleido (Get-ClipArguments)
$started = [Diagnostics.Stopwatch]::StartNew()
$wait = [int][math]::Ceiling($Length + 3 - $started.Elapsed.TotalSeconds)
if ($wait -gt 0) { Start-Sleep -Seconds $wait }
$tree = Get-Tree $run.Proc.Id
"strom procesů: " + (($tree | Group-Object Name | ForEach-Object { "$($_.Count)× $($_.Name)" }) -join ', ')
Show-Cpu "Kaleido v pauze" (Measure-Cpu ($tree.ProcessId) $PauseSeconds)
Show-Memory $run
Close-Kaleido $run 'zavření v pauze'

"== Zbylé procesy"
Start-Sleep -Milliseconds 500
$left = @(Get-Process -Name Kaleido, kaleido-mpv -ErrorAction SilentlyContinue)
if ($left.Count) { "stále běží: " + (($left | ForEach-Object { "$($_.ProcessName) $($_.Id)" }) -join ', ') } else { 'žádné' }
