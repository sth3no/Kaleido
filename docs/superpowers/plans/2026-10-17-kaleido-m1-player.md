# Kaleido M1 – přehrávač: implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** První skutečná verze Kaleida: přehrávač nad upstream libmpv s liquid glass UI, který otevře soubory, složky i odkazy, ovládá se ostrůvky, rychlým nastavením a playlistem, má mini přehrávač, design tokeny, češtinu i angličtinu, Nastavení (kromě Pluginů a Aktualizací) a logy (spec 14, M1).

**Architecture:** Nová Tauri 2 aplikace v kořeni repa (`src/` React UI, `src-tauri/` Rust jádro s moduly ze spec 4.2) nad zachovanými crates `mpv-ffi` a `kaleido-mpv`. Rust vlastní libmpv na dvou vláknech (uspořádaná fronta příkazů a vlákno událostí, nikdy hlavní vlákno), UI s ním mluví jen typovanými příkazy a událostmi (4.4). `prototype/` je jen reference: jeho testy se převezmou a v posledním tasku se smaže.

**Tech Stack:** Rust 1.98 (edition 2024), Tauri 2.12 (pluginy dialog 2.8, single-instance 2, opener 2, clipboard-manager 2), windows 0.62, webview2-com (verze, kterou používá wry z Tauri 2.12), tracing + tracing-subscriber + tracing-appender, url, sys-locale, libmpv shinchiro 20261011; React 19.3, TypeScript 7 (strict), Vite 8, Vitest 5 + @testing-library/react, Zustand, i18next + react-i18next, ESLint 9 (typescript-eslint, eslint-plugin-react-hooks, eslint-plugin-i18next), CSS proměnné + CSS Modules, WebdriverIO + tauri-driver.

**Spec:** `docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md` (hlavně 3, 4, 5, 8, 9.2, 9.3, 10.1, 10.2, 10.6, 10.8, 12, 13, 14) a `docs/m0/report.md` (kapitoly „Review celé větve“ a „Závěr a doporučení pro M1“).

## Pracovní prostor

- Worktree `.claude/worktrees/m1-player`, nová větev `m1-player` z `m0-prototype` (M0 zatím není v `main`; pokud se M0 sloučí dřív, vyjít z `main`).
- Před prvním taskem: `scripts/fetch-libmpv.ps1` a `scripts/fetch-thumbfast.ps1` (stáhnou připnuté verze do `vendor/`).
- Testy se skutečnou libmpv běží s `vo=null`, `ao=null` a dočasnou `config-dir`, pokud task neříká jinak (okno `mpv` potřebuje `vo=gpu-next`; v CI bez GPU běží přes WARP).

## Global Constraints

