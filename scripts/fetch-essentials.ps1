#Requires -Version 5.1
<#
  Downloads the essentials (the mpv scripts Kaleido bundles, spec 6.4) pinned in
  resources/essentials/essentials.json: every file from raw.githubusercontent.com at the pinned
  commit, checked against its SHA-256, into <Destination>/<name>/<src>. The manifest is the one
  source of truth for this script, the bundle (tauri.conf.json), Rust and the license list.

  A file whose SHA-256 differs from the manifest is never written: the script throws.
#>
param([string]$Destination = (Join-Path $PSScriptRoot '..\vendor\essentials'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Manifest = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\resources\essentials\essentials.json'))
# Without a trailing separator, so that "vendor\essentials\" works with the containment check below.
$Destination = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
$Essentials = ConvertFrom-Json -InputObject (Get-Content -Raw -Encoding UTF8 -LiteralPath $Manifest)
if (-not $Essentials) { throw "No essentials in $Manifest" }

function Get-Sha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

foreach ($Essential in $Essentials) {
    if ($Essential.name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Bad essential name '$($Essential.name)'" }
    foreach ($File in $Essential.files) {
        # The manifest is ours, but a path that leaves the destination is refused all the same.
        if ($File.src -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $File.src -match '\.\.') {
            throw "Bad file name '$($File.src)' in $($Essential.name)"
        }
        $Expected = ([string]$File.sha256).ToLowerInvariant()
        $Target = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $Destination $Essential.name) $File.src))
        if (-not $Target.StartsWith($Destination + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "$Target is outside $Destination"
        }
        if ((Test-Path -LiteralPath $Target -PathType Leaf) -and ((Get-Sha256 $Target) -eq $Expected)) {
            Write-Host "$($Essential.name)/$($File.src) is already in place"
            continue
        }

        $Url = "https://raw.githubusercontent.com/$($Essential.repo)/$($Essential.commit)/$($File.src)"
        $Temp = [System.IO.Path]::GetTempFileName()
        try {
            Write-Host "Downloading $Url"
            Invoke-WebRequest -Uri $Url -OutFile $Temp -UseBasicParsing
            $Actual = Get-Sha256 $Temp
            if ($Actual -ne $Expected) {
                throw "SHA-256 mismatch for $($Essential.name)/$($File.src): expected $Expected, got $Actual"
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
            Copy-Item -LiteralPath $Temp -Destination $Target -Force
            Write-Host "$($Essential.name) $($Essential.version) ready in $Target"
        } finally {
            Remove-Item -LiteralPath $Temp -Force -ErrorAction SilentlyContinue
        }
    }
}
