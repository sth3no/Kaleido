#Requires -Version 5.1
<#
Install the standalone M0 build and its per-user shell registration.

Capability registration only (Microsoft "Application Registration" / "Default Programs"):
Applications\Kaleido.exe, one ProgID, Classes\<ext>\OpenWithProgids, Capabilities +
RegisteredApplications, per-extension SystemFileAssociations verbs, App Paths, Start menu and
Send to shortcuts. It never writes or deletes UserChoice, never forges its hash, never touches
UCPD, never changes an extension's default value and never writes Explorer\FileExts history.

-ChooseDefault (on its own, after installing) opens Kaleido's page in Windows Default apps, the
supported way for the user to make Kaleido the default; read the result back with
scripts\diagnose-associations.ps1. -Unregister removes only entries that still point at this
installation.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Unregister,
    [switch]$ChooseDefault,
    # Folder with the release kaleido-proto.exe and kaleido-mpv.exe (another worktree's build is fine).
    [string]$BuildDir
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $BuildDir) { $BuildDir = Join-Path $RepoRoot 'target\release' }
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Kaleido-M0'
$Exe = Join-Path $InstallDir 'Kaleido.exe'
$Command = '"' + $Exe + '" -- "%1"'
$Icon = '"' + $Exe + '",0'
$ProgId = 'Kaleido.M0.Video'
$VerbName = 'Kaleido.M0.Play'
$AppKey = 'Software\Classes\Applications\Kaleido.exe'
$WildcardVerb = 'Software\Classes\*\shell\' + $VerbName      # earlier layout, removed on sight
$Capabilities = 'Software\Kaleido\M0\Capabilities'
$RegisteredName = 'Kaleido'
$AppPath = 'Software\Microsoft\Windows\CurrentVersion\App Paths\Kaleido.exe'
$FileExts = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Kaleido M0.lnk'
$SendToPath = Join-Path ([Environment]::GetFolderPath('SendTo')) 'Kaleido.lnk'
$Extensions = @(
    '.3g2', '.3gp', '.3gp2', '.3gpp', '.amv', '.asf', '.avi', '.av1', '.divx',
    '.f4v', '.flv', '.h264', '.h265', '.hevc', '.m1v', '.m2t', '.m2ts', '.m2v',
    '.m4v', '.mkv', '.mov', '.mp2v', '.mp4', '.mp4v', '.mpe', '.mpeg',
    '.mpg', '.mpv', '.mts', '.mxf', '.ogm', '.ogv', '.qt', '.rm', '.rmvb',
    '.ts', '.vob', '.webm', '.wmv', '.wtv', '.y4m'
)
# No longer advertised: .mod is also Go modules and tracker music, and is not in spec 8.12.
$RetiredExtensions = @('.mod')
$Hive = [Microsoft.Win32.Registry]::CurrentUser
$None = [Microsoft.Win32.RegistryValueKind]::None
$Shell = New-Object -ComObject WScript.Shell

function Get-RegistrationValue([string]$Path, [string]$Name) {
    $Key = $Hive.OpenSubKey($Path)
    if (-not $Key) { return $null }
    try { return $Key.GetValue($Name) } finally { $Key.Dispose() }
}

function Set-RegistrationValue {
    param([string]$Path, [string]$Name, [object]$Value,
        [Microsoft.Win32.RegistryValueKind]$Kind = [Microsoft.Win32.RegistryValueKind]::String)
    $Key = $Hive.CreateSubKey($Path)
    try { $Key.SetValue($Name, $Value, $Kind) } finally { $Key.Dispose() }
}

function Remove-RegistrationValue([string]$Path, [string]$Name) {
    $Key = $Hive.OpenSubKey($Path, $true)
    if ($Key) { try { $Key.DeleteValue($Name, $false) } finally { $Key.Dispose() } }
}