- libmpv **jen z upstreamu, nikdy fork ani patch**: `mpv-dev-x86_64-20261011-git-accb7b2821.7z` od shinchira (SHA-256 v `scripts/fetch-libmpv.ps1`), varianta x86_64.
- **Tauri 2.x**, React 19, TypeScript strict, Vite, Zustand pro stav, CSS proměnné pro design tokeny + CSS Modules, i18next, npm, Cargo workspace (spec 3).
- **UI nikdy nemluví s mpv přímo**, jen přes typované příkazy a události. **Spouštění procesů a práce se soubory jsou jen v Rustu**; UI nemá přístup k souborovému systému ani k shellu. UI nemůže poslat libovolný příkaz mpv; volná pole se validují v Rustu (4.2, 4.4).
- Výchozí konfigurace mpv: `osc=no`, `vo=gpu-next`, `gpu-api=d3d11`, `target-colorspace-hint=yes`, `hwdec=auto-safe`, `autocreate-playlist=filter`, `save-position-on-quit=yes` (`watch-later-dir` v `state\`), `deinterlace=auto`, `ytdl=yes` (5.2). `screenshot-dir` = cesta Plochy z Tauri.
- libmpv se inicializuje s `config=yes` a `config-dir=%APPDATA%\Kaleido` (5.1). Existující config uživatele (`%APPDATA%\mpv\`, `portable_config`) se **nikdy nemění**.
- Složky přesně podle spec 4.3 (`%APPDATA%\Kaleido\…`, `%LOCALAPPDATA%\Kaleido\{tools,cache,state,logs,crash}`).
- `mpv` dostane jako `wid` HWND hlavního okna; `surface` umisťuje okno třídy `mpv` (5.1).
- **`input.conf` je jediný zdroj pravdy**, i pro zkratky Kaleida: `script-message kaleido <akce>` → `player:message` (5.3). Textová pole klávesy nepřeposílají.
- `time-pos` max. 10×/s; `player:state` je dávka změn (4.4).
- Rozmazání nad videem dělá shader v mpv přes `glsl-shader-opts`; na předky prvků s `backdrop-filter` se **nikdy nedává `transform: scale`** (použít `zoom` nebo nic) (8.2). Snímky obrazovky z vazeb Kaleida sklo neobsahují.
- Texty jen v `locales/cs.json` a `locales/en.json`; ESLint hlídá řetězce napsané natvrdo; data a čísla přes `Intl`; výchozí jazyk podle systému (čeština → čeština, jinak angličtina) (8.8).
- Písmo Segoe UI Variable, záloha Segoe UI; časy `tabular-nums`; velikosti písma 11 / 12 / 13 / 15 / 20 / 28 (8.7).
- Animace ostrůvků a panelů 150–250 ms, pružinová křivka; `prefers-reduced-motion` → jen prolínání (8.6). Ovládání i kurzor se skryjí po **2,5 s** bez pohybu myši (8.4).
- Přístupnost: celé UI ovladatelné klávesnicí s viditelným fokusem, Esc zavře panel nebo lištu, ARIA popisky, `forced-colors` → systémové barvy, měřítko UI 90–150 % přes CSS `zoom` (8.9).
- Zápis `mpv.conf` je šetrný a atomický (8.10).
- Chyby: srozumitelná zpráva CZ/EN, akce k nápravě, rozbalitelné „Podrobnosti“ s úryvkem logu; nic neselže potichu (10.1).
- Výkonnostní limity (13): okno ≤ 500 ms, první snímek ≤ 1 s, CPU v pauze < 1 %, při přehrávání nejvýš +2 p. b. proti mpv a UI nepřekresluje, sklo ≤ 1 ms GPU ve 4K, WebView2 ≤ 200 MB.
- Platforma Windows 10 22H2 / Windows 11, x64; na Windows 10 místo Mica neprůhledné pozadí s gradientem (11.1).
- Rust: edition 2024, `rust-version = "1.90"`, `license = "GPL-3.0-or-later"` v každém manifestu, `cargo fmt --check` a `cargo clippy --all-targets -- -D warnings` čisté. TS: `tsc --noEmit` a `eslint .` čisté.
- Commity: conventional commits, zakončené řádkem `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rozhodnutí plánu

Místa, kde spec nechává volnost nebo kde M0 přineslo nové poznatky. Uživatel je může při review plánu změnit.

1. **Jediná instance a otevírání z příkazové řádky už v M1** (spec je řadí do M4). M0 je má hotové a bez nich by „Odeslat → Kaleido“ otevíralo druhé okno. Registrace přípon, protokol a kontextové menu zůstávají v M4.
2. **Odkazy** v M1 přehrává `ytdl_hook` s yt-dlp z `PATH`, pokud existuje; přímé http(s) odkazy na média fungují i bez něj. Spravovaný yt-dlp a Deno, výběr kvality a třídění chyb streamů jsou M2.
3. **Rychlé nastavení** má v M1 záložky Titulky a Zvuk; Kvalita přijde s `tools` v M2. **Lišta** má v M1 Přehrávač a Nastavení; Obchod a Moje pluginy přidají M2/M3, stránky ROADMAPA M4. Úvodní obrazovka už má kartu „Pokračovat ve sledování“ se štítkem ROADMAPA.
4. **thumbfast** načte Kaleido přímo z přibalené kopie (`load-script`); evidence v `plugins.json` a aktualizace přijdou s essentials v M2. Přepis HDR filtru po `vf set` přes IPC (spec 4.1) zůstává otevřený pro M2.
5. **Snímek, který plugin vyvolá přímo příkazem `screenshot`, sklo obsahuje.** M1 to přijímá a dokumentuje v „O aplikaci“ (otázka 7 z M0).
6. **Shader skla** se jako v M0 generuje za běhu do `%LOCALAPPDATA%\Kaleido\cache\shaders\kaleido-glass.glsl`, ne jako statický soubor v `resources/`.
7. **Kolečko a touchpad:** UI sčítá jemné kroky a mpv pošle krok až po celém zářezu (100 px, 3 řádky nebo 1 stránka) místo `keypress` s měřítkem. Funguje to s jakoukoli verzí mpv.
8. **Přetahování:** `dragDropEnabled=false`. Soubory předá UI přes WebView2 `postMessageWithAdditionalObjects` přímo do Rustu, který z nich čte cesty (UI cesty nevidí); odkazy UI čte z `text/uri-list`. Pokud se to v Task 5 (Rust) a Task 17 (UI) nepodaří, záloha je drop Tauri (jen soubory) a přetažení odkazu se zapíše jako otevřené.
9. **Záložní řešení z M0** (body 1, 5, 6) se neimplementují, protože zatím nic neselhalo. „Snížit průhlednost“ (bez shaderu) a skok + prolnutí mini přehrávače při `prefers-reduced-motion` jsou zároveň hotové záložní cesty pro body 5 a 6.
10. **Typy IPC** se v TS píšou ručně; shodu s Rustem hlídají společné JSON fixtures (Task 13) a `tsc`.
11. **Kaleido vynutí** volby, na kterých stojí UI (`osc=no`, `input-default-bindings=yes`, `input-vo-keyboard=no`, `vo`, `gpu-api`, `watch-later-dir`, `screenshot-dir`, `log-file`, shader skla, thumbfast), i proti `mpv.conf` uživatele. Ostatní volby z 5.2 jdou do výchozího `mpv.conf`, který si uživatel může upravit.

## Review Focus

1. **Cesty s diakritikou, mezerami, delší než 260 znaků a UNC** (`\\server\share\Videa čeština (2026)\žluťoučký kůň.mkv`) se otevřou z příkazové řádky, dialogu i přetažení stejně jako ASCII cesty → test `opens_paths_with_czech_characters_spaces_and_long_names` (Task 4).
2. **Vlastní `mpv.conf` uživatele v rozporu s Kaleidem** (`osc=yes`, `vo=gpu`, `input-default-bindings=no`, `glsl-shaders=…`, profily) nesmí vypnout UI, vstup ani sklo, jeho ostatní volby ale platí → testy `user_config_cannot_turn_off_kaleido_essentials` a `user_mpv_conf_options_still_apply` (Task 2), `user_shaders_and_glass_shader_coexist` (Task 8).
3. **Rychlé dávky vstupu** (podržená klávesa, točení kolečkem, tažení po časové ose) zachovají pořadí a nezahltí mpv ani UI → testy `commands_and_properties_keep_their_order` (Task 2), `seek_drag_sends_throttled_keyframe_seeks_and_one_exact_seek_at_release` (Task 18).
4. **Soubor, který nejde přehrát, uprostřed playlistu** (chybí, je poškozený, nepodporovaný, odkaz vrací 404) → karta chyby a playlist pokračuje → testy `playlist_continues_after_a_broken_file` (Task 4) a `error_card_shows_details_from_log_tail` (Task 19).
5. **Změny stavu okna** (minimalizace a obnovení, změna DPI, změna velikosti v mini režimu, fullscreen z mini režimu) – video nikdy nedostane nulovou velikost ani zmáčknutý obdélník → testy `minimized_window_hides_surface`, `mini_stays_anchored_bottom_right_after_resize`, `mini_shrinks_with_aspect_instead_of_squashing` (Task 6).

---

## Struktura souborů

```
app/
  package.json, package-lock.json, tsconfig.json, vite.config.ts, vitest.setup.ts,
  eslint.config.js, index.html, README.md
  src/
    main.tsx, App.tsx
    ipc/          types.ts, commands.ts, events.ts, contract.test.ts
    state/        playerStore.ts, uiStore.ts, bridge.ts, useInterpolatedTime.ts (+ testy)
    theme/        tokens.ts, useAppearance.ts, global.css, glass.module.css (+ testy)
    i18n/         index.ts, format.ts, locales/cs.json, locales/en.json (+ testy)
    input/        keys.ts, mouse.ts, tracker.ts, wheel.ts, forward.ts (+ testy)
    glass/        regions.ts, useGlassRegion.ts (+ test)
    surface/      mini.ts, useSurfaceLayout.ts (+ test)
    shell/        AppShell.tsx, VideoLayer.tsx, TitleIsland.tsx, WindowIsland.tsx, Sidebar.tsx (+ testy)
    home/         HomeScreen.tsx, PasteField.tsx, useDrop.ts (+ testy)
    player/       PlayerPage.tsx, ControlsIsland.tsx, Seekbar.tsx, ThumbBubble.tsx, VolumeControl.tsx,
                  useAutohide.ts, fullscreen.ts, subMargin.ts, Indicator.tsx, LoadingTitle.tsx,
                  ErrorCard.tsx (+ testy)
    panels/       Popover.tsx, placement.ts, QuickSettings.tsx, PlaylistPanel.tsx (+ testy)
    mini/         MiniPlayer.tsx (+ test)
    settings/     SettingsPage.tsx, descriptors.ts, search.ts, fields/*.tsx,
                  sections/{Playback,Subtitles,Audio,Video,Appearance,Shortcuts,About}.tsx (+ testy)
  src-tauri/
    Cargo.toml (balík `kaleido`, binárka `Kaleido.exe`), build.rs, tauri.conf.json,
    capabilities/default.json, windows-app-manifest.xml, icons/
    src/main.rs, src/lib.rs          sestavení aplikace, směrování zpráv mpv
    src/paths.rs                     složky ze spec 4.3
    src/job.rs                       Job Object: procesy-potomci končí s Kaleidem
    src/commands.rs                  všechny Tauri příkazy (tenké)
    src/player/  mod.rs, engine.rs, options.rs, state.rs, command.rs, load.rs
    src/surface/ mod.rs, layout.rs, win32.rs
    src/input.rs, src/glass.rs, src/thumbs.rs, src/themes.rs
    src/settings/ mod.rs, store.rs, mpv_conf.rs, mpv_keys.rs, input_conf.rs
    src/system/  mod.rs, cli.rs, open_queue.rs, instance.rs, dialog.rs, clipboard.rs, drop.rs,
                 logs.rs, diagnostics.rs
    tests/fixtures/ipc/*.json        smlouva UI ↔ Rust
  resources/defaults/mpv.conf, resources/defaults/input.conf
  resources/licenses/extra.json, resources/licenses/third-party.json (generovaný)
  crates/mpv-ffi/, crates/kaleido-mpv/     beze změny kromě Task 2
  e2e/ wdio.conf.ts, smoke.e2e.ts, make-media.ps1
  scripts/generate-licenses.ps1, scripts/install-local.ps1, scripts/measure.ps1
  docs/m1/checklist.md
```

## Rozhraní UI ↔ Rust

Úplný seznam pro M1 (spec 4.4 ho zpřesňuje). Task, který položku přidá, ji i otestuje; Task 13 ji obalí v TS.

| Příkaz | Argumenty → návrat | Task |
|---|---|---|
| `system_ui_ready` | → `Snapshot` (mapa vlastností) | 5 |
| `player_load` | `sources: string[], mode: LoadMode` → `Result<(), LoadIssue[]>` | 4 |
| `player_command` | `cmd: PlayerCommand` → `Result<(), string>` | 4 |
| `player_input` | `event: InputEvent` | 7 |
| `surface_set_layout` | `layout: Layout` | 6 |
| `surface_set_caption_buttons` | `rects: CaptionButton[]` (jen pokud vyjde hrot Snap Layouts) | 16 |
| `glass_set_regions` | `rects: GlassRect[]` | 8 |
| `thumb_request` / `thumb_clear` / `thumb_get` | `seconds: f64` / – / → binární RGBA | 9 |
| `system_open_dialog` | `purpose: "media" \| "subtitle"` | 5 |
| `system_paste` | → `"played" \| "empty"` | 5 |
| `system_open_text` | `text: string` → `Result<(), LoadIssue>` | 5 |
| `system_open_roadmap` | – | 5 |
| `settings_get` / `settings_set` | – → `Settings` / `patch` → `Result<Settings, SettingsError>` | 10 |
| `settings_get_mpv` / `settings_set_mpv` | – → mapa / `key, value: string \| null` → `Result<(), SettingsError>` | 10 |
| `settings_audio_devices`, `settings_list_shaders`, `system_fonts` | → seznamy | 10 |
| `settings_bindings` / `settings_rebind` / `settings_reset_binding` | → `Binding[]` / `key, newKey` / `key` | 11 |
| `system_diagnostics`, `system_copy_diagnostics`, `system_open_logs`, `system_licenses` | | 12 |
| `system_appearance` | → `SystemAppearance` | 14 |
| `system_locale` | → `string` (BCP 47) | 15 |

| Událost | Obsah | Task |
|---|---|---|
| `player:state` | `{ changes: { [mpvProperty]: Json } }` | 3 |
| `player:file-loaded` | `{}` | 3 |
| `player:end-file` | `{ reason: "eof" \| "stop" \| "quit" \| "error" \| "redirect", error: string \| null }` | 3 |
| `player:message` | `{ args: string[] }` (bez úvodního `kaleido`) | 3 |
| `player:log` | `{ level, prefix, text }` (jen `warn`, `error`, `fatal`) | 3 |
| `player:thumb` | `{ width, height, seq }` | 9 |
| `glass:state` | `{ enabled, reason: "user" \| "system" \| "gpuFailure" \| null }` | 8 |
| `system:open-request` | `{ count }` | 5 |
| `system:paste-empty` | `{}` | 5 |
| `settings:changed` | `Settings` | 10 |
| `system:appearance-changed` | `SystemAppearance` | 14 |

Serde: struktury `rename_all = "camelCase"`, výčty s daty `tag = "type"`; názvy vlastností mpv zůstávají v kebab-case.

---

### Task 1: Kostra aplikace

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.setup.ts`, `eslint.config.js`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Create: `src-tauri/Cargo.toml`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `windows-app-manifest.xml` (převzít z `prototype/src-tauri/`), `icons/` (kopie z prototypu), `src/main.rs`, `src/lib.rs`, `src/paths.rs`, `src/job.rs`
- Modify: `Cargo.toml` (workspace `members` + `"src-tauri"`), `.gitignore` (`/dist/`, `/src-tauri/gen/`), `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `paths::AppPaths { config_dir, local_dir, state_dir, watch_later_dir, logs_dir, cache_dir, crash_dir, resource_dir, desktop_dir, exe_dir: PathBuf }`; `AppPaths::from_roots(roaming: &Path, local: &Path, resources: &Path, desktop: &Path, exe_dir: &Path) -> AppPaths`; `AppPaths::resolve(app: &tauri::AppHandle) -> anyhow::Result<AppPaths>`; `AppPaths::ensure_dirs(&self) -> std::io::Result<()>`.
- Produces: `job::Job::kill_on_close() -> windows::core::Result<Job>`, `Job::assign(&self, process: HANDLE) -> windows::core::Result<()>`, `job::bind_children_to_this_process() -> windows::core::Result<()>` (vytvoří Job s `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, přiřadí aktuální proces a handle záměrně nechá otevřený do konce procesu).
- `lib.rs`: `pub fn run()`; `main.rs` jen volá `kaleido::run()`.

- [ ] **Step 1: Napsat selhávající testy `paths.rs` a `job.rs`**

```rust
#[test]
fn from_roots_places_every_folder_like_spec_4_3() {
    let p = AppPaths::from_roots(Path::new("R"), Path::new("L"), Path::new("res"), Path::new("D"), Path::new("E"));
    assert_eq!(p.config_dir, Path::new("R/Kaleido"));
    assert_eq!(p.local_dir, Path::new("L/Kaleido"));
    assert_eq!(p.state_dir, Path::new("L/Kaleido/state"));
    assert_eq!(p.watch_later_dir, Path::new("L/Kaleido/state/watch_later"));
    assert_eq!(p.logs_dir, Path::new("L/Kaleido/logs"));
    assert_eq!(p.cache_dir, Path::new("L/Kaleido/cache"));
    assert_eq!(p.crash_dir, Path::new("L/Kaleido/crash"));
}
#[test] fn ensure_dirs_creates_missing_folders_and_keeps_existing_files() // soubor v config_dir přežije
#[test] fn dropping_the_job_kills_assigned_processes() // `cmd /c ping -n 30 127.0.0.1` v Jobu; po drop skončí do 2 s
```

- [ ] **Step 2: Spustit testy, ověřit selhání**

Run: `cargo test -p kaleido`
Expected: FAIL (chybí `AppPaths`, `Job`)

- [ ] **Step 3: Implementovat `paths.rs`, `job.rs` a kostru aplikace**

- `tauri.conf.json`: `productName: "Kaleido"`, `mainBinaryName: "Kaleido"`, `identifier: "com.sth3no.kaleido"`; okno `main` 1280×720, min 640×360, `decorations: false`, `transparent: true`, `dragDropEnabled: false`; `bundle.active: false` (instalátor je M4); `bundle.resources`: `../resources/defaults/` → `defaults/`, `../vendor/thumbfast/thumbfast.lua` → `essentials/thumbfast.lua`, `../resources/licenses/` → `licenses/`; `build.beforeDevCommand: "cargo build -p kaleido-mpv && npm run dev"`, `beforeBuildCommand: "npm run build"`, `devUrl: "http://localhost:1420"`, `frontendDist: "../dist"`.
- `build.rs` vloží `windows-app-manifest.xml` (UTF-8 `activeCodePage`, jako v prototypu, commit `296fd93`).
- `run()`: na začátku `job::bind_children_to_this_process()`, pak Tauri builder.
- `index.html` + `src/App.tsx`: neprůhledné tmavé pozadí `#0e0e12` (5.1: než je video načtené, UI kreslí neprůhledné pozadí).
- `eslint.config.js`: typescript-eslint `strict`, `react-hooks`, `i18next/no-literal-string` (`mode: "jsx-only"`) už od začátku.
- `package.json` skripty: `dev`, `build` (`tsc --noEmit && vite build`), `test` (`vitest run`), `lint` (`eslint .`), `tauri`.
- CI: job `ui` (`npm ci`, `npm run lint`, `npm test`, `npm run build`) a job `app` (fetch libmpv + thumbfast, `cargo clippy -p kaleido --all-targets -- -D warnings`, `cargo test -p kaleido`). Job `prototype` zůstává do Task 24.

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido && npm run lint && npm run build`
Expected: PASS. Ruční: `npm run tauri dev` otevře okno bez rámečku s tmavým pozadím.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.setup.ts eslint.config.js index.html src src-tauri Cargo.toml Cargo.lock .gitignore .github/workflows/ci.yml
git commit -m "feat(app): Tauri 2 shell with spec folders and child processes bound to the app"
```

---

### Task 2: Engine – vlákna, fronta, vynucené volby, výchozí config

**Files:**
- Create: `src-tauri/src/player/mod.rs`, `engine.rs`, `options.rs`; `resources/defaults/mpv.conf`, `resources/defaults/input.conf`
- Modify: `crates/mpv-ffi/src/lib.rs` (`KALEIDO_LIBMPV` a záložní cesta do `vendor/` jen v `cfg(debug_assertions)`), `src-tauri/src/lib.rs` (spuštění enginu, zavření okna)

**Interfaces:**
- Consumes: `AppPaths` (Task 1).
- Produces:
  - `EngineConfig { paths: AppPaths, wid: Option<isize>, vo: String, ao: Option<String> }` (aplikace: `vo = "gpu-next"`, `ao = None`; testy `"null"`).
  - `trait EventLoop: Send + 'static { fn on_event(&mut self, mpv: &Mpv, event: Event); fn on_idle(&mut self, mpv: &Mpv) -> Option<Duration>; }`. Vlákno událostí: `wait_event(timeout)`, kde timeout je poslední návrat `on_idle` (`None` = čekat bez limitu). Po každé události vyprázdní frontu přes `wait_event(0)` a pak zavolá `on_idle`. `Event::Shutdown` předá a skončí.
  - `Engine::start(cfg: EngineConfig, events: impl EventLoop) -> mpv_ffi::Result<Engine>`
  - `enum Request { Command(Vec<String>), SetProperty { name: String, value: String }, Call(Box<dyn FnOnce(&Mpv) + Send>) }`; `Engine::request(&self, r: Request)` (neblokuje), `Engine::command(&self, args: &[&str])`, `Engine::call<T: Send + 'static>(&self, f: impl FnOnce(&Mpv) -> T + Send + 'static) -> T` (blokuje, běží ve stejné frontě).
  - `Engine::quit(&self, timeout: Duration) -> bool` (pošle `quit`, mpv uloží pozici; čeká na `Shutdown`).
  - `options::enforced(cfg: &EngineConfig) -> Vec<(&'static str, String)>`, `options::reassert(mpv: &Mpv, cfg: &EngineConfig) -> mpv_ffi::Result<()>`, `options::ensure_defaults(paths: &AppPaths) -> std::io::Result<()>`.
- Vynucené volby před `initialize`: `config=yes`, `config-dir`, `wid` (je-li), `vo`, `ao` (je-li), `gpu-api=d3d11`, `osc=no`, `input-default-bindings=yes`, `input-vo-keyboard=no`, `terminal=no`, `force-window=yes`, `idle=yes`, `watch-later-dir`, `screenshot-dir`, `log-file=<logs_dir>/mpv.log`. Po `initialize` `reassert` přečte `osc`, `input-default-bindings`, `input-vo-keyboard`, `gpu-api`, `vo`, `watch-later-dir`, `screenshot-dir` a ty, které `mpv.conf` přepsal, nastaví zpět (`gpu-api` před `vo`).
- `resources/defaults/mpv.conf` (jen volby, které si uživatel smí změnit):

```
# Kaleido – výchozí nastavení mpv. Kaleido mění jen klíče, které spravuje.
target-colorspace-hint=yes
hwdec=auto-safe
autocreate-playlist=filter
save-position-on-quit=yes
deinterlace=auto
keep-open=yes
ytdl=yes
```

- `resources/defaults/input.conf` (přepisuje jen tyto vestavěné vazby, ostatní vazby mpv platí dál):

```
# Kaleido – výchozí zkratky. Akce Kaleida jdou přes script-message kaleido <akce>.
RIGHT no-osd seek 5; script-message kaleido osd seek
LEFT no-osd seek -5; script-message kaleido osd seek
UP no-osd seek 60; script-message kaleido osd seek
DOWN no-osd seek -60; script-message kaleido osd seek
Shift+RIGHT no-osd seek 1 exact; script-message kaleido osd seek
Shift+LEFT no-osd seek -1 exact; script-message kaleido osd seek
9 no-osd add volume -2; script-message kaleido osd volume
0 no-osd add volume 2; script-message kaleido osd volume
/ no-osd add volume -2; script-message kaleido osd volume
* no-osd add volume 2; script-message kaleido osd volume
WHEEL_UP no-osd add volume 2; script-message kaleido osd volume
WHEEL_DOWN no-osd add volume -2; script-message kaleido osd volume
m no-osd cycle mute; script-message kaleido osd volume
[ no-osd multiply speed 1/1.1; script-message kaleido osd speed
] no-osd multiply speed 1.1; script-message kaleido osd speed
{ no-osd multiply speed 0.5; script-message kaleido osd speed
} no-osd multiply speed 2.0; script-message kaleido osd speed
BS no-osd set speed 1.0; script-message kaleido osd speed
s script-message kaleido screenshot subtitles
S script-message kaleido screenshot video
Ctrl+s script-message kaleido screenshot window
Alt+s script-message kaleido screenshot each-frame
Ctrl+v script-message kaleido paste
Ctrl+o script-message kaleido open
```

- [ ] **Step 1: Napsat selhávající testy (skutečná libmpv)**

```rust
#[test] fn defaults_are_copied_once_and_never_overwritten() // upravený mpv.conf přežije druhé ensure_defaults
#[test] fn default_input_conf_routes_kaleido_actions() // s/S/Ctrl+s/Alt+s → "script-message kaleido screenshot <subtitles|video|window|each-frame>", Ctrl+v → paste, Ctrl+o → open; každá vazba hlasitosti/přetáčení/rychlosti začíná "no-osd"
#[test]
fn user_config_cannot_turn_off_kaleido_essentials() {
    // config_dir/mpv.conf: "osc=yes\ninput-default-bindings=no\ninput-vo-keyboard=yes\nwatch-later-dir=C:/x\n"
    assert!(!mpv.get_flag("osc").unwrap());
    assert!(mpv.get_flag("input-default-bindings").unwrap());
    assert!(!mpv.get_flag("input-vo-keyboard").unwrap());
    assert_eq!(mpv.get_string("watch-later-dir").unwrap(), paths.watch_later_dir.to_string_lossy());
}
#[test] fn user_mpv_conf_options_still_apply() // "volume=37" → get_f64("volume") == 37.0
#[test]
fn commands_and_properties_keep_their_order() {
    // request: SetProperty speed=1.5, Command ["add","speed","0.5"], Command ["multiply","speed","2"]
    assert_eq!(engine.call(|m| m.get_f64("speed").unwrap()), 4.0);
}
#[test] fn quit_shuts_the_engine_down_within_2_s() // quit(2 s) == true, EventLoop dostala Shutdown, drop nevisí
#[test] fn lua_scripts_see_utf8_paths_from_the_environment() // převzít z prototype/src-tauri/src/main.rs (+ ignorovaný pomocný test)
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido player::`
Expected: FAIL (chybí `Engine`)

- [ ] **Step 3: Implementovat `engine.rs`, `options.rs` a úpravu `mpv-ffi`**

Fronta je `std::sync::mpsc` do vlákna příkazů, které vlastní `Arc<Mpv>` spolu s vláknem událostí; Tauri příkazy nikdy nevolají mpv z hlavního vlákna (M0 review). `lib.rs`: `WindowEvent::CloseRequested` → `prevent_close`, `engine.quit(2 s)`, pak `app.exit(0)`; `Shutdown` z mpv (klávesa `q`) → `app.exit(0)`.

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido player:: && cargo test -p mpv-ffi`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri resources/defaults crates/mpv-ffi/src/lib.rs
git commit -m "feat(player): engine threads, ordered request queue and enforced mpv options"
```

---

### Task 3: Stav a události přehrávače

**Files:**
- Create: `src-tauri/src/player/state.rs`
- Modify: `src-tauri/src/player/mod.rs`, `src-tauri/src/lib.rs` (`AppSink`)

**Interfaces:**
- Consumes: `EventLoop`, `Engine` (Task 2).
- Produces:
  - `OBSERVED: &[(&str, PropertyKind)]`: `pause`, `time-pos`, `duration`, `volume`, `volume-max`, `mute`, `speed`, `media-title`, `playlist`, `playlist-pos`, `track-list`, `chapter-list`, `chapter`, `video-params`, `osd-dimensions`, `fullscreen`, `ontop`, `idle-active`, `eof-reached`, `paused-for-cache`, `seeking`, `sub-delay`, `sub-scale`, `audio-delay`, `aid`, `sid`, `vid`, `hwdec-current`.
  - `JSON_PROPERTIES = ["playlist", "track-list", "chapter-list", "video-params", "osd-dimensions"]`: sledují se jako `String` a Rust je parsuje na `serde_json::Value`; chyba parsování → `null` + `tracing::warn!`.
  - `#[derive(Serialize)] enum PlayerEvent { State { changes: BTreeMap<String, Value> }, FileLoaded, EndFile { reason: EndReason, error: Option<String> }, Message { args: Vec<String> }, Log(LogLine), ThumbRendered(String), Shutdown }`, `PlayerEvent::channel(&self) -> Option<&'static str>` (`Some("player:state")`, …; `ThumbRendered` a `Shutdown` jsou jen pro Rust → `None`); `LogLine { level, prefix, text }`.
  - `trait EventSink: Send + Sync + 'static { fn emit(&self, event: PlayerEvent); }`
  - `StateLoop<S: EventSink>` implementuje `EventLoop`: `on_event` sbírá změny do dávky, `on_idle` dávku pošle a vrátí, kdy je splatná podržená hodnota `time-pos`.
  - `Throttle<T>` (převzít z `prototype/src-tauri/src/engine.rs` i s testy, interval 100 ms).
  - Klientské zprávy: `["kaleido", …]` → `Message { args: zbytek }`; `["thumbfast-render", json]` → `ThumbRendered(json)`; ostatní zahodit. Log: dál jdou jen `warn`, `error`, `fatal` (`request_log_messages("warn")`).
  - `snapshot(mpv: &Mpv) -> BTreeMap<String, Value>` (všechny `OBSERVED`, JSON vlastnosti parsované).
  - `lib.rs`: `AppSink { app }` emituje vše do UI; směrování vybraných zpráv do Rustu přidají Task 5, 8 a 9 ve funkci `route(app, &PlayerEvent) -> bool` (true = vyřízeno v Rustu).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn throttle_keeps_the_latest_time_pos() // převzaté testy Throttle
#[test] fn batch_merges_changes_from_one_drain() // pause, volume=10, volume=20 → jedna State { pause, volume: 20 }
#[test] fn time_pos_is_sent_at_most_10_per_second() // time-pos každých 10 ms po 200 ms → ≤ 3 dávky s time-pos, poslední hodnota dorazí po on_idle deadline
#[test] fn client_messages_only_for_kaleido() // ["kaleido","osd","volume"] → Message{args:["osd","volume"]}; ["other","x"] → nic
#[test] fn list_properties_arrive_as_json() // skutečná libmpv + y4m klip: changes["track-list"][0]["type"] == "video"
#[test] fn end_file_carries_reason_and_error() // neexistující soubor → EndFile { reason: Error, error: Some(_) }
#[test] fn snapshot_reports_current_values() // volume=42 → snapshot["volume"] == 42.0
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido player::state`
Expected: FAIL

- [ ] **Step 3: Implementovat `state.rs` a `AppSink`**

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido player::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(player): batched player:state events, throttled time-pos, messages and logs"
```

---

### Task 4: Typované příkazy a otevírání zdrojů

**Files:**
- Create: `src-tauri/src/player/command.rs`, `src-tauri/src/player/load.rs`, `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (registrace příkazů)

**Interfaces:**
- Consumes: `Engine` (Task 2), `Snapshot`/`PlayerEvent` (Task 3).
- Produces:
  - `enum PlayerCommand` (`tag = "type"`): `TogglePause`, `SetPause { paused }`, `Seek { target: f64, mode: SeekMode, exact: bool }`, `SetVolume { volume }`, `SetMute { muted }`, `SetSpeed { speed }`, `SelectTrack { kind: TrackKind, id: Option<i64> }`, `SetSubDelay { seconds }`, `SetSubScale { scale }`, `SetAudioDelay { seconds }`, `SetSubMargin { margin: i64 }`, `PlaylistNext`, `PlaylistPrev`, `PlaylistPlay { index }`, `PlaylistRemove { index }`, `PlaylistMove { from, to }`, `Screenshot { mode: ScreenshotMode }`, `SetFullscreen { on }`, `SetOntop { on }`, `Stop`.
  - `SeekMode { Absolute, Relative, AbsolutePercent }`, `TrackKind { Audio, Sub, Video }`, `ScreenshotMode { Subtitles, Video, Window, EachFrame }`.
  - `to_mpv(cmd: &PlayerCommand) -> Result<Vec<Vec<String>>, CommandError>`. Meze: čísla konečná; hlasitost 0–1000; rychlost 0,01–100; `sub-scale` 0,1–10; zpoždění ±600 s; `sub-margin-y` 0–720. `SelectTrack { id: None }` → `set aid|sid|vid no`. `PlaylistMove { from, to }` znamená „po přesunu je položka na indexu `to`“ (mpv: `playlist-move from to+1` při posunu dolů). `Screenshot` sem nepatří (Task 8), `to_mpv` vrátí `CommandError::Routed`.
  - `enum Source { File(PathBuf), Url(url::Url) }`, `enum SourceError { NotFound, Protocol, Invalid }`, `parse_source(raw: &str, cwd: &Path) -> Result<Source, SourceError>`: URL jen `http`/`https`; cokoli jiného se schématem `xxx://` (`file`, `edl`, `lavfi`, `av`, `ytdl`, `memory`, `fd`, …) → `Protocol`; jinak lokální cesta (absolutní, relativní k `cwd`, UNC, `\\?\`), která existuje jako soubor nebo složka, jinak `NotFound`.
  - `LoadMode { Replace, Append }`, `LoadOptions { start: Option<f64>, format: Option<String> }` + `LoadOptions::validate(&self) -> Result<(), SourceError>`: `start` ≥ 0 a konečné; `format` 1–200 znaků z `[A-Za-z0-9_+\-/*\[\]<>=!~^$?.:()]` (bez čárky, mezer a uvozovek).
  - `load_commands(sources: &[Source], mode: LoadMode, opts: &LoadOptions) -> Vec<Vec<String>>`: první zdroj `loadfile <src> replace|append-play -1 <volby>`, další `append`; volby `start=%N%…`, `ytdl-format=%N%…` (délkové uvozovky mpv); po `replace` `set pause no` (spec 9.3).
  - `link_from_text(text: &str) -> Option<Url>`: přesně jeden řádek, po ořezání celý jeden http(s) odkaz.
  - Tauri: `player_command(cmd)`, `player_load(sources: Vec<String>, mode: LoadMode) -> Result<(), Vec<LoadIssue>>`, `LoadIssue { source: String, kind: SourceError }` (při chybě některého zdroje se ostatní otevřou).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn seek_modes_map_to_mpv_flags() // Relative+exact → ["seek","10","relative+exact"]; Absolute → "absolute+keyframes"
#[test] fn invalid_numbers_are_rejected() // NaN, ∞, volume 5000, speed 0
#[test] fn track_off_maps_to_no()
#[test] fn sources_accept_only_local_paths_and_http_urls() // tabulka: https ok, http ok, file:/// Protocol, edl:// Protocol, lavfi:// Protocol, ytdl:// Protocol, chybějící NotFound, relativní existující ok, složka ok
#[test] fn percent_quoting_keeps_valid_formats_intact() // "bv*[height<=?1080]+ba/b" → "ytdl-format=%22%bv*[height<=?1080]+ba/b"
#[test] fn formats_that_could_inject_options_are_rejected() // "best,vo=gpu", "a b", "\"x\""
#[test] fn link_from_text_takes_one_clean_http_link() // "  https://youtu.be/x \n" ok; "viz https://x" None; dva řádky None; "file:///C:/a" None
// skutečná libmpv:
#[test] fn playlist_move_matches_spec_semantics() // [a,b,c] + Move{0,2} → [b,c,a]
#[test] fn start_option_starts_playback_there() // klip 10 s, start=4 → po FileLoaded time-pos ≥ 3.9
#[test] fn opening_a_file_resumes_a_paused_player() // převzít z prototype open_requests.rs
#[test] fn opens_paths_with_czech_characters_spaces_and_long_names() // složka "Videa čeština (2026)" + cesta > 260 znaků → FileLoaded
#[test] fn playlist_continues_after_a_broken_file() // [náhodné bajty .mkv, dobrý .y4m] → EndFile{Error} a pak FileLoaded
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido player::command player::load`
Expected: FAIL

- [ ] **Step 3: Implementovat `command.rs`, `load.rs`, `commands.rs`**

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido player::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(player): typed player commands and validated sources for loadfile"
```

---

### Task 5: Požadavky na otevření – příkazová řádka, jediná instance, dialog, schránka, přetažení

**Files:**
- Create: `src-tauri/src/system/mod.rs`, `cli.rs`, `open_queue.rs`, `instance.rs`, `dialog.rs`, `clipboard.rs`, `drop.rs`
- Modify: `src-tauri/Cargo.toml` (`tauri-plugin-single-instance`, `tauri-plugin-dialog`, `tauri-plugin-clipboard-manager`, `tauri-plugin-opener`, `webview2-com`), `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `Source`, `LoadMode`, `LoadOptions`, `parse_source`, `load_commands`, `link_from_text` (Task 4), `Engine`, `snapshot` (Task 2–3).
- Produces:
  - `cli::parse(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> CliRequest` (bez názvu programu), `CliRequest { mode: Option<LoadMode>, options: LoadOptions, sources: Vec<Source>, rejected: Vec<(String, SourceError)> }`: `--append` → `Some(Append)`, `--start=<s>`, `--format=<f>`, `--` ukončí volby; neznámé `--x` se zaloguje a ignoruje (spec 9.2).
  - `OpenRequest { sources, mode: Option<LoadMode>, options }`, `Batch { sources, mode: LoadMode, options }`; `OpenQueue::new(join_window: Duration)` (300 ms); `submit(&self, now: Instant, req: OpenRequest, default_mode: LoadMode) -> Option<Batch>`; `ui_ready(&self, now: Instant, default_mode: LoadMode) -> Vec<Batch>`. Dokud UI není připravené, požadavky čekají. Požadavek do 300 ms po předchozím se přidá do playlistu (`Append`); jinak platí `req.mode`, nebo `default_mode` (nastavení „chování při otevření souboru za běhu“, do Task 10 `Replace`) (spec 9.3).
  - `instance::plugin() -> TauriPlugin<Wry>`: argumenty další instance → `cli::parse` s jejím `cwd` → `submit` → obnovit (`unminimize`), zobrazit a aktivovat okno, emitovat `system:open-request { count }`.
  - Tauri: `system_ui_ready() -> Snapshot` (označí UI připravené, předá čekající dávky, vrátí `snapshot`), `system_open_dialog(purpose: DialogPurpose)` (`Media` → filtr přípon videa, zvuku a playlistů z 8.12 + „Všechny soubory“, otevře podle nastavení; `Subtitle` → `srt, ass, ssa, vtt, sub, sup, idx` → `sub-add <cesta> select`), `system_paste() -> PasteOutcome { Played, Empty }` (text schránky přes `link_from_text`), `system_open_text(text) -> Result<(), LoadIssue>`, `system_open_roadmap()` (otevře `ROADMAP_URL` přes opener).
  - `const ROADMAP_URL: &str = "https://github.com/sth3no/Kaleido/projects"` v `system/mod.rs` (spec 11.7: veřejný GitHub Project v repu Kaleido; stránka projektů repa ho ukáže, jakmile vznikne).
  - Směrování v `route`: `Message ["paste"]` → `system_paste`, při `Empty` emit `system:paste-empty`; `Message ["open"]` → dialog `Media`.
  - `drop::install(webview: &tauri::Webview) -> anyhow::Result<()>`: obsluha WebView2 `WebMessageReceived` pro zprávu `"kaleido:drop"`; z `ICoreWebView2WebMessageReceivedEventArgs2::AdditionalObjects` čte `ICoreWebView2File::Path` → `parse_source` → `submit`. `drop::sources_from_paths(paths: Vec<PathBuf>) -> Vec<Source>`.

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn cli_flags_and_sources() // ["--append","--start=12.5","--format=bv*+ba/b","a.mkv","https://x/y"] → Append, start 12.5, format, 2 zdroje
#[test] fn cli_double_dash_allows_dash_names() // převzít z prototype
#[test] fn cli_rejects_protocols_but_keeps_the_rest() // ["edl://x","a.mkv"] → 1 zdroj, 1 rejected Protocol
#[test] fn queue_waits_for_the_ui() // převzít z prototype
#[test] fn requests_within_300_ms_join_one_playlist() // t=0 a t=120 ms → druhý Batch má Append
#[test] fn later_requests_follow_the_open_while_playing_setting() // t=0 a t=900 ms, default Append → Append; mode=Some(Replace) vyhraje
#[test] fn sources_from_paths_keep_files_and_folders() // drop: soubor, složka, chybějící → 2 zdroje
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido system::`
Expected: FAIL

- [ ] **Step 3: Implementovat modul `system` (bez `logs`, `diagnostics`)**

`drop.rs` je hrot (rozhodnutí 8): přes `webview.with_webview(|w| w.controller())` dostat `ICoreWebView2`, přidat `add_WebMessageReceived` a zprávy jiné než `"kaleido:drop"` nechat být (IPC Tauri má vlastní obsluhu). Pokud API z Tauri 2.12 / webview2-com nejde použít, přepnout `dragDropEnabled` na `true`, obsloužit `WindowEvent::DragDrop` přes `sources_from_paths` a do `docs/m1/checklist.md` zapsat, že přetažení odkazu zatím nefunguje.

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido system::`
Expected: PASS. Ruční: `Kaleido.exe "<cesta s diakritikou>.mkv"` přehraje soubor; druhé spuštění s jiným souborem ho otevře ve stejném okně.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(system): command line, single instance, open dialog, paste and drop into the player"
```

---

### Task 6: Surface – okno mpv, mini obdélník, fullscreen a „vždy navrchu“

**Files:**
- Create: `src-tauri/src/surface/mod.rs`, `layout.rs`, `win32.rs` (převzít z `prototype/src-tauri/src/surface.rs` včetně testů se skutečnou libmpv)
- Modify: `src-tauri/src/lib.rs` (události okna), `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `Engine` (Task 2), `player:state` `fullscreen`/`ontop` (Task 3).
- Produces:
  - `enum Layout` (`tag = "kind"`): `Full`, `Rect { x, y, w, h }` (CSS px, snímky animace), `Mini { w, h, right, bottom }` (CSS px, ukotvené vpravo dole), `Hidden`.
  - `to_physical(layout: Layout, client_w: u32, client_h: u32, scale: f64) -> Option<PxRect>`: `Mini` se po změně velikosti okna drží v rohu; když se nevejde, zmenší se se zachováním poměru stran (nikdy nezmáčkne); minimalizované okno nebo nulová plocha → `None` (skrýt).
  - `win32::{find_child, place, pin}` (převzato; `pin` obaluje proceduru okna `mpv` a ve `WM_WINDOWPOSCHANGED` vrací obdélník), `Surface::new(main: isize)`, `Surface::apply(&self, client_w, client_h, scale)`, `Surface::set_layout(&self, layout)`.
  - `FullscreenSync` (čistý stav): `mpv_changed(on) -> Option<SyncAction>`, `window_changed(on) -> Option<SyncAction>`, `SyncAction { SetWindow(bool), SetMpv(bool) }`. Ozvěna vlastní akce se ignoruje. Stejný typ pro `ontop` (`set_always_on_top`).
  - Tauri: `surface_set_layout(layout)`; `WindowEvent::Resized` / `ScaleFactorChanged` → `apply`.

- [ ] **Step 1: Napsat selhávající testy**

```rust
// převzaté: full_covers_the_client_area, rect_is_scaled_and_rounded, rect_is_clamped_to_the_client_area,
// minimized_window_hides_surface, rect_outside_the_window_hides_surface, hidden_is_hidden,
// finds_and_places_a_child_window_by_class, surface_moves_the_window_libmpv_creates_inside_wid,
// mini_player_survives_moving_and_resizing_the_window
#[test] fn mini_stays_anchored_bottom_right_after_resize() // Mini{360,202,16,16} v 1280×720 a pak 1600×900 → x = šířka − 16 − 360
#[test] fn mini_shrinks_with_aspect_instead_of_squashing() // okno 300×200 → w/h == 360/202 ± 1 px
#[test] fn fullscreen_sync_ignores_its_own_echo() // mpv_changed(true) → SetWindow(true); window_changed(true) → None; window_changed(false) → SetMpv(false)
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido surface::`
Expected: FAIL

- [ ] **Step 3: Implementovat `surface`**

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido surface::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(surface): place mpv's window for full, animated and anchored mini layouts"
```

---

### Task 7: Vstup

**Files:**
- Create: `src-tauri/src/input.rs` (převzít z prototypu), `src/input/keys.ts`, `mouse.ts`, `tracker.ts` (převzít i s testy), `src/input/wheel.ts`, `src/input/forward.ts` (+ testy)
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `Engine::request` (Task 2).
- Produces:
  - Rust: `InputEvent` (`tag = "type"`): `KeyDown { key }`, `KeyUp { key }`, `MouseMove { x, y }` (fyzické px okna `mpv`), `ButtonDown { button }`, `ButtonUp { button }`, `Wheel { key, steps: u8 }`; `to_commands(event: &InputEvent) -> Vec<Vec<String>>` (prázdné = nepovoleno). `Wheel` pošle `keypress <key>` `steps`krát, nejvýš 10krát. `pub fn valid_key(key: &str) -> bool` (použije i Task 11). Tauri `player_input(event)` jde frontou enginu (pořadí `keydown`/`keyup` zachováno). Proti M0 odpadá `DoubleClick`: mpv si dvojklik skládá samo (`SEND_EXPLICIT_DOUBLE_CLICK = false`).
  - TS: `WheelAccumulator.push(e: { deltaX: number; deltaY: number; deltaMode: number }): { key: 'WHEEL_UP' | 'WHEEL_DOWN' | 'WHEEL_LEFT' | 'WHEEL_RIGHT'; steps: number } | null` (zářez = 100 px / 3 řádky / 1 stránka, zbytek se drží, změna směru ho vynuluje).
  - TS: `shouldForward(e: KeyboardEvent): boolean`: false pro cíl `input`/`textarea`/`select`/`contenteditable`, `e.isComposing`, `e.defaultPrevented` (klávesu už obsloužil fokusovaný prvek UI, např. časová osa nebo panel), `Alt+F4`, `Alt+Space`, `Alt+Tab` a kombinace s klávesou Win. U přeposlaných kláves `preventDefault`. Posluchač na `window` běží ve fázi bublání, aby prvky UI měly přednost.
  - TS: `attachVideoInput(el: HTMLElement): () => void` (myš, tlačítka, kolečko z vrstvy videa; klávesnice z `window`).

- [ ] **Step 1: Napsat selhávající testy**

```ts
// převzaté: keys.test.ts (česká klávesnice, AltGr, numerický blok), mouse.test.ts, tracker.test.ts (zaseknuté klávesy)
test('wheel accumulates touchpad deltas into whole steps', () => {
  const w = new WheelAccumulator();
  expect(w.push({ deltaX: 0, deltaY: -30, deltaMode: 0 })).toBeNull();
  expect(w.push({ deltaX: 0, deltaY: -30, deltaMode: 0 })).toBeNull();
  expect(w.push({ deltaX: 0, deltaY: -40, deltaMode: 0 })).toEqual({ key: 'WHEEL_UP', steps: 1 });
});
test('a change of direction drops the leftover', /* -60 px, pak +60 px → null */);
test('system shortcuts are not forwarded', /* Alt+F4, Alt+Space → false */);
test('typing in text fields is not forwarded', /* cíl <input> → false */);
test('keys a focused control handled are not forwarded', /* defaultPrevented → false */);
```

```rust
// převzaté: keys_map_to_keydown_and_keyup, malformed_key_names_are_rejected, mouse_moves_and_known_buttons
#[test] fn wheel_steps_repeat_keypress_and_are_capped() // steps 3 → 3× keypress; steps 50 → 10×
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/input && cargo test -p kaleido input::`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/input && cargo test -p kaleido input::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src src-tauri/src
git commit -m "feat(input): forward unhandled keys, mouse and whole wheel steps to mpv in order"
```

---

### Task 8: Sklo nad videem a snímky obrazovky

**Files:**
- Create: `src-tauri/src/glass.rs` (převzít generátor a `shader_opts` i s testy)
- Modify: `src-tauri/src/lib.rs` (`route`), `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `Engine`, `PlayerEvent::{Message, Log}`, `osd-dimensions` (Task 2–3), `ScreenshotMode` (Task 4).
- Produces:
  - Převzato: `GlassRect { x, y, w, h, r }` (CSS px), `OutputOrigin`, `MAX_REGIONS = 6`, `SHADER = "kaleido-glass"`, `OUTPUT_EXCLUDES_MARGINS = true`, `shader_opts(rects, scale, origin) -> String`, `shader_source() -> String`.
  - `GlassController::new(engine, shader_path: PathBuf)`. Při startu zapíše shader do `cache_dir/shaders/kaleido-glass.glsl` a připojí ho `change-list glsl-shaders append`.
  - `set_regions(&self, rects: Vec<GlassRect>)`, `set_scale(&self, scale: f64)` (při `ScaleFactorChanged`), `set_origin(&self, osd: &Value)` (z `osd-dimensions`).
  - `set_enabled(&self, on: bool, reason: GlassReason)`: vypnutí shader odebere (`change-list glsl-shaders remove`), aby nestál GPU; emituje `glass:state`.
  - `screenshot(&self, mode: ScreenshotMode)`: vynulovat oblasti → `screenshot <mode>` → vrátit. `EachFrame` je přepínač a sklo zůstane vynulované, dokud je zapnutý.
  - `screenshot_sequence(current: &str, zeroed: &str, mode: ScreenshotMode) -> Vec<Vec<String>>` (čistá funkce pro test), `is_glass_failure(line: &LogLine) -> bool` (úroveň `error`/`fatal`, prefix začíná `vo/gpu-next`, text obsahuje `kaleido-glass`).
  - Směrování: `Message ["screenshot", mode]` → `screenshot`; `Log` → při `is_glass_failure` jednou `set_enabled(false, GpuFailure)` + `tracing::error!` (spec 10.6). `PlayerCommand::Screenshot` z UI jde stejnou cestou.
  - Tauri: `glass_set_regions(rects)`.

- [ ] **Step 1: Napsat selhávající testy**

```rust
// převzaté: no_rects_disables_every_region, rects_are_scaled_offset_and_radius_clamped,
// regions_beyond_the_limit_are_dropped, shader_declares_every_param_and_three_passes
#[test] fn screenshot_suspends_glass_around_the_command() // [set glsl-shader-opts <nuly>, screenshot video, set glsl-shader-opts <původní>]
#[test] fn each_frame_keeps_glass_off_until_toggled_again()
#[test] fn shader_errors_switch_glass_off_once() // dvě chybové řádky → jeden glass:state { enabled: false, reason: "gpuFailure" }
#[test] fn user_shaders_and_glass_shader_coexist() // skutečná libmpv; mpv.conf glsl-shaders=~~/shaders/user.glsl → seznam obsahuje oba
#[test] fn disabling_glass_removes_the_shader() // skutečná libmpv; po set_enabled(false) seznam neobsahuje kaleido-glass
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido glass::`
Expected: FAIL

- [ ] **Step 3: Implementovat `glass.rs` a směrování**

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido glass::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(glass): runtime glass regions, glass-free screenshots and GPU failure fallback"
```

---

### Task 9: Náhledy na časové ose

**Files:**
- Create: `src-tauri/src/thumbs.rs` (převzít z prototypu i s testy)
- Modify: `src-tauri/src/player/options.rs` (načtení thumbfastu po `initialize`), `src-tauri/src/lib.rs` (`route`), `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `Engine`, `PlayerEvent::ThumbRendered` (Task 2–3), `AppPaths::{resource_dir, exe_dir}`.
- Produces:
  - Po `initialize`: `change-list script-opts append` pro `thumbfast-mpv_path=<exe_dir>/kaleido-mpv.exe`, `thumbfast-network=no`, `thumbfast-tone_mapping=mobius`, pak `load-script <resource_dir>/essentials/thumbfast.lua`.
  - `thumbfast_temp_dir() -> PathBuf`: proměnná `TEMP` (stejnou čte thumbfast, `thumbfast.lua:256`), záloha `std::env::temp_dir()`.
  - `validate(json, temp_dir)`, `load(json, temp_dir) -> Result<Thumb, ThumbError>`. Nově se velikost souboru (`metadata().len() == w*h*4`) kontroluje před čtením.
  - `ThumbStore` (poslední náhled + pořadové číslo), událost `player:thumb { width, height, seq }`.
  - Tauri: `thumb_request(seconds)` → `script-message-to thumbfast thumb <s s přesností 3 desetinných míst> "" "" <client_name>` (prázdné x/y + jméno klienta = thumbfast pošle `thumbfast-render` místo překryvu, jako v M0), `thumb_clear()` → `script-message-to thumbfast clear`, `thumb_get() -> tauri::ipc::Response` (8 B hlavička: šířka a výška jako `u32` little-endian, pak RGBA).

- [ ] **Step 1: Napsat selhávající testy**

```rust
// převzaté: accepts_thumbfasts_own_temp_file, rejects_paths_outside_temp, rejects_other_files_in_temp,
// rejects_bad_sizes_and_json, converts_bgra_to_opaque_rgba, rejects_truncated_pixel_data,
// loads_a_written_thumbnail, missing_file_is_a_read_error
#[test] fn size_is_checked_before_reading() // soubor o 1 B větší → ThumbError::Size, bez čtení obsahu
#[test] fn temp_dir_is_the_one_thumbfast_uses() // TEMP=X, TMP=Y → X
#[test] fn thumb_response_has_size_header() // 2×1 RGBA → [2,0,0,0,1,0,0,0, …8 B]
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido thumbs::`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido thumbs:: && cargo test -p kaleido-mpv`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(thumbs): thumbfast previews through kaleido-mpv with size checks before reading"
```

---

### Task 10: Nastavení – `settings.json` a šetrný zápis `mpv.conf`

**Files:**
- Create: `src-tauri/src/settings/mod.rs`, `store.rs`, `mpv_conf.rs`, `mpv_keys.rs`
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/system/open_queue.rs` (výchozí režim z nastavení)

**Interfaces:**
- Consumes: `Engine` (Task 2), `AppPaths`, `GlassController` (Task 8, kvůli `glsl-shaders`).
- Produces:
  - `Settings { version: 1, language: Language, appearance: Appearance, playback: Playback, #[serde(flatten)] extra: Map<String, Value> }`.
  - `Language { System, Cs, En }`.
  - `Appearance { mode: ThemeMode { System, Dark, Light }, accent: String /* "kaleido" nebo "#RRGGBB" */, glass_tint: String /* "#RRGGBB" */, glass_opacity: f64 /* 0.3–0.95 */, blur: f64 /* 0–40 */, saturation: f64 /* 0.5–2.0 */, radius: f64 /* 0–28 */, mica: bool, reduce_transparency: ReduceTransparency { Auto, On, Off }, ui_scale: f64 /* 0.9–1.5 */ }`.
  - `Playback { open_while_playing: LoadMode }` (výchozí `Replace`).
  - `SettingsStore::load(path) -> SettingsStore` (chybějící → výchozí; poškozený → přesun na `settings.json.bad-<unix čas>` a výchozí), `get()`, `update(patch: Value) -> Result<Settings, SettingsError>` (sloučení, kontrola mezí, atomický zápis přes dočasný soubor a přejmenování, emit `settings:changed`).
  - `MpvConf::parse(text: &str) -> MpvConf`, `get(&self, key) -> Option<String>`, `set(&mut self, key, value: Option<&str>)`, `render(&self) -> String`. Pravidla ze spec 8.10:
    - Mění se jen hlavní část (před prvním `[profil]`) a poslední výskyt klíče.
    - Rozumí tvarům `key=value`, `key` (= yes) a `no-key` (= no).
    - Chybějící klíče jdou do bloku za řádek `# --- Kaleido ---` na konci hlavní části.
    - `None` smaže řádky klíče v hlavní části.
    - Hodnoty s `#`, `"` nebo krajní mezerou se zapíšou jako `%N%hodnota`.
    - Komentáře, neznámé a nečitelné řádky, profily, CRLF a BOM zůstanou beze změny.
  - `MPV_SETTINGS: &[MpvSetting]`, `MpvSetting { key, kind: ValueKind, live: bool }`, `ValidationCtx { audio_devices: Vec<String>, fonts: Vec<String>, shaders: Vec<String> }` (naplní se z `audio-device-list`, `system_fonts` a obsahu `config_dir/shaders/`), `validate_mpv(key, value: Option<&str>, ctx: &ValidationCtx) -> Result<Option<String>, SettingsError>`. Povolené klíče:
    - Přehrávání: `hwdec` (auto-safe, auto-copy-safe, no), `autocreate-playlist` (no, filter, same), `save-position-on-quit` (bool).
    - Titulky: `sub-font` (název ze `system_fonts`), `sub-font-size` (10–120), `sub-color`, `sub-border-color`, `sub-back-color` (`#RRGGBB` nebo `#AARRGGBB`), `sub-border-size` (0–10), `slang` (seznam kódů `[a-z]{2,3}` oddělený čárkou).
    - Zvuk: `audio-device` (musí být v `audio-device-list`), `volume` (0–100), `volume-max` (100–1000), `alang` (seznam kódů).
    - Obraz: `deinterlace` (auto, no, yes), `tone-mapping` (auto, clip, mobius, reinhard, hable, bt.2390, bt.2446a, spline, st2094-40, st2094-10), `hdr-compute-peak` (auto, yes, no), `profile` (fast, high-quality, nebo žádný), `glsl-shaders` (jen soubory z `config_dir/shaders/`).
    - Jiný klíč → `SettingsError::NotAllowed`.
  - Tauri:
    - `settings_get`, `settings_set(patch)`.
    - `settings_get_mpv() -> BTreeMap<String, Option<String>>` (hodnota z `mpv.conf`, jinak aktuální vlastnost).
    - `settings_set_mpv(key, value)`: validace → atomický šetrný zápis → u `live` klíčů `set_property`. `glsl-shaders` se nastaví jako uživatelské shadery + shader skla.
    - `settings_audio_devices() -> Vec<AudioDevice { name, description }>`, `settings_list_shaders() -> Vec<String>`, `system_fonts() -> Vec<String>` (rodiny písem přes DirectWrite).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn mpv_conf_keeps_comments_profiles_and_unknown_lines()
#[test] fn mpv_conf_updates_the_last_occurrence_in_the_main_section()
#[test] fn mpv_conf_never_touches_profile_sections()
#[test] fn mpv_conf_appends_missing_keys_to_the_kaleido_block()
#[test] fn mpv_conf_understands_flag_and_no_forms() // "fs" → Some("yes"); "no-osc" → get("osc") == Some("no")
#[test] fn mpv_conf_removing_a_key_deletes_only_main_section_lines()
#[test] fn mpv_conf_quotes_values_with_hash_or_quotes() // "a#b" → "%3%a#b"
#[test] fn mpv_conf_round_trip_is_byte_identical_without_changes() // CRLF + BOM
#[test] fn settings_defaults_when_missing()
#[test] fn corrupt_settings_are_kept_aside_and_defaults_used()
#[test] fn unknown_settings_keys_survive_updates()
#[test] fn out_of_range_appearance_is_rejected() // ui_scale 2.0, glass_opacity 0.1
#[test] fn unknown_keys_and_bad_values_are_rejected() // "vo", "script", sub-color "red", volume 5000, slang "cs;rm"
// skutečná libmpv:
#[test] fn live_settings_apply_without_restart() // sub-font-size 40 → vlastnost 40 a řádek v mpv.conf
#[test] fn audio_device_must_be_listed() // "auto" ok, "nic-takoveho" NotAllowed
#[test] fn user_shaders_keep_the_glass_shader()
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido settings::`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido settings::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(settings): settings.json and gentle atomic mpv.conf writes from an allow-list"
```

---

### Task 11: Zkratky – `input.conf` a seznam vazeb

**Files:**
- Create: `src-tauri/src/settings/input_conf.rs`
- Modify: `src-tauri/src/settings/mod.rs`, `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `Engine` (Task 2), validátor jmen kláves z `input.rs` (Task 7), `DEFAULT_INPUT_CONF` (Task 2).
- Produces:
  - `InputConf::parse(text) -> InputConf`, `bind(&mut self, key, command)`, `silence(&mut self, key)` (zapíše `KEY ignore`), `reset(&mut self, key, default: Option<&str>)` (vrátí řádek z výchozího `input.conf`, nebo řádek smaže, když jde o vestavěnou vazbu mpv), `render()`. Komentáře a ostatní řádky beze změny.
  - `Binding { key, command, source: BindingSource, comment: Option<String> }`, `BindingSource { Kaleido, User, Mpv, Plugin { name } }`, odvozené z vlastnosti `input-bindings`: `owner` → Plugin; vazba z `input.conf` shodná s výchozím souborem → Kaleido; jiná z `input.conf` → User; slabé vestavěné → Mpv.
  - Tauri:
    - `settings_bindings() -> Vec<Binding>`.
    - `settings_rebind(key, new_key) -> Result<(), SettingsError>`: příkaz se bere z existující vazby `key` (UI neposílá příkaz); zapíše `new_key <příkaz>` a `key ignore`; živě přes příkaz mpv `keybind`.
    - `settings_reset_binding(key)`.

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn input_conf_round_trip_keeps_comments()
#[test] fn rebind_moves_the_command_and_silences_the_old_key()
#[test] fn reset_restores_the_kaleido_default()
#[test] fn rebinding_an_unknown_key_fails() // UI nemůže podstrčit vlastní příkaz
#[test] fn invalid_key_names_are_rejected()
// skutečná libmpv:
#[test] fn bindings_list_marks_sources() // testovací skript s vazbou "x" → Plugin{name}; "s" → Kaleido; "SPACE" → Mpv
#[test] fn keybind_applies_live() // po rebind obsahuje input-bindings nový klíč
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido settings::input_conf`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido settings::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(settings): list every binding with its source and rebind through input.conf"
```

---

### Task 12: Logy, diagnostika a licence

**Files:**
- Create: `src-tauri/src/system/logs.rs`, `src-tauri/src/system/diagnostics.rs`, `scripts/generate-licenses.ps1`, `resources/licenses/extra.json`, `resources/licenses/third-party.json` (generovaný a commitnutý)
- Modify: `src-tauri/src/lib.rs` (inicializace logů jako první, `rotate_mpv_log` před startem enginu), `.github/workflows/ci.yml` (kontrola aktuálnosti licencí)

**Interfaces:**
- Consumes: `AppPaths`, `Engine` (verze libmpv).
- Produces:
  - `logs::init(paths: &AppPaths) -> LogGuard`: `tracing-appender` s denní rotací a 7 soubory (`kaleido.<datum>.log`) v `logs_dir`.
  - `logs::rotate_mpv_log(logs_dir: &Path, now: SystemTime) -> io::Result<()>`: existující `mpv.log` přejmenuje na `mpv-YYYYMMDD-HHMMSS.log` a smaže `mpv-*.log` starší než 7 dní (spec 10.8).
  - `Diagnostics { kaleido, libmpv /* mpv-version */, ffmpeg /* ffmpeg-version */, windows /* build z RtlGetVersion */, gpu /* popis adaptéru z DXGI */, scripts: Vec<String> /* jména složek v config_dir/scripts */ }`, `collect(...) -> Diagnostics`, `render(&Diagnostics) -> String`, `sanitize(text: &str) -> String` (odstraní cesty `X:\…`, `\\server\…`, `/…` a URL).
  - `License { name, version, license, url }`; `extra.json` ručně: libmpv (GPL, odkaz na zdroje použitého buildu, spec 11.6), thumbfast (MPL-2.0 podle hlavičky `thumbfast.lua`, commit z `scripts/fetch-thumbfast.ps1`). Segoe UI se nepřibaluje.
  - `generate-licenses.ps1`: `cargo about generate` (JSON šablona) + `npx license-checker-rseidelsohn --production --json` → `third-party.json`. CI ho spustí a selže na `git diff --exit-code`.
  - Tauri: `system_diagnostics() -> String` (už sanitizované), `system_copy_diagnostics()` (schránka), `system_open_logs()` (opener), `system_licenses() -> Vec<License>`.

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn rotation_keeps_seven_days_of_mpv_logs() // soubory stáří 1, 6, 8 dní + mpv.log → zůstanou 1, 6 a nový archiv
#[test] fn kaleido_log_is_written_to_the_logs_folder() // init + tracing::info! → soubor kaleido.*.log existuje
#[test] fn diagnostics_contain_no_paths_or_urls() // "C:\Users\a\b.mkv", "\\nas\x", "https://y/z" zmizí
#[test] fn diagnostics_report_versions() // skutečná libmpv: libmpv začíná "mpv "
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `cargo test -p kaleido system::logs system::diagnostics`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `cargo test -p kaleido system:: && powershell -File scripts/generate-licenses.ps1 && git diff --exit-code resources/licenses`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri scripts/generate-licenses.ps1 resources/licenses .github/workflows/ci.yml
git commit -m "feat(system): rotated logs, sanitized diagnostics and generated license list"
```

---

### Task 13: Základ UI – IPC, smlouva a stav přehrávače

**Files:**
- Create: `src/ipc/types.ts`, `commands.ts`, `events.ts`, `contract.test.ts`; `src/state/playerStore.ts`, `uiStore.ts`, `bridge.ts`, `useInterpolatedTime.ts` (+ testy); `src-tauri/tests/fixtures/ipc/*.json`
- Modify: `src-tauri/src/commands.rs` (test fixtures)

**Interfaces:**
- Consumes: všechny příkazy a události z tabulky „Rozhraní UI ↔ Rust“.
- Produces:
  - `types.ts`: TS typy shodné se serde (Rust je zdroj pravdy).
  - `commands.ts`: jedna funkce na příkaz, camelCase (`playerLoad`, `playerCommand`, `playerInput`, `surfaceSetLayout`, `glassSetRegions`, `thumbRequest`, `thumbClear`, `thumbGet`, `systemUiReady`, `systemOpenDialog`, `systemPaste`, `systemOpenText`, `systemOpenRoadmap`, `settingsGet`, `settingsSet`, `settingsGetMpv`, `settingsSetMpv`, `settingsAudioDevices`, `settingsListShaders`, `systemFonts`, `settingsBindings`, `settingsRebind`, `settingsResetBinding`, `systemDiagnostics`, `systemCopyDiagnostics`, `systemOpenLogs`, `systemLicenses`, `systemAppearance`, `systemLocale`).
  - `events.ts`: `on<Event>(cb) => Promise<UnlistenFn>` pro každou událost.
  - Fixtures: jeden JSON na příkaz (argumenty) a na událost (payload). Rust test `ipc_fixtures_match_serde` je deserializuje, resp. porovná se serializací vzorku; `contract.test.ts` je importuje s typem (`const f: PlayerCommand[] = fixture`), takže odchylku chytí `tsc`.
  - `playerStore` (Zustand): `props: Record<string, unknown>`, `loaded: boolean`, `lastEnd: EndFile | null`, `logTail: LogLine[]` (nejvýš 50); akce `applySnapshot`, `applyChanges`, `fileLoaded`, `endFile`, `addLog`.
  - Selektory: `selectPaused`, `selectTimePos`, `selectDuration`, `selectVolume`, `selectTracks(kind)`, `selectPlaylist`, `selectChapters`, `selectVideoBadge` (`h ≥ 2160` → `4K`, `≥ 1440` → `1440p`, `≥ 1080` → `1080p`, `≥ 720` → `720p`; `gamma` `pq`/`hlg` → přidá `HDR`). Převzít testy z `prototype/src/playerState.test.ts`.
  - `uiStore`: `page: 'player' | 'settings'`, `sidebarOpen`, `panel: null | 'quick-settings' | 'playlist'`, `quickTab: 'subtitles' | 'audio'`.
  - `bridge.ts`: `startPlayerBridge(): Promise<() => void>`. Nejdřív přihlásí všechny události, pak `systemUiReady()` a `applySnapshot` (převzít ochranu `disposed` z `prototype/src/usePlayer.ts`).
  - `useInterpolatedTime(): number`: mezi aktualizacemi dopočítá čas podle `speed`. Smyčka `requestAnimationFrame` běží jen při přehrávání a jen když hook někdo používá (skryté ovládání nepřekresluje, spec 13).

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('fixtures type-check against the IPC types', /* tsc + runtime: každý fixture má "type" ze známého výčtu */);
test('video badge', () => {
  expect(selectVideoBadge({ 'video-params': { h: 2160, gamma: 'pq' } })).toBe('4K HDR');
  expect(selectVideoBadge({ 'video-params': { h: 1080, gamma: 'bt.1886' } })).toBe('1080p');
});
test('log tail keeps the last 50 lines', /* 60× addLog → 50, poslední je #60 */);
test('bridge subscribes before asking for the snapshot', /* pořadí volání mocků */);
test('interpolates between updates and stops when paused', /* fake timers: time-pos 10, speed 2, +500 ms → 11; pause → stojí */);
```

```rust
#[test] fn ipc_fixtures_match_serde()
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/ipc src/state && cargo test -p kaleido ipc_fixtures`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/ipc src/state && npm run build && cargo test -p kaleido ipc_fixtures`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src src-tauri/tests src-tauri/src/commands.rs
git commit -m "feat(ui): typed IPC with shared fixtures and the player store"
```

---

### Task 14: Design tokeny, vzhled a Mica

**Files:**
- Create: `src/theme/tokens.ts`, `useAppearance.ts`, `global.css`, `glass.module.css` (+ testy); `src-tauri/src/themes.rs`
- Modify: `src/main.tsx`, `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `Settings.appearance` (Task 10), `GlassController::set_enabled` (Task 8).
- Produces:
  - `Tokens` se skupinami ze spec 8.1: `color`, `glass { tint, opacity, blur, saturation }`, `accent { gradient, solid }`, `radius { s, m, l, pill }`, `font { family, size { xs: 11, s: 12, m: 13, l: 15, xl: 20, xxl: 28 } }`, `space`, `shadow`, `motion { fast: 150, base: 200, slow: 250, spring }`, `focus { ring }`.
  - `defaultTokens(mode: 'dark' | 'light'): Tokens`, `tokensFromAppearance(a: Appearance, mode): Tokens` (`GLASS_TEXT_MIN_OPACITY = 0.45`: sklo pod textem nikdy průhlednější, spec 8.9), `toCssVariables(t: Tokens): Record<string, string>` (prefix `--k-`), `applyTokens(el: HTMLElement, t: Tokens)`.
  - Barvy, duhový akcent „Kaleido“ a hodnoty skla převzít z maket `C:\Users\PC\Projects\Apps\Kaleido\.superpowers\brainstorm\1883-1791720763\content\key-screens-v2.html` a `player-direction.html`. Testy ověřují strukturu a meze, ne konkrétní barvy.
  - `resolveReduceTransparency(setting: 'auto' | 'on' | 'off', transparencyEffects: boolean): boolean` (`auto` = zapnuto, když Windows vypnul efekty průhlednosti). Stejné pravidlo má Rust (`themes::glass_enabled`), který podle něj sám zapíná a vypíná shader skla.
  - `useAppearance()`:
    - Režim `System` podle `prefers-color-scheme`.
    - Na kořen nastaví `data-theme` a `data-reduce-transparency`; měřítko přes `zoom`, oříznuté na 0,9–1,5.
    - Shader neovládá; jen kreslí neprůhledné sklo, když `resolveReduceTransparency` vrátí true.
  - `global.css`:
    - Písmo `"Segoe UI Variable Text", "Segoe UI", system-ui` a třída `.tabular` (`tabular-nums`).
    - `@media (prefers-reduced-motion: reduce)` (jen prolínání), `@media (forced-colors: active)` (systémové barvy).
    - Viditelný fokus z tokenu `focus.ring`.
  - `glass.module.css`: `.glass` (tónování, krytí, jemný stín textu) a varianta pro `[data-reduce-transparency]` (neprůhledná, bez `backdrop-filter`).
  - Rust `themes.rs`:
    - `SystemAppearance { transparency_effects: bool, high_contrast: bool, windows_build: u32 }`.
    - `transparency_from_registry(value: Option<u32>) -> bool` (`HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\EnableTransparency`, chybějící = zapnuto).
    - `mica_supported(build: u32) -> bool` (≥ 22000).
    - `apply_window_effect(window, mica: bool)`: Mica přes `set_effects`; na Windows 10 bez efektu, UI ukáže gradient.
    - Při `WindowEvent::ThemeChanged` znovu načíst a emitovat `system:appearance-changed`.
    - `glass_enabled(reduce: ReduceTransparency, transparency_effects: bool) -> bool`; výsledek předá `GlassController::set_enabled` s důvodem `User` (nastavení `On`) nebo `System` (`Auto` a Windows bez průhlednosti).
  - Tauri: `system_appearance()`. Rust použije `apply_window_effect` a `glass_enabled` při startu, po změně `appearance` v `settings_set` a po `ThemeChanged`.

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('tokens have every group from spec 8.1');
test('font sizes match spec 8.7', () => expect(Object.values(defaultTokens('dark').font.size)).toEqual([11, 12, 13, 15, 20, 28]));
test('glass opacity never drops below the text floor', /* glass_opacity 0.3 → ≥ 0.45 */);
test('css variables cover every token');
test('reduce transparency auto follows Windows', () => {
  expect(resolveReduceTransparency('auto', false)).toBe(true);
  expect(resolveReduceTransparency('auto', true)).toBe(false);
  expect(resolveReduceTransparency('off', false)).toBe(false);
});
test('ui scale is clamped to 90–150 %');
test('no transform: scale in any stylesheet', /* projde src/**/*.css, regex transform\s*:[^;]*scale\( */);
```

```rust
#[test] fn transparency_effects_default_on_when_the_value_is_missing()
#[test] fn mica_only_on_windows_11()
#[test] fn glass_follows_the_same_rule_as_the_ui() // (Auto,false) → false; (Auto,true) → true; (On,true) → false
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/theme && cargo test -p kaleido themes::`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/theme && cargo test -p kaleido themes::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src src-tauri/src
git commit -m "feat(theme): design tokens, reduce transparency, high contrast and Mica"
```

---

### Task 15: Čeština a angličtina

**Files:**
- Create: `src/i18n/index.ts`, `format.ts`, `locales/cs.json`, `locales/en.json` (+ testy)
- Modify: `src/main.tsx`, `src-tauri/src/commands.rs` (`system_locale` přes `sys-locale`)

**Interfaces:**
- Consumes: `Settings.language` (Task 10).
- Produces:
  - `resolveLanguage(setting: 'system' | 'cs' | 'en', systemLocale: string): 'cs' | 'en'` (nastavení vyhrává; jinak `cs*` → `cs`, cokoli jiného → `en`).
  - `initI18n(lang)`, `fallbackLng: 'en'`.
  - `formatTime(seconds: number, forceHours?: boolean): string` (`2:03`, `1:02:03`; záporné a NaN → `0:00`), `formatNumber(n, opts?)`, `formatDate(d)` přes `Intl` v aktuálním jazyce.
  - Klíče po jmenných prostorech `shell.*`, `home.*`, `player.*`, `panels.*`, `settings.*`, `errors.*`; každý další task přidává své klíče do obou souborů.
  - Tauri: `system_locale() -> String`.

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('resolveLanguage follows the system unless set', () => {
  expect(resolveLanguage('system', 'cs-CZ')).toBe('cs');
  expect(resolveLanguage('system', 'sk-SK')).toBe('en');
  expect(resolveLanguage('en', 'cs-CZ')).toBe('en');
});
test('every key exists in both languages'); // hloubkové porovnání klíčů
test('no empty translations');
test('formatTime pads minutes and seconds', () => { expect(formatTime(123)).toBe('2:03'); expect(formatTime(3723)).toBe('1:02:03'); });
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/i18n`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/i18n && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src src-tauri/src
git commit -m "feat(i18n): Czech and English with system default and Intl formatting"
```

---

### Task 16: Okno aplikace – ostrůvky nahoře, lišta, vrstva videa

**Files:**
- Create: `src/shell/AppShell.tsx`, `VideoLayer.tsx`, `TitleIsland.tsx`, `WindowIsland.tsx`, `Sidebar.tsx` (+ testy); `src/glass/regions.ts` (převzít i s testem), `src/glass/useGlassRegion.ts`
- Modify: `src/App.tsx`, `src-tauri/src/surface/win32.rs` (Snap Layouts), locales

**Interfaces:**
- Consumes: `uiStore`, `playerStore`, `selectVideoBadge` (Task 13), `attachVideoInput` (Task 7), `glassSetRegions` (Task 8), tokeny (Task 14).
- Produces:
  - `AppShell`: vrstvy zdola nahoru: `VideoLayer` (průhledná, přeposílá vstup), stránka (`PlayerPage` / `HomeScreen` / `SettingsPage`), ostrůvky.
  - `TitleIsland`: ☰ (otevře lištu), název (`media-title`), štítek z `selectVideoBadge`; pozadí je `data-tauri-drag-region`.
  - `WindowIsland`: minimalizace, maximalizace/obnovení, zavření přes API okna Tauri (zavření spustí `CloseRequested` z Task 2).
  - `Sidebar`: položky Přehrávač a Nastavení. Při přehrávání je skrytá, otevře ji ☰ nebo najetí 8 px k levému okraji; bez videa je vidět; Esc ji zavře; šipky mezi položkami.
  - `useGlassRegion(ref, radius)`: přihlásí obdélník prvku do sdíleného seznamu (nejvýš `MAX_REGIONS`) a změny pošle `glassSetRegions`, nejvýš jednou za snímek.
  - **Snap Layouts (hrot, spec 5.1):** najetí na ⬜ má otevřít rozložení Windows 11. Postup:
    1. Zkusit WebView2 `IsNonClientRegionSupportEnabled` s CSS `app-region` a odpovědí `HTMAXBUTTON` ve `WM_NCHITTEST` hlavního okna pro obdélník tlačítka, který UI pošle příkazem `surface_set_caption_buttons(rects)`.
    2. Pokud to s oknem `mpv` pod WebView2 nefunguje, nechat vlastní tlačítka a do `docs/m1/checklist.md` zapsat, že Snap Layouts zatím jdou jen přes Win+Z.

- [ ] **Step 1: Napsat selhávající testy**

```ts
// převzaté: regions.test.ts
test('title island shows the media title and video badge');
test('sidebar is hidden while playing and opens from the hamburger');
test('sidebar opens when the pointer reaches the left edge');
test('escape closes the sidebar');
test('glass regions are capped at six and sent once per frame');
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/shell src/glass`
Expected: FAIL

- [ ] **Step 3: Implementovat (včetně hrotu Snap Layouts)**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/shell src/glass && npm run lint`
Expected: PASS. Ruční: přetažení okna za horní ostrůvek, minimalizace, maximalizace, zavření.

- [ ] **Step 5: Commit**

```bash
git add src src-tauri/src
git commit -m "feat(shell): floating top islands, sidebar and the video input layer"
```

---

### Task 17: Úvodní obrazovka, vložení a přetažení

**Files:**
- Create: `src/home/HomeScreen.tsx`, `PasteField.tsx`, `useDrop.ts` (+ testy)
- Modify: `src/shell/AppShell.tsx`, locales

**Interfaces:**
- Consumes: `systemOpenDialog`, `systemPaste`, `systemOpenText`, `systemOpenRoadmap`, `playerLoad`, `onPasteEmpty`, `onOpenRequest` (Task 13), drop handler v Rustu (Task 5).
- Produces:
  - `HomeScreen` (spec 8.5 bod 1, jen bez videa): zóna pro přetažení, „Otevřít soubor“ → `systemOpenDialog('media')`, „Vložit odkaz“ → `systemPaste()` (při `'empty'` ukáže `PasteField`), karta „Pokračovat ve sledování“ se štítkem ROADMAPA a odkaz „Co chystáme →“ (obojí `systemOpenRoadmap()`).
  - `PasteField`: jedno pole + Enter → `systemOpenText(text)`; chybu z Rustu ukáže u pole; Esc zavře. Ukáže se i po události `system:paste-empty` (Ctrl+V jde přes `input.conf`).
  - `useDrop()` (celé okno):
    - `dragover` vždy `preventDefault`, aby WebView2 nenavigoval na soubor.
    - Soubory → `window.chrome.webview.postMessageWithAdditionalObjects('kaleido:drop', files)`.
    - `text/uri-list` nebo text s http(s) odkazem → `playerLoad([url], 'replace')`.
    - Během tažení se zvýrazní zóna.
  - Po `system:open-request` přepne `uiStore.page` na `player`.

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('open button asks Rust for the dialog');
test('paste field appears when the clipboard has no link');
test('paste field shows the error Rust returns');
test('dropping a link plays it');
test('dropping files hands them to WebView2', /* mock window.chrome.webview */);
test('roadmap card has the ROADMAPA badge and opens the roadmap');
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/home`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/home`
Expected: PASS. Ruční: přetáhnout video z Průzkumníku a odkaz z prohlížeče; Ctrl+V s odkazem a bez něj.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(home): start screen with open, paste and drop for files and links"
```

---

### Task 18: Spodní ostrůvek – časová osa, ovládání, autohide, fullscreen

**Files:**
- Create: `src/player/PlayerPage.tsx`, `ControlsIsland.tsx`, `Seekbar.tsx`, `ThumbBubble.tsx`, `VolumeControl.tsx`, `useAutohide.ts`, `fullscreen.ts` (převzít i s testem), `subMargin.ts` (+ testy)
- Modify: locales

**Interfaces:**
- Consumes: `playerStore` + selektory, `useInterpolatedTime` (Task 13), `playerCommand`, `thumbRequest`, `thumbClear`, `thumbGet`, `onThumb` (Task 13), `useGlassRegion` (Task 16), `formatTime` (Task 15).
- Produces:
  - `Seekbar`:
    - Čas a délka s `tabular-nums`, značky kapitol z `chapter-list`.
    - Najetí → `thumbRequest` nejvýš jednou za 30 ms a `ThumbBubble` (canvas z `thumbGet` po `player:thumb`); odchod → `thumbClear`.
    - Tažení → `Seek { mode: Absolute, exact: false }` nejvýš jednou za 50 ms, puštění → jeden `Seek { exact: true }`.
    - Klávesnice při fokusu: šipky ±5 s, Home/End; obslouží je sama a zavolá `preventDefault`, takže je mpv nedostane podruhé (Task 7).
  - `ControlsIsland` (spec 8.4):
    - Předchozí, přehrát/pauza, další (předchozí a další jen s playlistem).
    - `VolumeControl`: ztlumení + posuvník 0 až `volume-max`, značka na 100.
    - Tlačítka Titulky (otevře rychlé nastavení na záložce Titulky, Task 20), Playlist (Task 20), Fullscreen.
  - `useAutohide(ms = 2500)`: při přehrávání po 2,5 s bez pohybu myši skryje ostrůvky i kurzor (`cursor: none` na kořeni). Neskryje, když je otevřený panel, ukazatel je nad ostrůvkem nebo má ostrůvek fokus. Pohyb myši nebo klávesa je hned ukáže.
  - `fullscreen.ts` (převzato): černá clona při přepnutí, dokud `osd-dimensions` neodpovídá nové velikosti okna, nejvýš 500 ms.
  - `subMarginFor(islandHeightPx: number, windowHeightPx: number): number` = `round(islandHeightPx * 720 / windowHeightPx)`; při viditelném ovládání → `SetSubMargin`, při skrytém → 0 (spec 5.3).

- [ ] **Step 1: Napsat selhávající testy**

```ts
// převzaté: fullscreen.test.ts
test('seek drag sends throttled keyframe seeks and one exact seek at release', /* 20 pohybů za 200 ms → ≤ 5 Seek{exact:false}, pak právě 1 Seek{exact:true} s koncovou pozicí */);
test('thumb requests are throttled to one per 30 ms');
test('controls hide after 2500 ms without movement');
test('controls stay while a panel is open');
test('cursor hides together with the controls');
test('sub margin scales to 720', () => expect(subMarginFor(120, 1080)).toBe(80));
test('volume slider respects volume-max');
test('prev and next are disabled without a playlist');
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/player`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/player && npm run lint`
Expected: PASS. Ruční: přehrát 1080p klip, náhled na časové ose, autohide, fullscreen tlačítkem a dvojklikem.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(player): seekbar with previews, controls island, autohide and fullscreen curtain"
```

---

### Task 19: Zpětná vazba – indikátor, načítání, karta chyby

**Files:**
- Create: `src/player/Indicator.tsx`, `LoadingTitle.tsx`, `ErrorCard.tsx` (+ testy)
- Modify: `src/player/PlayerPage.tsx`, locales

**Interfaces:**
- Consumes: `onMessage`, `playerStore` (`lastEnd`, `logTail`, `paused-for-cache`, `idle-active`) (Task 13), `playerCommand` (Task 4).
- Produces:
  - `Indicator`: skleněná kapsle nahoře uprostřed pro `player:message ["osd", "volume" | "speed" | "seek"]` s aktuální hodnotou z `playerStore`; 1 s, pak prolnutí.
  - `LoadingTitle`: viditelný, když `idle-active === false && !loaded` (mezi `end-file`/startem a `player:file-loaded`; `endFile` v `playerStore` nastaví `loaded = false`) nebo `paused-for-cache === true`. Ukáže `media-title` (u odkazu dokud ho mpv nezná, hostitele z `playlist`) a indikátor načítání (spec 8.5 bod 3).
  - `ErrorCard` (spec 10.1, 10.2):
    - Ukáže se po `player:end-file` s `reason: "error"`.
    - Zpráva podle chyby mpv: `errors.playback.notFound`, `errors.playback.unsupported`, jinak `errors.playback.generic`.
    - Rozbalitelné „Podrobnosti“ s posledními řádky `logTail`.
    - Akce „Další“ (jen s další položkou playlistu) a „Zavřít“.
    - Zmizí po 8 s nebo zavřením; nejvýš 3 karty nad sebou. Playlist pokračuje sám (mpv).

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('indicator shows the value for one second');
test('loading title shows until file-loaded');
test('error card shows details from log tail', /* end-file error + 3 řádky logu → rozbalené Podrobnosti je obsahují */);
test('error card offers Next only with a following playlist entry');
test('at most three error cards stack');
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/player`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/player`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(player): glass indicator, loading title and playback error cards"
```

---

### Task 20: Panely – rychlé nastavení a playlist

**Files:**
- Create: `src/panels/Popover.tsx`, `placement.ts`, `QuickSettings.tsx`, `PlaylistPanel.tsx` (+ testy)
- Modify: `src/player/ControlsIsland.tsx`, locales

**Interfaces:**
- Consumes: `uiStore.panel` a `quickTab`, `selectTracks`, `selectPlaylist` (Task 13), `playerCommand` (Task 4), `systemOpenDialog('subtitle')` (Task 5), `useGlassRegion` (Task 16).
- Produces:
  - `placeAbove(anchor: DOMRect, size: { w: number; h: number }, viewport: { w: number; h: number }, gap = 8): { x: number; y: number }` (nad tlačítkem, vodorovně uprostřed, oříznuté do okna; když se nahoru nevejde, pod tlačítko).
  - `Popover`: pružinová animace 200 ms, Esc zavře, fokus zůstává uvnitř, šipky v seznamech, při zavření vrátí fokus na tlačítko. Obsloužené klávesy (včetně Esc, které by jinak v mpv ukončilo fullscreen) volají `preventDefault`. Totéž platí pro lištu z Task 16.
  - `QuickSettings` (spec 8.5 bod 2):
    - Titulky: seznam stop + „Vypnuto“, „Načíst ze souboru“, velikost (`sub-scale` 0,5–2,0), posun ±0,1 s.
    - Zvuk: seznam zvukových stop, posun ±0,05 s.
  - `PlaylistPanel`: položky z `playlist` (název, jinak jméno souboru, aktuální zvýrazněná), klik → `PlaylistPlay`, ✕ → `PlaylistRemove`, přesun tažením za úchyt i Alt+↑/↓ → `PlaylistMove`.

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('popover stays inside the window', () => expect(placeAbove(rect(1250, 680, 30, 30), { w: 320, h: 400 }, { w: 1280, h: 720 }).x).toBeLessThanOrEqual(1280 - 320));
test('escape closes the panel and returns focus to its button');
test('selecting Off turns subtitles off', /* SelectTrack { kind: 'sub', id: null } */);
test('delay buttons step by 100 ms');
test('playlist reorders with Alt+Down', /* PlaylistMove { from: 0, to: 1 } */);
test('playlist shows the file name when there is no title');
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/panels`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/panels`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(panels): quick settings for subtitles and audio, and the playlist panel"
```

---

### Task 21: Mini přehrávač

**Files:**
- Create: `src/surface/mini.ts` (převzít i s testem), `src/surface/useSurfaceLayout.ts`, `src/mini/MiniPlayer.tsx` (+ testy)
- Modify: `src/shell/AppShell.tsx`, locales

**Interfaces:**
- Consumes: `surfaceSetLayout`, `Layout` (Task 6), `uiStore.page`, `playerStore` (`video-params`), tokeny `motion` (Task 14).
- Produces:
  - `MINI = { w: 360, right: 16, bottom: 16 }`, výška podle poměru stran videa (výchozí 16:9).
  - `useSurfaceLayout()`:
    - Stránka ≠ přehrávač a video načtené → animace z `Full` do mini (snímky `Rect` každý `requestAnimationFrame` po dobu `motion.slow`, pak ukotvené `Mini`); návrat obráceně.
    - Při `prefers-reduced-motion` skok: `Hidden` → `Mini` a prolnutí rámečku (spec 8.6, zároveň záloha bodu 6 z M0).
  - `MiniPlayer`: kolem neprůhledná stránka, rámeček se sklem, ▶/❚❚, „Zpět do přehrávače“, „Zastavit“ (`Stop`). Dvojklik do videa → zpět do přehrávače.

- [ ] **Step 1: Napsat selhávající testy**

```ts
// převzaté: mini.test.ts
test('mini layout uses the video aspect', /* 4:3 → h = 270 */);
test('reduced motion jumps and fades instead of animating');
test('expanding returns to the full layout');
test('double-click on the mini video returns to the player');
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/surface src/mini`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/surface src/mini`
Expected: PASS. Ruční: otevřít Nastavení během přehrávání, přetáhnout okno a změnit jeho velikost v mini režimu.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(mini): animated mini player with a reduced-motion fade"
```

---

### Task 22: Nastavení – stránka, hledání, Přehrávání, Titulky, Zvuk, Obraz

**Files:**
- Create: `src/settings/SettingsPage.tsx`, `descriptors.ts`, `search.ts`, `fields/{Toggle,Select,Slider,ColorField,FontField,LangListField,DeviceField,ShaderListField}.tsx`, `sections/{Playback,Subtitles,Audio,Video}.tsx` (+ testy)
- Modify: locales

**Interfaces:**
- Consumes: `settingsGet`, `settingsSet`, `settingsGetMpv`, `settingsSetMpv`, `settingsAudioDevices`, `settingsListShaders`, `systemFonts` (Task 10, 13).
- Produces:
  - `SettingDescriptor { id: string; section: SectionId; labelKey: string; keywordsKey?: string; field: FieldKind; target: { mpv: string } | { kaleido: string /* tečková cesta */ } }`, `SectionId = 'playback' | 'subtitles' | 'audio' | 'video' | 'appearance' | 'shortcuts' | 'about'`.
  - `FieldKind = { kind: 'toggle' } | { kind: 'select'; options: { value: string; labelKey: string }[] } | { kind: 'slider'; min: number; max: number; step: number; unitKey?: string } | { kind: 'color' } | { kind: 'font' } | { kind: 'langList' } | { kind: 'device' } | { kind: 'shaderList' }`. Meze polí odpovídají `MPV_SETTINGS` (Task 10); Rust je stejně zkontroluje znovu.
  - `searchSettings(query: string, t: TFunction): SettingDescriptor[]`: porovnává přeložené popisky a klíčová slova, bez ohledu na diakritiku a velikost písmen.
  - `SettingsPage`: seznam sekcí (Přehrávání, Titulky, Zvuk, Obraz, Vzhled, Zkratky, O aplikaci), pole hledání, ovládání klávesnicí.
  - Pole uloží změnu hned; odmítnutí z Rustu ukáže u pole a vrátí předchozí hodnotu.
  - Obsah sekcí (spec 8.10, bez položek pro M2/M4):
    - **Přehrávání:** `hwdec`, „Playlist ze složky“ (`autocreate-playlist` filter/no), `save-position-on-quit`, `playback.openWhilePlaying`.
    - **Titulky:** `sub-font`, `sub-font-size`, `sub-color`, `sub-border-color`, `sub-border-size`, `sub-back-color`, `slang`.
    - **Zvuk:** `audio-device`, `volume`, `volume-max`, `alang`.
    - **Obraz:** `deinterlace`, `tone-mapping`, `hdr-compute-peak`, `profile`, `glsl-shaders`.

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('search finds settings without diacritics', /* "pismo" najde "Písmo titulků" */);
test('changing a field calls settingsSetMpv with the value');
test('a rejection from Rust shows inline and restores the value');
test('every descriptor has labels in both languages');
test('sections are reachable with the keyboard');
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/settings`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/settings && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(settings): searchable settings with playback, subtitles, audio and video"
```

---

### Task 23: Nastavení – Vzhled, Zkratky, O aplikaci

**Files:**
- Create: `src/settings/sections/{Appearance,Shortcuts,About}.tsx` (+ testy)
- Modify: `src/settings/descriptors.ts`, locales

**Interfaces:**
- Consumes: `settingsSet` (appearance), `tokensFromAppearance`, `applyTokens`, `systemAppearance` (Task 14); `settingsBindings`, `settingsRebind`, `settingsResetBinding` (Task 11); `systemDiagnostics`, `systemCopyDiagnostics`, `systemOpenLogs`, `systemLicenses` (Task 12); mapování kláves z `src/input/keys.ts` (Task 7).
- Produces:
  - **Vzhled** (spec 8.5 bod 4):
    - Volby: režim, akcent (Kaleido / vlastní barva), tónování, krytí, rozmazání, sytost, zaoblení skla, Mica (na Windows 10 vypnuté s vysvětlením), „Snížit průhlednost“ (Auto/Zapnuto/Vypnuto), měřítko 90–150 %.
    - Živý náhled ostrůvků nad ukázkovým gradientem; změny se projeví hned; „Obnovit výchozí“ vrátí celou skupinu `appearance`.
  - **Zkratky:**
    - Seznam vazeb seskupený podle zdroje (Kaleido, Vlastní, mpv, pluginy) s hledáním.
    - „Změnit“ zachytí další stisk (jméno přes `keys.ts`). Obsazenou klávesu ukáže i s její vazbou a nahradí ji až po potvrzení.
    - „Obnovit“ u každé vazby.
  - **O aplikaci:**
    - Verze Kaleida (`getVersion`), libmpv a ffmpeg.
    - Licence třetích stran (`systemLicenses`), odkaz na zdroje vydání a na zdroje buildu libmpv (spec 11.6).
    - „Otevřít složku s logy“, „Zkopírovat diagnostiku“, poznámka, že snímky vyvolané pluginem obsahují sklo (rozhodnutí 5).

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('appearance changes apply live and persist');
test('reset restores the default appearance');
test('mica is disabled on Windows 10 with an explanation');
test('rebind captures the next key and warns on a conflict');
test('about shows versions and its buttons call Rust');
```

- [ ] **Step 2: Spustit, ověřit selhání**

Run: `npm test -- src/settings`
Expected: FAIL

- [ ] **Step 3: Implementovat**

- [ ] **Step 4: Ověřit**

Run: `npm test -- src/settings && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(settings): appearance with live preview, shortcuts editor and about page"
```

---

### Task 24: E2E, úklid prototypu a ruční kontrola M1

**Files:**
- Create: `e2e/wdio.conf.ts`, `e2e/smoke.e2e.ts`, `e2e/make-media.ps1`, `README.md`, `docs/m1/checklist.md`
- Modify: `.github/workflows/ci.yml` (job `e2e`, smazat job `prototype`), `Cargo.toml` (odebrat `prototype/src-tauri` z workspace), `scripts/install-local-prototype.ps1` → `scripts/install-local.ps1` (instaluje build M1: `target/release/Kaleido.exe`; registrace beze změny, nahradí je M4), `scripts/measure-m0.ps1` → `scripts/measure.ps1` (nová cesta k exe)
- Delete: `prototype/`

**Interfaces:**
- Consumes: celá aplikace.
- Produces:
  - `make-media.ps1`: 10s klip 1280×720 přes `kaleido-mpv.exe` (`av://lavfi:testsrc2`, `--ovc=libx264`) do `e2e/media/`.
  - `smoke.e2e.ts` (WebdriverIO + `tauri-driver` + msedgedriver ve verzi WebView2):
    - Spustit `target/debug/Kaleido.exe <klip>`; do 5 s ukazuje titulní ostrůvek název klipu.
    - Klik na přehrát/pauza přepne `aria-pressed`.
    - Otevření Nastavení ukáže mini přehrávač.
    - Zavření okna ukončí proces do 2 s.
  - `docs/m1/checklist.md`: ruční kontroly, které testy nepokryjí:
    - Vzhled ostrůvků a skla (i nad letterboxem, `OUTPUT_EXCLUDES_MARGINS`), 150 % DPI, dva monitory s různým DPI.
    - Snap Layouts a přetažení odkazu z prohlížeče (výsledky hrotů z Task 16 a 5).
    - Mica, „Snížit průhlednost“, vysoký kontrast, čeština a angličtina.
    - Výkon přes `scripts/measure.ps1` (cíle ze spec 13), HDR10 se zapnutým i vypnutým HDR ve Windows.
    - Otevřené body ruční kontroly z M0, které M1 přebírá.

- [ ] **Step 1: Napsat E2E test a ověřit, že bez buildu selže**

Run: `npx wdio run e2e/wdio.conf.ts`
Expected: FAIL (chybí `target/debug/Kaleido.exe` nebo klip)

- [ ] **Step 2: Sestavit a spustit E2E**

Run: `cargo build -p kaleido -p kaleido-mpv && powershell -File e2e/make-media.ps1 && npx wdio run e2e/wdio.conf.ts`
Expected: PASS

- [ ] **Step 3: Smazat prototyp, upravit workspace, CI a skripty**

- [ ] **Step 4: Ověřit celou větev**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && npm run lint && npm test && npm run build`
Expected: vše projde.

- [ ] **Step 5: Commit**

```bash
git add -A e2e README.md docs/m1 .github/workflows/ci.yml Cargo.toml Cargo.lock scripts prototype
git commit -m "chore(m1): smoke E2E, manual checklist and removal of the M0 prototype"
```
