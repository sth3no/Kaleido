#Requires -Version 5.1
<#
  Stáhne připnutý upstream build libmpv (shinchiro/mpv-winbuild-cmake), ověří SHA-256
  a rozbalí libmpv-2.dll + include/ do vendor/libmpv. Nikdy nepatchuje (spec 3).
#>
param(
    [string]$Destination = (Join-Path $PSScriptRoot '..\vendor\libmpv'),
    [string]$ExpectedSha256 = 'cf63b4ce66e03e5e70acf2648cbc3177656c77c5b9583e16d83efc58801182b7'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Release = '20261011'
$Asset = 'mpv-dev-x86_64-20261011-git-accb7b2821.7z'
$Url = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$Release/$Asset"

$Destination = [System.IO.Path]::GetFullPath($Destination)
$Dll = Join-Path $Destination 'libmpv-2.dll'
$Stamp = Join-Path $Destination 'VERSION'
if ((Test-Path $Dll) -and (Test-Path $Stamp) -and ((Get-Content $Stamp -Raw).Trim() -eq $Asset)) {
    Write-Host "libmpv $Asset už je v $Destination"
    exit 0
}

$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("kaleido-libmpv-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
    $Archive = Join-Path $Temp $Asset
    Write-Host "Stahuji $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
    $Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
    if ($Actual -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "SHA-256 nesouhlasí: očekáváno $ExpectedSha256, staženo $Actual"
    }

    $Extract = Join-Path $Temp 'x'
    New-Item -ItemType Directory -Path $Extract | Out-Null
    $SevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
    if (Test-Path $SevenZip) {
        & $SevenZip x $Archive "-o$Extract" -y | Out-Null
    } else {
        & "$env:SystemRoot\System32\tar.exe" -xf $Archive -C $Extract
    }
    if ($LASTEXITCODE -ne 0) { throw "Rozbalení selhalo (kód $LASTEXITCODE)" }

    $FoundDll = Get-ChildItem -Path $Extract -Recurse -Filter 'libmpv-2.dll' | Select-Object -First 1
    if (-not $FoundDll) { throw 'V archivu chybí libmpv-2.dll' }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item $FoundDll.FullName $Destination -Force
    $Include = Get-ChildItem -Path $Extract -Recurse -Directory -Filter 'include' | Select-Object -First 1
    if ($Include) { Copy-Item $Include.FullName $Destination -Recurse -Force }
    Set-Content -Path $Stamp -Value $Asset -Encoding ascii
    Write-Host "libmpv $Asset připravena v $Destination"
} finally {
    Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
