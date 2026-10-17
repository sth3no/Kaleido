#Requires -Version 5.1
<# Install the standalone M0 build and per-user shell actions. Never changes UserChoice. #>
[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$Unregister)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Kaleido-M0'
$Exe = Join-Path $InstallDir 'Kaleido.exe'
$Command = '"' + $Exe + '" -- "%1"'
$Icon = $Exe + ',0'
$ProgId = 'Kaleido.M0.Video'
$AppKey = 'Software\Classes\Applications\Kaleido.exe'
$VideoVerb = 'Software\Classes\*\shell\Kaleido.M0.Play'
$Capabilities = 'Software\Kaleido\M0\Capabilities'
$AppPath = 'Software\Microsoft\Windows\CurrentVersion\App Paths\Kaleido.exe'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Kaleido M0.lnk'
$SendToPath = Join-Path ([Environment]::GetFolderPath('SendTo')) 'Kaleido.lnk'
$Extensions = @(
    '.3g2', '.3gp', '.3gp2', '.3gpp', '.amv', '.asf', '.avi', '.av1', '.divx',
    '.f4v', '.flv', '.h264', '.h265', '.hevc', '.m1v', '.m2t', '.m2ts', '.m2v',
    '.m4v', '.mkv', '.mod', '.mov', '.mp2v', '.mp4', '.mp4v', '.mpe', '.mpeg',
    '.mpg', '.mpv', '.mts', '.mxf', '.ogm', '.ogv', '.qt', '.rm', '.rmvb',
    '.ts', '.vob', '.webm', '.wmv', '.wtv', '.y4m'
)
$Hive = [Microsoft.Win32.Registry]::CurrentUser
$Shell = New-Object -ComObject WScript.Shell

foreach ($Link in @($ShortcutPath, $SendToPath)) {
    if (Test-Path -LiteralPath $Link) {
        if ($Shell.CreateShortcut($Link).TargetPath -ne $Exe) {
            throw "Another application owns $Link."
        }
    }
}

function Set-RegistrationValue {
    param([string]$Path, [string]$Name, [object]$Value,
        [Microsoft.Win32.RegistryValueKind]$Kind = [Microsoft.Win32.RegistryValueKind]::String)
    $Key = $Hive.CreateSubKey($Path)
    try { $Key.SetValue($Name, $Value, $Kind) } finally { $Key.Dispose() }
}

# Do not take over another installation that happens to use the same application name.
foreach ($Registration in @(
    @{ Path = "$AppKey\shell\open\command"; Name = ''; Expected = $Command },
    @{ Path = "Software\Classes\$ProgId\shell\open\command"; Name = ''; Expected = $Command },
    @{ Path = "$VideoVerb\command"; Name = ''; Expected = $Command },
    @{ Path = 'Software\RegisteredApplications'; Name = 'Kaleido'; Expected = $Capabilities },
    @{ Path = $AppPath; Name = ''; Expected = $Exe }
)) {
    $Existing = $Hive.OpenSubKey($Registration.Path)
    if ($Existing) {
        try { $ExistingValue = $Existing.GetValue($Registration.Name) } finally { $Existing.Dispose() }
        if ($null -ne $ExistingValue -and $ExistingValue -ne $Registration.Expected) {
            throw "Another Kaleido registration exists at $($Registration.Path)."
        }
    }
}

