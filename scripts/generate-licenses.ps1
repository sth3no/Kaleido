#Requires -Version 5.1
<#
  Regenerates resources/licenses/third-party.json: the licenses of the Rust crates that go into
  Kaleido.exe (cargo-about) and of the npm packages that go into the UI (license-checker).
  The "About" page lists them (spec 11.6); extra.json holds what is added by hand.

  The file is committed and CI runs this script, then `git diff --exit-code resources/licenses`,
  so a changed dependency shows up as a changed list. The same dependencies give the same bytes:
  sorted in code-unit order, one entry per line, no dates, no machine paths, LF line ends.

  Needs: exactly cargo-about 0.9.2 (`cargo install --locked --features cli cargo-about@0.9.2`;
  the script checks), Node with npm and the UI's packages installed (`npm ci`). Run from anywhere.
#>
param(
    [string]$Output = (Join-Path $PSScriptRoot '..\resources\licenses\third-party.json')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Pinned, so that every machine reads the packages the same way.
$LicenseChecker = 'license-checker-rseidelsohn@5.0.1'

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Output = [System.IO.Path]::GetFullPath($Output)

# The version decides how a license is worded, so the committed list and CI's check need the
# same one everywhere.
$AboutVersion = '0.9.2'
$AboutHelp = "cargo install --locked --features cli cargo-about@$AboutVersion"
if (-not (Get-Command cargo-about -ErrorAction SilentlyContinue)) {
    throw "cargo-about is missing: $AboutHelp"
}
$AboutFound = (& cargo about --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $AboutFound -ne "cargo-about $AboutVersion") {
    throw "cargo-about $AboutVersion is needed, but this is '$AboutFound': $AboutHelp"
}

# One JSON string. The values here are names, versions, SPDX expressions and URLs.
function ConvertTo-JsonString([string]$Value) {
    if ($Value -match '[\x00-\x1f]') { throw "Control character in '$Value'" }
    '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

# The address of a repository as a web page: no git+ prefix, no .git suffix.
function ConvertTo-WebUrl([string]$Value) {
    $Value = $Value.Trim()
    $Value = $Value -replace '^git\+', ''
    $Value = $Value -replace '^(git|ssh)://(git@)?', 'https://'
    $Value = $Value -replace '^git@github\.com:', 'https://github.com/'
    $Value = $Value -replace '\.git$', ''
    $Value
}

$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ('kaleido-licenses-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp | Out-Null
Push-Location $Root
try {
    $entries = New-Object 'System.Collections.Generic.List[object]'

    # Rust: the crates of Kaleido.exe for 64-bit Windows, as the template lists them.
    $CratesFile = Join-Path $Temp 'crates.json'
    & cargo about generate --manifest-path src-tauri/Cargo.toml --config scripts/cargo-about.toml `
        --locked --fail --output-file $CratesFile scripts/cargo-about.hbs
    if ($LASTEXITCODE -ne 0) { throw "cargo about failed (exit code $LASTEXITCODE)" }
    $crates = Get-Content -Raw -Encoding UTF8 $CratesFile | ConvertFrom-Json
    $rustCount = 0
    foreach ($crate in $crates) {
        # A crate from this repository (path dependency) is Kaleido, not third party.
        if (-not $crate.source) { continue }
        $url = $crate.repository
        if (-not $url) { $url = $crate.homepage }
        if (-not $url) { $url = 'https://crates.io/crates/' + $crate.name }
        $entries.Add([pscustomobject]@{
            name = [string]$crate.name
            version = [string]$crate.version
            license = ([string]$crate.license -replace '\s+', ' ').Trim()
            url = ConvertTo-WebUrl ([string]$url)
        })
        $rustCount++
    }

    # npm: what the UI needs to run, not what builds and tests it.
    $NpmFile = Join-Path $Temp 'npm.json'
    & npx.cmd --yes $LicenseChecker --production --excludePrivatePackages --json --out $NpmFile
    if ($LASTEXITCODE -ne 0) { throw "license-checker failed (exit code $LASTEXITCODE)" }
    $npm = Get-Content -Raw -Encoding UTF8 $NpmFile | ConvertFrom-Json
    $npmCount = 0
    foreach ($package in $npm.PSObject.Properties) {
        # "name@version"; a scoped name starts with an @ of its own.
        $at = $package.Name.LastIndexOf('@')
        if ($at -lt 1) { throw "Unexpected package key '$($package.Name)'" }
        $name = $package.Name.Substring(0, $at)
        $version = $package.Name.Substring($at + 1)
        # "MIT*" says the license was guessed from the text of its file.
        $license = ((@($package.Value.licenses) -join ' AND ') -replace '\*', '').Trim()
        if (-not $license -or $license -match 'UNKNOWN|UNLICENSED') {
            throw "No license found for $($package.Name); add it to resources/licenses/extra.json or replace the package"
        }
        $url = ''
        if ($package.Value.repository) { $url = ConvertTo-WebUrl ([string]$package.Value.repository) }
        if (-not $url) { $url = 'https://www.npmjs.com/package/' + $name }
        $entries.Add([pscustomobject]@{
            name = $name
            version = $version
            license = $license
            url = $url
        })
        $npmCount++
    }

    # Sorted by name, then version, comparing UTF-16 code units: the same on every machine and
    # in every language (a Czech sort would put "ch" after "h").
    $byKey = @{}
    foreach ($entry in $entries) { $byKey[$entry.name + "`t" + $entry.version] = $entry }
    $keys = [string[]]@($byKey.Keys)
    [System.Array]::Sort($keys, [System.StringComparer]::Ordinal)

    $lines = foreach ($key in $keys) {
        $entry = $byKey[$key]
        '  {{"name":{0},"version":{1},"license":{2},"url":{3}}}' -f (ConvertTo-JsonString $entry.name),
            (ConvertTo-JsonString $entry.version), (ConvertTo-JsonString $entry.license),
            (ConvertTo-JsonString $entry.url)
    }
    $text = "[`n" + ($lines -join ",`n") + "`n]`n"

    New-Item -ItemType Directory -Force -Path (Split-Path $Output) | Out-Null
    [System.IO.File]::WriteAllText($Output, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "$rustCount Rust crates and $npmCount npm packages written to $Output"
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