# A command, path or shortcut target belongs to this installation when it names our Kaleido.exe.
function Test-Ours([object]$Value) {
    return ($null -ne $Value) -and ([string]$Value).IndexOf($Exe, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-RegistrationKey([string]$Path) {
    $Key = $Hive.OpenSubKey($Path)
    if ($Key) { $Key.Dispose(); return $true }
    return $false
}

# Deletes a key we created unless its command now points at another program.
function Remove-OwnedTree([string]$Path, [string]$CommandPath) {
    if (-not (Test-RegistrationKey $Path)) { return }
    $Value = Get-RegistrationValue $CommandPath ''
    if ($null -ne $Value -and -not (Test-Ours $Value)) {
        Write-Warning "Left $Path alone: it points at another program ($Value)."
        return
    }
    $Hive.DeleteSubKeyTree($Path, $false)
}

# Parent keys created only to hold our values go too, but only while nothing else lives in them.
function Remove-KeyIfEmpty([string]$Path) {
    $Key = $Hive.OpenSubKey($Path)
    if (-not $Key) { return }
    try { $Empty = $Key.ValueCount -eq 0 -and $Key.SubKeyCount -eq 0 } finally { $Key.Dispose() }
    if ($Empty) { $Hive.DeleteSubKey($Path, $false) }
}

function Remove-ExtensionRegistration([string]$Extension) {
    Remove-RegistrationValue "Software\Classes\$Extension\OpenWithProgids" $ProgId
    Remove-KeyIfEmpty "Software\Classes\$Extension\OpenWithProgids"
    Remove-KeyIfEmpty "Software\Classes\$Extension"
    # Installer-written history from earlier versions: exactly our ProgID value, nothing else.
    Remove-RegistrationValue "$FileExts\$Extension\OpenWithProgids" $ProgId
    Remove-RegistrationValue "$AppKey\SupportedTypes" $Extension
    Remove-RegistrationValue "$Capabilities\FileAssociations" $Extension
    $Verb = "Software\Classes\SystemFileAssociations\$Extension\shell\$VerbName"
    Remove-OwnedTree $Verb "$Verb\command"
    Remove-KeyIfEmpty "Software\Classes\SystemFileAssociations\$Extension\shell"
    Remove-KeyIfEmpty "Software\Classes\SystemFileAssociations\$Extension"
}

function Test-ShortcutOurs([string]$Link) {
    return (Test-Path -LiteralPath $Link) -and ($Shell.CreateShortcut($Link).TargetPath -eq $Exe)
}

if ($Unregister) {
    if (-not $PSCmdlet.ShouldProcess('HKCU Kaleido M0 entries', 'Unregister')) { return }
    foreach ($Extension in $Extensions + $RetiredExtensions) { Remove-ExtensionRegistration $Extension }
    Remove-OwnedTree $WildcardVerb "$WildcardVerb\command"
    Remove-OwnedTree "Software\Classes\$ProgId" "Software\Classes\$ProgId\shell\open\command"
    Remove-OwnedTree $AppKey "$AppKey\shell\open\command"
    if (Test-Ours (Get-RegistrationValue $AppPath '')) { $Hive.DeleteSubKeyTree($AppPath, $false) }
    if ((Get-RegistrationValue 'Software\RegisteredApplications' $RegisteredName) -eq $Capabilities) {
        Remove-RegistrationValue 'Software\RegisteredApplications' $RegisteredName
        $Hive.DeleteSubKeyTree('Software\Kaleido\M0', $false)
    }
    foreach ($Link in @($ShortcutPath, $SendToPath)) {
        if (Test-ShortcutOurs $Link) { Remove-Item -LiteralPath $Link }
        elseif (Test-Path -LiteralPath $Link) { Write-Warning "Left $Link alone: it belongs to another program." }
    }
} elseif ($ChooseDefault) {
    if ((Get-RegistrationValue 'Software\RegisteredApplications' $RegisteredName) -ne $Capabilities) {
        throw 'Kaleido is not registered yet; run the script without -ChooseDefault first.'
    }
    # The supported route: Windows shows Kaleido's file types and the user decides.
    Start-Process "ms-settings:defaultapps?registeredAppUser=$([Uri]::EscapeDataString($RegisteredName))"
    Write-Output 'Opened Default apps for Kaleido. Check the result with scripts\diagnose-associations.ps1.'
    return
} else {
    # Do not take over another installation that happens to use the same names.
    foreach ($Check in @(
        @{ Path = "$AppKey\shell\open\command"; Name = '' },
        @{ Path = "Software\Classes\$ProgId\shell\open\command"; Name = '' },
        @{ Path = $AppPath; Name = '' }
    )) {
        $Value = Get-RegistrationValue $Check.Path $Check.Name
        if ($null -ne $Value -and -not (Test-Ours $Value)) { throw "Another program owns $($Check.Path): $Value" }
    }
    $Registered = Get-RegistrationValue 'Software\RegisteredApplications' $RegisteredName
    if ($null -ne $Registered -and $Registered -ne $Capabilities) { throw "Another program is registered as '$RegisteredName': $Registered" }
    foreach ($Link in @($ShortcutPath, $SendToPath)) {
        if ((Test-Path -LiteralPath $Link) -and -not (Test-ShortcutOurs $Link)) { throw "Another program owns $Link." }
    }

    $Files = @(
        @{ Source = Join-Path $BuildDir 'kaleido-proto.exe'; Destination = 'Kaleido.exe' },
        @{ Source = Join-Path $BuildDir 'kaleido-mpv.exe'; Destination = 'kaleido-mpv.exe' },
        @{ Source = Join-Path $RepoRoot 'vendor\libmpv\libmpv-2.dll'; Destination = 'libmpv-2.dll' },
        @{ Source = Join-Path $RepoRoot 'vendor\thumbfast\thumbfast.lua'; Destination = 'resources\thumbfast.lua' },
        @{ Source = Join-Path $RepoRoot 'prototype\src-tauri\test-scripts\click-target.lua'; Destination = 'resources\click-target.lua' },
        @{ Source = Join-Path $RepoRoot 'LICENSE'; Destination = 'LICENSE' }
    )
    foreach ($File in $Files) {
        if (-not (Test-Path -LiteralPath $File.Source -PathType Leaf)) {
            throw "Missing $($File.Source). Build the release app and kaleido-mpv first (or pass -BuildDir)."
        }
    }
    # Replacing files under a running player fails halfway or leaves a stale helper behind.
    $Running = @(Get-Process -Name Kaleido, kaleido-mpv -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) })
    if ($Running.Count) { throw "Close Kaleido first (running: $(($Running | ForEach-Object { "$($_.ProcessName) $($_.Id)" }) -join ', '))." }

    if (-not $PSCmdlet.ShouldProcess($InstallDir, "Install Kaleido M0 and register it for $($Extensions.Count) video extensions")) { return }
    New-Item -ItemType Directory -Path (Join-Path $InstallDir 'resources') -Force | Out-Null
    foreach ($File in $Files) {
        Copy-Item -LiteralPath $File.Source -Destination (Join-Path $InstallDir $File.Destination) -Force
    }

    Set-RegistrationValue $AppKey 'FriendlyAppName' 'Kaleido'
    Set-RegistrationValue $AppKey 'ApplicationCompany' 'sth3no'
    Set-RegistrationValue "$AppKey\DefaultIcon" '' $Icon
    Set-RegistrationValue "$AppKey\shell" '' 'open'
    Set-RegistrationValue "$AppKey\shell\open\command" '' $Command
    Set-RegistrationValue "Software\Classes\$ProgId" '' 'Kaleido video'
    # Keeps Kaleido an Open with choice but out of Windows' implicit default fallback:
    # the user picks the default in Settings (-ChooseDefault).
    Set-RegistrationValue "Software\Classes\$ProgId" 'AllowSilentDefaultTakeOver' ([byte[]]@()) $None
    Set-RegistrationValue "Software\Classes\$ProgId\DefaultIcon" '' $Icon
    Set-RegistrationValue "Software\Classes\$ProgId\Application" 'ApplicationName' 'Kaleido'
    Set-RegistrationValue "Software\Classes\$ProgId\Application" 'ApplicationCompany' 'sth3no'
    Set-RegistrationValue "Software\Classes\$ProgId\Application" 'ApplicationIcon' $Icon
    # No explicit AppUserModelID is registered for this standalone build.
    Remove-RegistrationValue "Software\Classes\$ProgId\Application" 'AppUserModelId'
    Set-RegistrationValue "Software\Classes\$ProgId\shell" '' 'open'
    # Shown as the default action when Kaleido is the default; the supplementary verb below
    # already says "Přehrát v Kaleidu", so this one stays short (VLC does the same).
    Set-RegistrationValue "Software\Classes\$ProgId\shell\open" '' 'Přehrát'
    Set-RegistrationValue "Software\Classes\$ProgId\shell\open\command" '' $Command
    Set-RegistrationValue $Capabilities 'ApplicationName' 'Kaleido'
    Set-RegistrationValue $Capabilities 'ApplicationDescription' 'Kaleido M0 - video player powered by upstream libmpv'
    Set-RegistrationValue $Capabilities 'ApplicationIcon' $Icon
    Set-RegistrationValue 'Software\RegisteredApplications' $RegisteredName $Capabilities
    Set-RegistrationValue $AppPath '' $Exe
    Set-RegistrationValue $AppPath 'Path' $InstallDir
    foreach ($Extension in $Extensions) {
        Set-RegistrationValue "$AppKey\SupportedTypes" $Extension ''
        Set-RegistrationValue "$Capabilities\FileAssociations" $Extension $ProgId
        Set-RegistrationValue "Software\Classes\$Extension\OpenWithProgids" $ProgId ([byte[]]@()) $None
        # Explorer\FileExts is Windows' own per-user history; only remove what earlier versions wrote.
        Remove-RegistrationValue "$FileExts\$Extension\OpenWithProgids" $ProgId
        # A supplementary verb per extension stays in the classic menu whatever the default is.
        $Verb = "Software\Classes\SystemFileAssociations\$Extension\shell\$VerbName"
        Set-RegistrationValue $Verb '' 'Přehrát v Kaleidu'
        Set-RegistrationValue $Verb 'MUIVerb' 'Přehrát v Kaleidu'
        Set-RegistrationValue $Verb 'Icon' $Icon
        Set-RegistrationValue $Verb 'MultiSelectModel' 'Single'
        Set-RegistrationValue "$Verb\command" '' $Command
    }
    foreach ($Extension in $RetiredExtensions) { Remove-ExtensionRegistration $Extension }
    Remove-OwnedTree $WildcardVerb "$WildcardVerb\command"
    foreach ($Link in @($ShortcutPath, $SendToPath)) {
        # Recreate tracking metadata after replacing the target executable.
        if (Test-Path -LiteralPath $Link) { Remove-Item -LiteralPath $Link }
        $Shortcut = $Shell.CreateShortcut($Link)
        $Shortcut.TargetPath = $Exe
        $Shortcut.Arguments = $(if ($Link -eq $SendToPath) { '--' } else { '' })
        $Shortcut.WorkingDirectory = $InstallDir
        $Shortcut.IconLocation = "$Exe,0"
        $Shortcut.Description = 'Kaleido M0'
        $Shortcut.Save()
    }
}

if (-not ('KaleidoM0.ShellNotify' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace KaleidoM0 {
    public static class ShellNotify {
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
        [DllImport("shell32.dll", EntryPoint = "SHChangeNotify", CharSet = CharSet.Unicode)]
        public static extern void NotifyPath(uint eventId, uint flags, string path, IntPtr item2);
    }
}
'@
}
foreach ($Link in @($ShortcutPath, $SendToPath)) {
    $LinkEvent = $(if (Test-Path -LiteralPath $Link) { 2 } else { 4 }) # SHCNE_CREATE / SHCNE_DELETE
    [KaleidoM0.ShellNotify]::NotifyPath($LinkEvent, 0x1005, $Link, [IntPtr]::Zero)
}
[KaleidoM0.ShellNotify]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)

if ($Unregister) {
    Write-Output 'Kaleido M0 unregistered. Local application files were kept; defaults chosen in Windows were not touched.'
} else {
    Write-Output "Installed: $Exe"
    Write-Output "Registered $($Extensions.Count) video extensions and Send to > Kaleido. Existing defaults were preserved."
    Write-Output 'To make Kaleido the default player, run this script with -ChooseDefault.'
}
