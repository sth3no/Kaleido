# Kaleido M0 – ověřovací prototyp: implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ověřit osm nejrizikovějších předpokladů Kaleida 1.0 (spec 5.4) na funkčním prototypu a rozhodnout o záložních řešeních před M1.

**Architecture:** Dvě trvalé knihovny v Cargo workspace (`crates/mpv-ffi` – tenká FFI vrstva nad libmpv načítanou za běhu, `crates/kaleido-mpv` – bezhlavé CLI pro thumbfast) plus zahoditelný prototyp `prototype/` (Tauri 2 + React). Prototyp vytvoří nativní podokno pod průhledným WebView2, předá ho mpv jako `wid` a ověří průhlednost, HDR, vstup, fullscreen, shader sklo, mini přehrávač, náhledy a snímky obrazovky. Výsledky se zapisují do `docs/m0/report.md`.

**Tech Stack:** Rust 1.98 (edition 2024), libmpv 2.x (shinchiro build 20261011), libloading 0.8, windows 0.62, Tauri 2.12, tauri-plugin-dialog 2.8, React 19.3, TypeScript 7, Vite 8, Vitest 5, PowerShell 5.1 skripty.

**Spec:** `docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md` (hlavně 3, 4.1, 4.2, 4.4, 5, 8.2, 8.3, 8.6, 13, 14)

## Global Constraints

- libmpv **jen z upstreamu, nikdy fork ani patch**: `mpv-dev-x86_64-20261011-git-accb7b2821.7z` od shinchira, SHA-256 `cf63b4ce66e03e5e70acf2648cbc3177656c77c5b9583e16d83efc58801182b7`, varianta x86_64 (ne `v3`).
- **Tauri 2.x** (`tauri = "2.12"`), ne 3.0 alpha.
- Výchozí volby mpv: `vo=gpu-next`, `gpu-api=d3d11`, `target-colorspace-hint=yes`, `hwdec=auto-safe`, `osc=no`.
- **UI nikdy nemluví s mpv přímo**, jen přes typované Tauri příkazy a události. Spouštění procesů a práce se soubory jen v Rustu.
- Rozmazání nad videem dělá shader v mpv; na předky prvků s `backdrop-filter` se nikdy nedává `transform: scale` (použít `zoom` nebo nic).
- Rust: edition 2024, `rust-version = "1.90"`, `license = "GPL-3.0-or-later"` v každém manifestu. Kód projde `cargo fmt --check` a `cargo clippy -- -D warnings`.
- Texty v UI prototypu česky (i18n přijde v M1).
- Cíle: shader skla ≤ 1 ms GPU na snímek ve 4K; okno ≤ 500 ms; v pauze CPU < 1 %.
- Platforma: Windows 10 22H2 / Windows 11, x64.
- Kód v `prototype/` se do M1 **nepřebírá automaticky**; `crates/` jsou určené k zachování.
- Commity: krátká zpráva ve stylu conventional commits, zakončená řádkem `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Cesty s diakritikou a mezerami** (`C:\Users\…\Videa čeština (2026)\žluťoučký kůň.mkv`) se musí otevřít stejně jako ASCII cesty → test `opens_path_with_czech_characters_and_spaces` (Task 3).
2. **Minimalizované okno / nulová klientská plocha** nesmí poslat podoknu nulovou nebo zápornou velikost; podokno se skryje → test `minimized_window_hides_surface` (Task 7).
3. **Česká klávesnice, AltGr a modifikátor puštěný dřív než klávesa** – mpv dostane znak, který klávesa skutečně píše, a `keyup` vždy se stejným jménem jako `keydown`, jinak se klávesa „zasekne“ v opakování → testy v `keys.test.ts` a `tracker.test.ts` (Task 9).
4. **Podvržená nebo poškozená zpráva `thumbfast-render`** (cesta mimo `%TEMP%`, cizí soubor, nesmyslná velikost, useknutá data) se odmítne bez pádu → testy v `thumbs.rs` (Task 12).
5. **Zavření okna během přehrávání nebo `quit` z klávesy** ukončí aplikaci čistě, bez zaseknutí a bez osiřelých procesů → test `quit_yields_shutdown_and_drop_does_not_hang` (Task 3) a ruční krok v Task 7 a Task 12.

---

## Struktura souborů

```
app/
  .gitignore, LICENSE, Cargo.toml (workspace)
  scripts/fetch-libmpv.ps1          připnutá libmpv → vendor/libmpv/
  scripts/fetch-thumbfast.ps1       připnutý thumbfast → vendor/thumbfast/
  .github/workflows/ci.yml
  crates/mpv-ffi/
    src/lib.rs        veřejné API, hledání DLL
    src/sys.rs        typy a tabulka funkcí z client.h
    src/error.rs      Error, Result
    src/handle.rs     Mpv: volby, příkazy, vlastnosti, události
    src/event.rs      Event, PropertyValue, převod z mpv_event
    src/testing.rs    generátor testovacího videa (Y4M)
    tests/common/mod.rs, tests/handle.rs, tests/events.rs
  crates/kaleido-mpv/
    src/args.rs       parsování příkazové řádky ve stylu mpv
    src/main.rs       bezhlavé mpv nad libmpv
    tests/cli.rs
  prototype/
    package.json, tsconfig.json, vite.config.ts, index.html, app-icon.svg
    src/main.tsx, src/App.tsx, src/app.css
    src/player.ts             typované příkazy a události
    src/playerState.ts        čistý reducer stavu přehrávače (+ test)
    src/usePlayer.ts          React hook nad událostmi
    src/fullscreen.ts         černá clona (+ test)
    src/input/keys.ts, mouse.ts, tracker.ts (+ testy), forward.ts
    src/glass/regions.ts (+ test), useGlassRegions.ts
    src/surface/mini.ts (+ test)
    src/useIdle.ts
    src/components/TitleBar.tsx, StartScreen.tsx, Controls.tsx, Seekbar.tsx, MiniPlayer.tsx
    src-tauri/
      Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, icons/
      src/main.rs       sestavení aplikace, události okna
      src/commands.rs   všechny Tauri příkazy
      src/options.rs    cesty a volby mpv
      src/engine.rs     instance mpv a vlákno událostí
      src/surface.rs    podokno pro video + výpočet obdélníku (+ testy)
      src/input.rs      převod vstupu na příkazy mpv (+ testy)
      src/glass.rs      generátor shaderu a glsl-shader-opts (+ testy)
      src/thumbs.rs     ověření a načtení náhledu z thumbfastu (+ testy)
      test-scripts/click-target.lua
  docs/m0/report.md
```

---

### Task 1: Základ repa a připnuté závislosti mimo Cargo

**Files:**
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `Cargo.toml`
- Create: `scripts/fetch-libmpv.ps1`
- Create: `scripts/fetch-thumbfast.ps1`

**Interfaces:**
- Consumes: nic
- Produces: `vendor/libmpv/libmpv-2.dll`, `vendor/libmpv/include/`, `vendor/libmpv/VERSION`, `vendor/thumbfast/thumbfast.lua`; Cargo workspace s `[workspace.package]` (edition, license, rust-version, repository), na které se odkazují všechny crates.

- [ ] **Step 1: Vytvořit `.gitignore`**

```gitignore
/target/
/vendor/
node_modules/
/prototype/dist/
/prototype/src-tauri/gen/
*.log
```

- [ ] **Step 2: Stáhnout text licence GPL-3.0**

Run: `curl -sSfL https://www.gnu.org/licenses/gpl-3.0.txt -o LICENSE && head -3 LICENSE`
Expected: druhý řádek obsahuje `GNU GENERAL PUBLIC LICENSE` a třetí `Version 3, 29 June 2007`.

- [ ] **Step 3: Vytvořit `Cargo.toml` (workspace)**

```toml
[workspace]
resolver = "3"
members = ["crates/mpv-ffi"]

[workspace.package]
edition = "2024"
license = "GPL-3.0-or-later"
repository = "https://github.com/sth3no/Kaleido"
rust-version = "1.90"
```

- [ ] **Step 4: Vytvořit `scripts/fetch-libmpv.ps1`**

```powershell
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
```

- [ ] **Step 5: Ověřit, že skript odmítne špatný kontrolní součet**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-libmpv.ps1 -Destination "$TEMP/kaleido-badhash" -ExpectedSha256 0000000000000000000000000000000000000000000000000000000000000000; echo "exit=$?"`
Expected: výpis `SHA-256 nesouhlasí: …` a nenulový exit; složka `$TEMP/kaleido-badhash` neobsahuje `libmpv-2.dll`.

- [ ] **Step 6: Stáhnout skutečnou libmpv**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-libmpv.ps1 && ls vendor/libmpv && cat vendor/libmpv/VERSION`
Expected: `libmpv-2.dll`, `include`, `VERSION` s textem `mpv-dev-x86_64-20261011-git-accb7b2821.7z`. Druhé spuštění vypíše `už je v …` bez stahování.

- [ ] **Step 7: Vytvořit `scripts/fetch-thumbfast.ps1`**

```powershell
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
```

- [ ] **Step 8: Stáhnout thumbfast**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-thumbfast.ps1 && sha256sum vendor/thumbfast/thumbfast.lua`
Expected: `a3d08e71eae8b892f6cd39f9593ea219768e709312d176bca883841b156448bf`.

- [ ] **Step 9: Commit**

```bash
git add .gitignore LICENSE Cargo.toml scripts/
git commit -m "chore: add workspace, GPL-3.0 license and pinned libmpv/thumbfast fetch scripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `mpv-ffi` – načtení libmpv a ovládání instance

**Files:**
- Create: `crates/mpv-ffi/Cargo.toml`
- Create: `crates/mpv-ffi/src/lib.rs`
- Create: `crates/mpv-ffi/src/sys.rs`
- Create: `crates/mpv-ffi/src/error.rs`
- Create: `crates/mpv-ffi/src/handle.rs`
- Create: `crates/mpv-ffi/src/testing.rs`
- Test: `crates/mpv-ffi/tests/common/mod.rs`, `crates/mpv-ffi/tests/handle.rs`

**Interfaces:**
- Consumes: `vendor/libmpv/libmpv-2.dll` (Task 1)
- Produces:
  - `mpv_ffi::locate_libmpv() -> PathBuf` (pořadí: `$KALEIDO_LIBMPV`, vedle spuštěného exe, `vendor/libmpv` v repu)
  - `mpv_ffi::load_api(&Path) -> Result<Arc<sys::Api>>`
  - `sys::Api::client_api_version(&self) -> u64`, `sys::Api::error_string(&self, i32) -> String`
  - `Mpv::create(Arc<Api>) -> Result<Mpv>`, `set_option(&str, &str)`, `initialize()`, `command(&[&str])`, `set_property(&str, &str)`, `get_string(&str) -> Result<String>`, `get_f64`, `get_i64`, `get_flag -> Result<bool>`, `client_name() -> String`
  - `Error::{Load, ApiVersion{major,minor}, Create, Mpv{code,message,context}, Nul}`, `Result<T>`
  - `mpv_ffi::testing::write_y4m(&Path, width, height, frames) -> io::Result<()>`

- [ ] **Step 1: Vytvořit `crates/mpv-ffi/Cargo.toml`**

```toml
[package]
name = "mpv-ffi"
version = "0.1.0"
edition.workspace = true
license.workspace = true
repository.workspace = true
rust-version.workspace = true
publish = false

[dependencies]
libloading = "0.8"
thiserror = "2"

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Napsat padající testy `tests/common/mod.rs` a `tests/handle.rs`**

`crates/mpv-ffi/tests/common/mod.rs`:

```rust
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use mpv_ffi::{Mpv, load_api, locate_libmpv};

/// Initialized core without any window or audio output.
pub fn headless() -> Mpv {
    let mpv = Mpv::create(load_api(&locate_libmpv()).expect("load libmpv")).expect("create");
    for (name, value) in [
        ("vo", "null"),
        ("ao", "null"),
        ("audio", "no"),
        ("untimed", "yes"),
        ("terminal", "no"),
    ] {
        mpv.set_option(name, value).expect(name);
    }
    mpv.initialize().expect("initialize");
    mpv
}

/// 2 s of 64×36 uncompressed video inside `dir`.
pub fn clip(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    mpv_ffi::testing::write_y4m(&path, 64, 36, 60).expect("write clip");
    path
}
```

`crates/mpv-ffi/tests/handle.rs`:

```rust
mod common;

use std::path::Path;

use mpv_ffi::{Error, Mpv, load_api, locate_libmpv};

#[test]
fn missing_library_is_a_load_error() {
    match load_api(Path::new("C:/kaleido/missing/libmpv-2.dll")) {
        Err(Error::Load(_)) => {}
        Err(other) => panic!("unexpected error {other}"),
        Ok(_) => panic!("loaded a library that does not exist"),
    }
}

#[test]
fn pinned_libmpv_speaks_client_api_2() {
    let api = load_api(&locate_libmpv()).expect("load libmpv");
    assert_eq!(api.client_api_version() >> 16, 2);
}

#[test]
fn initializes_headless_and_reports_version() {
    let mpv = common::headless();
    assert!(mpv.get_string("mpv-version").unwrap().starts_with("mpv "));
}

#[test]
fn volume_roundtrip() {
    let mpv = common::headless();
    mpv.set_property("volume", "42").unwrap();
    assert_eq!(mpv.get_f64("volume").unwrap(), 42.0);
}

#[test]
fn flag_roundtrip() {
    let mpv = common::headless();
    mpv.set_property("pause", "yes").unwrap();
    assert!(mpv.get_flag("pause").unwrap());
}

