#Requires -Version 5.1
<#
Microsoft Edge WebDriver for the E2E run, in exactly the version of this machine's WebView2 runtime
(msedgedriver drives WebView2 only when the two match). Downloaded from Microsoft's own server into
e2e/driver/, which git ignores; a driver already there in the right version is kept.

    powershell -NoProfile -ExecutionPolicy Bypass -File e2e/fetch-driver.ps1
#>
param(
    # Another WebView2 version than the installed one (the driver of another machine).
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Driver = Join-Path $PSScriptRoot 'driver'
$Exe = Join-Path $Driver 'msedgedriver.exe'

if (-not $Version) {
    # The WebView2 runtime's client key (Evergreen), per machine or per user.
    $Client = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($Key in @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$Client",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$Client",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$Client"
    )) {
        $Found = (Get-ItemProperty -Path $Key -Name pv -ErrorAction SilentlyContinue).pv
        if ($Found -and $Found -ne '0.0.0.0') { $Version = $Found; break }
    }
    if (-not $Version) {
        # Without the client key (some images), the runtime's own folder is named by its version.
        $Folder = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'
        $Version = Get-ChildItem -LiteralPath $Folder -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
            Sort-Object { [version]$_.Name } -Descending |
            Select-Object -First 1 -ExpandProperty Name
    }
    if (-not $Version) { throw 'No WebView2 runtime found (no EdgeUpdate client key, no EdgeWebView folder).' }
}
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "Not a WebView2 version: $Version" }

if (Test-Path -LiteralPath $Exe) {
    $Have = (& $Exe --version) -join ' '
    if ($Have -match [regex]::Escape(" $Version ")) {
        Write-Output "msedgedriver $Version is already in $Driver."
        return
    }
    Write-Output "Replacing $Have."
}

# Downloaded into a folder of its own and checked before anything is put in e2e/driver.
$Download = Join-Path ([IO.Path]::GetTempPath()) ("kaleido-edgedriver-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Download | Out-Null
try {
    $Zip = Join-Path $Download 'edgedriver_win64.zip'
    $Url = "https://msedgedriver.microsoft.com/$Version/edgedriver_win64.zip"
    Write-Output "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
    $Unpacked = Join-Path $Download 'unpacked'
    Expand-Archive -LiteralPath $Zip -DestinationPath $Unpacked
    $New = Join-Path $Unpacked 'msedgedriver.exe'
    $Signature = Get-AuthenticodeSignature -LiteralPath $New
    if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Corporation,') {
        throw "msedgedriver.exe from $Url is not signed by Microsoft ($($Signature.Status))."
    }
    New-Item -ItemType Directory -Force -Path $Driver | Out-Null
    Copy-Item -Path (Join-Path $Unpacked '*') -Destination $Driver -Recurse -Force
} finally {
    Remove-Item -LiteralPath $Download -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output "$((& $Exe --version) -join ' ') is in $Driver."