if ($Unregister) {
    if (-not $PSCmdlet.ShouldProcess('HKCU Kaleido M0 entries', 'Unregister Open With')) { return }
    foreach ($Extension in $Extensions) {
        foreach ($CandidatePath in @(
            "Software\Classes\$Extension\OpenWithProgids",
            "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$Extension\OpenWithProgids"
        )) {
            $Key = $Hive.OpenSubKey($CandidatePath, $true)
            if ($Key) {
                try { $Key.DeleteValue($ProgId, $false) } finally { $Key.Dispose() }
            }
        }
        $Hive.DeleteSubKeyTree("Software\Classes\SystemFileAssociations\$Extension\shell\Kaleido.M0.Play", $false)
    }
    foreach ($Path in @($AppKey, "Software\Classes\$ProgId", 'Software\Kaleido\M0', $AppPath, $VideoVerb)) {
        $Hive.DeleteSubKeyTree($Path, $false)
    }
    $Key = $Hive.OpenSubKey('Software\RegisteredApplications', $true)
    if ($Key) {
        try { $Key.DeleteValue('Kaleido', $false) } finally { $Key.Dispose() }
    }
    if (Test-Path -LiteralPath $ShortcutPath) { Remove-Item -LiteralPath $ShortcutPath }
    if (Test-Path -LiteralPath $SendToPath) { Remove-Item -LiteralPath $SendToPath }
} else {
    $Files = @(
        @{ Source = 'target\release\kaleido-proto.exe'; Destination = 'Kaleido.exe' },
        @{ Source = 'target\release\kaleido-mpv.exe'; Destination = 'kaleido-mpv.exe' },
        @{ Source = 'vendor\libmpv\libmpv-2.dll'; Destination = 'libmpv-2.dll' },
        @{ Source = 'vendor\thumbfast\thumbfast.lua'; Destination = 'resources\thumbfast.lua' },
        @{ Source = 'prototype\src-tauri\test-scripts\click-target.lua'; Destination = 'resources\click-target.lua' },
        @{ Source = 'LICENSE'; Destination = 'LICENSE' }
    )
    foreach ($File in $Files) {
        if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $File.Source) -PathType Leaf)) {
            throw "Missing $($File.Source). Build the release app and kaleido-mpv first."
        }
    }
    if (-not $PSCmdlet.ShouldProcess($InstallDir, "Install Kaleido M0 and register Open With for $($Extensions.Count) video extensions")) { return }
    New-Item -ItemType Directory -Path (Join-Path $InstallDir 'resources') -Force | Out-Null
    foreach ($File in $Files) {
        Copy-Item -LiteralPath (Join-Path $RepoRoot $File.Source) -Destination (Join-Path $InstallDir $File.Destination) -Force
    }

    Set-RegistrationValue $AppKey 'FriendlyAppName' 'Kaleido'
    Set-RegistrationValue $AppKey 'ApplicationCompany' 'sth3no'
    Set-RegistrationValue "$AppKey\DefaultIcon" '' $Icon
    Set-RegistrationValue "$AppKey\shell" '' 'open'
    Set-RegistrationValue "$AppKey\shell\open\command" '' $Command
    Set-RegistrationValue "Software\Classes\$ProgId" '' 'Kaleido video'
    Set-RegistrationValue "Software\Classes\$ProgId\DefaultIcon" '' $Icon
    Set-RegistrationValue "Software\Classes\$ProgId\Application" 'ApplicationName' 'Kaleido'
    Set-RegistrationValue "Software\Classes\$ProgId\Application" 'ApplicationCompany' 'sth3no'
    Set-RegistrationValue "Software\Classes\$ProgId\Application" 'ApplicationIcon' $Icon
    # No explicit AppUserModelID is registered for this standalone build.
    $ApplicationKey = $Hive.OpenSubKey("Software\Classes\$ProgId\Application", $true)
    try { $ApplicationKey.DeleteValue('AppUserModelId', $false) } finally { $ApplicationKey.Dispose() }
    Set-RegistrationValue "Software\Classes\$ProgId\shell" '' 'open'
    Set-RegistrationValue "Software\Classes\$ProgId\shell\open" '' 'Přehrát v Kaleidu'
    Set-RegistrationValue "Software\Classes\$ProgId\shell\open\command" '' $Command
    Set-RegistrationValue $Capabilities 'ApplicationName' 'Kaleido'
    Set-RegistrationValue $Capabilities 'ApplicationDescription' 'Kaleido M0 - video player powered by upstream libmpv'
    Set-RegistrationValue $Capabilities 'ApplicationIcon' $Icon
    Set-RegistrationValue 'Software\RegisteredApplications' 'Kaleido' $Capabilities
    Set-RegistrationValue $AppPath '' $Exe
    Set-RegistrationValue $AppPath 'Path' $InstallDir
    foreach ($Extension in $Extensions) {
        Set-RegistrationValue "$AppKey\SupportedTypes" $Extension ''
        Set-RegistrationValue "$Capabilities\FileAssociations" $Extension $ProgId
        Set-RegistrationValue "Software\Classes\$Extension\OpenWithProgids" $ProgId ([byte[]]@()) ([Microsoft.Win32.RegistryValueKind]::None)
        # The current-user picker also tracks its own candidates, independently of UserChoice.
        Set-RegistrationValue "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$Extension\OpenWithProgids" $ProgId ([byte[]]@()) ([Microsoft.Win32.RegistryValueKind]::None)
        # Migrate the earlier per-extension verbs to one filtered static verb.
        $Hive.DeleteSubKeyTree("Software\Classes\SystemFileAssociations\$Extension\shell\Kaleido.M0.Play", $false)
    }
    $AppliesTo = ($Extensions | ForEach-Object { 'System.FileExtension:="' + $_ + '"' }) -join ' OR '
    Set-RegistrationValue $VideoVerb '' 'Přehrát v Kaleidu'
    Set-RegistrationValue $VideoVerb 'MUIVerb' 'Přehrát v Kaleidu'
    Set-RegistrationValue $VideoVerb 'Icon' $Icon
    Set-RegistrationValue $VideoVerb 'MultiSelectModel' 'Single'
    Set-RegistrationValue $VideoVerb 'Position' 'Top'
    Set-RegistrationValue $VideoVerb 'AppliesTo' $AppliesTo
    Set-RegistrationValue "$VideoVerb\command" '' $Command
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
    $LinkEvent = $(if ($Unregister) { 4 } else { 2 }) # SHCNE_DELETE / SHCNE_CREATE
    [KaleidoM0.ShellNotify]::NotifyPath($LinkEvent, 0x1005, $Link, [IntPtr]::Zero)
}
[KaleidoM0.ShellNotify]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
if ($Unregister) {
    Write-Output 'Kaleido M0 unregistered. Local application files were kept.'
} else {
    Write-Output "Installed: $Exe"
    Write-Output "Registered $($Extensions.Count) video extensions and Send to > Kaleido. Existing defaults were preserved."
}
