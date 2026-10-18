#Requires -Version 5.1
<#
The clip the smoke E2E opens: 10 s of mpv's 1280x720 test pattern (lavfi testsrc2), H.264 in
Matroska, encoded by kaleido-mpv (the bundled libmpv's encoder, so no ffmpeg is needed). Written to
e2e/media/kaleido-e2e.mkv, which git ignores.

Build the helper first: cargo build -p kaleido-mpv
An existing clip is kept; -Force writes it again.

    powershell -NoProfile -ExecutionPolicy Bypass -File e2e/make-media.ps1
#>
param(
    # kaleido-mpv.exe; the debug build finds vendor\libmpv\libmpv-2.dll by itself.
    [string]$Helper = (Join-Path $PSScriptRoot '..\target\debug\kaleido-mpv.exe'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Media = Join-Path $PSScriptRoot 'media'
$Clip = Join-Path $Media 'kaleido-e2e.mkv'
# Written next to the clip and renamed at the end, so a broken encode never passes for the clip.
$Partial = Join-Path $Media 'kaleido-e2e.partial.mkv'
$Log = Join-Path $Media 'make-media.log'

if ((Test-Path -LiteralPath $Clip) -and -not $Force) {
    Write-Output "The clip is already there: $Clip (-Force writes it again)."
    return
}
if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) {
    throw "Missing $Helper. Build it first: cargo build -p kaleido-mpv"
}
New-Item -ItemType Directory -Force -Path $Media | Out-Null
foreach ($Old in $Partial, $Log) { if (Test-Path -LiteralPath $Old) { Remove-Item -LiteralPath $Old } }

# Windows PowerShell joins the arguments with spaces and does not quote them: the paths are quoted
# here, so that a checkout under a folder with spaces still works.
$Arguments = @(
    '--no-config',
    '--end=10',
    '--ovc=libx264',
    '--ovcopts=preset=veryfast,crf=28',
    '--of=matroska',
    ('"--o=' + $Partial + '"'),
    ('"--log-file=' + $Log + '"'),
    '--',
    'av://lavfi:testsrc2=size=1280x720:rate=30'
)
$Process = Start-Process -FilePath $Helper -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
# kaleido-mpv also ends with 0 when mpv could not open or encode the source: the file decides.
if ($Process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $Partial) -or (Get-Item -LiteralPath $Partial).Length -lt 10KB) {
    throw "kaleido-mpv did not write the clip (exit code $($Process.ExitCode)); see $Log"
}
Move-Item -LiteralPath $Partial -Destination $Clip -Force
Remove-Item -LiteralPath $Log
Write-Output "Wrote $Clip ($([math]::Round((Get-Item -LiteralPath $Clip).Length / 1KB)) KB)."