#[test]
fn unknown_option_reports_mpv_error_code() {
    let mpv = Mpv::create(load_api(&locate_libmpv()).unwrap()).unwrap();
    match mpv.set_option("kaleido-no-such-option", "1") {
        Err(Error::Mpv { code, .. }) => assert_eq!(code, -5, "MPV_ERROR_OPTION_NOT_FOUND"),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn interior_nul_never_reaches_mpv() {
    let mpv = common::headless();
    assert!(matches!(mpv.command(&["show-text", "a\0b"]), Err(Error::Nul(_))));
}

#[test]
fn host_client_is_named_main() {
    assert_eq!(common::headless().client_name(), "main");
}
```

- [ ] **Step 3: Spustit testy a ověřit, že selžou**

Run: `cargo test -p mpv-ffi`
Expected: FAIL – překlad selže, protože `src/lib.rs` neexistuje.

- [ ] **Step 4: Napsat `src/error.rs`**

```rust
use std::ffi::NulError;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cannot load libmpv: {0}")]
    Load(#[from] libloading::Error),
    #[error("unsupported libmpv client API {major}.{minor}, need 2.x")]
    ApiVersion { major: u64, minor: u64 },
    #[error("mpv_create returned NULL")]
    Create,
    #[error("{context}: {message} ({code})")]
    Mpv {
        code: i32,
        message: String,
        context: String,
    },
    #[error("string contains an interior NUL byte")]
    Nul(#[from] NulError),
}

pub type Result<T> = std::result::Result<T, Error>;
```

- [ ] **Step 5: Napsat `src/sys.rs`**

```rust
//! Raw libmpv client API (`client.h`, API 2.x), resolved at runtime from the DLL.
#![allow(non_camel_case_types)]

use std::ffi::{CStr, c_char, c_double, c_int, c_ulong, c_void};
use std::path::Path;

use libloading::Library;

#[repr(C)]
pub struct mpv_handle {
    _private: [u8; 0],
}

pub type mpv_format = c_int;
pub const MPV_FORMAT_NONE: mpv_format = 0;
pub const MPV_FORMAT_STRING: mpv_format = 1;
pub const MPV_FORMAT_FLAG: mpv_format = 3;
pub const MPV_FORMAT_INT64: mpv_format = 4;
pub const MPV_FORMAT_DOUBLE: mpv_format = 5;

pub type mpv_event_id = c_int;
pub const MPV_EVENT_NONE: mpv_event_id = 0;
pub const MPV_EVENT_SHUTDOWN: mpv_event_id = 1;
pub const MPV_EVENT_LOG_MESSAGE: mpv_event_id = 2;
pub const MPV_EVENT_START_FILE: mpv_event_id = 6;
pub const MPV_EVENT_END_FILE: mpv_event_id = 7;
pub const MPV_EVENT_FILE_LOADED: mpv_event_id = 8;
pub const MPV_EVENT_CLIENT_MESSAGE: mpv_event_id = 16;
pub const MPV_EVENT_VIDEO_RECONFIG: mpv_event_id = 17;
pub const MPV_EVENT_SEEK: mpv_event_id = 20;
pub const MPV_EVENT_PLAYBACK_RESTART: mpv_event_id = 21;
pub const MPV_EVENT_PROPERTY_CHANGE: mpv_event_id = 22;

pub const MPV_END_FILE_REASON_EOF: c_int = 0;
pub const MPV_END_FILE_REASON_STOP: c_int = 2;
pub const MPV_END_FILE_REASON_QUIT: c_int = 3;
pub const MPV_END_FILE_REASON_ERROR: c_int = 4;
pub const MPV_END_FILE_REASON_REDIRECT: c_int = 5;

#[repr(C)]
pub struct mpv_event {
    pub event_id: mpv_event_id,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_property {
    pub name: *const c_char,
    pub format: mpv_format,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_log_message {
    pub prefix: *const c_char,
    pub level: *const c_char,
    pub text: *const c_char,
    pub log_level: c_int,
}

#[repr(C)]
pub struct mpv_event_end_file {
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
    pub playlist_insert_id: i64,
    pub playlist_insert_num_entries: c_int,
}

#[repr(C)]
pub struct mpv_event_client_message {
    pub num_args: c_int,
    pub args: *const *const c_char,
}

type FnVersion = unsafe extern "C" fn() -> c_ulong;
type FnCreate = unsafe extern "C" fn() -> *mut mpv_handle;
type FnInitialize = unsafe extern "C" fn(*mut mpv_handle) -> c_int;
type FnHandleOnly = unsafe extern "C" fn(*mut mpv_handle);
type FnSetString = unsafe extern "C" fn(*mut mpv_handle, *const c_char, *const c_char) -> c_int;
type FnCommand = unsafe extern "C" fn(*mut mpv_handle, *mut *const c_char) -> c_int;
type FnGetProperty =
    unsafe extern "C" fn(*mut mpv_handle, *const c_char, mpv_format, *mut c_void) -> c_int;
type FnFree = unsafe extern "C" fn(*mut c_void);
type FnObserve = unsafe extern "C" fn(*mut mpv_handle, u64, *const c_char, mpv_format) -> c_int;
type FnRequestLog = unsafe extern "C" fn(*mut mpv_handle, *const c_char) -> c_int;
type FnWaitEvent = unsafe extern "C" fn(*mut mpv_handle, c_double) -> *mut mpv_event;
type FnErrorString = unsafe extern "C" fn(c_int) -> *const c_char;
type FnClientName = unsafe extern "C" fn(*mut mpv_handle) -> *const c_char;

/// Function table of a loaded libmpv. Keeps the DLL loaded for as long as it lives.
pub struct Api {
    pub(crate) client_api_version: FnVersion,
    pub(crate) create: FnCreate,
    pub(crate) initialize: FnInitialize,
    pub(crate) terminate_destroy: FnHandleOnly,
    pub(crate) set_option_string: FnSetString,
    pub(crate) set_property_string: FnSetString,
    pub(crate) command: FnCommand,
    pub(crate) get_property: FnGetProperty,
    pub(crate) free: FnFree,
    pub(crate) observe_property: FnObserve,
    pub(crate) request_log_messages: FnRequestLog,
    pub(crate) wait_event: FnWaitEvent,
    pub(crate) wakeup: FnHandleOnly,
    pub(crate) error_string: FnErrorString,
    pub(crate) client_name: FnClientName,
    _lib: Library,
}

impl Api {
    /// # Safety
    /// `path` must be a libmpv 2.x DLL chosen by the application; loading runs its init code.
    pub unsafe fn load(path: &Path) -> Result<Api, libloading::Error> {
        unsafe {
            let lib = Library::new(path)?;
            let client_api_version = *lib.get::<FnVersion>(b"mpv_client_api_version\0")?;
            let create = *lib.get::<FnCreate>(b"mpv_create\0")?;
            let initialize = *lib.get::<FnInitialize>(b"mpv_initialize\0")?;
            let terminate_destroy = *lib.get::<FnHandleOnly>(b"mpv_terminate_destroy\0")?;
            let set_option_string = *lib.get::<FnSetString>(b"mpv_set_option_string\0")?;
            let set_property_string = *lib.get::<FnSetString>(b"mpv_set_property_string\0")?;
            let command = *lib.get::<FnCommand>(b"mpv_command\0")?;
            let get_property = *lib.get::<FnGetProperty>(b"mpv_get_property\0")?;
            let free = *lib.get::<FnFree>(b"mpv_free\0")?;
            let observe_property = *lib.get::<FnObserve>(b"mpv_observe_property\0")?;
            let request_log_messages = *lib.get::<FnRequestLog>(b"mpv_request_log_messages\0")?;
            let wait_event = *lib.get::<FnWaitEvent>(b"mpv_wait_event\0")?;
            let wakeup = *lib.get::<FnHandleOnly>(b"mpv_wakeup\0")?;
            let error_string = *lib.get::<FnErrorString>(b"mpv_error_string\0")?;
            let client_name = *lib.get::<FnClientName>(b"mpv_client_name\0")?;
            Ok(Api {
                client_api_version,
                create,
                initialize,
                terminate_destroy,
                set_option_string,
                set_property_string,
                command,
                get_property,
                free,
                observe_property,
                request_log_messages,
                wait_event,
                wakeup,
                error_string,
                client_name,
                _lib: lib,
            })
        }
    }

    /// `major << 16 | minor`.
    pub fn client_api_version(&self) -> u64 {
        // SAFETY: no arguments, no preconditions.
        unsafe { (self.client_api_version)() as u64 }
    }

    pub fn error_string(&self, code: i32) -> String {
        // SAFETY: mpv_error_string accepts any value and returns a static string.
        let ptr = unsafe { (self.error_string)(code) };
        if ptr.is_null() {
            return format!("mpv error {code}");
        }
        unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
    }
}
```

- [ ] **Step 6: Napsat `src/handle.rs`**

```rust
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::Arc;

use crate::error::{Error, Result};
use crate::sys::{self, Api};

const MPV_ERROR_PROPERTY_UNAVAILABLE: i32 = -10;

/// One libmpv core (`mpv_handle`). Dropping it destroys the core.
pub struct Mpv {
    pub(crate) api: Arc<Api>,
    pub(crate) ctx: *mut sys::mpv_handle,
}

// SAFETY: the libmpv client API is thread-safe. Its one restriction (mpv_wait_event
// must not run on two threads at once) is documented on `Mpv::wait_event`.
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

impl Mpv {
    pub fn create(api: Arc<Api>) -> Result<Mpv> {
        let version = api.client_api_version();
        let (major, minor) = (version >> 16, version & 0xffff);
        if major != 2 {
            return Err(Error::ApiVersion { major, minor });
        }
        // SAFETY: plain constructor, returns NULL on failure.
        let ctx = unsafe { (api.create)() };
        if ctx.is_null() {
            return Err(Error::Create);
        }
        Ok(Mpv { api, ctx })
    }

    /// Only meaningful before `initialize` for most options.
    pub fn set_option(&self, name: &str, value: &str) -> Result<()> {
        let (n, v) = (CString::new(name)?, CString::new(value)?);
        // SAFETY: ctx is live; both strings are NUL-terminated and outlive the call.
        let code = unsafe { (self.api.set_option_string)(self.ctx, n.as_ptr(), v.as_ptr()) };
        self.check(code, || format!("set option {name}={value}"))
    }

    pub fn initialize(&self) -> Result<()> {
        // SAFETY: ctx is live.
        let code = unsafe { (self.api.initialize)(self.ctx) };
        self.check(code, || "initialize".to_owned())
    }

    /// Runs an input command given as separate arguments (no quoting needed).
    pub fn command(&self, args: &[&str]) -> Result<()> {
        let owned = args
            .iter()
            .map(|a| CString::new(*a))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        // SAFETY: NULL-terminated array of valid C strings that outlive the call.
        let code = unsafe { (self.api.command)(self.ctx, ptrs.as_mut_ptr()) };
        self.check(code, || format!("command {args:?}"))
    }

    pub fn set_property(&self, name: &str, value: &str) -> Result<()> {
        let (n, v) = (CString::new(name)?, CString::new(value)?);
        // SAFETY: see set_option.
        let code = unsafe { (self.api.set_property_string)(self.ctx, n.as_ptr(), v.as_ptr()) };
        self.check(code, || format!("set property {name}={value}"))
    }

    pub fn get_string(&self, name: &str) -> Result<String> {
        let mut out: *mut c_char = std::ptr::null_mut();
        self.get_raw(name, sys::MPV_FORMAT_STRING, (&raw mut out).cast())?;
        if out.is_null() {
            return Err(Error::Mpv {
                code: MPV_ERROR_PROPERTY_UNAVAILABLE,
                message: "property unavailable".to_owned(),
                context: format!("get {name}"),
            });
        }
        // SAFETY: mpv returned an owned C string that we must release with mpv_free.
        let value = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
        unsafe { (self.api.free)(out.cast()) };
        Ok(value)
    }

    pub fn get_f64(&self, name: &str) -> Result<f64> {
        let mut value: f64 = 0.0;
        self.get_raw(name, sys::MPV_FORMAT_DOUBLE, (&raw mut value).cast())?;
        Ok(value)
    }

    pub fn get_i64(&self, name: &str) -> Result<i64> {
        let mut value: i64 = 0;
        self.get_raw(name, sys::MPV_FORMAT_INT64, (&raw mut value).cast())?;
        Ok(value)
    }

    pub fn get_flag(&self, name: &str) -> Result<bool> {
        let mut value: c_int = 0;
        self.get_raw(name, sys::MPV_FORMAT_FLAG, (&raw mut value).cast())?;
        Ok(value != 0)
    }

    /// Name other clients use to reach us with `script-message-to` ("main").
    pub fn client_name(&self) -> String {
        // SAFETY: returns a string owned by the handle, valid while ctx lives.
        let ptr = unsafe { (self.api.client_name)(self.ctx) };
        unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
    }

    fn get_raw(&self, name: &str, format: sys::mpv_format, out: *mut c_void) -> Result<()> {
        let n = CString::new(name)?;
        // SAFETY: `out` points to storage of the C type matching `format`.
        let code = unsafe { (self.api.get_property)(self.ctx, n.as_ptr(), format, out) };
        self.check(code, || format!("get {name}"))
    }

    pub(crate) fn check(&self, code: c_int, context: impl FnOnce() -> String) -> Result<()> {
        if code >= 0 {
            return Ok(());
        }
        Err(Error::Mpv {
            code,
            message: self.api.error_string(code),
            context: context(),
        })
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        // SAFETY: ctx came from mpv_create and is destroyed exactly once.
        unsafe { (self.api.terminate_destroy)(self.ctx) }
    }
}
```

- [ ] **Step 7: Napsat `src/testing.rs`**

```rust
//! Helpers for tests in this workspace: generated media that needs no codec.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

/// Writes an uncompressed YUV4MPEG2 clip: `frames` frames at 30 fps with a luma ramp.
pub fn write_y4m(path: &Path, width: usize, height: usize, frames: usize) -> std::io::Result<()> {
    assert!(
        width.is_multiple_of(2) && height.is_multiple_of(2),
        "4:2:0 needs even dimensions"
    );
    let mut out = BufWriter::new(File::create(path)?);
    writeln!(out, "YUV4MPEG2 W{width} H{height} F30:1 Ip A1:1 C420jpeg")?;
    let luma = width * height;
    for i in 0..frames {
        out.write_all(b"FRAME\n")?;
        out.write_all(&vec![(i * 4 % 256) as u8; luma])?;
        out.write_all(&vec![128u8; luma / 2])?;
    }
    out.flush()
}
```

- [ ] **Step 8: Napsat `src/lib.rs`**

```rust
//! Thin, safe wrapper over the upstream libmpv client API, loaded at runtime (spec 3, 4.2).

mod error;
mod handle;
pub mod sys;
#[doc(hidden)]
pub mod testing;

use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use error::{Error, Result};
pub use handle::Mpv;

/// Overrides where libmpv is loaded from.
pub const LIBMPV_ENV: &str = "KALEIDO_LIBMPV";
pub const LIBMPV_DLL: &str = "libmpv-2.dll";

/// `$KALEIDO_LIBMPV`, then next to the running executable, then the repo's `vendor/` (dev builds).
pub fn locate_libmpv() -> PathBuf {
    if let Some(path) = std::env::var_os(LIBMPV_ENV) {
        return PathBuf::from(path);
    }
    if let Some(candidate) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(LIBMPV_DLL)))
        .filter(|path| path.is_file())
    {
        return candidate;
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../vendor/libmpv")
        .join(LIBMPV_DLL)
}

pub fn load_api(path: &Path) -> Result<Arc<sys::Api>> {
    // SAFETY: the path comes from the application (locate_libmpv), never from user input.
    Ok(Arc::new(unsafe { sys::Api::load(path)? }))
}
```

- [ ] **Step 9: Spustit testy a ověřit, že projdou**

Run: `cargo test -p mpv-ffi`
Expected: PASS, 8 testů v `handle.rs`. Varování `field is never read` u `observe_property`, `request_log_messages`, `wait_event` a `wakeup` je v pořádku, použije je Task 3.

- [ ] **Step 10: Commit**

```bash
git add crates/mpv-ffi Cargo.lock
git commit -m "feat(mpv-ffi): load upstream libmpv at runtime and drive a core" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `mpv-ffi` – události, sledování vlastností a ukončení

**Files:**
- Create: `crates/mpv-ffi/src/event.rs`
- Modify: `crates/mpv-ffi/src/handle.rs` (přidat metody na konec `impl Mpv`)
- Modify: `crates/mpv-ffi/src/lib.rs` (modul a re-export)
- Modify: `crates/mpv-ffi/tests/common/mod.rs` (přidat `wait_for`)
- Test: `crates/mpv-ffi/tests/events.rs`

**Interfaces:**
- Consumes: `Mpv`, `sys::Api` (Task 2)
- Produces:
  - `PropertyKind::{Flag, Int64, Double, String}`
  - `PropertyValue::{Unavailable, Flag(bool), Int64(i64), Double(f64), String(String)}`
  - `EndFileReason::{Eof, Stop, Quit, Error{code,message}, Redirect, Other(i32)}`
  - `Event::{None, Shutdown, LogMessage{prefix,level,text}, StartFile, FileLoaded, EndFile{reason}, VideoReconfig, Seek, PlaybackRestart, PropertyChange{id,name,value}, ClientMessage{args}, Other(i32)}`
  - `Mpv::observe(&self, id: u64, name: &str, kind: PropertyKind) -> Result<()>`
  - `Mpv::request_log_messages(&self, min_level: &str) -> Result<()>`
  - `Mpv::wait_event(&self, timeout_secs: f64) -> Event` (záporná hodnota = čekat navždy; volat jen z jednoho vlákna)
  - `Mpv::wakeup(&self)`

- [ ] **Step 1: Přidat `wait_for` do `tests/common/mod.rs`**

Na konec souboru přidat:

```rust
use std::time::{Duration, Instant};

use mpv_ffi::Event;

/// Pumps events until `pred` matches; panics with everything seen on timeout.
pub fn wait_for(mpv: &Mpv, secs: u64, mut pred: impl FnMut(&Event) -> bool) -> Vec<Event> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        let event = mpv.wait_event(0.25);
        if event == Event::None {
            continue;
        }
        let hit = pred(&event);
        seen.push(event);
        if hit {
            return seen;
        }
    }
    panic!("event not received within {secs}s; seen: {seen:#?}");
}
```

- [ ] **Step 2: Napsat padající testy `tests/events.rs`**

```rust
mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use mpv_ffi::{EndFileReason, Event, PropertyKind, PropertyValue};

const MISSING: &str = "C:/kaleido/missing/file.mkv";

#[test]
fn plays_generated_clip_to_eof() {
    let dir = tempfile::tempdir().unwrap();
    let clip = common::clip(dir.path(), "clip.y4m");
    let mpv = common::headless();
    mpv.command(&["loadfile", clip.to_str().unwrap()]).unwrap();
    let seen = common::wait_for(&mpv, 20, |e| matches!(e, Event::EndFile { .. }));
    assert!(seen.contains(&Event::FileLoaded), "{seen:#?}");
    assert_eq!(
        seen.last(),
        Some(&Event::EndFile { reason: EndFileReason::Eof })
    );
}

#[test]
fn opens_path_with_czech_characters_and_spaces() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Videa čeština (2026)");
    std::fs::create_dir(&folder).unwrap();
    let clip = common::clip(&folder, "žluťoučký kůň.y4m");
    let mpv = common::headless();
    mpv.command(&["loadfile", clip.to_str().unwrap()]).unwrap();
    common::wait_for(&mpv, 20, |e| *e == Event::FileLoaded);
}

#[test]
fn missing_file_ends_with_error() {
    let mpv = common::headless();
    mpv.command(&["loadfile", MISSING]).unwrap();
    let seen = common::wait_for(&mpv, 20, |e| matches!(e, Event::EndFile { .. }));
    assert!(
        matches!(
            seen.last(),
            Some(Event::EndFile { reason: EndFileReason::Error { .. } })
        ),
        "{seen:#?}"
    );
}

#[test]
fn error_log_messages_are_delivered() {
    let mpv = common::headless();
    mpv.request_log_messages("error").unwrap();
    mpv.command(&["loadfile", MISSING]).unwrap();
    common::wait_for(&mpv, 20, |e| {
        matches!(e, Event::LogMessage { level, .. } if level == "error")
    });
}

#[test]
fn observed_flag_reports_initial_value_and_changes() {
    let mpv = common::headless();
    mpv.observe(7, "pause", PropertyKind::Flag).unwrap();
    let change = |on| Event::PropertyChange {
        id: 7,
        name: "pause".into(),
        value: PropertyValue::Flag(on),
    };
    common::wait_for(&mpv, 5, |e| *e == change(false));
    mpv.set_property("pause", "yes").unwrap();
    common::wait_for(&mpv, 5, |e| *e == change(true));
}

#[test]
fn script_message_reaches_host_client() {
    let mpv = common::headless();
    mpv.command(&["script-message", "kaleido", "hello world"]).unwrap();
    common::wait_for(&mpv, 5, |e| {
        *e == Event::ClientMessage {
            args: vec!["kaleido".into(), "hello world".into()],
        }
    });
}

#[test]
fn quit_yields_shutdown_and_drop_does_not_hang() {
    let mpv = common::headless();
    mpv.command(&["quit"]).unwrap();
    common::wait_for(&mpv, 5, |e| *e == Event::Shutdown);
    let started = Instant::now();
    drop(mpv);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn wakeup_interrupts_an_infinite_wait() {
    let mpv = Arc::new(common::headless());
    while mpv.wait_event(0.0) != Event::None {}
    let waker = Arc::clone(&mpv);
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        waker.wakeup();
    });
    assert_eq!(mpv.wait_event(-1.0), Event::None);
    thread.join().unwrap();
}
```

- [ ] **Step 3: Spustit testy a ověřit, že selžou**

Run: `cargo test -p mpv-ffi --test events`
Expected: FAIL – `Event`, `PropertyKind`, `wait_event` … nejsou definované.

- [ ] **Step 4: Napsat `src/event.rs`**

```rust
use std::ffi::{CStr, c_char, c_int, c_void};

use crate::sys::{self, Api};

/// C type an observed property is delivered as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropertyKind {
    Flag,
    Int64,
    Double,
    String,
}

impl PropertyKind {
    pub(crate) fn format(self) -> sys::mpv_format {
        match self {
            PropertyKind::Flag => sys::MPV_FORMAT_FLAG,
            PropertyKind::Int64 => sys::MPV_FORMAT_INT64,
            PropertyKind::Double => sys::MPV_FORMAT_DOUBLE,
            PropertyKind::String => sys::MPV_FORMAT_STRING,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PropertyValue {
    Unavailable,
    Flag(bool),
    Int64(i64),
    Double(f64),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndFileReason {
    Eof,
    Stop,
    Quit,
    Error { code: i32, message: String },
    Redirect,
    Other(i32),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    None,
    Shutdown,
    LogMessage { prefix: String, level: String, text: String },
    StartFile,
    FileLoaded,
    EndFile { reason: EndFileReason },
    VideoReconfig,
    Seek,
    PlaybackRestart,
    PropertyChange { id: u64, name: String, value: PropertyValue },
    ClientMessage { args: Vec<String> },
    Other(i32),
}

unsafe fn string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

unsafe fn property_value(format: sys::mpv_format, data: *mut c_void) -> PropertyValue {
    if data.is_null() {
        return PropertyValue::Unavailable;
    }
    unsafe {
        match format {
            sys::MPV_FORMAT_FLAG => PropertyValue::Flag(*data.cast::<c_int>() != 0),
            sys::MPV_FORMAT_INT64 => PropertyValue::Int64(*data.cast::<i64>()),
            sys::MPV_FORMAT_DOUBLE => PropertyValue::Double(*data.cast::<f64>()),
            sys::MPV_FORMAT_STRING => PropertyValue::String(string(*data.cast::<*const c_char>())),
            _ => PropertyValue::Unavailable,
        }
    }
}

/// # Safety
/// `raw` must come from `mpv_wait_event` on a live handle and is only valid until the next call.
pub(crate) unsafe fn from_raw(api: &Api, raw: *const sys::mpv_event) -> Event {
    if raw.is_null() {
        return Event::None;
    }
    unsafe {
        let event = &*raw;
        match event.event_id {
            sys::MPV_EVENT_NONE => Event::None,
            sys::MPV_EVENT_SHUTDOWN => Event::Shutdown,
            sys::MPV_EVENT_LOG_MESSAGE => {
                let m = &*event.data.cast::<sys::mpv_event_log_message>();
                Event::LogMessage {
                    prefix: string(m.prefix),
                    level: string(m.level),
                    text: string(m.text).trim_end().to_owned(),
                }
            }
            sys::MPV_EVENT_START_FILE => Event::StartFile,
            sys::MPV_EVENT_FILE_LOADED => Event::FileLoaded,
            sys::MPV_EVENT_END_FILE => {
                let e = &*event.data.cast::<sys::mpv_event_end_file>();
                let reason = match e.reason {
                    sys::MPV_END_FILE_REASON_EOF => EndFileReason::Eof,
                    sys::MPV_END_FILE_REASON_STOP => EndFileReason::Stop,
                    sys::MPV_END_FILE_REASON_QUIT => EndFileReason::Quit,
                    sys::MPV_END_FILE_REASON_ERROR => EndFileReason::Error {
                        code: e.error,
                        message: api.error_string(e.error),
                    },
                    sys::MPV_END_FILE_REASON_REDIRECT => EndFileReason::Redirect,
                    other => EndFileReason::Other(other),
                };
                Event::EndFile { reason }
            }
            sys::MPV_EVENT_VIDEO_RECONFIG => Event::VideoReconfig,
            sys::MPV_EVENT_SEEK => Event::Seek,
            sys::MPV_EVENT_PLAYBACK_RESTART => Event::PlaybackRestart,
            sys::MPV_EVENT_PROPERTY_CHANGE => {
                let p = &*event.data.cast::<sys::mpv_event_property>();
                Event::PropertyChange {
                    id: event.reply_userdata,
                    name: string(p.name),
                    value: property_value(p.format, p.data),
                }
            }
            sys::MPV_EVENT_CLIENT_MESSAGE => {
                let m = &*event.data.cast::<sys::mpv_event_client_message>();
                let count = usize::try_from(m.num_args).unwrap_or(0);
                let args = (0..count).map(|i| string(*m.args.add(i))).collect();
                Event::ClientMessage { args }
            }
            other => Event::Other(other),
        }
    }
}
```

- [ ] **Step 5: Přidat metody do `src/handle.rs`**

Na začátek souboru přidat `use crate::event::{self, Event, PropertyKind};`. Do `impl Mpv` (za `client_name`) vložit:

```rust
    /// Delivers `Event::PropertyChange { id, .. }` now and on every change.
    pub fn observe(&self, id: u64, name: &str, kind: PropertyKind) -> Result<()> {
        let n = CString::new(name)?;
        // SAFETY: ctx is live; name outlives the call.
        let code = unsafe { (self.api.observe_property)(self.ctx, id, n.as_ptr(), kind.format()) };
        self.check(code, || format!("observe {name}"))
    }

    /// `min_level` is an mpv log level: "no", "fatal", "error", "warn", "info", "v", "debug", "trace".
    pub fn request_log_messages(&self, min_level: &str) -> Result<()> {
        let level = CString::new(min_level)?;
        // SAFETY: ctx is live; level outlives the call.
        let code = unsafe { (self.api.request_log_messages)(self.ctx, level.as_ptr()) };
        self.check(code, || format!("request_log_messages {min_level}"))
    }

    /// Blocks up to `timeout_secs` (negative = forever). Call from a single thread only.
    pub fn wait_event(&self, timeout_secs: f64) -> Event {
        // SAFETY: the returned event is converted before any further libmpv call on this thread.
        unsafe {
            let raw = (self.api.wait_event)(self.ctx, timeout_secs);
            event::from_raw(&self.api, raw)
        }
    }

    /// Makes a blocked `wait_event` return `Event::None`.
    pub fn wakeup(&self) {
        // SAFETY: ctx is live; mpv_wakeup is explicitly thread-safe.
        unsafe { (self.api.wakeup)(self.ctx) }
    }
```

- [ ] **Step 6: Upravit `src/lib.rs`**

Za `mod error;` přidat `mod event;` a za `pub use error::{Error, Result};` přidat:

```rust
pub use event::{EndFileReason, Event, PropertyKind, PropertyValue};
```

- [ ] **Step 7: Spustit všechny testy crate**

Run: `cargo test -p mpv-ffi`
Expected: PASS – 8 testů v `handle.rs` + 8 v `events.rs`, žádné varování o nepoužitých polích.

- [ ] **Step 8: Commit**

```bash
git add crates/mpv-ffi Cargo.lock
git commit -m "feat(mpv-ffi): events, property observation, log messages and wakeup" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `kaleido-mpv` – bezhlavé CLI pro thumbfast

**Files:**
- Create: `crates/kaleido-mpv/Cargo.toml`
- Create: `crates/kaleido-mpv/src/args.rs`
- Create: `crates/kaleido-mpv/src/main.rs`
- Test: `crates/kaleido-mpv/tests/cli.rs`

**Interfaces:**
- Consumes: `mpv_ffi::{Mpv, Event, load_api, locate_libmpv, LIBMPV_ENV, testing::write_y4m}`
- Produces: binárka `kaleido-mpv.exe` (subsystem Windows, žádné konzolové okno), která přijímá příkazovou řádku ve stylu mpv (`--volba=hodnota`, `--volba`, `--no-volba`, `--`, soubory); exit 0 po `SHUTDOWN`, 1 při chybě. `args::parse_args(I) -> Invocation { options: Vec<(String, String)>, files: Vec<String> }`.

- [ ] **Step 1: Přidat crate do workspace a vytvořit `Cargo.toml`**

V kořenovém `Cargo.toml` (ve `[workspace]`) změnit řádek `members` na:

```toml
members = ["crates/mpv-ffi", "crates/kaleido-mpv"]
```

`crates/kaleido-mpv/Cargo.toml`:

```toml
[package]
name = "kaleido-mpv"
version = "0.1.0"
edition.workspace = true
license.workspace = true
repository.workspace = true
rust-version.workspace = true
publish = false

[dependencies]
mpv-ffi = { path = "../mpv-ffi" }

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Napsat `src/args.rs` s padajícími testy**

```rust
/// Options and files from an mpv-style command line.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Invocation {
    pub options: Vec<(String, String)>,
    pub files: Vec<String>,
}

/// `--name=value` → (name, value); `--no-name` → (name, "no"); `--name` → (name, "yes");
/// everything after `--` and every bare argument is a file.
pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Invocation {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Invocation {
        parse_args(args.iter().map(|a| a.to_string()))
    }

    fn opt(name: &str, value: &str) -> (String, String) {
        (name.to_owned(), value.to_owned())
    }

    #[test]
    fn thumbfast_style_command_line() {
        let inv = parse(&[
            "--no-config",
            "--msg-level=all=no",
            "--idle",
            "--vf=scale=w=200:h=-2,format=fmt=bgra",
            "--start=12.5",
            "--",
            r"C:\Videa\film --x.mkv",
        ]);
        assert_eq!(
            inv.options,
            vec![
                opt("config", "no"),
                opt("msg-level", "all=no"),
                opt("idle", "yes"),
                opt("vf", "scale=w=200:h=-2,format=fmt=bgra"),
                opt("start", "12.5"),
            ]
        );
        assert_eq!(inv.files, vec![r"C:\Videa\film --x.mkv".to_owned()]);
    }

    #[test]
    fn bare_arguments_are_files() {
        let inv = parse(&["a.mkv", "--pause", "b.mkv"]);
        assert_eq!(inv.options, vec![opt("pause", "yes")]);
        assert_eq!(inv.files, vec!["a.mkv".to_owned(), "b.mkv".to_owned()]);
    }

    #[test]
    fn double_dash_turns_options_into_files() {
        let inv = parse(&["--", "--no-config"]);
        assert!(inv.options.is_empty());
        assert_eq!(inv.files, vec!["--no-config".to_owned()]);
    }

    #[test]
    fn empty_value_is_kept() {
        assert_eq!(parse(&["--o="]).options, vec![opt("o", "")]);
    }
}
```

`src/main.rs` (dočasně, aby se crate přeložil):

```rust
mod args;

fn main() {}
```

- [ ] **Step 3: Spustit testy a ověřit, že selžou**

Run: `cargo test -p kaleido-mpv --bin kaleido-mpv`
Expected: FAIL – 4 testy panikaří na `not yet implemented`.

- [ ] **Step 4: Implementovat `parse_args`**

Nahradit `todo!()`:

```rust
    let mut inv = Invocation::default();
    let mut files_only = false;
    for arg in args {
        if files_only {
            inv.files.push(arg);
            continue;
        }
        if arg == "--" {
            files_only = true;
            continue;
        }
        let Some(option) = arg.strip_prefix("--") else {
            inv.files.push(arg);
            continue;
        };
        let pair = match option.split_once('=') {
            Some((name, value)) => (name.to_owned(), value.to_owned()),
            None => match option.strip_prefix("no-") {
                Some(name) => (name.to_owned(), "no".to_owned()),
                None => (option.to_owned(), "yes".to_owned()),
            },
        };
        inv.options.push(pair);
    }
    inv
```

- [ ] **Step 5: Spustit unit testy**

Run: `cargo test -p kaleido-mpv --bin kaleido-mpv`
Expected: PASS (4 testy).

- [ ] **Step 6: Napsat padající integrační testy `tests/cli.rs`**

```rust
use std::fs::OpenOptions;
use std::io::Write;
use std::process::{Child, Command, ExitStatus};
use std::time::{Duration, Instant};

const EXE: &str = env!("CARGO_BIN_EXE_kaleido-mpv");

fn wait_with_timeout(child: &mut Child, limit: Duration) -> ExitStatus {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("kaleido-mpv did not exit within {limit:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The exact encode path thumbfast relies on: one raw BGRA frame written to a file.
#[test]
fn encodes_one_bgra_frame_like_thumbfast() {
    let dir = tempfile::tempdir().unwrap();
    let clip = dir.path().join("clip.y4m");
    mpv_ffi::testing::write_y4m(&clip, 64, 36, 30).unwrap();
    let out = dir.path().join("thumbfast.out");
    let mut child = Command::new(EXE)
        .args([
            "--no-config",
            "--msg-level=all=no",
            "--no-sub",
            "--no-audio",
            "--frames=1",
            "--vf=scale=w=32:h=18,format=fmt=bgra",
            "--sws-scaler=fast-bilinear",
            "--ovc=rawvideo",
            "--of=image2",
            "--ofopts=update=1",
        ])
        .arg(format!("--o={}", out.display()))
        .arg("--")
        .arg(&clip)
        .spawn()
        .unwrap();
    assert!(wait_with_timeout(&mut child, Duration::from_secs(20)).success());
    assert_eq!(std::fs::metadata(&out).unwrap().len(), 32 * 18 * 4);
}

/// thumbfast controls its thumbnailer through a named pipe and ends it with `quit`.
#[test]
fn quits_when_told_over_ipc() {
    let pipe = format!("kaleido-test-{}", std::process::id());
    let mut child = Command::new(EXE)
        .args(["--no-config", "--idle"])
        .arg(format!("--input-ipc-server={pipe}"))
        .spawn()
        .unwrap();
    let path = format!(r"\\.\pipe\{pipe}");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut connection = loop {
        match OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => break file,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                let _ = child.kill();
                panic!("pipe {path} never appeared: {e}");
            }
        }
    };
    connection.write_all(b"quit\n").unwrap();
    drop(connection);
    assert!(wait_with_timeout(&mut child, Duration::from_secs(10)).success());
}

#[test]
fn fails_cleanly_without_libmpv() {
    let mut child = Command::new(EXE)
        .env(mpv_ffi::LIBMPV_ENV, "C:/kaleido/missing/libmpv-2.dll")
        .arg("--idle")
        .spawn()
        .unwrap();
    assert_eq!(wait_with_timeout(&mut child, Duration::from_secs(10)).code(), Some(1));
}
```

(Integrační testy vidí běžné závislosti balíčku, takže `mpv_ffi::testing` je dostupné bez další úpravy.)

- [ ] **Step 7: Spustit integrační testy a ověřit, že selžou**

Run: `cargo test -p kaleido-mpv --test cli`
Expected: FAIL – prázdné `main` skončí hned s kódem 0, takže `encodes_one_bgra_frame_like_thumbfast` nenajde výstup a `fails_cleanly_without_libmpv` dostane `Some(0)`.

- [ ] **Step 8: Napsat `src/main.rs`**

```rust
#![cfg_attr(not(test), windows_subsystem = "windows")]
//! Headless mpv-compatible CLI over libmpv. Exists so thumbfast can spawn its
//! thumbnailer without Kaleido shipping a full mpv.exe (spec 4.1).

mod args;

use mpv_ffi::{Event, Mpv, load_api, locate_libmpv};

fn main() {
    let code = match run() {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("kaleido-mpv: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn run() -> mpv_ffi::Result<()> {
    let invocation = args::parse_args(std::env::args().skip(1));
    let mpv = Mpv::create(load_api(&locate_libmpv())?)?;
    // mpv CLI behaviour that libmpv does not default to: leave once the playlist is done,
    // never read a config directory, never touch a terminal.
    mpv.set_option("idle", "once")?;
    mpv.set_option("config", "no")?;
    mpv.set_option("terminal", "no")?;
    for (name, value) in &invocation.options {
        if let Err(e) = mpv.set_option(name, value) {
            eprintln!("kaleido-mpv: ignoring --{name}={value}: {e}");
        }
    }
    mpv.initialize()?;
    for file in &invocation.files {
        mpv.command(&["loadfile", file, "append-play"])?;
    }
    while mpv.wait_event(-1.0) != Event::Shutdown {}
    Ok(())
}
```

- [ ] **Step 9: Spustit všechny testy crate**

Run: `cargo test -p kaleido-mpv`
Expected: PASS – 4 unit testy + 3 integrační. Pokud `encodes_one_bgra_frame_like_thumbfast` selže, libmpv neumí encoding mode. To je **blokující zjištění pro bod 7 z 5.4**: zapsat ho do `docs/m0/report.md` (vznikne v Task 7) a pokračovat s ostatními úkoly.

- [ ] **Step 10: Commit**

```bash
git add Cargo.toml Cargo.lock crates/kaleido-mpv
git commit -m "feat(kaleido-mpv): headless mpv-style CLI for thumbfast's thumbnailer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: CI pro crates

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `scripts/fetch-libmpv.ps1`, crates `mpv-ffi`, `kaleido-mpv`
- Produces: workflow `CI` s jobem `rust` (Task 7 přidá job `prototype`).

- [ ] **Step 1: Vytvořit `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  rust:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v5
      - name: Fetch pinned libmpv
        shell: pwsh
        run: ./scripts/fetch-libmpv.ps1
      - run: rustup component add clippy rustfmt
      - run: cargo fmt --all --check
      - run: cargo clippy -p mpv-ffi -p kaleido-mpv --all-targets -- -D warnings
      - run: cargo test -p mpv-ffi -p kaleido-mpv
```

- [ ] **Step 2: Spustit stejné kroky lokálně**

Run: `cargo fmt --all --check && cargo clippy -p mpv-ffi -p kaleido-mpv --all-targets -- -D warnings && cargo test -p mpv-ffi -p kaleido-mpv`
Expected: vše projde bez varování. Nálezy clippy opravit v dotčených souborech a spustit znovu.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: test mpv-ffi and kaleido-mpv against pinned libmpv on Windows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Kostra prototypu (Tauri 2 + React), okno bez rámečku

**Files:**
- Modify: `Cargo.toml` (přidat člena workspace)
- Create: `prototype/package.json`, `prototype/tsconfig.json`, `prototype/vite.config.ts`, `prototype/index.html`, `prototype/app-icon.svg`
- Create: `prototype/src/main.tsx`, `prototype/src/App.tsx`, `prototype/src/app.css`, `prototype/src/components/TitleBar.tsx`
- Create: `prototype/src-tauri/Cargo.toml`, `prototype/src-tauri/build.rs`, `prototype/src-tauri/tauri.conf.json`, `prototype/src-tauri/capabilities/default.json`, `prototype/src-tauri/src/main.rs`
- Generate: `prototype/src-tauri/icons/*`, `prototype/package-lock.json`

**Interfaces:**
- Consumes: nic z předchozích úkolů
- Produces: okno `main` (bez rámečku, průhledné, 1280×720), komponenta `TitleBar({ title, badge? })`, CSS třídy `.glass`, `.capsule`, `.icon-btn`, `.btn`, `.start`, `.start-card`, `.title`, `.dot`, tokeny `--k-*`; skripty `npm run dev | build | test | tauri`.

- [ ] **Step 1: Přidat prototyp do workspace**

V kořenovém `Cargo.toml`:

```toml
members = ["crates/mpv-ffi", "crates/kaleido-mpv", "prototype/src-tauri"]
```

- [ ] **Step 2: Vytvořit `prototype/package.json`**

```json
{
  "name": "kaleido-proto",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.12.3",
    "@tauri-apps/plugin-dialog": "^2.8.2",
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.12.2",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.2",
    "typescript": "^7.0.2",
    "vite": "^8.3.4",
    "vitest": "^5.0.3"
  }
}
```

- [ ] **Step 3: Vytvořit `tsconfig.json`, `vite.config.ts`, `index.html`**

`prototype/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`prototype/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: { environment: 'node' },
});
```

`prototype/index.html`:

```html
<!doctype html>
<html lang="cs">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Kaleido M0</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Vytvořit UI soubory**

`prototype/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`prototype/src/app.css`:

```css
:root {
  --k-font: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  --k-glass-tint: rgba(255, 255, 255, 0.13);
  --k-glass-border: rgba(255, 255, 255, 0.3);
  --k-glass-highlight: rgba(255, 255, 255, 0.55);
  --k-glass-shadow: 0 10px 34px rgba(0, 0, 0, 0.35);
  --k-radius-capsule: 999px;
  --k-radius-panel: 24px;
  --k-accent: #a98bff;
  --k-app-bg: radial-gradient(120% 90% at 0% 0%, #2a2350 0%, #15122b 55%, #0d0b1c 100%);
  --k-page-solid: #15122b;
  --k-motion-fast: 180ms;
  --k-ease: cubic-bezier(0.2, 0.9, 0.2, 1.05);
}

* { box-sizing: border-box; }

html, body, #root {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: transparent;
  color: #fff;
  font-family: var(--k-font);
  user-select: none;
}

.app { position: fixed; inset: 0; }
.app.idle-bg { background: var(--k-app-bg); }

/* No backdrop-filter: over video the blur comes from the mpv shader (spec 8.2). */
.glass {
  background: var(--k-glass-tint);
  border: 1px solid var(--k-glass-border);
  box-shadow: inset 0 1px 0 var(--k-glass-highlight), var(--k-glass-shadow);
}

.capsule {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-radius: var(--k-radius-capsule);
}
.titlebar-left { top: 16px; left: 16px; }
.titlebar-right { top: 16px; right: 16px; }

.icon-btn {
  all: unset;
  cursor: pointer;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  font-size: 14px;
}
.icon-btn:hover { background: rgba(255, 255, 255, 0.18); }
.icon-btn:focus-visible { outline: 2px solid var(--k-accent); }

.title { font-size: 13px; font-weight: 600; white-space: nowrap; }
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: conic-gradient(#7fd8ff, #a98bff, #ff8fd0, #ffd27a, #7fd8ff);
}

.start { position: absolute; inset: 0; display: grid; place-items: center; }
.start-card {
  padding: 40px 56px;
  border-radius: 28px;
  text-align: center;
  display: grid;
  gap: 14px;
  justify-items: center;
}
.btn {
  all: unset;
  cursor: pointer;
  font-size: 13px;
  font-weight: 700;
  padding: 9px 18px;
  border-radius: 999px;
  background: #fff;
  color: #2a1d4d;
}
.btn:focus-visible { outline: 2px solid var(--k-accent); outline-offset: 2px; }
```

`prototype/src/components/TitleBar.tsx`:

```tsx
import { getCurrentWindow } from '@tauri-apps/api/window';

export function TitleBar({ title, badge }: { title: string; badge?: string }) {
  const win = getCurrentWindow();
  return (
    <>
      <div className="capsule glass titlebar-left" data-tauri-drag-region data-glass>
        <span className="dot" data-tauri-drag-region />
        <span className="title" data-tauri-drag-region>{title}</span>
        {badge && <span className="badge">{badge}</span>}
      </div>
      <div className="capsule glass titlebar-right" data-glass>
        <button className="icon-btn" aria-label="Minimalizovat" onClick={() => win.minimize()}>–</button>
        <button className="icon-btn" aria-label="Maximalizovat" onClick={() => win.toggleMaximize()}>□</button>
        <button className="icon-btn" aria-label="Zavřít" onClick={() => win.close()}>✕</button>
      </div>
    </>
  );
}
```

`prototype/src/App.tsx`:

```tsx
import { TitleBar } from './components/TitleBar';

export function App() {
  return (
    <div className="app idle-bg">
      <TitleBar title="Kaleido M0" />
    </div>
  );
}
```

`prototype/app-icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7fd8ff"/>
      <stop offset=".5" stop-color="#a98bff"/>
      <stop offset="1" stop-color="#ff8fd0"/>
    </linearGradient>
  </defs>
  <circle cx="256" cy="256" r="220" fill="url(#g)"/>
</svg>
```

- [ ] **Step 5: Vytvořit Tauri část**

`prototype/src-tauri/Cargo.toml`:

```toml
[package]
name = "kaleido-proto"
version = "0.0.0"
edition.workspace = true
license.workspace = true
repository.workspace = true
rust-version.workspace = true
publish = false

[build-dependencies]
tauri-build = { version = "2.7", features = [] }

[dependencies]
tauri = { version = "2.12", features = [] }
tauri-plugin-dialog = "2.8"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`prototype/src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

`prototype/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Kaleido M0",
  "version": "0.0.0",
  "identifier": "com.sth3no.kaleido.m0",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Kaleido M0",
        "width": 1280,
        "height": 720,
        "minWidth": 640,
        "minHeight": 360,
        "decorations": false,
        "transparent": true
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": false,
    "icon": ["icons/icon.ico"]
  }
}
```

`prototype/src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-set-fullscreen",
    "dialog:allow-open"
  ]
}
```

`prototype/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("Kaleido M0 se nepodařilo spustit");
}
```

- [ ] **Step 6: Nainstalovat závislosti a vygenerovat ikony**

Run: `cd prototype && npm install && npx tauri icon app-icon.svg && npm run build`
Expected: vznikne `package-lock.json`, `src-tauri/icons/icon.ico` a `dist/`; `tsc` i `vite build` projdou bez chyb.

- [ ] **Step 7: Ruční kontrola okna**

Run: `cd prototype && npm run tauri dev`
Expected: okno bez systémového rámečku s fialovým pozadím a dvěma skleněnými kapslemi. Tažením za levou kapsli se okno posouvá. Tlačítka minimalizují, maximalizují a zavřou okno.

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml Cargo.lock prototype
git commit -m "feat(prototype): frameless transparent Tauri 2 + React shell" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Video pod průhledným WebView2 (body 1 a 2)

**Files:**
- Create: `prototype/src-tauri/src/surface.rs`, `src/engine.rs`, `src/options.rs`, `src/commands.rs`
- Modify: `prototype/src-tauri/src/main.rs` (celý obsah), `prototype/src-tauri/Cargo.toml` (závislosti)
- Create: `prototype/src/player.ts`, `prototype/src/playerState.ts`, `prototype/src/usePlayer.ts`
- Create: `prototype/src/components/StartScreen.tsx`, `prototype/src/components/Controls.tsx`
- Modify: `prototype/src/App.tsx` (celý obsah), `prototype/src/app.css` (připsat blok)
- Test: `prototype/src/playerState.test.ts`, unit testy v `surface.rs`
- Create: `docs/m0/report.md`
- Modify: `.github/workflows/ci.yml` (job `prototype`)

**Interfaces:**
- Consumes: `mpv_ffi::{Mpv, Event, PropertyKind, PropertyValue, load_api, locate_libmpv}` (Task 2–3), `TitleBar` (Task 6)
- Produces:
  - Rust: `surface::{Layout, PxRect, to_physical(Layout, u32, u32, f64) -> Option<PxRect>, SurfaceState::{new, apply(w,h,scale), set_layout}, win::VideoWindow::{create(isize), raw() -> isize, place(Option<PxRect>)}}`; `engine::Engine { pub mpv: Mpv }` s `Engine::start(AppHandle, wid: isize, &[(&str, String)]) -> mpv_ffi::Result<Arc<Engine>>`; `options::{Paths::resolve(&AppHandle), mpv_options(&Paths)}`; příkazy `open_file(path)`, `player_command(cmd)`, `surface_set_layout(layout)`.
  - Události: `player:prop {name, value}`, `player:file-loaded`, `player:end-file`, `player:log`, `player:message (string[])`.
  - TS: `player.ts` – typy `PropValue`, `PlayerCmd`, `Layout`, funkce `openFile`, `playerCommand`, `setSurfaceLayout`, `onProp`, `onMessage`; `playerState.ts` – `PlayerState`, `initialState`, `applyProp`, `badgeFor`, `formatTime`; `usePlayer(): PlayerState`; komponenty `StartScreen`, `Controls({ s })`.

- [ ] **Step 1: Připravit testovací média (ručně, uživatel)**

Do `%USERPROFILE%\Videos\kaleido-m0\` dát: `sdr-1080p.*` (běžné SDR video), `uhd-2160p.*` (4K SDR nebo HDR), `hdr10.*` (HDR10, např. z https://kodi.wiki/view/Samples), `letterbox.*` (širokoúhlé 2.39:1 s černými pruhy), a kopii `sdr-1080p` pojmenovanou `Žluťoučký kůň (zkouška).mkv` (nebo s příslušnou příponou).
Expected: složka obsahuje 5 souborů; agent je nestahuje.

- [ ] **Step 2: Přidat závislosti do `prototype/src-tauri/Cargo.toml`**

Do `[dependencies]` přidat:

```toml
mpv-ffi = { path = "../../crates/mpv-ffi" }
raw-window-handle = "0.6"
windows = { version = "0.62", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_System_LibraryLoader",
  "Win32_UI_WindowsAndMessaging",
] }
```

- [ ] **Step 3: Napsat `src/surface.rs` s padajícími testy**

```rust
use std::sync::Mutex;

