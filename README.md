# Kaleido

A video player for Windows: a Tauri 2 and React 19 interface over the upstream
[libmpv](https://mpv.io/) (never a fork or a patch). The UI floats over the video as glass
islands, mpv's own configuration (`mpv.conf`, `input.conf`, scripts) keeps working, and a mini
player follows you into the settings. Windows 10 22H2 and Windows 11, x64.

M1 (this branch) is the player: opening files, folders and links (command line, dialog, drag and
drop, paste), playback controls, panels, error cards, the mini player, settings and shortcuts.

## Layout

| Folder | What is in it |
|---|---|
| `src/` | The UI: React 19, TypeScript, Zustand, i18next (`src/i18n/locales/cs.json`, `en.json`). It talks to Rust only through typed commands and events (`src/ipc/`). |
| `src-tauri/` | The app (crate `kaleido`, binary `Kaleido.exe`): the mpv engine, the video surface, glass, thumbnails, settings, opening and the single instance, logs and diagnostics. |
| `crates/` | `mpv-ffi` (libmpv bindings) and `kaleido-mpv` (the headless mpv command line that thumbfast starts). |
| `resources/` | Bundled defaults (`mpv.conf`, `input.conf`) and the licence lists for the About page. |
| `scripts/` | Pinned libmpv and thumbfast downloads, the licence generator, the local install, performance measurement, association diagnostics. |
| `e2e/` | The smoke E2E test (WebdriverIO, tauri-driver, Microsoft Edge WebDriver). |
| `docs/` | The specification, the plans, the M0 report and the manual checklists. |
| `vendor/` | Pinned libmpv and thumbfast (downloaded, not in git). |

## Build and run

Needs Rust 1.90 or newer, Node 24 with npm, and the WebView2 runtime.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-libmpv.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-thumbfast.ps1
npm ci
npm run tauri dev
```

`npm run tauri dev` builds `kaleido-mpv`, starts Vite and runs the debug app against it. A plain
`cargo build -p kaleido` makes the same dev build, which loads the UI from Vite
(`http://localhost:1420`); a build with the UI inside comes from the Tauri CLI:

```powershell
npm run tauri build -- --no-bundle      # target/release/Kaleido.exe
cargo build --release -p kaleido-mpv
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local.ps1
```

`scripts/install-local.ps1` installs that build for the current user and registers it with Windows
(Open with, Send to, the classic context menu) exactly as M0 did; `-ChooseDefault` opens Windows'
Default apps page for Kaleido and `-Unregister` removes the registration. Details:
[docs/m0/local-install.md](docs/m0/local-install.md) (written for M0's
`install-local-prototype.ps1`, which this script replaces). The M4 installer replaces both.

## Test

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace      # also drives the real libmpv, with vo=null and ao=null
npm run lint
npm test                    # vitest
npm run build               # tsc and the Vite build
```

The E2E test starts the built app under WebView2's WebDriver and plays a generated clip:

```powershell
cargo install tauri-driver --locked --version 2.1.0   # the version CI uses
powershell -NoProfile -ExecutionPolicy Bypass -File e2e/fetch-driver.ps1   # msedgedriver of this WebView2
npm run e2e:build           # kaleido-mpv, the debug app with the UI inside, e2e/media/kaleido-e2e.mkv
npm run e2e
```

Close Kaleido first: a running instance would take the clip over. Like any start of Kaleido, the
run uses your own `%APPDATA%\Kaleido` and `%LOCALAPPDATA%\Kaleido`, so a `mpv.conf` there that
starts files paused or loops them (`pause`, `loop-file`, `loop-playlist`) can make the smoke test
fail; what mpv saved for the clip (`watch_later`) is removed before each run. tauri-driver is
looked for in `$KALEIDO_TAURI_DRIVER`, then `$CARGO_HOME\bin`, then `PATH`, then `~\.cargo\bin`.

Performance against the targets of spec 13: `scripts/measure.ps1` (measures the local install).

## Documents

- Specification: [docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md](docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md)
- Plans: [M0](docs/superpowers/plans/2026-10-11-kaleido-m0-prototype.md), [M1](docs/superpowers/plans/2026-10-17-kaleido-m1-player.md)
- M0 prototype: [report](docs/m0/report.md), [checklist](docs/m0/checklist.md) (the prototype's code is on the `m0-prototype` branch)
- M1 manual checklist: [docs/m1/checklist.md](docs/m1/checklist.md)

## Licence

GPL-3.0-or-later ([LICENSE](LICENSE)). Third-party licences: `resources/licenses/`, shown in the
app under Settings → About.
