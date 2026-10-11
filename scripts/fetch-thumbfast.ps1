#Requires -Version 5.1
<# Stáhne thumbfast připnutý na commit a ověří SHA-256 (essentials, spec 6.4). #>
param([string]$Destination = (Join-Path $PSScriptRoot '..\vendor\thumbfast'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Commit = '0f711de3138c9bd6718209d819ac54022c23ded2'
$Expected = 'a3d08e71eae8b892f6cd39f9593ea219768e709312d176bca883841b156448bf'
$Url = "https://raw.githubusercontent.com/po5/thumbfast/$Commit/thumbfast.lua"

$Destination = [System.IO.Path]::GetFullPath($Destination)
$Target = Join-Path $Destination 'thumbfast.lua'
$Temp = [System.IO.Path]::GetTempFileName()
try {
    Invoke-WebRequest -Uri $Url -OutFile $Temp -UseBasicParsing
    $Actual = (Get-FileHash -Algorithm SHA256 $Temp).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { throw "SHA-256 nesouhlasí: očekáváno $Expected, staženo $Actual" }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item $Temp $Target -Force
    Write-Host "thumbfast $Commit připraven v $Target"
} finally {
    Remove-Item $Temp -Force -ErrorAction SilentlyContinue
}