use serde::Deserialize;

/// Where the video surface should be, in CSS px of the window (spec 8.3, mini player).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layout {
    Full,
    Rect { x: f64, y: f64, w: f64, h: f64 },
    Hidden,
}

/// Child-window rectangle in physical px.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PxRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// None = hide the surface (explicitly hidden, or nothing visible to show).
pub fn to_physical(layout: Layout, client_w: u32, client_h: u32, scale: f64) -> Option<PxRect> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_covers_the_client_area() {
        assert_eq!(
            to_physical(Layout::Full, 1920, 1080, 1.5),
            Some(PxRect { x: 0, y: 0, w: 1920, h: 1080 })
        );
    }

    #[test]
    fn rect_is_scaled_and_rounded() {
        let layout = Layout::Rect { x: 10.4, y: 20.0, w: 100.0, h: 50.0 };
        assert_eq!(
            to_physical(layout, 1920, 1080, 1.5),
            Some(PxRect { x: 16, y: 30, w: 150, h: 75 })
        );
    }

    #[test]
    fn rect_is_clamped_to_the_client_area() {
        let layout = Layout::Rect { x: -10.0, y: -10.0, w: 50.0, h: 50.0 };
        assert_eq!(
            to_physical(layout, 40, 30, 1.0),
            Some(PxRect { x: 0, y: 0, w: 40, h: 30 })
        );
    }

    #[test]
    fn minimized_window_hides_surface() {
        assert_eq!(to_physical(Layout::Full, 0, 0, 1.0), None);
    }

    #[test]
    fn rect_outside_the_window_hides_surface() {
        let layout = Layout::Rect { x: 500.0, y: 10.0, w: 50.0, h: 50.0 };
        assert_eq!(to_physical(layout, 400, 300, 1.0), None);
    }

    #[test]
    fn hidden_is_hidden() {
        assert_eq!(to_physical(Layout::Hidden, 800, 600, 1.0), None);
    }
}
```

Do `src/main.rs` dočasně přidat `mod surface;` (nad `fn main`).

- [ ] **Step 4: Spustit testy a ověřit, že selžou**

Run: `cd prototype && npm run build && cd .. && cargo test -p kaleido-proto surface`
Expected: FAIL – 6 testů panikaří na `not yet implemented`.

- [ ] **Step 5: Implementovat `to_physical`, `SurfaceState` a `win::VideoWindow`**

Nahradit `todo!()`:

```rust
    let (cw, ch) = (client_w as i32, client_h as i32);
    if cw <= 0 || ch <= 0 {
        return None;
    }
    match layout {
        Layout::Hidden => None,
        Layout::Full => Some(PxRect { x: 0, y: 0, w: cw, h: ch }),
        Layout::Rect { x, y, w, h } => {
            let px = |v: f64, max: i32| ((v * scale).round() as i32).clamp(0, max);
            let (left, top) = (px(x, cw), px(y, ch));
            let (right, bottom) = (px(x + w, cw), px(y + h, ch));
            (right > left && bottom > top).then_some(PxRect {
                x: left,
                y: top,
                w: right - left,
                h: bottom - top,
            })
        }
    }
```

Za funkci `to_physical` (před `#[cfg(test)]`) přidat:

