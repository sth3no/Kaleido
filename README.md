# Kaleido

A video player for Windows: a Tauri 2 and React 19 interface over the upstream
[libmpv](https://mpv.io/) (never a fork or a patch). The UI floats over the video as glass
islands, mpv's own configuration (`mpv.conf`, `input.conf`, scripts) keeps working, and a mini
player follows you into the settings. Windows 10 22H2 and Windows 11, x64.

M1 is the player: opening files, folders and links (command line, dialog, drag and drop, paste),
playback controls, panels, error cards, the mini player, settings and shortcuts.

M2 (this branch) adds plugins and tools. A plugin is a plain mpv script that Kaleido lists on My
plugins (turn it off, uninstall it, change its settings, apply it with a restart of the player that
carries on where you were); three essentials, thumbfast, sub-select and reload, come with Kaleido.
yt-dlp and Deno are downloaded, verified and kept up to date by Kaleido itself. Links get a quality
choice in quick settings, error cards that say what went wrong and what to do, and cookies from a
browser.

## Layout

| Folder | What is in it |
|---|---|
| `src/` | The UI: React 19, TypeScript, Zustand, i18next (`src/i18n/locales/cs.json`, `en.json`). It talks to Rust only through typed commands and events (`src/ipc/`). |
| `src-tauri/` | The app (crate `kaleido`, binary `Kaleido.exe`): the mpv engine, the video surface, glass, thumbnails, plugins and essentials, the managed tools (yt-dlp, Deno), stream quality, settings, opening and the single instance, logs and diagnostics. |
| `crates/` | `mpv-ffi` (libmpv bindings) and `kaleido-mpv` (the headless mpv command line that thumbfast starts). |
| `resources/` | Bundled defaults (`mpv.conf`, `input.conf`), the pinned essentials (`essentials/essentials.json`) and the licence lists for the About page. |
| `scripts/` | Pinned libmpv and essentials downloads, the licence generator, the local install, performance measurement, association diagnostics. |
| `e2e/` | The smoke E2E test (WebdriverIO, tauri-driver, Microsoft Edge WebDriver). |
| `docs/` | The specification, the plans, the M0 report and the manual checklists. |
| `vendor/` | Pinned libmpv and the essentials: thumbfast, sub-select, reload (downloaded, not in git). |

## Build and run

Needs Rust 1.90 or newer, Node 24 with npm, and the WebView2 runtime.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-libmpv.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-essentials.ps1
npm ci
npm run tauri dev
```

`npm run tauri dev` builds `kaleido-mpv`, starts Vite and runs the debug app against it. A plain
`cargo build -p kaleido` makes the same dev build, which loads the UI from Vite
(`http://localhost:1420`); a build with the UI inside comes from the Tauri CLI. Every build of
the app needs the essentials that `scripts/fetch-essentials.ps1` downloads (see
[Plugins and essentials](#plugins-and-essentials)):

```powershell
npm run tauri build -- --no-bundle      # target/release/Kaleido.exe
cargo build --release -p kaleido-mpv
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local.ps1
```

`scripts/install-local.ps1` installs that build for the current user and registers it with Windows
(Open with, Send to, the classic context menu) exactly as M0 did, with the essentials the build
bundles (`resources\essentials\`); `-ChooseDefault` opens Windows' Default apps page for Kaleido
and `-Unregister` removes the registration. Details:
[docs/m0/local-install.md](docs/m0/local-install.md) (written for M0's
`install-local-prototype.ps1`, which this script replaces). The M4 installer replaces both.

Run it yourself, in your own PowerShell window, with Kaleido closed (it refuses to replace a
running installed player). It writes to your user's registry and to `%LOCALAPPDATA%\Programs\`,
and only a script that runs in your own Windows session reaches the registration Explorer reads;
what a sandboxed shell writes to the registry, `%APPDATA%` or `%LOCALAPPDATA%` does not reach it.
The same goes for `scripts/diagnose-associations.ps1`, which reads the registration back.

## Plugins and essentials

A plugin is an ordinary mpv script, a `.lua` or `.js` file or a folder with a `main.lua` or
`main.js`, in `%APPDATA%\Kaleido\scripts\`, with its options in `script-opts\<name>.conf` if it
has any. There is no Kaleido plugin API. My plugins lists whatever is in that folder: it turns a
plugin off (the script moves to `scripts-disabled\`) or on, uninstalls it (the files go to the
Recycle Bin and the options stay), and edits its settings. A change to a plugin that is running
waits for Apply, which restarts mpv's core and carries on with the same playlist, position,
tracks, pause, volume and speed. `plugins.json` beside `mpv.conf` records what Kaleido installed.

The essentials are the plugins Kaleido installs itself on its first start: thumbfast (the
timeline previews), sub-select (picks the subtitles by your languages) and reload (reloads a
stalled stream; `Ctrl+R` does it by hand; a link it reloads plays in the default quality, and the
Quality button says so). Which ones, from which repository and commit, with the
SHA-256 of every file, the settings My plugins offers for them and the options Kaleido writes
itself is pinned in one file, `resources/essentials/essentials.json`. The scripts themselves are
not in git; `scripts/fetch-essentials.ps1` downloads them:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-essentials.ps1
```

For each file of the manifest it downloads `raw.githubusercontent.com/<repo>/<commit>/<file>` into
`vendor/essentials/<name>/` and checks its SHA-256; a file that differs is never written (the
script throws), and one that is in place and right is skipped. Run it once after cloning and
again whenever the manifest changes (a new commit or checksum). The Tauri build bundles
`vendor/essentials/` as `resources\essentials\`, so building the app, running its E2E and CI all
need it first.

On its first start Kaleido copies the essentials from there into `scripts\`, once. An essential
you uninstall is not copied again (Restore essentials brings it back), and a script of your own
that mpv knows by the same name is never replaced. Before every start of the player's core Kaleido
sets a few options of the essentials itself, in their `script-opts` files, and leaves the rest of
those files alone.

## yt-dlp and Deno

mpv plays links through yt-dlp, and YouTube needs Deno beside it. Kaleido downloads and updates
both itself; nothing is installed by hand and there is no step for them in the build. They live in
`%LOCALAPPDATA%\Kaleido\tools\`: `yt-dlp.exe`, `deno.exe` and `tools.json`, which records what
was installed and when it was last checked. They are Kaleido's own: it never uses a yt-dlp from
`PATH` and shares nothing with other programs. A first start without them downloads them in the
background (the M4 installer will bring first copies).

- **Where from, and how they are trusted.** GitHub Releases (`releases/latest/download`) of
  `yt-dlp/yt-dlp`, `yt-dlp/yt-dlp-nightly-builds` and `denoland/deno`, over https and only from
  GitHub's own hosts. A download is used only when its SHA-256 is the one the release lists, and
  it is put in place beside the file that may be running, so a failed or interrupted update leaves
  the tool as it was. Every check also reads the SHA-256 of the file in place: one that was
  replaced or damaged since is downloaded again, so Check now repairs it.
- **When.** yt-dlp is checked daily, and at once when a link fails because yt-dlp no longer
  understands its site (not more than once in ten minutes); Deno weekly. A check that fails is
  tried again after 1 minute, 5 minutes, 30 minutes and then every 2 hours; offline, a tool that
  is installed stays as it is.
- **Settings → Updates** shows each tool with its version, when it was last checked, what it is
  doing and Check now, and the version of libmpv, which comes with Kaleido. The yt-dlp channel
  there is Stable or Nightly: nightly gets fixes for websites sooner and is less tested. Deno
  has stable releases only.
- **A link that keeps failing.** The card's "Update and try again" opens the link again only when
  the update brought something new; otherwise the card says what it found (yt-dlp is already the
  newest, or Deno is missing) and links to Settings → Updates.
- **Limits.** A whole download has 10 minutes, doubled after each failed check of the tool up to
  80 minutes, so a slow line gets there in the end. For proxies only the `HTTP_PROXY` and
  `HTTPS_PROXY` environment variables are used, not Windows' own proxy setting.

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
npm run e2e:build           # kaleido-mpv, the debug app with the UI inside (and the essentials), e2e/media/kaleido-e2e.mkv
npm run e2e
```

Close Kaleido first: a running instance would take the clip over. Like any start of Kaleido, the
run uses your own `%APPDATA%\Kaleido` and `%LOCALAPPDATA%\Kaleido`, so a `mpv.conf` there that
starts files paused or loops them (`pause`, `loop-file`, `loop-playlist`) can make the smoke test
fail; what mpv saved for the clip (`watch_later`) is removed before each run. tauri-driver is
looked for in `$KALEIDO_TAURI_DRIVER`, then `$CARGO_HOME\bin`, then `PATH`, then `~\.cargo\bin`.

A step near the end opens My plugins and expects Kaleido's own thumbfast there, as an essential
and turned on. A first start of the app installs it from the essentials the build bundles
(`scripts/fetch-essentials.ps1` comes before `npm run e2e:build`); a thumbfast you uninstalled or
turned off in My plugins, or replaced with a `thumbfast.lua` of your own, makes that step fail.

Performance against the targets of spec 13: `scripts/measure.ps1` (measures the local install).

## Documents

- Specification: [docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md](docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md)
- Plans: [M0](docs/superpowers/plans/2026-10-11-kaleido-m0-prototype.md), [M1](docs/superpowers/plans/2026-10-17-kaleido-m1-player.md), [M2](docs/superpowers/plans/2026-10-18-kaleido-m2-plugins.md)
- M0 prototype: [report](docs/m0/report.md), [checklist](docs/m0/checklist.md) (the prototype's code is on the `m0-prototype` branch)
- M1 manual checklist: [docs/m1/checklist.md](docs/m1/checklist.md)
- M2 manual checklist: [docs/m2/checklist.md](docs/m2/checklist.md)

## Licence

GPL-3.0-or-later ([LICENSE](LICENSE)). Third-party licences: `resources/licenses/`, shown in the
app under Settings → About.