```rust
/// The video child window plus the layout the UI asked for.
pub struct SurfaceState {
    window: win::VideoWindow,
    layout: Mutex<Layout>,
    client: Mutex<(u32, u32, f64)>,
}

impl SurfaceState {
    pub fn new(window: win::VideoWindow) -> SurfaceState {
        SurfaceState {
            window,
            layout: Mutex::new(Layout::Full),
            client: Mutex::new((0, 0, 1.0)),
        }
    }

    /// Call on every resize / DPI change (main thread).
    pub fn apply(&self, client_w: u32, client_h: u32, scale: f64) {
        *self.client.lock().unwrap() = (client_w, client_h, scale);
        let layout = *self.layout.lock().unwrap();
        self.window.place(to_physical(layout, client_w, client_h, scale));
    }

    pub fn set_layout(&self, layout: Layout) {
        *self.layout.lock().unwrap() = layout;
        let (w, h, scale) = *self.client.lock().unwrap();
        self.apply(w, h, scale);
    }
}

pub mod win {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{BLACK_BRUSH, GetStockObject, HBRUSH};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, HWND_BOTTOM, RegisterClassW, SWP_HIDEWINDOW,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetWindowPos, WINDOW_EX_STYLE,
        WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
    };
    use windows::core::w;

    use super::PxRect;

    /// Child window handed to mpv as `wid`; always at the bottom of the z-order, under WebView2.
    pub struct VideoWindow {
        hwnd: isize,
    }

    unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
    }

    impl VideoWindow {
        /// Must run on the thread that owns `parent` (Tauri's main thread).
        pub fn create(parent: isize) -> windows::core::Result<VideoWindow> {
            unsafe {
                let instance = GetModuleHandleW(None)?;
                let class = w!("KaleidoVideoSurface");
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    hInstance: instance.into(),
                    lpszClassName: class,
                    hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
                    ..Default::default()
                };
                RegisterClassW(&wc); // 0 when already registered, which is fine
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    class,
                    w!(""),
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                    0,
                    0,
                    1,
                    1,
                    Some(HWND(parent as *mut _)),
                    None,
                    Some(instance.into()),
                    None,
                )?;
                SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)?;
                Ok(VideoWindow { hwnd: hwnd.0 as isize })
            }
        }

        pub fn raw(&self) -> isize {
            self.hwnd
        }

        pub fn place(&self, rect: Option<PxRect>) {
            let hwnd = HWND(self.hwnd as *mut _);
            // Failures only mean the window is gone (app shutting down); nothing to recover.
            let _ = unsafe {
                match rect {
                    Some(r) => SetWindowPos(hwnd, Some(HWND_BOTTOM), r.x, r.y, r.w, r.h, SWP_NOACTIVATE | SWP_SHOWWINDOW),
                    None => SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_HIDEWINDOW),
                }
            };
        }
    }
}
```

- [ ] **Step 6: Spustit testy surface**

Run: `cargo test -p kaleido-proto surface`
Expected: PASS (6 testů).

- [ ] **Step 7: Napsat `src/options.rs`**

```rust
use std::error::Error;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Files the prototype hands to mpv.
pub struct Paths {
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> Result<Paths, Box<dyn Error>> {
        let data_dir = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        Ok(Paths { data_dir })
    }
}

/// Set before mpv_initialize. Spec 5.2 subset; `config=no` keeps the user's own mpv config out of M0.
pub fn mpv_options(paths: &Paths) -> Vec<(&'static str, String)> {
    vec![
        ("vo", "gpu-next".into()),
        ("gpu-api", "d3d11".into()),
        ("target-colorspace-hint", "yes".into()),
        ("hwdec", "auto-safe".into()),
        ("keep-open", "yes".into()),
        ("idle", "yes".into()),
        ("force-window", "yes".into()),
        ("osc", "no".into()),
        ("config", "no".into()),
        ("input-default-bindings", "yes".into()),
        ("input-vo-keyboard", "no".into()),
        ("terminal", "no".into()),
        ("log-file", paths.data_dir.join("mpv.log").display().to_string()),
    ]
}
```

- [ ] **Step 8: Napsat `src/engine.rs`**

```rust
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use mpv_ffi::{Event, Mpv, PropertyKind, PropertyValue, load_api, locate_libmpv};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

/// Properties the UI renders (M0 subset of spec 4.4 `player:state`).
const OBSERVED: &[(&str, PropertyKind)] = &[
    ("pause", PropertyKind::Flag),
    ("time-pos", PropertyKind::Double),
    ("duration", PropertyKind::Double),
    ("volume", PropertyKind::Double),
    ("fullscreen", PropertyKind::Flag),
    ("media-title", PropertyKind::String),
    ("video-params/gamma", PropertyKind::String),
    ("video-params/h", PropertyKind::Int64),
    ("osd-dimensions/w", PropertyKind::Int64),
    ("osd-dimensions/h", PropertyKind::Int64),
    ("osd-dimensions/ml", PropertyKind::Int64),
    ("osd-dimensions/mt", PropertyKind::Int64),
];

const TIME_POS_INTERVAL: Duration = Duration::from_millis(100);

pub struct Engine {
    pub mpv: Mpv,
}

#[derive(Clone, Serialize)]
struct Prop {
    name: String,
    value: Value,
}

pub fn to_json(value: &PropertyValue) -> Value {
    match value {
        PropertyValue::Unavailable => Value::Null,
        PropertyValue::Flag(b) => json!(b),
        PropertyValue::Int64(i) => json!(i),
        PropertyValue::Double(d) => json!(d),
        PropertyValue::String(s) => json!(s),
    }
}

impl Engine {
    pub fn start(app: AppHandle, wid: isize, options: &[(&str, String)]) -> mpv_ffi::Result<Arc<Engine>> {
        let mpv = Mpv::create(load_api(&locate_libmpv())?)?;
        mpv.set_option("wid", &wid.to_string())?;
        for (name, value) in options {
            mpv.set_option(name, value)?;
        }
        mpv.initialize()?;
        for (id, (name, kind)) in OBSERVED.iter().enumerate() {
            mpv.observe(id as u64, name, *kind)?;
        }
        mpv.request_log_messages("warn")?;
        let engine = Arc::new(Engine { mpv });
        let pump = Arc::clone(&engine);
        thread::Builder::new()
            .name("mpv-events".into())
            .spawn(move || pump.run_events(&app))
            .expect("spawn mpv event thread");
        Ok(engine)
    }

    fn run_events(&self, app: &AppHandle) {
        let mut last_time_pos = Instant::now();
        loop {
            match self.mpv.wait_event(-1.0) {
                // mpv's `quit` (q, window close) ends the app (spec 5.1).
                Event::Shutdown => {
                    app.exit(0);
                    return;
                }
                Event::PropertyChange { name, value, .. } => {
                    if name == "time-pos" {
                        if last_time_pos.elapsed() < TIME_POS_INTERVAL {
                            continue;
                        }
                        last_time_pos = Instant::now();
                    }
                    let _ = app.emit("player:prop", Prop { value: to_json(&value), name });
                }
                Event::FileLoaded => {
                    let _ = app.emit("player:file-loaded", ());
                }
                Event::EndFile { reason } => {
                    let _ = app.emit("player:end-file", format!("{reason:?}"));
                }
                Event::LogMessage { prefix, level, text } => {
                    let _ = app.emit("player:log", format!("[{prefix}] {level}: {text}"));
                }
                Event::ClientMessage { args } => self.on_client_message(app, args),
                _ => {}
            }
        }
    }

    fn on_client_message(&self, app: &AppHandle, args: Vec<String>) {
        let _ = app.emit("player:message", args);
    }
}
```

- [ ] **Step 9: Napsat `src/commands.rs`**

```rust
use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::engine::Engine;
use crate::surface::{Layout, SurfaceState};

pub type CmdResult = Result<(), String>;

fn err(e: mpv_ffi::Error) -> String {
    e.to_string()
}

#[tauri::command]
pub fn open_file(engine: State<'_, Arc<Engine>>, path: String) -> CmdResult {
    engine.mpv.command(&["loadfile", &path, "replace"]).map_err(err)
}

/// Typed player commands; the UI cannot send arbitrary mpv commands (spec 4.4).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlayerCmd {
    TogglePause,
    SeekAbsolute { seconds: f64 },
    SetVolume { value: f64 },
    SetFullscreen { on: bool },
}

#[tauri::command]
pub fn player_command(engine: State<'_, Arc<Engine>>, cmd: PlayerCmd) -> CmdResult {
    let mpv = &engine.mpv;
    match cmd {
        PlayerCmd::TogglePause => mpv.command(&["cycle", "pause"]),
        PlayerCmd::SeekAbsolute { seconds } => {
            mpv.command(&["seek", &seconds.max(0.0).to_string(), "absolute+keyframes"])
        }
        PlayerCmd::SetVolume { value } => mpv.set_property("volume", &value.clamp(0.0, 130.0).to_string()),
        PlayerCmd::SetFullscreen { on } => mpv.set_property("fullscreen", if on { "yes" } else { "no" }),
    }
    .map_err(err)
}

#[tauri::command]
pub fn surface_set_layout(surface: State<'_, SurfaceState>, layout: Layout) {
    surface.set_layout(layout);
}
```

- [ ] **Step 10: Přepsat `src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod engine;
mod options;
mod surface;

use std::sync::Arc;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{Manager, WindowEvent};

use engine::Engine;
use surface::SurfaceState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = app.get_webview_window("main").ok_or("main window missing")?;
            let parent = match window.window_handle()?.as_raw() {
                RawWindowHandle::Win32(handle) => handle.hwnd.get(),
                other => return Err(format!("unsupported window handle {other:?}").into()),
            };
            let video = surface::win::VideoWindow::create(parent)?;
            let paths = options::Paths::resolve(app.handle())?;
            let engine = Engine::start(app.handle().clone(), video.raw(), &options::mpv_options(&paths))?;
            let surface = SurfaceState::new(video);
            let size = window.inner_size()?;
            surface.apply(size.width, size.height, window.scale_factor()?);
            app.manage(surface);
            app.manage(engine);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                if let (Some(surface), Ok(size), Ok(scale)) =
                    (window.try_state::<SurfaceState>(), window.inner_size(), window.scale_factor())
                {
                    surface.apply(size.width, size.height, scale);
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                // mpv shuts down first; the event thread exits the app on SHUTDOWN.
                if let Some(engine) = window.try_state::<Arc<Engine>>() {
                    api.prevent_close();
                    let _ = engine.mpv.command(&["quit"]);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::player_command,
            commands::surface_set_layout,
        ])
        .run(tauri::generate_context!())
        .expect("Kaleido M0 se nepodařilo spustit");
}
```

- [ ] **Step 11: Ověřit překlad a testy Rustu**

Run: `cargo test -p kaleido-proto && cargo clippy -p kaleido-proto -- -D warnings`
Expected: PASS (6 testů), bez varování.

- [ ] **Step 12: Napsat padající test `prototype/src/playerState.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { applyProp, badgeFor, formatTime, initialState } from './playerState';

describe('applyProp', () => {
  it('maps observed mpv properties onto UI state', () => {
    let s = applyProp(initialState, 'pause', false);
    s = applyProp(s, 'time-pos', 12.5);
    s = applyProp(s, 'osd-dimensions/ml', 140);
    s = applyProp(s, 'media-title', 'Duna');
    expect(s).toMatchObject({ pause: false, timePos: 12.5, title: 'Duna', osd: { ml: 140 } });
  });

  it('treats unavailable values as empty', () => {
    expect(applyProp(initialState, 'duration', null).duration).toBe(0);
    expect(applyProp(initialState, 'media-title', null).title).toBe('');
  });

  it('ignores unknown properties', () => {
    expect(applyProp(initialState, 'whatever', 1)).toBe(initialState);
  });
});

describe('badgeFor', () => {
  it('labels 4K HDR', () => expect(badgeFor({ gamma: 'pq', videoHeight: 2160 })).toBe('4K HDR'));
  it('labels HLG as HDR', () => expect(badgeFor({ gamma: 'hlg', videoHeight: 1080 })).toBe('1080p HDR'));
  it('has no badge for small SDR', () => expect(badgeFor({ gamma: 'bt.1886', videoHeight: 720 })).toBeUndefined());
});

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [75.4, '1:15'],
    [3725, '1:02:05'],
    [Number.NaN, '0:00'],
    [-3, '0:00'],
  ])('%s → %s', (sec, text) => expect(formatTime(sec)).toBe(text));
});
```

- [ ] **Step 13: Spustit test a ověřit, že selže**

Run: `cd prototype && npm test`
Expected: FAIL – modul `./playerState` neexistuje.

- [ ] **Step 14: Napsat `prototype/src/playerState.ts`**

```ts
import type { PropValue } from './player';

export type PlayerState = {
  loaded: boolean;
  pause: boolean;
  timePos: number;
  duration: number;
  volume: number;
  fullscreen: boolean;
  title: string;
  gamma: string;
  videoHeight: number;
  osd: { w: number; h: number; ml: number; mt: number };
};

export const initialState: PlayerState = {
  loaded: false,
  pause: true,
  timePos: 0,
  duration: 0,
  volume: 100,
  fullscreen: false,
  title: '',
  gamma: '',
  videoHeight: 0,
  osd: { w: 0, h: 0, ml: 0, mt: 0 },
};

/** Applies one observed mpv property to the UI state. */
export function applyProp(s: PlayerState, name: string, v: PropValue): PlayerState {
  const num = typeof v === 'number' ? v : 0;
  const text = typeof v === 'string' ? v : '';
  switch (name) {
    case 'pause': return { ...s, pause: v === true };
    case 'time-pos': return { ...s, timePos: num };
    case 'duration': return { ...s, duration: num };
    case 'volume': return { ...s, volume: num };
    case 'fullscreen': return { ...s, fullscreen: v === true };
    case 'media-title': return { ...s, title: text };
    case 'video-params/gamma': return { ...s, gamma: text };
    case 'video-params/h': return { ...s, videoHeight: num };
    case 'osd-dimensions/w': return { ...s, osd: { ...s.osd, w: num } };
    case 'osd-dimensions/h': return { ...s, osd: { ...s.osd, h: num } };
    case 'osd-dimensions/ml': return { ...s, osd: { ...s.osd, ml: num } };
    case 'osd-dimensions/mt': return { ...s, osd: { ...s.osd, mt: num } };
    default: return s;
  }
}

/** Resolution/HDR label for the top-left capsule (spec 8.4). */
export function badgeFor(s: Pick<PlayerState, 'gamma' | 'videoHeight'>): string | undefined {
  const parts: string[] = [];
  if (s.videoHeight >= 2160) parts.push('4K');
  else if (s.videoHeight >= 1440) parts.push('1440p');
  else if (s.videoHeight >= 1080) parts.push('1080p');
  if (s.gamma === 'pq' || s.gamma === 'hlg') parts.push('HDR');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export function formatTime(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
```

`prototype/src/player.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type PropValue = boolean | number | string | null;

export type PlayerCmd =
  | { type: 'togglePause' }
  | { type: 'seekAbsolute'; seconds: number }
  | { type: 'setVolume'; value: number }
  | { type: 'setFullscreen'; on: boolean };

export type Layout =
  | { kind: 'full' }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'hidden' };

export const openFile = (path: string) => invoke<void>('open_file', { path });
export const playerCommand = (cmd: PlayerCmd) => invoke<void>('player_command', { cmd });
export const setSurfaceLayout = (layout: Layout) => invoke<void>('surface_set_layout', { layout });

export const onProp = (cb: (name: string, value: PropValue) => void): Promise<UnlistenFn> =>
  listen<{ name: string; value: PropValue }>('player:prop', (e) => cb(e.payload.name, e.payload.value));

export const onMessage = (cb: (args: string[]) => void): Promise<UnlistenFn> =>
  listen<string[]>('player:message', (e) => cb(e.payload));
```

`prototype/src/usePlayer.ts`:

```ts
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { onProp } from './player';
import { applyProp, initialState, type PlayerState } from './playerState';

export function usePlayer(): PlayerState {
  const [state, setState] = useState(initialState);
  useEffect(() => {
    const subscriptions = [
      onProp((name, value) => setState((s) => applyProp(s, name, value))),
      listen('player:file-loaded', () => setState((s) => ({ ...s, loaded: true }))),
      listen<string>('player:log', (e) => console.warn(e.payload)),
    ];
    return () => {
      subscriptions.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);
  return state;
}
```

- [ ] **Step 15: Spustit UI testy**

Run: `cd prototype && npm test`
Expected: PASS (11 testů).

- [ ] **Step 16: Napsat komponenty a App**

`prototype/src/components/StartScreen.tsx`:

```tsx
import { open } from '@tauri-apps/plugin-dialog';
import { openFile } from '../player';

const VIDEO = ['mkv', 'mp4', 'm4v', 'webm', 'mov', 'avi', 'ts', 'm2ts', 'y4m'];

export function StartScreen() {
  async function pick() {
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Video', extensions: VIDEO }] });
    if (typeof path === 'string') await openFile(path);
  }
  return (
    <div className="start">
      <div className="start-card glass">
        <div className="title">Kaleido M0 · ověřovací prototyp</div>
        <button className="btn" onClick={pick}>Otevřít soubor</button>
      </div>
    </div>
  );
}
```

`prototype/src/components/Controls.tsx`:

```tsx
import { playerCommand } from '../player';
import { formatTime, type PlayerState } from '../playerState';

export function Controls({ s }: { s: PlayerState }) {
  return (
    <div className="capsule glass controls" data-glass>
      <div className="row">
        <span className="time">{formatTime(s.timePos)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={s.duration || 0}
          step={0.1}
          value={Math.min(s.timePos, s.duration || 0)}
          aria-label="Pozice"
          onChange={(e) => playerCommand({ type: 'seekAbsolute', seconds: Number(e.target.value) })}
        />
        <span className="time">{formatTime(s.duration)}</span>
      </div>
      <div className="row">
        <input
          className="volume"
          type="range"
          min={0}
          max={130}
          value={s.volume}
          aria-label="Hlasitost"
          onChange={(e) => playerCommand({ type: 'setVolume', value: Number(e.target.value) })}
        />
        <span className="spacer" />
        <button
          className="icon-btn play"
          aria-label={s.pause ? 'Přehrát' : 'Pozastavit'}
          onClick={() => playerCommand({ type: 'togglePause' })}
        >
          {s.pause ? '▶' : '❚❚'}
        </button>
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label="Celá obrazovka"
          onClick={() => playerCommand({ type: 'setFullscreen', on: !s.fullscreen })}
        >
          ⛶
        </button>
      </div>
    </div>
  );
}
```

`prototype/src/App.tsx`:

```tsx
import { Controls } from './components/Controls';
import { StartScreen } from './components/StartScreen';
import { TitleBar } from './components/TitleBar';
import { badgeFor } from './playerState';
import { usePlayer } from './usePlayer';

export function App() {
  const s = usePlayer();
  return (
    <div className={s.loaded ? 'app' : 'app idle-bg'}>
      {!s.loaded && <StartScreen />}
      <TitleBar title={s.title || 'Kaleido M0'} badge={badgeFor(s)} />
      {s.loaded && <Controls s={s} />}
    </div>
  );
}
```

Na konec `prototype/src/app.css` připsat:

```css
.controls {
  left: 115px;
  right: 115px;
  bottom: 18px;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  padding: 13px 20px 11px;
  border-radius: var(--k-radius-panel);
  transition: opacity var(--k-motion-fast) ease, translate var(--k-motion-fast) var(--k-ease);
}
.controls .row { display: flex; align-items: center; gap: 10px; }
.controls .spacer { flex: 1; }
.time { font-size: 12px; font-variant-numeric: tabular-nums; opacity: 0.9; white-space: nowrap; }
.seek { flex: 1; accent-color: var(--k-accent); }
.volume { width: 90px; accent-color: var(--k-accent); }
.play { font-size: 18px; width: 30px; height: 30px; }
.badge { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 6px; background: rgba(255, 255, 255, 0.22); }
```

- [ ] **Step 17: Vytvořit `docs/m0/report.md`**

```markdown
# M0 – zpráva z ověřovacího prototypu

Spec: `docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md`, kapitola 5.4.
libmpv: shinchiro `mpv-dev-x86_64-20261011-git-accb7b2821.7z` (mpv `accb7b2821`).

## Prostředí

| Položka | Hodnota |
|---|---|
| Windows (verze, build) | ⏳ |
| GPU | NVIDIA GeForce RTX 5060 Ti; AMD Radeon (integrovaná) |
| Monitory (rozlišení, DPI, HDR) | ⏳ |

## Výsledky

| # | Ověřit | Kritérium | Výsledek | Měření / pozorování | Rozhodnutí |
|---|---|---|---|---|---|
| 1 | průhledné WebView2 nad D3D11 podoknem | bez blikání při změně velikosti a přesunu, 60 fps | ⏳ | | |
| 2 | HDR | HDR10 se zapnutým i vypnutým HDR ve Windows, UI nerozbije HDR | ⏳ | | |
| 3 | přeposílání vstupu | klávesy s modifikátory, myš, kolečko; konzole; menu v obraze | ⏳ | | |
| 4 | fullscreen a DPI | černá clona, přesun mezi monitory s různým DPI | ⏳ | | |
| 5 | shader sklo | oblasti za běhu, ≤ 1 ms GPU ve 4K, sleduje animaci | ⏳ | | |
| 6 | mini přehrávač | podokno synchronně s animací UI | ⏳ | | |
| 7 | thumbfast | `kaleido-mpv.exe` + `thumbfast-render` v React bublině | ⏳ | | |
| 8 | snímek obrazovky | bez rozmazaných oblastí skla | ⏳ | | |

## Další zjištění

## Závěr a doporučení pro M1
```

(⏳ = zatím neověřeno; vyplní se v Task 7–13.)

- [ ] **Step 18: Ruční kontrola bodů 1 a 2**

Run: `cd prototype && npm run tauri dev`
Expected / postup:
1. „Otevřít soubor“ → `sdr-1080p`. Video je vidět pod kapslemi, které jsou poloprůhledné (tónování bez rozmazání). Titulní kapsle ukazuje název a `1080p`.
2. Posuvník, hlasitost a ▶/❚❚ fungují.
3. 10 s rychle měnit velikost okna tažením za rohy a přesouvat ho: zapsat, jestli mezi videem a UI bliká, zůstávají černé nebo bílé okraje nebo video zaostává za oknem.
4. Otevřít `Žluťoučký kůň (zkouška)` → přehraje se.
5. Zapnout HDR ve Windows → `hdr10` → štítek `HDR`, světla výrazně jasnější než bílé UI, UI není vybledlé. Vypnout HDR ve Windows → stejné video je tónově mapované, barvy nejsou vybledlé.
6. Zavřít okno ✕ během přehrávání → aplikace skončí do 2 s. Pak `tasklist | findstr /i kaleido` nic nevypíše.
7. Výsledky zapsat do řádků 1 a 2 v `docs/m0/report.md` (✅ / ❌ + pozorování).

- [ ] **Step 19: Přidat job `prototype` do CI**

Do `.github/workflows/ci.yml` pod `jobs:` připsat:

```yaml
  prototype:
    runs-on: windows-latest
    defaults:
      run:
        working-directory: prototype
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: prototype/package-lock.json
      - run: npm ci
      - run: npm test
      - run: npm run build
      - run: cargo clippy -p kaleido-proto --all-targets -- -D warnings
      - run: cargo test -p kaleido-proto
```

- [ ] **Step 20: Commit**

```bash
git add prototype docs/m0/report.md .github/workflows/ci.yml Cargo.lock
git commit -m "feat(prototype): mpv in a child window under transparent WebView2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Fullscreen s černou clonou a DPI (bod 4)

**Files:**
- Create: `prototype/src/fullscreen.ts`
- Test: `prototype/src/fullscreen.test.ts`
- Modify: `prototype/src/App.tsx` (celý obsah), `prototype/src/app.css` (připsat)

**Interfaces:**
- Consumes: `usePlayer` (`fullscreen`, `osd.w`), `getCurrentWindow().setFullscreen` (oprávnění z Task 6)
- Produces: `createFullscreenController(deps: FullscreenDeps) => (on: boolean) => Promise<void>`, `nextFrame(): Promise<void>`, typ `FullscreenDeps { setCurtain, nextFrame, setWindowFullscreen, waitForResize }`; CSS `.curtain`, `.curtain.on`.

- [ ] **Step 1: Napsat padající test `fullscreen.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createFullscreenController, type FullscreenDeps } from './fullscreen';

function fake(): { log: string[]; deps: FullscreenDeps } {
  const log: string[] = [];
  return {
    log,
    deps: {
      setCurtain: (on) => { log.push(on ? 'curtain:on' : 'curtain:off'); },
      nextFrame: async () => { log.push('frame'); },
      setWindowFullscreen: async (on) => { log.push(`fs:${on}`); },
      waitForResize: async () => { log.push('resize'); },
    },
  };
}

describe('createFullscreenController', () => {
  it('covers the switch with the curtain until mpv has the new size', async () => {
    const { log, deps } = fake();
    await createFullscreenController(deps)(true);
    expect(log).toEqual(['curtain:on', 'frame', 'frame', 'fs:true', 'resize', 'frame', 'curtain:off']);
  });

  it('does nothing when already in the requested mode', async () => {
    const { log, deps } = fake();
    await createFullscreenController(deps)(false);
    expect(log).toEqual([]);
  });

  it('serializes rapid toggles', async () => {
    const { log, deps } = fake();
    const apply = createFullscreenController(deps);
    await Promise.all([apply(true), apply(false)]);
    expect(log.filter((l) => l.startsWith('fs:'))).toEqual(['fs:true', 'fs:false']);
  });
});
```

- [ ] **Step 2: Spustit test a ověřit, že selže**

Run: `cd prototype && npm test -- fullscreen`
Expected: FAIL – modul `./fullscreen` neexistuje.

- [ ] **Step 3: Napsat `fullscreen.ts`**

```ts
export type FullscreenDeps = {
  setCurtain(on: boolean): void;
  nextFrame(): Promise<void>;
  setWindowFullscreen(on: boolean): Promise<void>;
  waitForResize(timeoutMs: number): Promise<void>;
};

/** Keeps a black curtain over the window while it switches mode, until mpv has resized (spec 5.1). */
export function createFullscreenController(deps: FullscreenDeps): (on: boolean) => Promise<void> {
  let current = false;
  let queue = Promise.resolve();
  return (on) => {
    queue = queue.then(async () => {
      if (on === current) return;
      current = on;
      deps.setCurtain(true);
      await deps.nextFrame();
      await deps.nextFrame();
      await deps.setWindowFullscreen(on);
      await deps.waitForResize(400);
      await deps.nextFrame();
      deps.setCurtain(false);
    });
    return queue;
  };
}

export const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
```

- [ ] **Step 4: Spustit test**

Run: `cd prototype && npm test -- fullscreen`
Expected: PASS (3 testy).

- [ ] **Step 5: Zapojit do `App.tsx` a CSS**

`prototype/src/App.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Controls } from './components/Controls';
import { StartScreen } from './components/StartScreen';
import { TitleBar } from './components/TitleBar';
import { createFullscreenController, nextFrame } from './fullscreen';
import { badgeFor } from './playerState';
import { usePlayer } from './usePlayer';

export function App() {
  const s = usePlayer();
  const [curtain, setCurtain] = useState(false);
  const resizeWaiters = useRef<Array<() => void>>([]);

  useEffect(() => {
    resizeWaiters.current.splice(0).forEach((resolve) => resolve());
  }, [s.osd.w, s.osd.h]);

  const applyFullscreen = useMemo(
    () =>
      createFullscreenController({
        setCurtain,
        nextFrame,
        setWindowFullscreen: (on) => getCurrentWindow().setFullscreen(on),
        waitForResize: (ms) =>
          new Promise<void>((resolve) => {
            resizeWaiters.current.push(resolve);
            setTimeout(resolve, ms);
          }),
      }),
    [],
  );

  useEffect(() => {
    void applyFullscreen(s.fullscreen);
  }, [s.fullscreen, applyFullscreen]);

  return (
    <div className={s.loaded ? 'app' : 'app idle-bg'}>
      {!s.loaded && <StartScreen />}
      <TitleBar title={s.title || 'Kaleido M0'} badge={badgeFor(s)} />
      {s.loaded && <Controls s={s} />}
      <div className={curtain ? 'curtain on' : 'curtain'} />
    </div>
  );
}
```

Na konec `app.css`:

```css
.curtain {
  position: fixed;
  inset: 0;
  background: #000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
  z-index: 100;
}
.curtain.on { opacity: 1; transition: none; }
```

- [ ] **Step 6: Ruční kontrola bodu 4**

Run: `cd prototype && npm run tauri dev`
Expected / postup:
1. Přehrávat `sdr-1080p`, tlačítko ⛶ → okno přejde na celou obrazovku. Během přechodu je vidět jen černá, žádný roztažený ani useknutý snímek a žádné bílé blikání. Totéž zpět.
2. 10× rychle za sebou ⛶ → žádné zaseknutí, okno skončí ve správném režimu.
3. Při dvou monitorech s různým měřítkem (např. 100 % a 150 %) přetáhnout okno z jednoho na druhý → video vyplní okno bez mezer.
4. Výsledek zapsat do řádku 4 v `docs/m0/report.md`. Dvojklik a Esc se ověří v Task 9.

- [ ] **Step 7: Commit**

```bash
git add prototype/src
git commit -m "feat(prototype): fullscreen switch behind a black curtain" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Přeposílání klávesnice a myši do mpv (bod 3)

**Files:**
- Create: `prototype/src-tauri/src/input.rs`
- Modify: `prototype/src-tauri/src/commands.rs` (připsat `player_input`), `prototype/src-tauri/src/main.rs` (`mod input;` + handler), `prototype/src-tauri/src/options.rs` (testovací skript)
- Create: `prototype/src-tauri/test-scripts/click-target.lua`
- Create: `prototype/src/input/keys.ts`, `prototype/src/input/mouse.ts`, `prototype/src/input/tracker.ts`, `prototype/src/input/forward.ts`
- Test: `prototype/src/input/keys.test.ts`, `mouse.test.ts`, `tracker.test.ts`, unit testy v `input.rs`
- Modify: `prototype/src/App.tsx`, `prototype/src/components/TitleBar.tsx`, `prototype/src/components/Controls.tsx`, `prototype/src/app.css`

**Interfaces:**
- Consumes: `Engine.mpv` (Task 7), `usePlayer`/`App` (Task 8)
- Produces:
  - Rust: `input::InputEvent::{KeyDown{key}, KeyUp{key}, MouseMove{x,y}, ButtonDown{button}, ButtonUp{button}, Wheel{key}, DoubleClick}` (serde `tag="type"`, camelCase), `input::to_command(&InputEvent) -> Option<Vec<String>>`, příkaz `player_input(ev)`.
  - TS: `toMpvKey(KeyInput) -> string | null`, `createKeyTracker()`, `toSurfacePoint(...)`, `buttonName(n)`, `wheelKey(dx, dy)`, `installKeyboardForwarding(): () => void`, `videoPointerHandlers(getSurface)`, `type SurfaceRect`, `type InputEvent`, konstanta `SEND_EXPLICIT_DOUBLE_CLICK`, `blurAfterPointer`.

- [ ] **Step 1: Napsat `input.rs` s padajícími testy**

```rust
use serde::Deserialize;

/// Input the UI did not handle itself (spec 5.3). Names use mpv's input.conf scheme.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputEvent {
    KeyDown { key: String },
    KeyUp { key: String },
    MouseMove { x: i32, y: i32 },
    ButtonDown { button: String },
    ButtonUp { button: String },
    Wheel { key: String },
    DoubleClick,
}

const BUTTONS: &[&str] = &["MBTN_LEFT", "MBTN_MID", "MBTN_RIGHT", "MBTN_BACK", "MBTN_FORWARD"];
const WHEEL: &[&str] = &["WHEEL_UP", "WHEEL_DOWN", "WHEEL_LEFT", "WHEEL_RIGHT"];

/// One mpv command (argument list) for the event, or None if it is not allowed.
pub fn to_command(event: &InputEvent) -> Option<Vec<String>> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(args: &[&str]) -> Option<Vec<String>> {
        Some(args.iter().map(|a| a.to_string()).collect())
    }

    #[test]
    fn keys_map_to_keydown_and_keyup() {
        assert_eq!(to_command(&InputEvent::KeyDown { key: "Ctrl+a".into() }), cmd(&["keydown", "Ctrl+a"]));
        assert_eq!(to_command(&InputEvent::KeyUp { key: "ě".into() }), cmd(&["keyup", "ě"]));
    }

    #[test]
    fn malformed_key_names_are_rejected() {
        for key in ["", "a b", "\n", "x".repeat(40).as_str()] {
            assert_eq!(to_command(&InputEvent::KeyDown { key: key.into() }), None, "{key:?}");
        }
    }

    #[test]
    fn mouse_moves_and_known_buttons() {
        assert_eq!(to_command(&InputEvent::MouseMove { x: 10, y: 20 }), cmd(&["mouse", "10", "20"]));
        assert_eq!(
            to_command(&InputEvent::ButtonDown { button: "MBTN_LEFT".into() }),
            cmd(&["keydown", "MBTN_LEFT"])
        );
        assert_eq!(to_command(&InputEvent::ButtonUp { button: "MBTN_X".into() }), None);
    }

    #[test]
    fn wheel_and_double_click() {
        assert_eq!(to_command(&InputEvent::Wheel { key: "WHEEL_UP".into() }), cmd(&["keypress", "WHEEL_UP"]));
        assert_eq!(to_command(&InputEvent::Wheel { key: "q".into() }), None);
        assert_eq!(to_command(&InputEvent::DoubleClick), cmd(&["keypress", "MBTN_LEFT_DBL"]));
    }

    #[test]
    fn deserializes_ui_payloads() {
        let ev: InputEvent = serde_json::from_str(r#"{"type":"keyDown","key":"Ctrl+a"}"#).unwrap();
        assert_eq!(ev, InputEvent::KeyDown { key: "Ctrl+a".into() });
        let ev: InputEvent = serde_json::from_str(r#"{"type":"doubleClick"}"#).unwrap();
        assert_eq!(ev, InputEvent::DoubleClick);
    }
}
```

Do `main.rs` přidat `mod input;`.

- [ ] **Step 2: Spustit testy a ověřit, že selžou**

Run: `cargo test -p kaleido-proto input`
Expected: FAIL – `not yet implemented`.

- [ ] **Step 3: Implementovat `to_command`**

Nahradit `todo!()`:

```rust
    let owned = |args: &[&str]| Some(args.iter().map(|a| (*a).to_owned()).collect());
    match event {
        InputEvent::KeyDown { key } if valid_key(key) => owned(&["keydown", key]),
        InputEvent::KeyUp { key } if valid_key(key) => owned(&["keyup", key]),
        InputEvent::MouseMove { x, y } => owned(&["mouse", &x.to_string(), &y.to_string()]),
        InputEvent::ButtonDown { button } if BUTTONS.contains(&button.as_str()) => owned(&["keydown", button]),
        InputEvent::ButtonUp { button } if BUTTONS.contains(&button.as_str()) => owned(&["keyup", button]),
        InputEvent::Wheel { key } if WHEEL.contains(&key.as_str()) => owned(&["keypress", key]),
        InputEvent::DoubleClick => owned(&["keypress", "MBTN_LEFT_DBL"]),
        _ => None,
    }
```

Pod funkci přidat:

```rust
fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.chars().count() <= 32 && !key.chars().any(|c| c.is_whitespace() || c.is_control())
}
```

- [ ] **Step 4: Spustit testy**

Run: `cargo test -p kaleido-proto input`
Expected: PASS (5 testů).

- [ ] **Step 5: Připsat příkaz a zaregistrovat ho**

Na konec `commands.rs`:

```rust
#[tauri::command]
pub fn player_input(engine: State<'_, Arc<Engine>>, ev: crate::input::InputEvent) -> CmdResult {
    let Some(args) = crate::input::to_command(&ev) else {
        return Err(format!("rejected input {ev:?}"));
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    engine.mpv.command(&args).map_err(err)
}
```

V `main.rs` do `generate_handler!` přidat `commands::player_input,`.

- [ ] **Step 6: Testovací skript `test-scripts/click-target.lua` a jeho načtení**

```lua
-- M0 test (spec 5.4 #3): a box drawn into the video that counts clicks inside it.
local assdraw = require 'mp.assdraw'
local box = { x = 40, y = 120, w = 240, h = 90 }
local overlay = mp.create_osd_overlay('ass-events')
local hits = 0

local function render()
    local w, h = mp.get_osd_size()
    if not w or w == 0 then return end
    overlay.res_x, overlay.res_y = w, h
    local a = assdraw.ass_new()
    a:new_event()
    a:append('{\\an7\\bord2\\shad0\\1c&H40B0FF&\\1a&H60&\\3c&HFFFFFF&}')
    a:pos(0, 0)
    a:draw_start()
    a:rect_cw(box.x, box.y, box.x + box.w, box.y + box.h)
    a:draw_stop()
    a:new_event()
    a:append('{\\an7\\fs26\\bord1}')
    a:pos(box.x + 14, box.y + 28)
    a:append('click-target: ' .. hits)
    overlay.data = a.text
    overlay:update()
end

mp.add_forced_key_binding('MBTN_LEFT', 'click-target', function()
    local pos = mp.get_property_native('mouse-pos')
    if pos and pos.x >= box.x and pos.x <= box.x + box.w and pos.y >= box.y and pos.y <= box.y + box.h then
        hits = hits + 1
        mp.commandv('script-message', 'kaleido-test', 'hit', tostring(hits))
        render()
    end
end)

mp.observe_property('osd-dimensions', 'native', render)
```

`prototype/src-tauri/src/options.rs` nahradit celý:

```rust
use std::error::Error;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Files the prototype hands to mpv.
pub struct Paths {
    pub data_dir: PathBuf,
    pub click_target: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> Result<Paths, Box<dyn Error>> {
        let data_dir = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        let click_target = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/test-scripts/click-target.lua"));
        Ok(Paths { data_dir, click_target })
    }
}

/// Set before mpv_initialize. Spec 5.2 subset; `config=no` keeps the user's own mpv config out of M0.
pub fn mpv_options(paths: &Paths) -> Vec<(&'static str, String)> {
    vec![
        ("vo", "gpu-next".into()),
        ("gpu-api", "d3d11".into()),
        ("target-colorspace-hint", "yes".into()),
        ("hwdec", "auto-safe".into()),
        ("keep-open", "yes".into()),
        ("idle", "yes".into()),
        ("force-window", "yes".into()),
        ("osc", "no".into()),
        ("config", "no".into()),
        ("input-default-bindings", "yes".into()),
        ("input-vo-keyboard", "no".into()),
        ("terminal", "no".into()),
        ("log-file", paths.data_dir.join("mpv.log").display().to_string()),
        ("scripts", paths.click_target.display().to_string()),
    ]
}
```

- [ ] **Step 7: Napsat padající testy v TS**

`prototype/src/input/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toMpvKey, type KeyInput } from './keys';

const k = (key: string, o: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...o,
});

describe('toMpvKey', () => {
  it.each([
    [k(' '), 'SPACE'],
    [k(' ', { shiftKey: true }), 'Shift+SPACE'],
    [k('a'), 'a'],
    [k('A', { shiftKey: true }), 'A'],
    [k('a', { ctrlKey: true }), 'Ctrl+a'],
    [k('A', { ctrlKey: true, shiftKey: true }), 'Ctrl+A'],
    [k('ArrowLeft', { shiftKey: true }), 'Shift+LEFT'],
    [k('#', { shiftKey: true }), 'SHARP'],
    [k('?', { shiftKey: true }), '?'],
    [k('ě'), 'ě'],
    [k('€', { ctrlKey: true, altKey: true, altGraph: true }), '€'],
    [k('+', { code: 'NumpadAdd' }), 'KP_ADD'],
    [k('7', { code: 'Numpad7' }), 'KP7'],
    [k('F5'), 'F5'],
    [k('Escape'), 'ESC'],
    [k('MediaPlayPause'), 'PLAYPAUSE'],
  ])('%o → %s', (input, expected) => expect(toMpvKey(input)).toBe(expected));

  it.each(['Control', 'Shift', 'AltGraph', 'Dead', 'Unidentified'])('ignores %s', (key) =>
    expect(toMpvKey(k(key))).toBeNull(),
  );
});
```

`prototype/src/input/tracker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createKeyTracker } from './tracker';

describe('createKeyTracker', () => {
  it('releases with the name used on press even if Ctrl went up first', () => {
    const t = createKeyTracker();
    expect(t.down('KeyA', 'Ctrl+a')).toBe(true);
    expect(t.up('KeyA')).toBe('Ctrl+a');
    expect(t.up('KeyA')).toBeNull();
  });

  it('ignores a second press of a held key', () => {
    const t = createKeyTracker();
    t.down('ArrowRight', 'RIGHT');
    expect(t.down('ArrowRight', 'RIGHT')).toBe(false);
  });

  it('releases everything on focus loss', () => {
    const t = createKeyTracker();
    t.down('ArrowRight', 'RIGHT');
    t.down('KeyZ', 'z');
    expect(t.releaseAll().sort()).toEqual(['RIGHT', 'z']);
    expect(t.releaseAll()).toEqual([]);
  });
});
```

`prototype/src/input/mouse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buttonName, toSurfacePoint, wheelKey } from './mouse';

const surface = { left: 10, top: 10, width: 200, height: 100 };

describe('toSurfacePoint', () => {
  it('converts CSS client coordinates to physical surface pixels', () => {
    expect(toSurfacePoint(110, 60, surface, 1.5)).toEqual({ x: 150, y: 75 });
  });
  it('is null outside the surface', () => {
    expect(toSurfacePoint(5, 60, surface, 1)).toBeNull();
    expect(toSurfacePoint(210, 60, surface, 1)).toBeNull();
  });
});

describe('buttonName', () => {
  it.each([[0, 'MBTN_LEFT'], [1, 'MBTN_MID'], [2, 'MBTN_RIGHT'], [3, 'MBTN_BACK'], [4, 'MBTN_FORWARD'], [7, null]])(
    '%i → %s',
    (n, name) => expect(buttonName(n)).toBe(name),
  );
});

describe('wheelKey', () => {
  it.each([
    [0, -100, 'WHEEL_UP'],
    [0, 50, 'WHEEL_DOWN'],
    [-30, 5, 'WHEEL_LEFT'],
    [30, 0, 'WHEEL_RIGHT'],
    [0, 0, null],
  ])('(%i, %i) → %s', (dx, dy, key) => expect(wheelKey(dx, dy)).toBe(key));
});
```

- [ ] **Step 8: Spustit testy a ověřit, že selžou**

Run: `cd prototype && npm test -- input`
Expected: FAIL – moduly `keys`, `tracker`, `mouse` neexistují.

- [ ] **Step 9: Napsat `keys.ts`, `tracker.ts`, `mouse.ts`**

`prototype/src/input/keys.ts`:

```ts
export type KeyInput = {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altGraph?: boolean;
};

const NAMED: Record<string, string> = {
  ' ': 'SPACE', Enter: 'ENTER', Escape: 'ESC', Tab: 'TAB', Backspace: 'BS', Delete: 'DEL', Insert: 'INS',
  Home: 'HOME', End: 'END', PageUp: 'PGUP', PageDown: 'PGDWN',
  ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ArrowUp: 'UP', ArrowDown: 'DOWN',
  PrintScreen: 'PRINT', ContextMenu: 'MENU',
  MediaPlayPause: 'PLAYPAUSE', MediaStop: 'STOP', MediaTrackNext: 'NEXT', MediaTrackPrevious: 'PREV',
  AudioVolumeUp: 'VOLUME_UP', AudioVolumeDown: 'VOLUME_DOWN', AudioVolumeMute: 'MUTE',
};

const NUMPAD: Record<string, string> = {
  NumpadDecimal: 'KP_DEC', NumpadEnter: 'KP_ENTER', NumpadAdd: 'KP_ADD',
  NumpadSubtract: 'KP_SUBTRACT', NumpadMultiply: 'KP_MULTIPLY', NumpadDivide: 'KP_DIVIDE',
};

const SYMBOLS: Record<string, string> = { '#': 'SHARP' };

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn']);

/** DOM keyboard event → mpv input.conf key name; null when mpv should not get it (spec 5.3). */
export function toMpvKey(e: KeyInput): string | null {
  if (MODIFIERS.has(e.key)) return null;
  let base: string | null = null;
  let printable = false;
  if (/^Numpad\d$/.test(e.code) && /^\d$/.test(e.key)) base = `KP${e.code.slice(6)}`;
  else if (NUMPAD[e.code]) base = NUMPAD[e.code];
  else if (NAMED[e.key]) base = NAMED[e.key];
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.key)) base = e.key;
  else if ([...e.key].length === 1) {
    base = SYMBOLS[e.key] ?? e.key;
    printable = true;
  }
  if (!base) return null;
  // AltGr arrives as Ctrl+Alt on Windows; the produced character already reflects it.
  const altGr = e.altGraph === true;
  let mods = '';
  if (e.ctrlKey && !altGr) mods += 'Ctrl+';
  if (e.altKey && !altGr) mods += 'Alt+';
  // For printable keys Shift is already in the character ("?" not "Shift+/").
  if (e.shiftKey && !printable) mods += 'Shift+';
  if (e.metaKey) mods += 'Meta+';
  return mods + base;
}
```

`prototype/src/input/tracker.ts`:

```ts
/** Remembers the mpv name sent for each physical key so keyup always matches keydown. */
export function createKeyTracker() {
  const held = new Map<string, string>();
  return {
    down(code: string, key: string): boolean {
      if (held.has(code)) return false;
      held.set(code, key);
      return true;
    },
    up(code: string): string | null {
      const key = held.get(code) ?? null;
      held.delete(code);
      return key;
    },
    releaseAll(): string[] {
      const keys = [...held.values()];
      held.clear();
      return keys;
    },
  };
}
```

`prototype/src/input/mouse.ts`:

```ts
export type Point = { x: number; y: number };
export type SurfaceRect = { left: number; top: number; width: number; height: number };

/** CSS client coordinates → mpv window pixels; null outside the video surface. */
export function toSurfacePoint(clientX: number, clientY: number, surface: SurfaceRect, dpr: number): Point | null {
  const x = clientX - surface.left;
  const y = clientY - surface.top;
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return null;
  return { x: Math.round(x * dpr), y: Math.round(y * dpr) };
}

const BUTTONS = ['MBTN_LEFT', 'MBTN_MID', 'MBTN_RIGHT', 'MBTN_BACK', 'MBTN_FORWARD'];

export function buttonName(button: number): string | null {
  return BUTTONS[button] ?? null;
}

export function wheelKey(deltaX: number, deltaY: number): string | null {
  if (Math.abs(deltaY) >= Math.abs(deltaX)) {
    if (deltaY < 0) return 'WHEEL_UP';
    if (deltaY > 0) return 'WHEEL_DOWN';
    return null;
  }
  return deltaX < 0 ? 'WHEEL_LEFT' : 'WHEEL_RIGHT';
}
```

- [ ] **Step 10: Spustit testy**

Run: `cd prototype && npm test -- input`
Expected: PASS (keys 21, tracker 3, mouse 13).

- [ ] **Step 11: Napsat `forward.ts`**

```ts
import { invoke } from '@tauri-apps/api/core';
import type { MouseEvent, PointerEvent, WheelEvent } from 'react';
import { toMpvKey } from './keys';
import { buttonName, toSurfacePoint, wheelKey, type SurfaceRect } from './mouse';
import { createKeyTracker } from './tracker';

export type InputEvent =
  | { type: 'keyDown'; key: string }
  | { type: 'keyUp'; key: string }
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'buttonDown'; button: string }
  | { type: 'buttonUp'; button: string }
  | { type: 'wheel'; key: string }
  | { type: 'doubleClick' };

/** Flip to true if mpv does not synthesize MBTN_LEFT_DBL from keydown/keyup (report row 3). */
export const SEND_EXPLICIT_DOUBLE_CLICK = false;

const send = (ev: InputEvent) => {
  invoke('player_input', { ev }).catch((e) => console.warn('player_input', e));
};

const INTERACTIVE = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']);
const ownsKeyboard = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || INTERACTIVE.has(t.tagName));

/** Keys go to mpv unless a UI handler called preventDefault or focus is in a UI control. */
export function installKeyboardForwarding(): () => void {
  const tracker = createKeyTracker();
  const onDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || ownsKeyboard(e.target)) return;
    const key = toMpvKey({
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      altGraph: e.getModifierState('AltGraph'),
    });
    if (!key) return;
    e.preventDefault();
    // Auto-repeat is mpv's job: it repeats a held keydown until keyup.
    if (tracker.down(e.code || e.key, key)) send({ type: 'keyDown', key });
  };
  const onUp = (e: KeyboardEvent) => {
    const key = tracker.up(e.code || e.key);
    if (!key) return;
    e.preventDefault();
    send({ type: 'keyUp', key });
  };
  const onBlur = () => tracker.releaseAll().forEach((key) => send({ type: 'keyUp', key }));
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  window.addEventListener('blur', onBlur);
  return () => {
    onBlur();
    window.removeEventListener('keydown', onDown);
    window.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', onBlur);
  };
}

/** Pointer handlers for the layer that covers the video under the controls. */
export function videoPointerHandlers(getSurface: () => SurfaceRect) {
  let pending: { x: number; y: number } | null = null;
  let scheduled = false;
  const point = (e: { clientX: number; clientY: number }) =>
    toSurfacePoint(e.clientX, e.clientY, getSurface(), window.devicePixelRatio);
  return {
    onPointerMove(e: PointerEvent) {
      pending = point(e);
      if (!pending || scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (pending) send({ type: 'mouseMove', ...pending });
      });
    },
    onPointerDown(e: PointerEvent) {
      const p = point(e);
      const button = buttonName(e.button);
      if (!p || !button) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      send({ type: 'mouseMove', ...p });
      send({ type: 'buttonDown', button });
      if (SEND_EXPLICIT_DOUBLE_CLICK && e.detail === 2 && button === 'MBTN_LEFT') send({ type: 'doubleClick' });
    },
    onPointerUp(e: PointerEvent) {
      const button = buttonName(e.button);
      if (button) send({ type: 'buttonUp', button });
    },
    onWheel(e: WheelEvent) {
      const key = wheelKey(e.deltaX, e.deltaY);
      if (key) send({ type: 'wheel', key });
    },
    onContextMenu(e: MouseEvent) {
      e.preventDefault();
    },
  };
}

/** UI buttons and sliders give keyboard focus back after a click, so Space/arrows reach mpv. */
export const blurAfterPointer = {
  onPointerUp: (e: PointerEvent<HTMLElement>) => e.currentTarget.blur(),
};
```

- [ ] **Step 12: Zapojit do UI**

`prototype/src/App.tsx` nahradit celý:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Controls } from './components/Controls';
import { StartScreen } from './components/StartScreen';
import { TitleBar } from './components/TitleBar';
import { createFullscreenController, nextFrame } from './fullscreen';
import { installKeyboardForwarding, videoPointerHandlers } from './input/forward';
import { badgeFor } from './playerState';
import { usePlayer } from './usePlayer';

export function App() {
  const s = usePlayer();
  const [curtain, setCurtain] = useState(false);
  const resizeWaiters = useRef<Array<() => void>>([]);

  useEffect(() => installKeyboardForwarding(), []);

  useEffect(() => {
    resizeWaiters.current.splice(0).forEach((resolve) => resolve());
  }, [s.osd.w, s.osd.h]);

  const applyFullscreen = useMemo(
    () =>
      createFullscreenController({
        setCurtain,
        nextFrame,
        setWindowFullscreen: (on) => getCurrentWindow().setFullscreen(on),
        waitForResize: (ms) =>
          new Promise<void>((resolve) => {
            resizeWaiters.current.push(resolve);
            setTimeout(resolve, ms);
          }),
      }),
    [],
  );

  useEffect(() => {
    void applyFullscreen(s.fullscreen);
  }, [s.fullscreen, applyFullscreen]);

  const pointer = useMemo(
    () => videoPointerHandlers(() => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight })),
    [],
  );

  return (
    <div className={s.loaded ? 'app' : 'app idle-bg'}>
      {s.loaded && <div className="video-catcher" {...pointer} />}
      {!s.loaded && <StartScreen />}
      <TitleBar title={s.title || 'Kaleido M0'} badge={badgeFor(s)} />
      {s.loaded && <Controls s={s} />}
      <div className={curtain ? 'curtain on' : 'curtain'} />
    </div>
  );
}
```

`prototype/src/components/TitleBar.tsx` nahradit celý:

```tsx
import { getCurrentWindow } from '@tauri-apps/api/window';
import { blurAfterPointer } from '../input/forward';

export function TitleBar({ title, badge }: { title: string; badge?: string }) {
  const win = getCurrentWindow();
  return (
    <>
      <div className="capsule glass titlebar-left" data-tauri-drag-region data-glass>
        <span className="dot" data-tauri-drag-region />
        <span className="title" data-tauri-drag-region>{title}</span>
        {badge && <span className="badge">{badge}</span>}
      </div>
      <div className="capsule glass titlebar-right" data-glass>
        <button className="icon-btn" aria-label="Minimalizovat" onClick={() => win.minimize()} {...blurAfterPointer}>–</button>
        <button className="icon-btn" aria-label="Maximalizovat" onClick={() => win.toggleMaximize()} {...blurAfterPointer}>□</button>
        <button className="icon-btn" aria-label="Zavřít" onClick={() => win.close()} {...blurAfterPointer}>✕</button>
      </div>
    </>
  );
}
```

`prototype/src/components/Controls.tsx` nahradit celý:

```tsx
import { blurAfterPointer } from '../input/forward';
import { playerCommand } from '../player';
import { formatTime, type PlayerState } from '../playerState';

export function Controls({ s }: { s: PlayerState }) {
  return (
    <div className="capsule glass controls" data-glass>
      <div className="row">
        <span className="time">{formatTime(s.timePos)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={s.duration || 0}
          step={0.1}
          value={Math.min(s.timePos, s.duration || 0)}
          aria-label="Pozice"
          onChange={(e) => playerCommand({ type: 'seekAbsolute', seconds: Number(e.target.value) })}
          {...blurAfterPointer}
        />
        <span className="time">{formatTime(s.duration)}</span>
      </div>
      <div className="row">
        <input
          className="volume"
          type="range"
          min={0}
          max={130}
          value={s.volume}
          aria-label="Hlasitost"
          onChange={(e) => playerCommand({ type: 'setVolume', value: Number(e.target.value) })}
          {...blurAfterPointer}
        />
        <span className="spacer" />
        <button
          className="icon-btn play"
          aria-label={s.pause ? 'Přehrát' : 'Pozastavit'}
          onClick={() => playerCommand({ type: 'togglePause' })}
          {...blurAfterPointer}
        >
          {s.pause ? '▶' : '❚❚'}
        </button>
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label="Celá obrazovka"
          onClick={() => playerCommand({ type: 'setFullscreen', on: !s.fullscreen })}
          {...blurAfterPointer}
        >
          ⛶
        </button>
      </div>
    </div>
  );
}
```

Na konec `app.css`:

```css
.video-catcher { position: absolute; inset: 0; }
```

- [ ] **Step 13: Ruční kontrola bodu 3**

Run: `cd prototype && npm run tauri dev`, otevřít `sdr-1080p`.
Expected / postup:
1. Mezerník pozastaví a spustí video. Šipky přetáčejí; podržená šipka přetáčí plynule a po puštění přestane.
2. Ctrl+šipka (podle výchozích vazeb mpv) funguje. Pustit Ctrl dřív než šipku → přetáčení se nezasekne.
3. Klávesou, která na tvé klávesnici píše `` ` ``, se otevře konzole mpv (`commands/open`). Napsat `show-text ahoj ěščř` + Enter → zobrazí se text s diakritikou. Esc konzoli zavře.
4. Klik do modrého rámečku `click-target` vlevo nahoře ve videu → počítadlo se zvýší. Klik mimo rámeček ho nezvýší. Zopakovat při měřítku Windows 150 %.
5. Kolečko myši vyvolá akci výchozí vazby mpv (posun nebo hlasitost).
6. Dvojklik do videa → fullscreen se přepne **právě jednou**. Když se nic nestane, nastavit `SEND_EXPLICIT_DOUBLE_CLICK = true` a zopakovat. Esc fullscreen ukončí.
7. Kliknout na ▶ a pak stisknout mezerník → přepne se pauza jen jednou, ne dvakrát.
8. Výsledek zapsat do řádku 3 v `docs/m0/report.md`, včetně hodnoty `SEND_EXPLICIT_DOUBLE_CLICK`.

- [ ] **Step 14: Commit**

```bash
git add prototype
git commit -m "feat(prototype): forward unhandled keyboard and mouse input to mpv" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Shader sklo nad videem a snímek obrazovky (body 5 a 8)

**Files:**
- Create: `prototype/src-tauri/src/glass.rs`
- Modify: `prototype/src-tauri/src/engine.rs` (celý obsah), `src/options.rs`, `src/commands.rs` (připsat), `src/main.rs` (`mod glass;` + handler)
- Create: `prototype/src/glass/regions.ts`, `prototype/src/glass/useGlassRegions.ts`, `prototype/src/useIdle.ts`
- Test: `prototype/src/glass/regions.test.ts`, unit testy v `glass.rs`
- Modify: `prototype/src/App.tsx`, `prototype/src/components/TitleBar.tsx`, `prototype/src/components/Controls.tsx`, `prototype/src/app.css`

**Interfaces:**
- Consumes: `Engine`, `run_events`, `on_client_message` (Task 7), `Paths` (Task 7/9), atributy `data-glass` (Task 6/7)
- Produces:
  - Rust: `glass::{MAX_REGIONS: usize = 6, GlassRect{x,y,w,h,r,a}, OutputOrigin{x,y}, OUTPUT_EXCLUDES_MARGINS: bool, shader_opts(&[GlassRect], f64, OutputOrigin) -> String, shader_source() -> String}`; `Engine::set_glass(Vec<GlassRect>, f64) -> mpv_ffi::Result<()>`; příkaz `glass_set_regions(rects)`; klávesa `s` = snímek bez skla.
  - TS: `GlassRect`, `MAX_REGIONS`, `measure(el, style) -> GlassRect | null`, `sameRects(a, b)`, `useGlassRegions(enabled: boolean)`, `useIdle(ms): boolean`.

- [ ] **Step 1: Napsat `glass.rs` s padajícími testy**

```rust
use serde::Deserialize;

/// Regions the shader can blur at once (spec 8.2).
pub const MAX_REGIONS: usize = 6;
/// Shader file stem; also the prefix that targets only our params in glsl-shader-opts.
pub const SHADER: &str = "kaleido-glass";
/// Whether libplacebo's OUTPUT texture starts at the video rectangle (inside letterbox
/// bars) instead of the window origin. Verified on `letterbox` media in Step 8.
pub const OUTPUT_EXCLUDES_MARGINS: bool = true;

const FIELDS: [&str; 6] = ["x", "y", "w", "h", "r", "a"];

/// Glass element as measured by the UI: CSS px in window coordinates, radius, opacity.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct GlassRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub r: f64,
    pub a: f64,
}

/// Window position (physical px) of the OUTPUT texture's top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct OutputOrigin {
    pub x: f64,
    pub y: f64,
}

/// Value for mpv's `glsl-shader-opts`. Always sets every region so stale ones are cleared.
pub fn shader_opts(rects: &[GlassRect], scale: f64, origin: OutputOrigin) -> String {
    todo!()
}

/// GLSL user shader (libplacebo syntax): downsampled separable blur + rounded-rect mask.
pub fn shader_source() -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64, r: f64) -> GlassRect {
        GlassRect { x, y, w, h, r, a: 1.0 }
    }

    #[test]
    fn no_rects_disables_every_region() {
        let opts = shader_opts(&[], 1.0, OutputOrigin::default());
        assert!(opts.starts_with("kaleido-glass/count=0,"), "{opts}");
        assert!(opts.contains("kaleido-glass/r5w=0.0"), "{opts}");
    }

    #[test]
    fn rects_are_scaled_offset_and_radius_clamped() {
        let opts = shader_opts(&[rect(10.0, 20.0, 100.0, 40.0, 999.0)], 1.5, OutputOrigin { x: 0.0, y: 30.0 });
        for part in ["count=1", "r0x=15.0", "r0y=0.0", "r0w=150.0", "r0h=60.0", "r0r=30.0", "r0a=1.00"] {
            assert!(opts.contains(&format!("kaleido-glass/{part}")), "{part} missing in {opts}");
        }
    }

    #[test]
    fn regions_beyond_the_limit_are_dropped() {
        let many = vec![rect(0.0, 0.0, 10.0, 10.0, 0.0); 9];
        let opts = shader_opts(&many, 1.0, OutputOrigin::default());
        assert!(opts.contains("kaleido-glass/count=6"));
        assert!(!opts.contains("r6x"));
    }

    #[test]
    fn shader_declares_every_param_and_three_passes() {
        let src = shader_source();
        assert_eq!(src.matches("//!PARAM ").count(), 1 + MAX_REGIONS * FIELDS.len());
        assert!(src.contains("//!PARAM r5a"));
        assert_eq!(src.matches("//!HOOK OUTPUT").count(), 3);
        assert_eq!(src.matches("//!WHEN count 0 >").count(), 3);
    }
}
```

Do `main.rs` přidat `mod glass;`.

- [ ] **Step 2: Spustit testy a ověřit, že selžou**

Run: `cargo test -p kaleido-proto glass`
Expected: FAIL – `not yet implemented`.

- [ ] **Step 3: Implementovat `shader_opts` a `shader_source`**

Tělo `shader_opts`:

```rust
    let count = rects.len().min(MAX_REGIONS);
    let mut parts = vec![format!("{SHADER}/count={count}")];
    for i in 0..MAX_REGIONS {
        let [x, y, w, h, r, a] = match rects.get(i) {
            Some(g) => {
                let (w, h) = (g.w * scale, g.h * scale);
                [
                    g.x * scale - origin.x,
                    g.y * scale - origin.y,
                    w,
                    h,
                    (g.r * scale).min(w.min(h) / 2.0),
                    g.a.clamp(0.0, 1.0),
                ]
            }
            None => [0.0; 6],
        };
        parts.push(format!(
            "{SHADER}/r{i}x={x:.1},{SHADER}/r{i}y={y:.1},{SHADER}/r{i}w={w:.1},{SHADER}/r{i}h={h:.1},{SHADER}/r{i}r={r:.1},{SHADER}/r{i}a={a:.2}"
        ));
    }
    parts.join(",")
```

Tělo `shader_source`:

```rust
    let mut src = String::from("// Generated by kaleido-proto (src/glass.rs). Blur under glass UI, spec 8.2.\n\n");
    src += &format!("//!PARAM count\n//!TYPE DYNAMIC int\n//!MINIMUM 0\n//!MAXIMUM {MAX_REGIONS}\n0\n\n");
    for i in 0..MAX_REGIONS {
        for field in FIELDS {
            src += &format!("//!PARAM r{i}{field}\n//!TYPE DYNAMIC float\n0.0\n\n");
        }
    }
    src += BLUR_PASSES;
    let mut regions = String::new();
    for i in 0..MAX_REGIONS {
        regions += &format!("    m = max(m, region(p, r{i}x, r{i}y, r{i}w, r{i}h, r{i}r) * r{i}a);\n");
    }
    src += &COMPOSITE_PASS.replace("{regions}", &regions);
    src
```

Pod funkce (nad `#[cfg(test)]`) přidat konstanty:

```rust
/// Horizontal then vertical 13-tap Gaussian on a quarter-resolution copy of OUTPUT.
const BLUR_PASSES: &str = r#"//!HOOK OUTPUT
//!BIND HOOKED
//!SAVE KGLASS_H
//!WIDTH HOOKED.w 4 /
//!HEIGHT HOOKED.h 4 /
//!WHEN count 0 >
//!DESC kaleido-glass blur H
vec4 hook() {
    vec4 c = vec4(0.0);
    float total = 0.0;
    for (int i = -6; i <= 6; i++) {
        float w = exp(-float(i * i) / 18.0);
        c += w * HOOKED_tex(HOOKED_pos + vec2(float(i) * 4.0 * HOOKED_pt.x, 0.0));
        total += w;
    }
    return c / total;
}

//!HOOK OUTPUT
//!BIND KGLASS_H
//!SAVE KGLASS_V
//!WIDTH KGLASS_H.w
//!HEIGHT KGLASS_H.h
//!WHEN count 0 >
//!DESC kaleido-glass blur V
vec4 hook() {
    vec4 c = vec4(0.0);
    float total = 0.0;
    for (int i = -6; i <= 6; i++) {
        float w = exp(-float(i * i) / 18.0);
        c += w * KGLASS_H_tex(KGLASS_H_pos + vec2(0.0, float(i) * KGLASS_H_pt.y));
        total += w;
    }
    return c / total;
}

"#;

/// Mixes the blurred copy back in, masked by antialiased rounded rectangles.
const COMPOSITE_PASS: &str = r#"//!HOOK OUTPUT
//!BIND HOOKED
//!BIND KGLASS_V
//!WHEN count 0 >
//!DESC kaleido-glass composite
float region(vec2 p, float x, float y, float w, float h, float r) {
    if (w <= 0.0 || h <= 0.0) return 0.0;
    vec2 half_size = vec2(w, h) * 0.5;
    vec2 q = abs(p - vec2(x, y) - half_size) - half_size + vec2(r);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    return 1.0 - smoothstep(-0.75, 0.75, d);
}

vec4 hook() {
    vec4 base = HOOKED_tex(HOOKED_pos);
    vec2 p = HOOKED_pos * HOOKED_size;
    float m = 0.0;
{regions}    return mix(base, KGLASS_V_tex(HOOKED_pos), clamp(m, 0.0, 1.0));
}
"#;
```

- [ ] **Step 4: Spustit testy**

Run: `cargo test -p kaleido-proto glass`
Expected: PASS (4 testy).

- [ ] **Step 5: Zapsat shader při startu a načíst ho v mpv**

`prototype/src-tauri/src/options.rs` nahradit celý:

```rust
use std::error::Error;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::glass;

/// Files the prototype hands to mpv.
pub struct Paths {
    pub data_dir: PathBuf,
    pub click_target: PathBuf,
    pub shader: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> Result<Paths, Box<dyn Error>> {
        let data_dir = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        let click_target = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/test-scripts/click-target.lua"));
        // The file stem is the shader name that glsl-shader-opts prefixes target.
        let shader = data_dir.join(format!("{}.glsl", glass::SHADER));
        std::fs::write(&shader, glass::shader_source())?;
        Ok(Paths { data_dir, click_target, shader })
    }
}

/// Set before mpv_initialize. Spec 5.2 subset; `config=no` keeps the user's own mpv config out of M0.
pub fn mpv_options(paths: &Paths) -> Vec<(&'static str, String)> {
    vec![
        ("vo", "gpu-next".into()),
        ("gpu-api", "d3d11".into()),
        ("target-colorspace-hint", "yes".into()),
        ("hwdec", "auto-safe".into()),
        ("keep-open", "yes".into()),
        ("idle", "yes".into()),
        ("force-window", "yes".into()),
        ("osc", "no".into()),
        ("config", "no".into()),
        ("input-default-bindings", "yes".into()),
        ("input-vo-keyboard", "no".into()),
        ("terminal", "no".into()),
        ("log-file", paths.data_dir.join("mpv.log").display().to_string()),
        ("scripts", paths.click_target.display().to_string()),
        ("glsl-shaders", paths.shader.display().to_string()),
        ("screenshot-dir", "~~desktop/".into()),
    ]
}
```

- [ ] **Step 6: Přepsat `engine.rs` (sklo + snímek bez skla)**

Celý soubor nahradit:

```rust
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use mpv_ffi::{Event, Mpv, PropertyKind, PropertyValue, load_api, locate_libmpv};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

use crate::glass::{self, GlassRect, OutputOrigin};

/// Properties the UI renders (M0 subset of spec 4.4 `player:state`).
const OBSERVED: &[(&str, PropertyKind)] = &[
    ("pause", PropertyKind::Flag),
    ("time-pos", PropertyKind::Double),
    ("duration", PropertyKind::Double),
    ("volume", PropertyKind::Double),
    ("fullscreen", PropertyKind::Flag),
    ("media-title", PropertyKind::String),
    ("video-params/gamma", PropertyKind::String),
    ("video-params/h", PropertyKind::Int64),
    ("osd-dimensions/w", PropertyKind::Int64),
    ("osd-dimensions/h", PropertyKind::Int64),
    ("osd-dimensions/ml", PropertyKind::Int64),
    ("osd-dimensions/mt", PropertyKind::Int64),
];

const TIME_POS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Default)]
struct GlassState {
    rects: Vec<GlassRect>,
    scale: f64,
    origin: OutputOrigin,
}

pub struct Engine {
    pub mpv: Mpv,
    glass: Mutex<GlassState>,
}

#[derive(Clone, Serialize)]
struct Prop {
    name: String,
    value: Value,
}

pub fn to_json(value: &PropertyValue) -> Value {
    match value {
        PropertyValue::Unavailable => Value::Null,
        PropertyValue::Flag(b) => json!(b),
        PropertyValue::Int64(i) => json!(i),
        PropertyValue::Double(d) => json!(d),
        PropertyValue::String(s) => json!(s),
    }
}

impl Engine {
    pub fn start(app: AppHandle, wid: isize, options: &[(&str, String)]) -> mpv_ffi::Result<Arc<Engine>> {
        let mpv = Mpv::create(load_api(&locate_libmpv())?)?;
        mpv.set_option("wid", &wid.to_string())?;
        for (name, value) in options {
            mpv.set_option(name, value)?;
        }
        mpv.initialize()?;
        for (id, (name, kind)) in OBSERVED.iter().enumerate() {
            mpv.observe(id as u64, name, *kind)?;
        }
        mpv.request_log_messages("warn")?;
        // `s` = screenshot with the glass regions removed first (spec 5.4 #8); `S` stays mpv's default.
        mpv.command(&["keybind", "s", "script-message kaleido screenshot"])?;
        let engine = Arc::new(Engine {
            mpv,
            glass: Mutex::new(GlassState { scale: 1.0, ..GlassState::default() }),
        });
        let pump = Arc::clone(&engine);
        thread::Builder::new()
            .name("mpv-events".into())
            .spawn(move || pump.run_events(&app))
            .expect("spawn mpv event thread");
        Ok(engine)
    }

    pub fn set_glass(&self, rects: Vec<GlassRect>, scale: f64) -> mpv_ffi::Result<()> {
        let mut glass = self.glass.lock().unwrap();
        glass.rects = rects;
        glass.scale = scale;
        self.apply_glass(&glass)
    }

    fn apply_glass(&self, glass: &GlassState) -> mpv_ffi::Result<()> {
        let opts = glass::shader_opts(&glass.rects, glass.scale, glass.origin);
        self.mpv.set_property("glsl-shader-opts", &opts)
    }

    fn on_output_margin(&self, name: &str, value: &PropertyValue) {
        if !glass::OUTPUT_EXCLUDES_MARGINS {
            return;
        }
        let PropertyValue::Int64(px) = value else { return };
        let mut glass = self.glass.lock().unwrap();
        match name {
            "osd-dimensions/ml" => glass.origin.x = *px as f64,
            "osd-dimensions/mt" => glass.origin.y = *px as f64,
            _ => return,
        }
        let _ = self.apply_glass(&glass);
    }

    fn screenshot_without_glass(&self) {
        let glass = self.glass.lock().unwrap();
        let _ = self.mpv.set_property("glsl-shader-opts", &glass::shader_opts(&[], 1.0, OutputOrigin::default()));
        let _ = self.mpv.command(&["screenshot"]);
        let _ = self.apply_glass(&glass);
    }

    fn run_events(&self, app: &AppHandle) {
        let mut last_time_pos = Instant::now();
        loop {
            match self.mpv.wait_event(-1.0) {
                // mpv's `quit` (q, window close) ends the app (spec 5.1).
                Event::Shutdown => {
                    app.exit(0);
                    return;
                }
                Event::PropertyChange { name, value, .. } => {
                    if name == "time-pos" {
                        if last_time_pos.elapsed() < TIME_POS_INTERVAL {
                            continue;
                        }
                        last_time_pos = Instant::now();
                    }
                    if name.starts_with("osd-dimensions/m") {
                        self.on_output_margin(&name, &value);
                    }
                    let _ = app.emit("player:prop", Prop { value: to_json(&value), name });
                }
                Event::FileLoaded => {
                    let _ = app.emit("player:file-loaded", ());
                }
                Event::EndFile { reason } => {
                    let _ = app.emit("player:end-file", format!("{reason:?}"));
                }
                Event::LogMessage { prefix, level, text } => {
                    let _ = app.emit("player:log", format!("[{prefix}] {level}: {text}"));
                }
                Event::ClientMessage { args } => self.on_client_message(app, args),
                _ => {}
            }
        }
    }

    fn on_client_message(&self, app: &AppHandle, args: Vec<String>) {
        match args.as_slice() {
            [target, action] if target == "kaleido" && action == "screenshot" => self.screenshot_without_glass(),
            _ => {
                let _ = app.emit("player:message", args);
            }
        }
    }
}
```

- [ ] **Step 7: Příkaz `glass_set_regions`**

Na konec `commands.rs`:

```rust
#[tauri::command]
pub fn glass_set_regions(
    window: tauri::WebviewWindow,
    engine: State<'_, Arc<Engine>>,
    rects: Vec<crate::glass::GlassRect>,
) -> CmdResult {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    engine.set_glass(rects, scale).map_err(err)
}
```

V `main.rs` do `generate_handler!` přidat `commands::glass_set_regions,`.

Run: `cargo test -p kaleido-proto && cargo clippy -p kaleido-proto -- -D warnings`
Expected: PASS, bez varování.

- [ ] **Step 8: Napsat padající test `glass/regions.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { measure, sameRects } from './regions';

const el = (x: number, y: number, width: number, height: number) => ({
  getBoundingClientRect: () => ({ x, y, width, height }),
});

describe('measure', () => {
  it('measures a visible capsule with its radius clamped to half the height', () => {
    expect(measure(el(10, 20, 300, 40), { borderTopLeftRadius: '999px', opacity: '1' })).toEqual({
      x: 10, y: 20, w: 300, h: 40, r: 20, a: 1,
    });
  });

  it('passes a fading opacity through as alpha', () => {
    expect(measure(el(0, 0, 100, 50), { borderTopLeftRadius: '24px', opacity: '0.4' })?.a).toBeCloseTo(0.4);
  });

  it('skips invisible and empty elements', () => {
    expect(measure(el(0, 0, 100, 50), { borderTopLeftRadius: '0px', opacity: '0' })).toBeNull();
    expect(measure(el(0, 0, 0, 50), { borderTopLeftRadius: '0px', opacity: '1' })).toBeNull();
  });
});

describe('sameRects', () => {
  const a = [{ x: 10, y: 10, w: 100, h: 40, r: 20, a: 1 }];
  it('treats sub-pixel jitter as unchanged', () => expect(sameRects(a, [{ ...a[0], x: 10.2 }])).toBe(true));
  it('notices real movement', () => expect(sameRects(a, [{ ...a[0], x: 12 }])).toBe(false));
  it('notices fades', () => expect(sameRects(a, [{ ...a[0], a: 0.5 }])).toBe(false));
  it('notices added or removed regions', () => expect(sameRects(a, [])).toBe(false));
});
```

- [ ] **Step 9: Spustit test a ověřit, že selže**

Run: `cd prototype && npm test -- regions`
Expected: FAIL – modul `./regions` neexistuje.

- [ ] **Step 10: Napsat `regions.ts`, `useGlassRegions.ts`, `useIdle.ts`**

`prototype/src/glass/regions.ts`:

```ts
/** Mirrors `glass::GlassRect` in Rust: CSS px in window coordinates, corner radius, opacity. */
export type GlassRect = { x: number; y: number; w: number; h: number; r: number; a: number };

/** Must match `glass::MAX_REGIONS`. */
export const MAX_REGIONS = 6;

type Measurable = { getBoundingClientRect(): { x: number; y: number; width: number; height: number } };
type StyleLike = { borderTopLeftRadius: string; opacity: string };

export function measure(el: Measurable, style: StyleLike): GlassRect | null {
  const box = el.getBoundingClientRect();
  const alpha = Number.parseFloat(style.opacity);
  if (box.width < 1 || box.height < 1 || !(alpha > 0.01)) return null;
  const radius = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0, box.width / 2, box.height / 2);
  return { x: box.x, y: box.y, w: box.width, h: box.height, r: radius, a: Math.min(1, alpha) };
}

const key = (r: GlassRect) =>
  [r.x, r.y, r.w, r.h, r.r].map((v) => Math.round(v * 2)).join(',') + ':' + Math.round(r.a * 100);

export function sameRects(a: GlassRect[], b: GlassRect[]): boolean {
  return a.length === b.length && a.every((r, i) => key(r) === key(b[i]));
}
```

`prototype/src/glass/useGlassRegions.ts`:

```ts
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MAX_REGIONS, measure, sameRects, type GlassRect } from './regions';

/** Keeps mpv's blur regions on top of every [data-glass] element, also during transitions. */
export function useGlassRegions(enabled: boolean) {
  useEffect(() => {
    let last: GlassRect[] = [];
    let frame = 0;
    let running = 0;

    const push = (rects: GlassRect[]) => {
      if (sameRects(rects, last)) return;
      last = rects;
      invoke('glass_set_regions', { rects }).catch((e) => console.warn('glass_set_regions', e));
    };
    const collect = (): GlassRect[] =>
      enabled
        ? [...document.querySelectorAll<HTMLElement>('[data-glass]')]
            .map((el) => measure(el, getComputedStyle(el)))
            .filter((r): r is GlassRect => r !== null)
            .slice(0, MAX_REGIONS)
        : [];
    const loop = () => {
      push(collect());
      frame = running > 0 ? requestAnimationFrame(loop) : 0;
    };
    const kick = () => {
      if (!frame) frame = requestAnimationFrame(loop);
    };
    const onStart = () => {
      running += 1;
      kick();
    };
    const onEnd = () => {
      running = Math.max(0, running - 1);
      kick();
    };

    const resize = new ResizeObserver(kick);
    resize.observe(document.body);
    const mutations = new MutationObserver(kick);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    document.addEventListener('transitionrun', onStart);
    document.addEventListener('transitionend', onEnd);
    document.addEventListener('transitioncancel', onEnd);
    kick();

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      document.removeEventListener('transitionrun', onStart);
      document.removeEventListener('transitionend', onEnd);
      document.removeEventListener('transitioncancel', onEnd);
      invoke('glass_set_regions', { rects: [] }).catch(() => undefined);
    };
  }, [enabled]);
}
```

`prototype/src/useIdle.ts`:

```ts
import { useEffect, useState } from 'react';

/** True after `ms` without pointer or keyboard activity (spec 8.4: hide controls after 2.5 s). */
export function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), ms);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), ms);
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [ms]);
  return idle;
}
```

- [ ] **Step 11: Spustit UI testy**

Run: `cd prototype && npm test`
Expected: PASS (všechny dosavadní + 7 nových).

- [ ] **Step 12: Zapojit sklo a skrývání ovládání**

`prototype/src/App.tsx` nahradit celý:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Controls } from './components/Controls';
import { StartScreen } from './components/StartScreen';
import { TitleBar } from './components/TitleBar';
import { createFullscreenController, nextFrame } from './fullscreen';
import { useGlassRegions } from './glass/useGlassRegions';
import { installKeyboardForwarding, videoPointerHandlers } from './input/forward';
import { badgeFor } from './playerState';
import { useIdle } from './useIdle';
import { usePlayer } from './usePlayer';

export function App() {
  const s = usePlayer();
  const [curtain, setCurtain] = useState(false);
  const [glassOn, setGlassOn] = useState(true);
  const resizeWaiters = useRef<Array<() => void>>([]);
  const idle = useIdle(2500) && s.loaded && !s.pause;

  useGlassRegions(s.loaded && glassOn);
  useEffect(() => installKeyboardForwarding(), []);

  // `g` toggles the glass for A/B comparison. Capture phase + preventDefault means the
  // forwarding listener (bubble phase, checks defaultPrevented) never sends it to mpv.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'g' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setGlassOn((on) => !on);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  useEffect(() => {
    resizeWaiters.current.splice(0).forEach((resolve) => resolve());
  }, [s.osd.w, s.osd.h]);

  const applyFullscreen = useMemo(
    () =>
      createFullscreenController({
        setCurtain,
        nextFrame,
        setWindowFullscreen: (on) => getCurrentWindow().setFullscreen(on),
        waitForResize: (ms) =>
          new Promise<void>((resolve) => {
            resizeWaiters.current.push(resolve);
            setTimeout(resolve, ms);
          }),
      }),
    [],
  );

  useEffect(() => {
    void applyFullscreen(s.fullscreen);
  }, [s.fullscreen, applyFullscreen]);

  const pointer = useMemo(
    () => videoPointerHandlers(() => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight })),
    [],
  );

  return (
    <div className={`app${s.loaded ? '' : ' idle-bg'}${idle ? ' idle' : ''}`}>
      {s.loaded && <div className="video-catcher" {...pointer} />}
      {!s.loaded && <StartScreen />}
      <TitleBar title={s.title || 'Kaleido M0'} badge={badgeFor(s)} hidden={idle} />
      {s.loaded && <Controls s={s} hidden={idle} />}
      <div className={curtain ? 'curtain on' : 'curtain'} />
    </div>
  );
}
```

`prototype/src/components/TitleBar.tsx` nahradit celý:

```tsx
import { getCurrentWindow } from '@tauri-apps/api/window';
import { blurAfterPointer } from '../input/forward';

type Props = { title: string; badge?: string; hidden?: boolean };

export function TitleBar({ title, badge, hidden = false }: Props) {
  const win = getCurrentWindow();
  const capsule = (side: 'left' | 'right') => `capsule glass titlebar-${side}${hidden ? ' hidden' : ''}`;
  return (
    <>
      <div className={capsule('left')} data-tauri-drag-region data-glass>
        <span className="dot" data-tauri-drag-region />
        <span className="title" data-tauri-drag-region>{title}</span>
        {badge && <span className="badge">{badge}</span>}
      </div>
      <div className={capsule('right')} data-glass>
        <button className="icon-btn" aria-label="Minimalizovat" onClick={() => win.minimize()} {...blurAfterPointer}>–</button>
        <button className="icon-btn" aria-label="Maximalizovat" onClick={() => win.toggleMaximize()} {...blurAfterPointer}>□</button>
        <button className="icon-btn" aria-label="Zavřít" onClick={() => win.close()} {...blurAfterPointer}>✕</button>
      </div>
    </>
  );
}
```

V `prototype/src/components/Controls.tsx` změnit hlavičku funkce a kořenový prvek na:

```tsx
export function Controls({ s, hidden = false }: { s: PlayerState; hidden?: boolean }) {
  return (
    <div className={`capsule glass controls${hidden ? ' hidden' : ''}`} data-glass>
```

(zbytek souboru beze změny).

Na konec `app.css`:

```css
.titlebar-left, .titlebar-right {
  transition: opacity var(--k-motion-fast) ease, translate var(--k-motion-fast) var(--k-ease);
}
.capsule.hidden { opacity: 0; pointer-events: none; }
.titlebar-left.hidden, .titlebar-right.hidden { translate: 0 -12px; }
.controls.hidden { translate: 0 12px; }
.app.idle { cursor: none; }
```

- [ ] **Step 13: Ruční kontrola bodů 5 a 8**

Run: `cd prototype && npm run tauri dev`
Expected / postup:
1. `sdr-1080p`: pod všemi třemi kapslemi je video rozmazané. Rozmazání přesně sedí na tvar kapsle se zaoblenými konci, bez posunu a bez převrácení. Klávesa `g` sklo vypne a zapne (porovnání).
2. Měřítko Windows 150 % → rozmazání pořád sedí.
3. `letterbox` (černé pruhy nahoře a dole): rozmazání sedí i u kapslí nad pruhy. Když je posunuté o výšku pruhu, přepnout `OUTPUT_EXCLUDES_MARGINS` na `false`, ověřit znovu a zapsat, která hodnota platí.
4. Při přehrávání nehýbat myší 2,5 s → kapsle plynule zmizí a rozmazání mizí s nimi, bez „bliknutí“ na konci. Pohyb myší je vrátí.
5. GPU čas: `uhd-2160p`, okno na celou obrazovku, zobrazit statistiky mpv (`I`), stránka 2 (Frame Timings), ovládání viditelné. Odečíst časy průchodů `kaleido-glass blur H`, `blur V`, `composite` a sečíst je. Cíl ≤ 1 ms na RTX 5060 Ti. Změřit i na integrované AMD grafice: Nastavení Windows → Grafika → `kaleido-proto.exe` → Úspora energie, restart aplikace.
6. Snímky: s viditelným ovládáním stisknout `s` (náš snímek bez skla) a `S` (výchozí `screenshot video` od mpv). Soubory se uloží na plochu. Ve snímku z `s` nesmí být rozmazané obdélníky. Zapsat, jestli je obsahuje snímek z `S` (tedy jestli je vynulování vůbec potřeba).
7. Výsledky zapsat do řádků 5 a 8 v `docs/m0/report.md`.

- [ ] **Step 14: Commit**

```bash
git add prototype
git commit -m "feat(prototype): mpv shader glass under UI regions, glass-free screenshots" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Mini přehrávač (bod 6)

**Files:**
- Create: `prototype/src/surface/mini.ts`, `prototype/src/components/MiniPlayer.tsx`
- Test: `prototype/src/surface/mini.test.ts`
- Modify: `prototype/src/App.tsx`, `prototype/src/components/Controls.tsx`, `prototype/src/app.css`

**Interfaces:**
- Consumes: `setSurfaceLayout` (Task 7), `videoPointerHandlers` (Task 9), `useGlassRegions(enabled)` (Task 10)
- Produces: `Rect`, `easeOutCubic(t)`, `lerpRect(a, b, t)`, `miniRect(viewW, viewH, width?, margin?)`, `animateRect(from, to, ms, onFrame, now?, raf?) => Promise<void>`; komponenta `MiniPlayer({ rect, pause, onTogglePause, onExpand })`; prop `onMini` v `Controls`.

- [ ] **Step 1: Napsat padající test `surface/mini.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { animateRect, easeOutCubic, lerpRect, miniRect } from './mini';

describe('mini player geometry', () => {
  it('eases from 0 to 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('interpolates rectangles', () => {
    expect(lerpRect({ x: 0, y: 0, w: 100, h: 50 }, { x: 100, y: 50, w: 200, h: 150 }, 0.5)).toEqual({
      x: 50, y: 25, w: 150, h: 100,
    });
  });

  it('places a 16:9 mini player bottom-right', () => {
    expect(miniRect(1280, 720)).toEqual({ x: 896, y: 493, w: 360, h: 203 });
  });

  it('shrinks the mini player in a narrow window', () => {
    expect(miniRect(300, 400).w).toBe(252);
  });
});

describe('animateRect', () => {
  it('reports frames and ends exactly on the target', async () => {
    let t = 0;
    const frames: number[] = [];
    const raf = (cb: () => void) => {
      t += 50;
      cb();
      return 0;
    };
    const to = { x: 10, y: 10, w: 10, h: 10 };
    await animateRect({ x: 0, y: 0, w: 0, h: 0 }, to, 200, (r) => frames.push(r.x), () => t, raf);
    expect(frames.length).toBe(4);
    expect(frames.at(-1)).toBe(10);
  });
});
```

- [ ] **Step 2: Spustit test a ověřit, že selže**

Run: `cd prototype && npm test -- mini`
Expected: FAIL – modul `./mini` neexistuje.

- [ ] **Step 3: Napsat `surface/mini.ts`**

```ts
export type Rect = { x: number; y: number; w: number; h: number };

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});

/** Floating 16:9 mini player in the bottom-right corner (spec 8.3). */
export function miniRect(viewW: number, viewH: number, width = 360, margin = 24): Rect {
  const w = Math.min(width, Math.max(160, viewW - 2 * margin));
  const h = Math.round((w * 9) / 16);
  return { x: viewW - w - margin, y: viewH - h - margin, w, h };
}

/** Drives one rectangle animation; UI frame and video surface follow the same values (spec 8.6). */
export function animateRect(
  from: Rect,
  to: Rect,
  ms: number,
  onFrame: (r: Rect) => void,
  now: () => number = () => performance.now(),
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
): Promise<void> {
  return new Promise((resolve) => {
    const start = now();
    const step = () => {
      const t = Math.min(1, (now() - start) / ms);
      onFrame(t >= 1 ? to : lerpRect(from, to, easeOutCubic(t)));
      if (t < 1) raf(step);
      else resolve();
    };
    raf(step);
  });
}
```

- [ ] **Step 4: Spustit test**

Run: `cd prototype && npm test -- mini`
Expected: PASS (5 testů).

- [ ] **Step 5: Komponenta `MiniPlayer.tsx` a zapojení**

`prototype/src/components/MiniPlayer.tsx`:

```tsx
import { useMemo } from 'react';
import { blurAfterPointer, videoPointerHandlers } from '../input/forward';
import type { Rect } from '../surface/mini';

type Props = { rect: Rect; pause: boolean; onTogglePause(): void; onExpand(): void };

/** The hole in the opaque page where mpv's surface shows through (spec 8.3). */
export function MiniPlayer({ rect, pause, onTogglePause, onExpand }: Props) {
  const pointer = useMemo(
    () => videoPointerHandlers(() => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })),
    [rect],
  );
  return (
    <div className="mini-frame" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} {...pointer}>
      <div className="mini-bar">
        <button className="icon-btn" aria-label={pause ? 'Přehrát' : 'Pozastavit'} onClick={onTogglePause} {...blurAfterPointer}>
          {pause ? '▶' : '❚❚'}
        </button>
        <button className="icon-btn" aria-label="Zpět na celé okno" onClick={onExpand} {...blurAfterPointer}>⤢</button>
      </div>
    </div>
  );
}
```

`prototype/src/App.tsx` nahradit celý:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Controls } from './components/Controls';
import { MiniPlayer } from './components/MiniPlayer';
import { StartScreen } from './components/StartScreen';
import { TitleBar } from './components/TitleBar';
import { createFullscreenController, nextFrame } from './fullscreen';
import { useGlassRegions } from './glass/useGlassRegions';
import { installKeyboardForwarding, videoPointerHandlers } from './input/forward';
import { playerCommand, setSurfaceLayout } from './player';
import { badgeFor } from './playerState';
import { animateRect, miniRect, type Rect } from './surface/mini';
import { useIdle } from './useIdle';
import { usePlayer } from './usePlayer';

const fullRect = (): Rect => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });

export function App() {
  const s = usePlayer();
  const [curtain, setCurtain] = useState(false);
  const [glassOn, setGlassOn] = useState(true);
  const [mini, setMini] = useState<Rect | null>(null);
  const resizeWaiters = useRef<Array<() => void>>([]);
  const idle = useIdle(2500) && s.loaded && !s.pause && !mini;

  useGlassRegions(s.loaded && glassOn && !mini);
  useEffect(() => installKeyboardForwarding(), []);

  // `g` toggles the glass for A/B comparison. Capture phase + preventDefault means the
  // forwarding listener (bubble phase, checks defaultPrevented) never sends it to mpv.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'g' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setGlassOn((on) => !on);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  useEffect(() => {
    resizeWaiters.current.splice(0).forEach((resolve) => resolve());
  }, [s.osd.w, s.osd.h]);

  const applyFullscreen = useMemo(
    () =>
      createFullscreenController({
        setCurtain,
        nextFrame,
        setWindowFullscreen: (on) => getCurrentWindow().setFullscreen(on),
        waitForResize: (ms) =>
          new Promise<void>((resolve) => {
            resizeWaiters.current.push(resolve);
            setTimeout(resolve, ms);
          }),
      }),
    [],
  );

  useEffect(() => {
    void applyFullscreen(s.fullscreen);
  }, [s.fullscreen, applyFullscreen]);

  const pointer = useMemo(
    () => videoPointerHandlers(() => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight })),
    [],
  );

  // The UI frame and the native surface take the same rectangle every frame (spec 8.6).
  const follow = (r: Rect) => {
    setMini(r);
    void setSurfaceLayout({ kind: 'rect', ...r });
  };
  async function toMini() {
    await animateRect(fullRect(), miniRect(window.innerWidth, window.innerHeight), 220, follow);
  }
  async function toFull() {
    if (!mini) return;
    await animateRect(mini, fullRect(), 220, follow);
    setMini(null);
    await setSurfaceLayout({ kind: 'full' });
  }

  return (
    <div className={`app${s.loaded ? '' : ' idle-bg'}${idle ? ' idle' : ''}`}>
      {s.loaded && !mini && <div className="video-catcher" {...pointer} />}
      {!s.loaded && <StartScreen />}
      <TitleBar title={s.title || 'Kaleido M0'} badge={badgeFor(s)} hidden={idle} />
      {s.loaded && !mini && <Controls s={s} hidden={idle} onMini={toMini} />}
      {mini && (
        <>
          <div className="page">Stránka (simulace Obchodu)</div>
          <MiniPlayer
            rect={mini}
            pause={s.pause}
            onTogglePause={() => playerCommand({ type: 'togglePause' })}
            onExpand={toFull}
          />
        </>
      )}
      <div className={curtain ? 'curtain on' : 'curtain'} />
    </div>
  );
}
```

V `prototype/src/components/Controls.tsx` změnit hlavičku funkce na:

```tsx
type Props = { s: PlayerState; hidden?: boolean; onMini(): void };

export function Controls({ s, hidden = false, onMini }: Props) {
```

a před tlačítko ⛶ (`aria-label="Celá obrazovka"`) vložit:

```tsx
        <button className="icon-btn" aria-label="Mini přehrávač" onClick={onMini} {...blurAfterPointer}>
          ▣
        </button>
```

Na konec `app.css`:

```css
/* Window controls stay above the page and its mini-player shadow. */
.titlebar-left, .titlebar-right { z-index: 5; }
.page {
  position: absolute;
  top: 80px;
  left: 40px;
  font-size: 20px;
  font-weight: 700;
  z-index: 2;
}
/* The huge spread shadow paints the opaque page around a transparent hole. */
.mini-frame {
  position: absolute;
  border-radius: 16px;
  box-shadow: 0 0 0 100vmax var(--k-page-solid), 0 10px 34px rgba(0, 0, 0, 0.5);
  outline: 1px solid var(--k-glass-border);
  z-index: 1;
}
.mini-bar {
  position: absolute;
  left: 8px;
  bottom: 8px;
  display: flex;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
}
```

- [ ] **Step 6: Ruční kontrola bodu 6**

Run: `cd prototype && npm run tauri dev`, přehrávat `sdr-1080p`.
Expected / postup:
1. ▣ → video se za 220 ms zmenší do rohu, kolem je neprůhledná „stránka“. ⤢ → zpět na celé okno.
2. Nahrát přechod na 60 fps (Xbox Game Bar Win+Alt+R nebo OBS) a projít ho po snímcích. Hrana videa smí od hrany rámečku zaostávat nejvýš o 1 snímek. Zapsat největší viděný posun.
3. V mini režimu: klik do mini videa jde do mpv (klik do `click-target` není vidět, ale dvojklik přepne fullscreen), ▶/❚❚ funguje.
4. Změnit velikost okna v mini režimu → mini video zůstane, kde bylo. Novou polohu v rohu dostane až po dalším ▣ (pro M0 stačí).
5. Výsledek zapsat do řádku 6. Pokud je rozjetí vidět, zapsat do sloupce „Rozhodnutí“ záložní řešení ze spec 8.6 (skok + prolnutí).

- [ ] **Step 7: Commit**

```bash
git add prototype/src
git commit -m "feat(prototype): animated mini player with the mpv surface following the UI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Náhledy z thumbfastu v React bublině (bod 7)

**Files:**
- Create: `prototype/src-tauri/src/thumbs.rs`
- Modify: `prototype/src-tauri/Cargo.toml` (dev-dependency `tempfile`), `src/engine.rs`, `src/options.rs`, `src/commands.rs`, `src/main.rs`, `prototype/src-tauri/tauri.conf.json` (`beforeDevCommand`)
- Create: `prototype/src/components/Seekbar.tsx`
- Modify: `prototype/src/components/Controls.tsx`, `prototype/src/app.css`
- Test: unit testy v `thumbs.rs`

**Interfaces:**
- Consumes: `kaleido-mpv.exe` (Task 4), `vendor/thumbfast/thumbfast.lua` (Task 1), `Engine::on_client_message` (Task 10), `Mpv::client_name` (Task 2)
- Produces:
  - Rust: `thumbs::{MAX_SIDE: u32 = 1024, ThumbError::{Json, Size, Path, Read, Length}, RenderInfo{width,height,thumbnail}, Thumb{width,height,rgba}, validate(&str, &Path) -> Result<(RenderInfo, PathBuf), ThumbError>, bgra_to_rgba(Vec<u8>, u32, u32) -> Result<Vec<u8>, ThumbError>, load(&str, &Path) -> Result<Thumb, ThumbError>}`; `Engine::latest_thumb() -> Vec<u8>`; příkazy `thumb_request(seconds)`, `thumb_clear()`, `thumb_fetch() -> ArrayBuffer`; událost `thumb:ready {width, height}`.
  - TS: komponenta `Seekbar({ timePos, duration })`.

- [ ] **Step 1: Napsat `thumbs.rs` s padajícími testy**

Do `prototype/src-tauri/Cargo.toml` přidat:

```toml
[dev-dependencies]
tempfile = "3"
```

`prototype/src-tauri/src/thumbs.rs`:

```rust
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Largest thumbnail side we accept from thumbfast.
pub const MAX_SIDE: u32 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbError {
    Json,
    Size,
    Path,
    Read,
    Length,
}

/// The fields of thumbfast's `thumbfast-render` JSON we use.
#[derive(Debug, Deserialize)]
pub struct RenderInfo {
    pub width: u32,
    pub height: u32,
    pub thumbnail: String,
}

pub struct Thumb {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Checks a `thumbfast-render` payload; returns the `.bgra` file to read.
/// Any script can send this message, so the path must be thumbfast's own temp file.
pub fn validate(json: &str, temp_dir: &Path) -> Result<(RenderInfo, PathBuf), ThumbError> {
    todo!()
}

pub fn bgra_to_rgba(data: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, ThumbError> {
    todo!()
}

pub fn load(json: &str, temp_dir: &Path) -> Result<Thumb, ThumbError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(width: u32, height: u32, thumbnail: &Path) -> String {
        format!(
            r#"{{"width":{width},"height":{height},"thumbnail":{}}}"#,
            serde_json::to_string(&thumbnail.display().to_string()).unwrap()
        )
    }

    #[test]
    fn accepts_thumbfasts_own_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let (info, file) = validate(&payload(200, 112, &dir.path().join("thumbfast.out1234")), dir.path()).unwrap();
        assert_eq!((info.width, info.height), (200, 112));
        assert!(file.ends_with("thumbfast.out1234.bgra"));
    }

    #[test]
    fn rejects_paths_outside_temp() {
        let dir = tempfile::tempdir().unwrap();
        let foreign = Path::new(r"C:\Windows\System32\thumbfast");
        assert_eq!(validate(&payload(10, 10, foreign), dir.path()).unwrap_err(), ThumbError::Path);
    }

    #[test]
    fn rejects_other_files_in_temp() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(validate(&payload(10, 10, &dir.path().join("secret")), dir.path()).unwrap_err(), ThumbError::Path);
    }

    #[test]
    fn rejects_bad_sizes_and_json() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("thumbfast.out1");
        assert_eq!(validate(&payload(0, 10, &file), dir.path()).unwrap_err(), ThumbError::Size);
        assert_eq!(validate(&payload(4096, 10, &file), dir.path()).unwrap_err(), ThumbError::Size);
        assert_eq!(validate("not json", dir.path()).unwrap_err(), ThumbError::Json);
    }

    #[test]
    fn converts_bgra_to_opaque_rgba() {
        assert_eq!(bgra_to_rgba(vec![1, 2, 3, 0, 4, 5, 6, 7], 2, 1), Ok(vec![3, 2, 1, 255, 6, 5, 4, 255]));
    }

    #[test]
    fn rejects_truncated_pixel_data() {
        assert_eq!(bgra_to_rgba(vec![0; 7], 2, 1), Err(ThumbError::Length));
    }

    #[test]
    fn loads_a_written_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("thumbfast.out9");
        std::fs::write(dir.path().join("thumbfast.out9.bgra"), [9, 8, 7, 6]).unwrap();
        let thumb = load(&payload(1, 1, &base), dir.path()).unwrap();
        assert_eq!(thumb.rgba, vec![7, 8, 9, 255]);
    }

    #[test]
    fn missing_file_is_a_read_error() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("thumbfast.out404");
        assert_eq!(load(&payload(1, 1, &base), dir.path()).err(), Some(ThumbError::Read));
    }
}
```

Do `main.rs` přidat `mod thumbs;`.

- [ ] **Step 2: Spustit testy a ověřit, že selžou**

Run: `cargo test -p kaleido-proto thumbs`
Expected: FAIL – `not yet implemented`.

- [ ] **Step 3: Implementovat**

```rust
pub fn validate(json: &str, temp_dir: &Path) -> Result<(RenderInfo, PathBuf), ThumbError> {
    let info: RenderInfo = serde_json::from_str(json).map_err(|_| ThumbError::Json)?;
    if info.width == 0 || info.height == 0 || info.width > MAX_SIDE || info.height > MAX_SIDE {
        return Err(ThumbError::Size);
    }
    let file = PathBuf::from(format!("{}.bgra", info.thumbnail));
    let named_like_thumbfast = file
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("thumbfast"));
    let in_temp = file.parent().is_some_and(|dir| same_dir(dir, temp_dir));
    if !named_like_thumbfast || !in_temp {
        return Err(ThumbError::Path);
    }
    Ok((info, file))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

pub fn bgra_to_rgba(mut data: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, ThumbError> {
    if data.len() != width as usize * height as usize * 4 {
        return Err(ThumbError::Length);
    }
    for px in data.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    Ok(data)
}

pub fn load(json: &str, temp_dir: &Path) -> Result<Thumb, ThumbError> {
    let (info, file) = validate(json, temp_dir)?;
    let data = std::fs::read(&file).map_err(|_| ThumbError::Read)?;
    let rgba = bgra_to_rgba(data, info.width, info.height)?;
    Ok(Thumb { width: info.width, height: info.height, rgba })
}
```

- [ ] **Step 4: Spustit testy**

Run: `cargo test -p kaleido-proto thumbs`
Expected: PASS (8 testů).

- [ ] **Step 5: Napojit thumbfast v `options.rs`**

`prototype/src-tauri/src/options.rs` nahradit celý:

```rust
use std::error::Error;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::glass;

/// Files the prototype hands to mpv.
pub struct Paths {
    pub data_dir: PathBuf,
    pub click_target: PathBuf,
    pub shader: PathBuf,
    pub thumbfast: PathBuf,
    pub helper_exe: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> Result<Paths, Box<dyn Error>> {
        let data_dir = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        let click_target = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/test-scripts/click-target.lua"));
        // The file stem is the shader name that glsl-shader-opts prefixes target.
        let shader = data_dir.join(format!("{}.glsl", glass::SHADER));
        std::fs::write(&shader, glass::shader_source())?;
        let thumbfast = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../vendor/thumbfast/thumbfast.lua"));
        // Built next to us by `beforeDevCommand` (cargo build -p kaleido-mpv).
        let helper_exe = std::env::current_exe()?.with_file_name("kaleido-mpv.exe");
        Ok(Paths { data_dir, click_target, shader, thumbfast, helper_exe })
    }
}

/// Set before mpv_initialize. Spec 5.2 subset; `config=no` keeps the user's own mpv config out of M0.
pub fn mpv_options(paths: &Paths) -> Vec<(&'static str, String)> {
    vec![
        ("vo", "gpu-next".into()),
        ("gpu-api", "d3d11".into()),
        ("target-colorspace-hint", "yes".into()),
        ("hwdec", "auto-safe".into()),
        ("keep-open", "yes".into()),
        ("idle", "yes".into()),
        ("force-window", "yes".into()),
        ("osc", "no".into()),
        ("config", "no".into()),
        ("input-default-bindings", "yes".into()),
        ("input-vo-keyboard", "no".into()),
        ("terminal", "no".into()),
        ("log-file", paths.data_dir.join("mpv.log").display().to_string()),
        // Windows path-list separator is ';'.
        ("scripts", format!("{};{}", paths.thumbfast.display(), paths.click_target.display())),
        ("script-opts", format!("thumbfast-mpv_path={},thumbfast-network=no", paths.helper_exe.display())),
        ("glsl-shaders", paths.shader.display().to_string()),
        ("screenshot-dir", "~~desktop/".into()),
    ]
}
```

V `tauri.conf.json` změnit `beforeDevCommand` na:

```json
    "beforeDevCommand": "cargo build -p kaleido-mpv && npm run dev",
```

- [ ] **Step 6: Obsluha `thumbfast-render` v `engine.rs`**

Do `struct Engine` přidat pole `thumb: Mutex<Vec<u8>>` a v `start` ho inicializovat `thumb: Mutex::new(Vec::new()),`. Přidat import `use crate::thumbs;` a typ:

```rust
#[derive(Clone, Serialize)]
struct ThumbReady {
    width: u32,
    height: u32,
}
```

Do `impl Engine` přidat:

```rust
    pub fn latest_thumb(&self) -> Vec<u8> {
        self.thumb.lock().unwrap().clone()
    }

    fn on_thumbfast_render(&self, app: &AppHandle, json: &str) {
        match thumbs::load(json, &std::env::temp_dir()) {
            Ok(thumb) => {
                let ready = ThumbReady { width: thumb.width, height: thumb.height };
                *self.thumb.lock().unwrap() = thumb.rgba;
                let _ = app.emit("thumb:ready", ready);
            }
            Err(e) => {
                let _ = app.emit("player:log", format!("thumbfast-render rejected: {e:?}"));
            }
        }
    }
```

`on_client_message` nahradit:

```rust
    fn on_client_message(&self, app: &AppHandle, args: Vec<String>) {
        match args.as_slice() {
            [target, action] if target == "kaleido" && action == "screenshot" => self.screenshot_without_glass(),
            [message, json] if message == "thumbfast-render" => self.on_thumbfast_render(app, json),
            _ => {
                let _ = app.emit("player:message", args);
            }
        }
    }
```

- [ ] **Step 7: Příkazy pro náhledy**

Na konec `commands.rs`:

```rust
#[tauri::command]
pub fn thumb_request(engine: State<'_, Arc<Engine>>, seconds: f64) -> CmdResult {
    // Empty x/y + our client name = "send me thumbfast-render instead of drawing an overlay".
    let me = engine.mpv.client_name();
    let time = format!("{:.3}", seconds.max(0.0));
    engine
        .mpv
        .command(&["script-message-to", "thumbfast", "thumb", &time, "", "", &me])
        .map_err(err)
}

#[tauri::command]
pub fn thumb_clear(engine: State<'_, Arc<Engine>>) -> CmdResult {
    engine.mpv.command(&["script-message-to", "thumbfast", "clear"]).map_err(err)
}

#[tauri::command]
pub fn thumb_fetch(engine: State<'_, Arc<Engine>>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(engine.latest_thumb())
}
```

V `main.rs` do `generate_handler!` přidat `commands::thumb_request, commands::thumb_clear, commands::thumb_fetch,`.

Run: `cargo test -p kaleido-proto && cargo clippy -p kaleido-proto -- -D warnings`
Expected: PASS, bez varování.

- [ ] **Step 8: Komponenta `Seekbar.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { playerCommand } from '../player';
import { formatTime } from '../playerState';

type Hover = { x: number; t: number };

/** Seekbar with a thumbfast preview rendered by React inside a glass bubble (spec 8.4). */
export function Seekbar({ timePos, duration }: { timePos: number; duration: number }) {
  const bar = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const lastRequested = useRef(-1);
  const [hover, setHover] = useState<Hover | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const unlisten = listen<{ width: number; height: number }>('thumb:ready', async (e) => {
      const { width, height } = e.payload;
      const buffer = await invoke<ArrayBuffer>('thumb_fetch');
      const target = canvas.current;
      if (!target || buffer.byteLength !== width * height * 4) return;
      target.width = width;
      target.height = height;
      target.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
      setSize({ w: width / window.devicePixelRatio, h: height / window.devicePixelRatio });
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const at = (clientX: number): Hover => {
    const box = bar.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return { x: clientX - box.left, t: f * duration };
  };

  return (
    <div
      className="seekbar"
      ref={bar}
      onPointerMove={(e) => {
        const h = at(e.clientX);
        setHover(h);
        if (duration > 0 && Math.abs(h.t - lastRequested.current) >= 0.25) {
          lastRequested.current = h.t;
          invoke('thumb_request', { seconds: h.t }).catch(() => undefined);
        }
      }}
      onPointerLeave={() => {
        setHover(null);
        lastRequested.current = -1;
        invoke('thumb_clear').catch(() => undefined);
      }}
      onPointerDown={(e) => {
        if (duration > 0) void playerCommand({ type: 'seekAbsolute', seconds: at(e.clientX).t });
      }}
    >
      <div className="seek-track">
        <div className="seek-fill" style={{ width: `${duration ? (timePos / duration) * 100 : 0}%` }} />
      </div>
      <div className={hover ? 'thumb glass' : 'thumb glass off'} data-glass style={{ left: hover?.x ?? 0 }}>
        <canvas ref={canvas} style={size ? { width: size.w, height: size.h } : { display: 'none' }} />
        <span className="time">{formatTime(hover?.t ?? 0)}</span>
      </div>
    </div>
  );
}
```

V `Controls.tsx` přidat `import { Seekbar } from './Seekbar';` a celý prvek `<input className="seek" … />` (od `<input` po jeho `/>`, včetně `{...blurAfterPointer}`) nahradit:

```tsx
        <Seekbar timePos={s.timePos} duration={s.duration} />
```

Na konec `app.css`:

```css
.seekbar { position: relative; flex: 1; height: 18px; display: flex; align-items: center; cursor: pointer; }
.seek-track { position: relative; width: 100%; height: 5px; border-radius: 5px; background: rgba(255, 255, 255, 0.25); }
.seek-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 5px;
  background: linear-gradient(90deg, #7fd8ff, #a98bff, #ff8fd0);
}
.thumb {
  position: absolute;
  bottom: 26px;
  translate: -50% 0;
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 6px;
  border-radius: 14px;
  pointer-events: none;
  transition: opacity 120ms ease;
}
.thumb canvas { border-radius: 9px; }
.thumb.off { opacity: 0; }
```

- [ ] **Step 9: Ruční kontrola bodu 7**

Run: `cd prototype && npm run tauri dev` (předem se sestaví `kaleido-mpv.exe`).
Expected / postup:
1. `sdr-1080p`, najet na časovou osu → do 300 ms se ve skleněné bublině objeví náhled ze správného místa a s pohybem myši se mění. Pod bublinou je video rozmazané (6. oblast skla).
2. Neobjeví se žádné konzolové okno. Ve Správci úloh běží `kaleido-mpv.exe` jako podproces.
3. `hdr10` → náhledy jsou tónově mapované, ne šedé ani přepálené.
4. Zavřít aplikaci → do 2 s nezůstane žádný `kaleido-mpv.exe` (`tasklist | findstr /i kaleido`).
5. V devtools (pravý klik → Inspect) nejsou v konzoli hlášky `thumbfast-render rejected`.
6. Výsledek zapsat do řádku 7. Pokud selhal integrační test encodingu v Task 4, zapsat ❌ a doporučení (přibalit `mpv.exe`, nebo vlastní generátor náhledů).

- [ ] **Step 10: Commit**

```bash
git add prototype Cargo.lock
git commit -m "feat(prototype): thumbfast previews via kaleido-mpv rendered in a React bubble" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Vyhodnocení M0 a doporučení pro M1

**Files:**
- Modify: `docs/m0/report.md`
- Modify (jen pokud se mění rozhodnutí): `docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md`

**Interfaces:**
- Consumes: řádky 1–8 vyplněné v Task 7–12, výsledky testů
- Produces: hotová zpráva M0 se závěrem; případně upravená spec (záložní řešení), ze které vyjde plán M1.

- [ ] **Step 1: Výkonnostní měření**

Run: `cd prototype && npm run tauri build -- --no-bundle`, pak spustit `target/release/kaleido-proto.exe`.
Expected / postup:
1. Čas od spuštění do viditelného okna (stopky nebo záznam obrazovky) → zapsat (cíl ≤ 500 ms).
2. `sdr-1080p` v pauze bez pohybu myši 60 s → průměrné CPU procesu `kaleido-proto.exe` ve Správci úloh (cíl < 1 %).
3. Při přehrávání se skrytým ovládáním porovnat CPU s `mpv.exe`. Ten není součástí repa, takže použít libovolný build mpv od shinchira, stejný soubor, stejné volby `--vo=gpu-next --hwdec=auto-safe`. Cíl: nanejvýš o 2 procentní body víc.
4. Paměť procesů WebView2 (`msedgewebview2.exe` patřících aplikaci) → zapsat (cíl ≤ 200 MB).
Všechny hodnoty zapsat do sekce „Další zjištění“.

- [ ] **Step 2: Doplnit prostředí a závěr**

Vyplnit tabulku „Prostředí“ (verze Windows: `winver`; monitory; HDR) a sekci „Závěr a doporučení pro M1“:
- které body prošly a které vyžadují záložní řešení ze spec 5.4,
- hodnoty `SEND_EXPLICIT_DOUBLE_CLICK` a `OUTPUT_EXCLUDES_MARGINS`,
- co z `crates/` jde do M1 beze změn a co z `prototype/` slouží jen jako reference,
- otevřené otázky pro plán M1.
Ve zprávě nesmí zůstat ⏳.

- [ ] **Step 3: Promítnout změny do spec (jen při změně rozhodnutí)**

Pokud M0 změnilo rozhodnutí (např. dvě okna místo podokna, sklo bez rozmazání, skok místo animace mini přehrávače, přibalení `mpv.exe`), upravit odpovídající odstavce v kapitolách 4.1, 5.4, 8.2 nebo 8.6 a v tabulce „Přehled rozhodnutí“ v kapitole 15. Pokud se nic nemění, spec neměnit.

- [ ] **Step 4: Finální kontrola testů**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && cd prototype && npm test && npm run build`
Expected: vše projde.

- [ ] **Step 5: Commit**

```bash
git add docs/m0/report.md docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md
git commit -m "docs(m0): prototype findings and recommendations for M1" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
