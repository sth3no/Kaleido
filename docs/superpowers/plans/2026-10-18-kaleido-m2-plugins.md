# Kaleido M2 – pluginy a nástroje: implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pluginy jako běžné mpv skripty s evidencí, essentials předinstalované a vypínatelné, stránka Moje pluginy s nastavením pluginů a s „Použít“ (restart jádra s pokračováním), spravovaný yt-dlp a Deno (stažení, ověření, aktualizace v Rustu), výběr kvality streamů v rychlém nastavení, třídění chyb streamů s akcemi a cookies z prohlížeče (spec 14, M2).

**Architecture:** Dva nové Rust moduly ze spec 4.2: `plugins` (evidence `plugins.json`, essentials, atomická instalace s kontrolou cest, zapnutí/vypnutí, nastavení přes `script-opts`, přiřazení chyb z logu) a `tools` (yt-dlp a Deno z GitHub Releases, ověření SHA-256, výměna vedle běžícího exe, plán kontrol, `yt-dlp -J`). `player` umí restart jádra s pokračováním, třídí chyby `ytdl_hook` a znovu načte stream v jiné kvalitě. UI dostane stránku Moje pluginy, záložku Kvalita, karty chyb streamů s akcemi a sekci Nastavení → Aktualizace; všechno jen přes typované příkazy a události se smlouvou R31.

**Tech Stack:** jako M1 (Rust 1.98 edition 2024, Tauri 2.12, windows 0.62, React 19.3, TypeScript ~6.0 (R6), Vite 8, Vitest 5, Zustand, i18next, ESLint 10 (R7)). Nově: `ureq` 3 (HTTP, `native-tls` = schannel, bez ring), `sha2`, `zip` (Deno je zip), `time` s `formatting`/`parsing` (RFC 3339 v `plugins.json` a `tools.json`), feature `Win32_UI_Shell` crate `windows` (Koš přes `SHFileOperationW`).

**Spec:** `docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md`, hlavně 4.1–4.4, 5.2, 6 (celá), 7.2 (formát nastavení), 7.3 (Moje pluginy), 8.3, 8.4, 8.5 body 2–3, 8.10, 10.1, 10.3, 10.4, 10.7, 10.8, 11.6, 12, 14. Dále M1: `docs/superpowers/plans/2026-10-17-kaleido-m1-player.md` (konvence, rozhraní) a jeho ledger s Rulings R1–R56 (`.claude/worktrees/m1-player/.superpowers/sdd/2026-10-17-kaleido-m1-player/progress.md`).

## Pracovní prostor

- Worktree `.claude/worktrees/m2-plugins`, větev `m2-plugins` z `refs/heads/m1-player` (cca44ad; M1 zatím není v `main`).
- `vendor/libmpv` je zkopírovaný z M1 (připnutá libmpv). Task 1 nahradí `scripts/fetch-thumbfast.ps1` skriptem `scripts/fetch-essentials.ps1` (stáhne všechny essentials do `vendor/essentials/`).
- **Tichý režim** (uživatel hraje hry): platí `.superpowers/sdd/2026-10-18-kaleido-m2-plugins/quiet-mode.md`. Kroky „Spustit test, ověřit selhání/průchod“ se v něm nespouštějí: implementer test napíše, RED/GREEN zapíše jako odložené a ověří jen kompilaci (`cargo check`/`clippy -D warnings` s `-j 2` a nízkou prioritou, `cargo fmt --check`, `tsc --noEmit`, `eslint .`). Všechny testy proběhnou v jednom velkém průchodu, až uživatel dohraje.
- Testy se skutečnou libmpv jako v M1: `vo=null`, `ao=null`, dočasná `config-dir` (`player::testing::{temp_paths, headless, clip, eventually}`). Testy `tools` nikdy nejdou na síť: HTTP je za traitem a testy mají falešný zdroj; jediný síťový test je `#[ignore]` a pouští se ručně (`--ignored`).

## Global Constraints

- Vše z Global Constraints M1 platí dál (libmpv jen z upstreamu, Tauri 2.x, React 19, TS strict, Zustand, CSS proměnné + CSS Modules, i18next, npm, Cargo workspace; UI nikdy nemluví s mpv přímo; spouštění procesů a práce se soubory jen v Rustu; texty jen v `locales/cs.json` a `locales/en.json`; přístupnost 8.9; tokeny; `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `tsc --noEmit`, `eslint .` čisté; conventional commits zakončené řádkem `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- **Plugin = běžný mpv skript** (Lua/JS, soubor nebo složka) + volitelně `script-opts`, shadery, fonty. **Žádné vlastní API** (6.1).
- Instalace do `scripts\<původní jméno skriptu>\` (jednosouborový skript jako `main.lua`/`main.js`). **Cíle souborů jen `scripts\<jméno>\`, `script-opts\<jméno>.conf`, `shaders\`, `fonts\`**; jiné cesty a `..` instalace odmítne (6.1).
- Instalace je **atomická**: zdroj → ověřit SHA-256 → dočasná složka → přesun; při selhání se nic nezmění (6.3).
- Vypnuté pluginy leží v `scripts-disabled\` (4.3, 6.3). Vypnutí a odinstalace se projeví po **„Použít“** = restart jádra s **pokračováním na stejném místě** (playlist, pozice, vybrané stopy, pauza) (6.3).
- `plugins.json` ve formátu 6.2 (`version: 1`, `plugins.<jméno>.{source, registryId, version, repo, commit, files[{path, sha256}], enabled, installedAt}`); skripty mimo evidenci jsou „ručně přidané“ (`source: manual`) (6.2).
- Essentials: **thumbfast, sub-select, reload** (evafast ne, rozhodnutí 17), `source: bundled`, kopie z `resources\essentials\` při prvním spuštění (6.4). **quality-menu se nepoužívá** (6.4). Kritéria essentials (6.4): široce používaný, udržovaný, licence slučitelná s GPL-3.0, nekoliduje s UI, bez dalších závislostí.
- uosc a ModernZ jsou **nekompatibilní**; ručně přidané dostanou štítek (6.5).
- **Nic se nevypíná automaticky** (10.4): plugin s chybami dostane štítek „hlásí chyby“ a jednu nenápadnou notifikaci s „Vypnout“.
- Nástroje v `%LOCALAPPDATA%\Kaleido\tools\` (`yt-dlp.exe`, `deno.exe`, `tools.json`) (4.3). **yt-dlp:** kontrola denně a vždy při chybě „zastaralý extraktor“, GitHub Releases, ověření podle `SHA2-256SUMS`, atomická výměna mezi načteními, kanál stabilní / volitelně nightly (Nastavení → Aktualizace). **Deno:** kontrola týdně, ověření kontrolního součtu (6.6). **ffmpeg v 1.0 není** (6.6). Kaleido **nesdílí** nástroje s The Downloader (9.4).
- Chyba stažení nástroje → opakování s odstupem; **offline se nástroj nemění** (10.7). Nikdy se nespustí neověřený soubor.
- Procesy nástrojů spouští jen Rust, bez shellu (`std::process::Command`, žádné `cmd /c`), s `CREATE_NO_WINDOW` (žádné konzolové okno), jako potomci v Job Objectu M1 (skončí s Kaleidem).
- 5.2: `ytdl=yes`, yt-dlp pro `ytdl_hook` je spravovaný, cesta k Deno jde přes `ytdl-raw-options` (`js-runtimes`).
- Kvalita streamů (8.5 bod 2): `tools` spustí `yt-dlp -J` souběžně s přehráváním, UI z výsledku sestaví seznam kvalit (logika formátů z downloaderu); volba nastaví `ytdl-format` a načte stream znovu na stejné pozici. Odkaz se přehraje rovnou ve výchozí kvalitě (Nastavení → Přehrávání → „Výchozí kvalita streamů“) (8.5 bod 3).
- Třídy chyb streamů podle zpráv `ytdl_hook` v logu mpv (10.3): zastaralý yt-dlp / změněný web → „Aktualizovat a zkusit znovu“; přihlášení nebo věk → „Použít cookies z prohlížeče“ (výběr prohlížeče); zablokovaný region, soukromé nebo smazané video → jen vysvětlení; výpadek sítě → „Zkusit znovu“.
- Diagnostika obsahuje verze yt-dlp a Deno a seznam pluginů, **bez cest a URL** (10.8).
- Licence třetích stran: yt-dlp (Unlicense), Deno (MIT), essentials podle jejich licencí (11.6).
- **Smlouva IPC (Ruling R31 z M1):** každý nový příkaz a událost dostane v tomtéž tasku: Rust typ (vstupní typy s `#[cfg_attr(test, derive(Serialize))]`), registraci v `lib.rs`, fixture v `src-tauri/tests/fixtures/ipc/` (`<příkaz>.json`, `returns.<příkaz>.json`, `rejects.<příkaz>.json`, `<událost s . místo :>.json`), položku v `src-tauri/src/ipc_contract_tests.rs` (round-trip, výčty v `variants!` bez zástupné větve), TS typ v `src/ipc/types.ts`, obal v `src/ipc/commands.ts` / `src/ipc/events.ts` a tabulku přesných klíčů v `src/ipc/contract.test.ts`. Serde: struktury `rename_all = "camelCase"`, výčty s daty `tag = "type"`.
- **Stránky (Ruling R46):** vrstva stránky je pod mini přehrávačem oříznutá, takže na stránkách (Moje pluginy, Nastavení) **žádné Popover portály**; seznamy a potvrzení se otevírají v toku stránky (`settings/fields/Dropdown.tsx` je vzor).
- Odkazy ven jen přes `system::shell_open::open` (Ruling R51, mimo Job Object). UI neotevírá libovolné adresy.
- Task, který přidá závislost (crate nebo npm), přegeneruje `resources/licenses/third-party.json` skriptem `scripts/generate-licenses.ps1` (v tichém režimu povoleno).

## Rozhodnutí plánu

Místa, kde spec nechává volnost, kde nesedí s tím, co existuje, nebo kde M1 přineslo poznatky. Uživatel je může změnit.

1. **Essentials jsou připnuté v `resources/essentials/essentials.json`** (repo, commit, verze, licence, soubory s SHA-256, schéma nastavení, spravované volby). `scripts/fetch-essentials.ps1` z něj stáhne soubory z `raw.githubusercontent.com/<repo>/<commit>/<src>` do `vendor/essentials/<jméno>/` a ověří je; Tauri je přibalí do `resources\essentials\`. Jeden zdroj pravdy pro skript, Rust, licence i CI.
2. **Pluginy načítá mpv samo** ze `scripts\` při startu jádra (`load-scripts` zůstává výchozí). Kaleido zkopíruje essentials **před startem jádra** a před každým startem jádra (i po restartu) šetrně zapíše své spravované volby do `script-opts\<optsName>.conf` (thumbfast: `mpv_path` = `kaleido-mpv.exe`, `network=no`, `tone_mapping=mobius`; thumbfast čte volby jen při načtení, `read_options` bez zpětného volání, proto soubor a ne `change-list` za běhu). `player::options::load_thumbfast` z M1 odpadá, thumbfast je essential jako ostatní (vyřeší i „uživatelská kopie thumbfastu by byla thumbfast2“ z M1 Task 9). Vestavěný `ytdl_hook` naopak změny voleb za běhu čte (`read_options(o, nil, <znovu hledat yt-dlp>)`), takže jeho `ytdl_path` Kaleido nastaví po startu jádra `change-list script-opts append` (přebije i `script-opts` z `mpv.conf`).
3. **Zapnutí za běhu** = přesun ze `scripts-disabled\` + `load-script`. Vypnutí, odinstalace **a změna nastavení pluginu** běžícího pluginu čekají na „Použít“ (restart jádra s pokračováním): skripty čtou `script-opts` jen při načtení. Plugin vypnutý a znovu zapnutý před „Použít“ se nenačítá podruhé.
4. **Odinstalace přesune soubory do Koše Windows** (`SHFileOperationW` + `FOF_ALLOWUNDO`), aby šla vrátit. `script-opts\<jméno>.conf` zůstává (nastavení uživatele). U essentials si `plugins.json` pamatuje odebrání v novém poli `removed` (rozšíření formátu 6.2), takže se při dalším startu znovu nezkopírují; „Obnovit essentials“ je vrátí.
5. **Restart jádra je požadavek ve frontě enginu**: běží na vlákně požadavků (nikdy na hlavním; M1 Task 2: VO potřebuje pumpu zpráv hlavního vlákna), nikdo na hlavním vlákně nečeká, požadavky poslané během restartu čekají ve frontě a jdou v pořadí do nového jádra. Staré jádro po zahájení restartu už nic nedoručí (jeho `Shutdown` nesmí ukončit aplikaci).
6. **Instalace z katalogu a z URL, stahování souborů pluginů, aktualizace pluginů a Nastavení → Pluginy jsou M3** (patří k `store` a indexu). M2 staví atomickou instalaci a kontrolu cest nad místními zdroji (essentials); M3 přidá zdroj ze sítě. Seznam nekompatibilních (uosc, ModernZ) je do M3 konstanta, pak ho nahradí `compat` z indexu.
7. **Nástroje se stahují přímo** z `https://github.com/<repo>/releases/latest/download/<asset>` (bez GitHub API a jeho limitů). **Čerstvost podle kontrolního součtu:** jiný součet v `SHA2-256SUMS` / `.sha256sum` = nová verze ke stažení; stejný = jen se zapíše čas kontroly. Verze pro UI a diagnostiku je z `--version` po instalaci. Přibalené první kopie (`resources\tools\`) přijdou s instalátorem M4; `tools` je převezme, když v instalaci jsou. Bez nich se nástroje stáhnou na pozadí hned při prvním startu.
8. **Chybějící yt-dlp** (ještě se stahuje, nebo stažení selhalo) je pro kartu chyby stejná třída jako zastaralý: „Aktualizovat a zkusit znovu“ ho stáhne a odkaz pustí znovu.
9. **Z The Downloader se převezme jen to, co existuje** (průzkum 2026-10-18, `Apps\Raycast\downloader`): `src/lib/video-format.ts` (`videoFormatSelector`), z `src/utils.ts` `getVideoFormats`, `formatTbr`, `formatFilesize`, i s testy (MIT, oba řádky copyrightu), a pravidla `extractDumpJson`/`isLiveStream` (v Rustu, protože JSON čte Rust). „Odhady“, „grafy“, `tool-freshness` a `tool-updates` v downloaderu nejsou a `managed-binary` spravuje jen spotDL: správa nástrojů je v Rustu navržená nově (rozhodnutí 7), detekce prohlížečů je port `src/lib/browsers.ts`. Seznam kvalit pro přehrávání skládá Kaleido podle výšky obrazu (s fps a HDR), selektor `bv*[height<=?H]+ba/b[height<=?H]`.
10. **Výchozí kvalita streamů je mpv volba `ytdl-format`** v `mpv.conf` z pevné tabulky předvoleb (`STREAM_QUALITY_PRESETS`, live); prázdná = výchozí yt-dlp. Volba v rychlém nastavení nastaví `ytdl-format` jen pro danou položku a načte ji znovu na stejné pozici (`loadfile … insert-next-play` + `playlist-remove` staré položky), takže playlist zůstane. Rust si volbu pamatuje pro URL po dobu běhu a restart jádra ji zachová.
11. **`yt-dlp -J` spouští Rust**, jakmile se načte položka s http(s) `path` (nová sledovaná vlastnost); výsledek drží v cache podle URL a posílá UI jako **typovaný `StreamInfo`** (ne syrový JSON), aby ho hlídala smlouva R31.
12. **Třídy chyb streamů počítá Rust** (spec 12: „třídění chyb yt-dlp“ je Rust unit) z řádků `ytdl_hook` od začátku položky; `player:end-file` dostane pole `streamError`. „Zkusit znovu“ pustí odkaz stejnou cestou jako vložený odkaz (fronta otevření, nastavení „Při otevření souboru za běhu“).
13. **Cookies z prohlížeče** se ukládají v `settings.json` (`playback.cookiesFromBrowser`, spec yt-dlp `BROWSER[:PROFIL]`) a jdou do mpv jako klíč `cookies-from-browser` v `ytdl-raw-options` a do `yt-dlp -J`. Prohlížeče detekuje Rust podle složek profilů (port `browsers.ts` pro Windows). Kaleido do `ytdl-raw-options` přidává a odebírá jen své klíče (`js-runtimes`, `cookies-from-browser`) přes `change-list` (vzor Ruling R21).
14. **Nastavení → Aktualizace** v M2 ukazuje yt-dlp (verze, poslední kontrola, stav, „Zkontrolovat“, kanál stabilní/nightly), Deno a verzi libmpv. Kanál aplikace přidá M4 s updaterem (žádné zástupné řádky).
15. **kaleido-mpv přepíše HDR řetězec thumbfastu i za běhu** (`vf set` přes IPC, spec 4.1, otevřené z M1 rozhodnutí 4): sleduje `vf` a známý řetězec nahradí stejným `lavfi` grafem jako při startu.
16. **Pořadí položek lišty:** Přehrávač, Moje pluginy, Nastavení (Obchod přidá M3 před Moje pluginy).
17. **evafast není essential.** Repo `po5/evafast` nemá licenci (žádný LICENSE, GitHub `license: null`, issue #15 „Add license“ otevřené od 2024-02-04 bez odpovědi), takže ho Kaleido nesmí přibalit; navíc váže `RIGHT` přes Kaleidovo přetáčení a ukazuje vlastní OSD mpv. Neprojde dvěma kritérii ze spec 6.4. Essentials v 1.0 jsou thumbfast, sub-select a reload. Uživatel to může změnit: licence od autora ho vrátí (jen položka v manifestu), nebo vlastní „podržet → pro zrychlení“ v Kaleidu jako samostatný task.
18. **sub-select bez `sub-select.json` vůbec nenaběhne** (`assert(io.open(...))` při načtení). Kaleido ho při prvním zkopírování sub-select jednou zapíše do `script-opts\sub-select.json` (výchozí místo skriptu; soubor zapisuje Kaleido sám, ne instalace, takže omezení cílů 6.1 se ho netýká) a pak už nikdy nepřepíše. Obsah podle jazyka UI při prvním startu: zvuk v jazyce uživatele → jen vynucené titulky, jinak žádné; jiný zvuk → titulky v jazyce uživatele, pak anglické; nic nesedí → výběr mpv beze změny. Úpravy preferencí jsou v M2 jen ruční úpravou souboru (checklist), formulář pro ně ne.
19. **Cookies z prohlížečů na Chromiu na Windows yt-dlp nepřečte** (App-Bound šifrování Chrome 127+, `Failed to decrypt with DPAPI`; za běhu prohlížeče `Could not copy Chrome cookie database`) a celé načtení pak selže. Kaleido je nabízí jen s varováním a tuto chybu třídí jako vlastní třídu `cookies` (akce: vybrat jiný prohlížeč, typicky Firefox, nebo cookies vypnout). Firefox a jeho forky fungují i za běhu prohlížeče. Soubor `cookies.txt` (`--cookies`) v M2 není.
20. **Deno musí být aspoň 2.3.0** (minimum yt-dlp pro řešení výzev YouTube). `ytdl_hook` volá yt-dlp s `--no-warnings`, takže chybějící nebo starý Deno se v logu neukáže (YouTube jen tiše nabídne méně formátů): Kaleido verzi kontroluje sám a starší Deno bere jako chybějící. yt-dlp najde `deno.exe` i sám vedle sebe, Kaleido cestu přesto předává výslovně (5.2).

## Review Focus

1. **Jména a tvary skriptů, které uživatel přidá ručně** (soubor `foo.lua` i složka s `main.js`, diakritika a mezery v názvu, tečka v názvu složky, ruční kopie essentials vedle bundled) – seznam ukazuje každý skript jednou se jménem, pod kterým ho mpv zná, a nic se nenačte dvakrát → testy `script_names_match_mpvs_clients` (Task 3) a `a_manual_copy_of_an_essential_is_flagged_and_not_seeded_again` (Task 5).
2. **„Použít“ v nečekaném stavu přehrávače** (nic neběží, pauza na konci s `keep-open`, stream, externí titulky, položka playlistu mezitím smazaná z disku, restart během restartu) – přehrávání pokračuje tam, kde bylo, nebo zůstane prázdné, a nic se nezasekne → testy `restart_of_an_idle_player_stays_idle`, `restart_keeps_external_subtitles_and_the_selected_track`, `a_second_restart_waits_for_the_first` (Task 6).
3. **Síť při správě nástrojů** (offline, přerušené stahování, jiný kontrolní součet, odpověď 403/404 od GitHubu, přesměrování na cizí host, yt-dlp.exe právě běží) – nainstalovaný nástroj zůstane funkční a další pokus přijde s odstupem → testy `offline_keeps_the_installed_tool_and_backs_off`, `a_checksum_mismatch_changes_nothing`, `a_redirect_to_another_host_is_refused`, `the_exe_is_replaced_while_the_old_one_runs` (Task 8).
4. **Cesty a hodnoty, které nesmí projít** (cíl instalace s `..`, absolutní cestou, `C:`, `\\server`, `file.lua:stream`, `CON.lua`, tečkou nebo mezerou na konci; hodnota `script-opts` s koncem řádku, klíč s `=`) – odmítnuto dřív, než se cokoli zapíše → testy `install_refuses_targets_outside_the_allowed_folders` (Task 5), `script_opts_refuse_line_breaks_and_bad_keys` (Task 4).
5. **Varianty zpráv yt-dlp** (typografický apostrof v „you’re“, několik řádků ERROR, varování před chybou, chyba sítě, která zmiňuje i „update“) – třída sedí a síťová chyba se nikdy nevydává za zastaralý yt-dlp → test `classify_real_yt_dlp_messages` s tabulkou skutečných zpráv (Task 10).

---

## Struktura souborů

```
app/
  resources/essentials/essentials.json          připnuté essentials (rozhodnutí 1)
  scripts/fetch-essentials.ps1                  nahradí fetch-thumbfast.ps1
  crates/kaleido-mpv/src/main.rs, thumbnail.rs  přepis vf za běhu (Task 2)
  src-tauri/src/
    plugins/  mod.rs (služba, příkazy), names.rs, registry.rs, scan.rs, script_opts.rs,
              schema.rs, targets.rs, install.rs, essentials.rs, recycle.rs, errors.rs
    tools/    mod.rs (služba), http.rs, checksum.rs, store.rs, schedule.rs, replace.rs,
              run.rs, ytdlp.rs, mpv.rs
    streams.rs                                  sondy -J, cache, volba kvality (Task 12)
    player/   resume.rs (Task 6), stream_error.rs (Task 10); engine.rs, state.rs, load.rs upraveny
    system/   browsers.rs (Task 11)
  src/
    plugins/  PluginsPage.tsx, PluginRow.tsx, ApplyBar.tsx, PluginLog.tsx, PluginSettings.tsx,
              SchemaForm.tsx, KeyValueEditor.tsx, pluginsStore.ts (+ testy)
    streams/  videoFormat.ts, formats.ts, quality.ts, streamStore.ts (+ testy)
    panels/   QualityTab.tsx (+ test)
    settings/ sections/Updates.tsx, fields/BrowserField.tsx (+ testy)
    shell/notices/streamError.ts (+ test)
  docs/m2/checklist.md
```

## Rozhraní UI ↔ Rust (nové v M2)

| Příkaz | Argumenty → návrat | Task |
|---|---|---|
| `plugins_list` | → `PluginsState` | 7 |
| `plugins_set_enabled` | `name, enabled` → `Result<PluginsState, PluginError>` | 7 |
| `plugins_uninstall` | `name` → `Result<PluginsState, PluginError>` | 7 |
| `plugins_restore_essentials` | → `Result<PluginsState, PluginError>` | 7 |
| `plugins_settings` | `name` → `Result<PluginSettings, PluginError>` | 7 |
| `plugins_set_setting` | `name, key, value: string \| null` → `Result<PluginSettings, PluginError>` | 7 |
| `plugins_log` | `name` → `LogLine[]` | 7 |
| `plugins_apply` | → `Result<PluginsState, PluginError>` | 7 |
| `tools_status` | → `ToolStatus[]` | 9 |
| `tools_check` | `tool: ToolId` → `ToolStatus` | 9 |
| `stream_retry` | `url, update: boolean` → `Result<(), LoadIssue>` | 10 |
| `system_browsers` | → `Browser[]` | 11 |
| `stream_formats` | → `StreamFormats \| null` | 12 |
| `player_set_quality` | `format: string \| null` → `Result<(), QualityError>` | 12 |

| Událost | Obsah | Task |
|---|---|---|
| `player:engine-restarted` | `{}` | 6 |
| `plugins:changed` | `PluginsState` | 7 |
| `plugins:error` | `{ name }` (poprvé za běh u daného pluginu) | 7 |
| `tools:status` | `ToolStatus` | 9 |
| `player:end-file` | + `streamError: StreamError \| null` | 10 |
| `stream:formats` | `StreamFormats` | 12 |

Úpravy existujících typů: `Settings` dostane `playback.cookiesFromBrowser` (Task 11) a sekci `updates { ytdlpChannel }` (Task 9); `player:state` nese i vlastnost `path` (Task 12).

---

### Task 1: Připnuté essentials, balíček a licence

**Files:**
- Create: `resources/essentials/essentials.json`, `scripts/fetch-essentials.ps1`, `src-tauri/src/plugins/mod.rs` (zatím jen `pub mod essentials; pub mod schema;`), `src-tauri/src/plugins/essentials.rs` (jen typy manifestu a jeho čtení; seeding přidá Task 5), `src-tauri/src/plugins/schema.rs` (jen typy `SettingSpec`, `SettingKind`, `Localized` se serde; kontrolu hodnot přidá Task 4)
- Modify: `src-tauri/tauri.conf.json` (`bundle.resources`), `resources/licenses/extra.json`, `crates/kaleido-mpv/tests/thumbfast.rs` (cesta `vendor/essentials/thumbfast/thumbfast.lua`), `.github/workflows/ci.yml` (`fetch-essentials.ps1` místo `fetch-thumbfast.ps1` ve všech jobech), `scripts/install-local.ps1` (kopíruje celou `resources\essentials\` z buildu, starý `resources\essentials\thumbfast.lua` jde do `$Retired`), `README.md`, `src-tauri/src/lib.rs` (`pub mod plugins;`)
- Delete: `scripts/fetch-thumbfast.ps1`

**Interfaces:**
- Produces: `essentials.json` (pole objektů, pořadí = pořadí v UI):

```json
[
  {
    "name": "thumbfast",
    "scriptName": "thumbfast",
    "optsName": "thumbfast",
    "repo": "po5/thumbfast",
    "commit": "0f711de3138c9bd6718209d819ac54022c23ded2",
    "version": "0f711de",
    "license": "MPL-2.0",
    "summary": { "en": "…", "cs": "…" },
    "files": [
      { "src": "thumbfast.lua", "dest": "scripts/thumbfast/main.lua",
        "sha256": "a3d08e71eae8b892f6cd39f9593ea219768e709312d176bca883841b156448bf" }
    ],
    "settings": [ { "key": "max_height", "type": "int", "default": 200, "min": 50, "max": 600,
                    "label": { "en": "…", "cs": "…" } } ],
    "managed": { "mpv_path": "{helper}", "network": "no", "tone_mapping": "mobius" }
  }
]
```

  - `name`: složka ve `scripts\` a klíč v `plugins.json`; `scriptName`: jméno klienta, pod kterým skript běží v mpv (pravidlo Task 3); `optsName`: identifikátor, který skript předává `read_options` (soubor `script-opts\<optsName>.conf`).
  - `settings`: formát nastavení ze spec 7.2 (typy `bool`, `int`, `float`, `string`, `enum` s `values`, `color`), jen klíče, které má smysl měnit z UI; `managed` klíče Kaleido zapisuje sám a UI je nenabízí. `{helper}` = `<exe_dir>\kaleido-mpv.exe`.
  - Tři essentials (rozhodnutí 17) s hodnotami z „Podklady z průzkumu → Essentials“ (commit, soubor, SHA-256, licence, `scriptName`, `optsName` jsou ověřené; implementer je po stažení `fetch-essentials.ps1` potvrdí, jinak `throw`):
    - `thumbfast`: nastavení `max_height`, `max_width` (`int` 50–600), `spawn_first` (`bool`), `hwdec` (`bool`); `managed` viz příklad.
    - `sub-select`: `files` = `sub-select.lua` → `scripts/sub-select/main.lua`; nastavení `select_audio`, `observe_audio_switches`, `explicit_forced_subs` (`bool`); `managed` žádné (`config` zůstává výchozí `~~/script-opts`, rozhodnutí 18).
    - `reload`: `files` = `main.lua` → `scripts/reload/main.lua` (skript volá `read_options` se jménem skriptu, složka se proto musí jmenovat `reload`); nastavení `paused_for_cache_timer_enabled` (`bool`), `paused_for_cache_timer_timeout` (`int` 3–120), `demuxer_cache_timer_enabled` (`bool`), `demuxer_cache_timer_timeout` (`int` 5–300), `reload_eof_enabled` (`bool`); `managed` žádné (`Ctrl+r` zůstává, s vazbami Kaleida nekoliduje).
- Produces (Rust): `essentials::Essential { name, script_name, opts_name, repo, commit, version, license, summary: Localized, files: Vec<EssentialFile { src, dest, sha256 }>, settings: Vec<SettingSpec>, managed: BTreeMap<String, String> }`, `Localized { en: String, cs: Option<String> }`, `essentials::load_manifest(path: &Path) -> anyhow::Result<Vec<Essential>>`, `essentials::MANIFEST: &str = "essentials.json"`. `SettingSpec` definuje Task 4; do té doby ho Task 1 deklaruje v `plugins/schema.rs` jako typ s `serde` (Task 4 doplní kontrolu hodnot).
- `fetch-essentials.ps1 [-Destination vendor\essentials]`: pro každý soubor manifestu stáhne `https://raw.githubusercontent.com/<repo>/<commit>/<src>` do dočasného souboru, ověří SHA-256 (jinak `throw` se jménem souboru a oběma součty), uloží do `vendor\essentials\<name>\<src>`.
- `tauri.conf.json` `bundle.resources`: `"../vendor/essentials/": "resources/essentials/"` a `"../resources/essentials/essentials.json": "resources/essentials/essentials.json"` místo mapování `thumbfast.lua`. Rust čte essentials z `resource_dir/essentials/<name>/<src>`.
- `extra.json`: položky `sub-select` (`MIT`) a `reload` (`MIT`) s verzí = zkrácený commit a `url` = `https://github.com/<repo>/tree/<commit>` (jako thumbfast), `yt-dlp` (`Unlicense`, `https://github.com/yt-dlp/yt-dlp`) a `Deno` (`MIT`, `https://github.com/denoland/deno`) s `"version": "managed"` (stahuje je Kaleido; O aplikaci ukáže místo slova skutečnou verzi z `tools_status`, Task 17).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn the_manifest_lists_the_three_essentials() // jména přesně [thumbfast, sub-select, reload]
#[test] fn every_essential_file_goes_to_its_own_script_folder() // dest začíná "scripts/<name>/" nebo je "script-opts/<optsName>.conf"
#[test] fn every_essential_has_a_gpl_compatible_license_entry() // license ∈ {MPL-2.0, MIT, Unlicense, GPL-3.0-or-later, GPL-2.0-or-later, BSD-2-Clause, ISC} a extra.json má položku se stejným jménem a licencí
#[test] fn vendored_files_match_the_manifest() // je-li vendor/essentials, SHA-256 každého souboru = manifest; bez vendor test řekne, že je přeskočen (eprintln) a projde
#[test] fn settings_and_managed_keys_do_not_overlap()
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido plugins::essentials` — Expected: FAIL (chybí manifest a typy)
- [ ] **Step 3: Napsat manifest, skript, typy; upravit balíček, CI, install-local, README; spustit `fetch-essentials.ps1`**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido plugins::essentials && cargo test -p kaleido-mpv` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add resources/essentials scripts/fetch-essentials.ps1 scripts/fetch-thumbfast.ps1 scripts/install-local.ps1 src-tauri crates/kaleido-mpv/tests/thumbfast.rs .github/workflows/ci.yml resources/licenses/extra.json README.md
git commit -m "feat(plugins): pin the three essentials in one manifest and bundle them"
```

---

### Task 2: kaleido-mpv – HDR řetězec thumbfastu i po `vf set`

**Files:**
- Modify: `crates/kaleido-mpv/src/main.rs`, `crates/kaleido-mpv/src/thumbnail.rs`

**Interfaces:**
- Consumes: `thumbnail::srgb_filter` (existuje).
- Produces: `thumbnail::is_raw_image_job(invocation: &Invocation) -> bool` (dnešní podmínka `ovc=rawvideo` + `of=image2`), `thumbnail::rewrite_vf(current: &str) -> Option<String>` (= `srgb_filter`, pojmenované pro běh). `main.rs`: u raw image jobu po `initialize` `observe(1, "vf", String)`; při změně, kterou `rewrite_vf` umí přepsat, `set_property("vf", přepis)` (přepis už znovu nesedí, takže se nezacyklí). Textový tvar vlastnosti `vf` nemusí být znak po znaku to, co thumbfast poslal (mpv seznam filtrů vypisuje sám): test se skutečnou libmpv nejdřív přečte, co mpv po `vf set <HDR>` hlásí, a `rewrite_vf` musí poznat právě tento tvar (případně oba).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn a_vf_set_at_runtime_gets_the_same_lavfi_graph() // skutečná libmpv, vo=null, ovc/of jako thumbfast: command ["vf","set",HDR] → po obsluze změny get_string("vf") obsahuje "lavfi=[" a "desat=0"
#[test] fn other_runtime_filters_stay() // ["vf","set","scale=200:112,format=bgra"] → beze změny
#[test] fn jobs_that_are_not_raw_images_do_not_watch_vf()
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido-mpv` — Expected: FAIL
- [ ] **Step 3: Implementovat** (obsluha změny `vf` jako funkce volatelná z testu, smyčka událostí v `main.rs` ji volá)
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido-mpv && cargo clippy -p kaleido-mpv --all-targets -- -D warnings` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add crates/kaleido-mpv
git commit -m "fix(kaleido-mpv): rewrite thumbfast's HDR filter chain when it is set at run time too"
```

---

### Task 3: Model pluginů – jména, evidence, nalezené skripty

**Files:**
- Create: `src-tauri/src/plugins/names.rs`, `registry.rs`, `scan.rs`
- Modify: `src-tauri/src/plugins/mod.rs`, `src-tauri/src/paths.rs`

**Interfaces:**
- Produces:
  - `AppPaths` + `scripts_dir` (`config_dir\scripts`), `scripts_disabled_dir` (`config_dir\scripts-disabled`), `script_opts_dir` (`config_dir\script-opts`); `ensure_dirs` je nevytváří (mpv bez nich funguje, vznikají při první instalaci).
  - `names::script_name(entry: &str) -> String`: jméno klienta, jak ho mpv odvodí z názvu souboru nebo složky ve `scripts\` (`player/scripting.c` a nastavení klienta připnutého buildu accb7b2821; ověřeno: složka `scripts\<dir>\main.lua` se jmenuje podle `<dir>`, soubor podle jména bez přípony, a každý bajt mimo `[A-Za-z0-9]` se nahradí `_`, takže `sub-select` → `sub_select`). Zbytek pravidla (tečka ve jménu složky, úvodní znaky) implementer přečte ve zdroji a pojistí testem se skutečnou libmpv. `names::INCOMPATIBLE: &[&str] = &["uosc", "modernz"]`, `names::is_incompatible(name: &str, script_name: &str) -> bool` (bez ohledu na velikost písmen).
  - `registry::Registry { version: u32 /* 1 */, plugins: BTreeMap<String, PluginRecord>, removed: BTreeSet<String>, #[serde(flatten)] extra: Map<String, Value> }`, `PluginRecord { source: PluginSource, registry_id: Option<String>, version: Option<String>, repo: Option<String>, commit: Option<String>, files: Vec<FileRecord { path: String, sha256: String }>, enabled: bool, installed_at: String /* RFC 3339 UTC */ }`, `PluginSource { Bundled, Store, Url, Manual }` (serde lowercase). `Registry::load(path) -> Registry` (chybí → prázdná; nečitelný JSON → kopie `plugins.json.bad-<unix čas>` a prázdná, s `tracing::warn!`, jako R23), `Registry::save(&self, path) -> io::Result<()>` (`settings::write_atomic`), `registry::FILE = "plugins.json"` v `config_dir`.
  - `scan::Found { name: String /* složka nebo jméno souboru bez přípony */, script_name: String, entry: PathBuf, layout: Layout { Folder, File }, enabled: bool /* scripts vs scripts-disabled */ }`, `scan::scan(paths: &AppPaths) -> Vec<Found>` (skript = soubor `.lua`/`.js`, nebo složka s `main.lua`/`main.js`; ostatní soubory a složky pomine; pořadí podle jména).
  - `scan::Duplicate`: dva nalezené se stejným `script_name` (mpv druhému přidá `2`); `scan::duplicates(found: &[Found]) -> Vec<(String, Vec<String>)>`.

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn script_names_follow_mpvs_rule() // složka "sub-select" → "sub_select", soubor "my-plugin.lua" → "my_plugin", "žluť.lua" → "__lu__" (UTF-8 bajty), "thumbfast" → "thumbfast"
#[test] fn registry_round_trips_the_spec_format() // příklad ze spec 6.2 + removed: ["reload"] → load/save beze ztráty, neznámý klíč přežije
#[test] fn a_corrupt_registry_is_kept_aside() // "{nope" → prázdná evidence a soubor plugins.json.bad-*
#[test] fn scan_finds_files_folders_and_disabled_ones() // scripts/a.lua, scripts/b/main.js, scripts/c/readme.txt, scripts-disabled/d/main.lua → a, b, d(disabled); c ne
#[test] fn duplicates_are_reported() // scripts/thumbfast/main.lua + scripts/thumbfast.lua → duplicita "thumbfast"
#[test] fn uosc_and_modernz_are_incompatible() // "uosc", "ModernZ", "modernz.lua" → true; "thumbfast" → false
// skutečná libmpv:
#[test] fn script_names_match_mpvs_clients() // scripts/sub-select/main.lua, scripts/my.plugin.lua, scripts/dot.dir/main.lua, scripts/Žluť kůň.lua (každý mp.register_script_message("ping")) → po startu enginu script-message-to <script_name(...)> ping uspěje pro každý
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido plugins::` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido plugins:: && cargo test -p kaleido paths::` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(plugins): plugins.json, mpv's script names and the scripts Kaleido finds"
```

---

### Task 4: `script-opts` a schéma nastavení pluginu

**Files:**
- Create: `src-tauri/src/plugins/script_opts.rs`
- Modify: `src-tauri/src/plugins/schema.rs` (z Task 1), `src-tauri/src/plugins/mod.rs`

**Interfaces:**
- Produces:
  - `ScriptOpts::parse(text: &str) -> ScriptOpts`, `get(&self, key) -> Option<&str>` (poslední výskyt), `entries(&self) -> Vec<(String, String)>` (klíče v pořadí prvního výskytu, hodnota posledního), `set(&mut self, key, value: Option<&str>) -> Result<(), ScriptOptsError>` (mění poslední výskyt, `None` smaže všechny výskyty, nový klíč na konec), `render(&self) -> String`. Pravidla jako `mp.options` (player/lua/options.lua připnutého buildu): komentář jen s `#` na začátku řádku, klíč = vše před prvním `=` bez ořezu, hodnota = vše za ním bez ořezu, řádek bez `=` se nechá být, žádné uvozování. Komentáře, prázdné a cizí řádky, CRLF a BOM zůstanou beze změny.
  - `ScriptOptsError { BadKey, LineBreak }`: klíč jen `[A-Za-z0-9_-]+`; hodnota bez `\r` a `\n`.
  - `schema::SettingSpec { key: String, kind: SettingKind, default: Value, label: Localized, description: Option<Localized> }`, `SettingKind` (`tag = "type"`, lowercase): `Bool`, `Int { min: Option<i64>, max: Option<i64> }`, `Float { min: Option<f64>, max: Option<f64> }`, `String`, `Enum { values: Vec<String> }`, `Color` — přesně tvar spec 7.2 (`{"key","type","default","min","max","values","label"}`); M3 ho použije pro manifesty katalogu.
  - `schema::validate(spec: &SettingSpec, raw: &str) -> Result<String, String /* důvod */>`: `bool` → `yes`/`no` (přijme i `true`/`false`), `int` celé číslo v mezích, `float` konečné v mezích, `enum` jedna z hodnot, `color` `#RRGGBB` nebo `#AARRGGBB` (`settings::is_hex_color`), `string` bez konce řádku. Vrací tvar, který se zapíše do souboru.

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn script_opts_round_trip_is_byte_identical() // CRLF, BOM, komentáře, "max_height=200", "bad line"
#[test] fn script_opts_change_the_last_occurrence_and_append_new_keys()
#[test] fn script_opts_remove_every_occurrence()
#[test] fn script_opts_keep_spaces_as_mp_options_reads_them() // "a= b" → get("a") == Some(" b")
#[test] fn script_opts_refuse_line_breaks_and_bad_keys() // hodnota "x\ny", klíč "a=b", "", "a b" → chyba, nic se nezměnilo
#[test] fn settings_specs_read_the_spec_7_2_shape() // {"key":"max_height","type":"int","default":200,"min":50,"max":600,"label":{"en":"Max height"}}
#[test] fn values_are_checked_and_normalised() // bool "true"→"yes"; int 700 (max 600) Err; float NaN Err; enum mimo Err; color "red" Err; string "a\nb" Err
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido plugins::` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido plugins::` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(plugins): gentle script-opts editing and checked plugin setting values"
```

---

### Task 5: Atomická instalace, essentials při startu, Koš

**Files:**
- Create: `src-tauri/src/plugins/targets.rs`, `install.rs`, `recycle.rs`
- Modify: `src-tauri/src/plugins/essentials.rs`, `src-tauri/src/plugins/mod.rs`, `src-tauri/src/lib.rs` (setup: evidence, essentials a spravované volby **před** `Engine::start`), `src-tauri/src/player/options.rs` (smazat `load_thumbfast`, `thumbfast_commands`, `thumbfast_script` a jejich test), `src-tauri/Cargo.toml` (`windows` feature `Win32_UI_Shell`, `time` features `formatting`, `parsing`), `resources/licenses/third-party.json` (přegenerovat)

**Interfaces:**
- Consumes: `Registry`, `PluginRecord` (Task 3), `ScriptOpts` (Task 4), `Essential`, `load_manifest` (Task 1), `settings::write_atomic`.
- Produces:
  - `targets::Target { ScriptFile { plugin: String, rel: PathBuf }, ScriptOpts { plugin: String }, Shader(PathBuf), Font(PathBuf) }`, `targets::parse(dest: &str, plugin: &str) -> Result<Target, TargetError>`: povolené jen `scripts/<plugin>/<…>`, `script-opts/<plugin>.conf`, `shaders/<soubor>`, `fonts/<soubor>` (oddělovač `/` i `\`); odmítne prázdný úsek, `.`, `..`, absolutní cestu, písmeno disku, UNC, `:` kdekoli (alternativní datový proud), rezervovaná jména Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, i s příponou), tečku nebo mezeru na konci úseku, řídicí znaky. `Target::path(&self, paths: &AppPaths) -> PathBuf`.
  - `install::FileSource { Bytes(Vec<u8>), Path(PathBuf) }`, `install::PlannedFile { dest: String, source: FileSource, sha256: String }`, `install::InstallPlan { name: String, files: Vec<PlannedFile>, record: PluginRecord }`, `install::install(paths: &AppPaths, registry: &mut Registry, plan: InstallPlan) -> Result<(), InstallError>`:
    1. všechny cíle přes `targets::parse`; 2. každý zdroj přečíst a ověřit SHA-256 do `config_dir\.kaleido-staging\<jméno>-<nanos>\` (stejný svazek, přesuny jsou přejmenování); 3. existující `scripts\<jméno>\` odsunout do staging, nové soubory přesunout na místo; `script-opts\<jméno>.conf`, který už existuje, **zůstane** (nastavení uživatele); shader nebo font se stejným jménem a jiným obsahem → `InstallError::Conflict`; 4. při chybě vrátit odsunuté a smazat staging; 5. zapsat záznam a `registry.save`. `InstallError { Target(TargetError), Checksum { dest, expected, actual }, Conflict { dest }, Io(String) }`.
  - `essentials::seed(paths: &AppPaths, registry: &mut Registry, manifest: &[Essential]) -> Vec<String>`: každé essential, které není v `registry.plugins` ani v `registry.removed`, nainstaluje z `resource_dir\essentials\<name>\<src>` se záznamem `{ source: Bundled, version, repo, commit, files, enabled: true, installedAt: teď }`; vrátí nově nainstalovaná jména; chyba jednoho se zaloguje a ostatní pokračují. Ruční skript stejného jména (`scripts\thumbfast.lua`) se nepřepíše: essential se nenainstaluje, zaloguje se konflikt a seznam ho ukáže jako duplicitu (Task 7).
  - `essentials::write_managed(paths: &AppPaths, manifest: &[Essential], registry: &Registry)`: u každého essential v evidenci (zapnutého i vypnutého) šetrně zapíše `managed` klíče do `script-opts\<optsName>.conf` (`{helper}` → `exe_dir\kaleido-mpv.exe`), atomicky; jiné řádky nechá. Volá se před každým startem jádra.
  - `essentials::sub_select_prefs(language: UiLanguage) -> String` a zápis do `script-opts\sub-select.json`, když `seed` právě nainstaloval sub-select a soubor neexistuje (rozhodnutí 18; existující soubor se nikdy nepřepíše). `UiLanguage { Cs, En }` = jazyk UI při startu (nastavení `language`, u `system` podle `sys_locale` jako `system_locale`, pravidlo R37). Obsah pro `Cs` (pro `En` stejný s `["en", "eng"]`):

```json
[
  { "alang": ["cs", "cze", "ces"], "slang": ["forced", "no"] },
  { "alang": "*", "slang": ["cs", "cze", "ces", "en", "eng"] }
]
```
  - `recycle::to_recycle_bin(paths: &[PathBuf]) -> io::Result<()>`: `SHFileOperationW` s `FO_DELETE`, `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT`, seznam ukončený dvojitou nulou.
  - `lib.rs` setup po načtení `SharedSettings` (jazyk pro `sub-select.json`) a před `Engine::start`: `Registry::load` → `load_manifest(resource_dir\essentials\essentials.json)` (chyba = zalogovat, pluginy jedou bez essentials) → `seed` → `write_managed`; evidence a manifest zůstanou pro Task 7 (předat do jeho služby, do té doby `app.manage` jednoduché struktury `plugins::Startup { registry, manifest }`).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn install_refuses_targets_outside_the_allowed_folders() // "scripts/x/../../mpv.conf", "C:/a.lua", "\\\\srv\\s\\a.lua", "/abs.lua", "scripts/x/a.lua:evil", "scripts/x/CON.lua", "scripts/x/a. ", "shaders/../a", "scripts/other/a.lua" (cizí plugin), "input.conf" → Err, na disku nic nového
#[test] fn a_checksum_mismatch_installs_nothing() // dva soubory, druhý se špatným součtem → žádný soubor, evidence beze změny, staging smazaný
#[test] fn reinstall_replaces_the_script_folder_and_keeps_the_users_script_opts()
#[test] fn a_failed_move_restores_the_previous_version() // cílový soubor zamčený (otevřený bez sdílení) → stará verze na místě
#[test] fn essentials_are_seeded_once_and_never_after_removal() // seed → 3 jména; seed znovu → []; removed=["reload"] po smazání → reload se nevrátí
#[test] fn a_manual_copy_of_an_essential_is_flagged_and_not_seeded_again() // scripts/thumbfast.lua existuje → thumbfast se nenainstaluje, nic se nepřepíše
#[test] fn managed_options_are_rewritten_before_each_start() // uživatel změnil mpv_path a přidal max_height → po write_managed je mpv_path náš, max_height zůstal
#[test] fn sub_select_gets_its_preferences_once() // první seed zapíše script-opts/sub-select.json (platný JSON, Cs varianta); upravený soubor po dalším startu i po Obnovit essentials zůstane
#[test] fn the_recycle_bin_takes_files_and_folders() // dočasný soubor i složka zmizí z disku
// skutečná libmpv:
#[test] fn sub_select_starts_with_kaleidos_preferences() // seed skutečného sub-select z vendor/essentials (bez vendor přeskočit) → po startu script-message-to sub_select select-subtitles uspěje (skript běží, assert prošel)
#[test] fn seeded_scripts_run_with_kaleidos_options() // falešné essential "probe" (Lua: read_options({greeting="x"}, "probe"); mp.set_property_native("user-data/probe/greeting", o.greeting)), managed greeting="kaleido" → po startu enginu user-data/probe/greeting == "kaleido"
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido plugins::` — Expected: FAIL
- [ ] **Step 3: Implementovat; v `lib.rs` nahradit `load_thumbfast` za seeding před startem jádra; přegenerovat licence**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido plugins:: && cargo test -p kaleido player::options && cargo test -p kaleido thumbs::` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri resources/licenses/third-party.json
git commit -m "feat(plugins): atomic installs into allowed folders, essentials on first start, removal to the Recycle Bin"
```

---

### Task 6: Restart jádra s pokračováním

**Files:**
- Create: `src-tauri/src/player/resume.rs`
- Modify: `src-tauri/src/player/engine.rs`, `src-tauri/src/player/mod.rs`, `src-tauri/src/player/load.rs` (sdílené `%N%` uvozování per-file voleb), `src-tauri/src/glass.rs` (`after_restart`), `src-tauri/src/lib.rs` (`restart_engine`, událost), `src-tauri/src/surface/mod.rs` (jen pokud `watch_for_first_window` potřebuje znovu spustit), IPC smlouva (událost `player:engine-restarted`: fixture `player.engine-restarted.json`, kontrakt v Rustu, `src/ipc/events.ts` `onEngineRestarted`, `src/ipc/contract.test.ts`). UI na událost zatím nic nedělá: nové jádro pošle počáteční hodnoty všech sledovaných vlastností samo a „Použít“ hlásí konec přes `plugins:changed` (Task 7).

**Interfaces:**
- Consumes: `Engine`, `EngineConfig`, `EventLoop`, `Request`, `options::{enforced, reasserted, reassert}` (M1), `essentials::write_managed` (Task 5).
- Produces:
  - `resume::ResumeState { entries: Vec<ResumeEntry>, current: Option<usize>, position: Option<f64>, paused: bool, tracks: ResumeTracks, external_subs: Vec<String> }`, `ResumeEntry { filename: String, options: Vec<(String, String)> }`, `ResumeTracks { aid: TrackChoice, sid: TrackChoice, vid: TrackChoice }`, `TrackChoice { Auto, Off, Id(i64) }`.
  - `resume::capture(mpv: &Mpv, entry_options: &dyn Fn(&str) -> Vec<(String, String)>) -> ResumeState`: z `playlist` (filename, current), `time-pos`, `pause`, `aid`/`sid`/`vid` (`no` → `Off`, `auto` → `Auto`), `track-list` (`external` + `external-filename` titulků aktuální položky). `entry_options` dodá per-file volby položky (Task 12: `ytdl-format` zvolené kvality); do té doby `|_| vec![]`.
  - `resume::restore_commands(state: &ResumeState) -> Vec<Vec<String>>` (čistá): prázdný playlist → `[]`; jinak `set pause yes|no`, pro každou položku `loadfile <filename> append -1 <volby>`, kde volby = `autocreate-playlist=no` (R55) + `entry.options`, u aktuální navíc `start=<position>`, `aid`/`sid`/`vid` a `sub-files=<externí titulky spojené ;>` (hodnoty v `%N%` uvozovkách jako `load_commands`); nakonec `playlist-play-index <current>` (bez aktuální položky nic nehraje).
  - `Engine::restart(&self, restart: Restart) -> Result<(), RestartError>` (blokuje volajícího, nikdy na hlavním vlákně), `pub struct Restart { pub events: Box<dyn EventLoop>, pub prepare: Box<dyn FnOnce(&Mpv) + Send>, pub entry_options: Box<dyn Fn(&str) -> Vec<(String, String)> + Send> }`, `RestartError { Quit /* staré jádro neskončilo do QUIT_TIMEOUT */, Start(String) }`. Na vlákně požadavků v pořadí fronty: `capture` → staré jádro přestane doručovat události (jeho `Event::Shutdown` se smyčce nepředá) → `quit` a čekání na `Shutdown` (`QUIT_TIMEOUT` 2 s, pak `terminate` natvrdo) → nové jádro se stejným `EngineConfig` (vynucené volby, `initialize`, hlídání `REASSERTED`, `reassert`) → vlákno událostí s `restart.events` → `restart.prepare(&mpv)` → `restore_commands` → pokračování fronty. `sub_margin_base` se vynuluje. `impl EventLoop for Box<dyn EventLoop>`. Druhý `restart` poslaný během prvního počká ve frontě.
  - `GlassController::after_restart(&self) -> Vec<Vec<String>>`: příkazy, které nové jádro potřebuje (připojit shader, je-li sklo zapnuté, a sloučit aktuální oblasti); zapomene `pushed`.
  - `lib.rs`: `pub fn restart_engine(app: &AppHandle) -> Result<(), RestartError>` (blokující): `write_managed` (s evidencí a manifestem z `plugins::Startup`, Task 7 je přesune do služby `Plugins`), `Restart { events: StateLoop::new(AppSink), prepare: observe_all + příkazy `glass.after_restart()` (+ Task 9 přidá volby nástrojů), entry_options }`, po návratu `surface::watch_for_first_window(app)` a emit `player:engine-restarted` (`{}`, konstanta `player::ENGINE_RESTARTED_EVENT`).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn restore_commands_play_the_current_entry_with_its_options() // [a,b], current 1, 12.5 s, pauza, sid 2, ytdl-format u b → přesný seznam příkazů
#[test] fn an_empty_state_restores_nothing()
// skutečná libmpv:
#[test] fn restart_resumes_the_playlist_where_it_was() // [a,b,c] klipy 10 s, hraje b na 4 s, pauza → po restartu playlist stejné filename, playlist-pos 1, time-pos 4 ± 0.5, pause yes
#[test] fn restart_keeps_external_subtitles_and_the_selected_track() // dvě .srt přes sub-add, sid = druhá → po restartu obě v track-list a sid je ta druhá
#[test] fn restart_of_an_idle_player_stays_idle() // nic otevřeno → idle-active, prázdný playlist
#[test] fn requests_sent_during_a_restart_reach_the_new_core_in_order() // restart na vlákně A; mezitím set speed 1.5, add speed 0.5 → po restartu speed 2.0
#[test] fn the_old_core_never_tells_its_loop_shutdown() // Recorder starého jádra nemá Event::Shutdown; Recorder nového vidí FileLoaded
#[test] fn a_second_restart_waits_for_the_first() // dva restarty ze dvou vláken → oba Ok, jedno běžící jádro, pozice zachovaná
#[test] fn quit_after_a_restart_shuts_down_within_2_s()
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido player::` — Expected: FAIL
- [ ] **Step 3: Implementovat** (jádro za zámkem jen na vlákně požadavků; `Engine::request` nikdy neblokuje)
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido player:: && cargo test -p kaleido glass:: && cargo test -p kaleido ipc_fixtures && npx vitest run src/ipc src/state` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri src
git commit -m "feat(player): restart the core in the request queue and resume playlist, position, tracks and pause"
```

---

### Task 7: Služba pluginů, příkazy a chyby z logu

**Files:**
- Create: `src-tauri/src/plugins/errors.rs`
- Modify: `src-tauri/src/plugins/mod.rs` (služba `Plugins`), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` (registrace, `route` pro `PlayerEvent::Log`), `src-tauri/src/system/diagnostics.rs` (`plugins` místo `scripts`), IPC smlouva (8 příkazů, 2 události, typy `PluginsState`, `PluginInfo`, `PluginSettings`, `PluginError`), `src/ipc/types.ts`, `commands.ts`, `events.ts`, `contract.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6 (`Registry`, `scan`, `ScriptOpts`, `SettingSpec`, `schema::validate`, `install`, `essentials`, `recycle`, `restart_engine`).
- Produces:
  - `PluginInfo { name, script_name, source: PluginSource, version: Option<String>, summary: Option<Localized>, enabled: bool, running: bool, incompatible: bool, duplicate: bool, errors: u32, settings: SettingsForm { Schema, KeyValue } }`, `PluginsState { plugins: Vec<PluginInfo>, restart_needed: bool, removed_essentials: Vec<String>, applying: bool }`.
  - `PluginSettings { name, schema: Option<Vec<SettingSpec>>, entries: Vec<OptEntry { key, value }>, managed: Vec<String> }` (`entries` bez `managed` klíčů).
  - `PluginError` (`tag = "type"`): `NotFound { name }`, `Invalid { key, reason }`, `Busy` (běží „Použít“), `Io { message }`, `Unavailable`.
  - `Plugins` (managed state, vnitřně `Mutex`): `running: BTreeSet<String>` (při startu = zapnuté nalezené), `pending_settings: BTreeSet<String>`.
    - `list()`; `set_enabled(name, on)`: přesun složky nebo souboru mezi `scripts\` a `scripts-disabled\` (+ `enabled` v evidenci); zapnutí neběžícího → `load-script <entry>` do jádra a `running += name`; vypnutí běžícího → `restart_needed`.
    - `uninstall(name)`: skript (a soubory evidence kromě `script-opts\<optsName>.conf`) do Koše, záznam pryč, u `Bundled` `removed += name`; běžící → `restart_needed`.
    - `restore_essentials()`: `removed` vyprázdní, `seed`, nově nainstalované načte `load-script`.
    - `settings(name)`, `set_setting(name, key, value)`: se schématem `schema::validate`, jinak klíč podle `ScriptOptsError`; `managed` klíč → `Invalid`; zápis do `script-opts\<optsName>.conf` (essentials) nebo `script-opts\<script_name>.conf` (ostatní); běžící plugin → `pending_settings += name`.
    - `restart_needed` = některý běžící už není zapnutý na disku, nebo `pending_settings` není prázdné.
    - `apply(app)`: `applying = true` + `plugins:changed`, `restart_engine(app)`, `running` = zapnuté nalezené, `pending_settings` prázdné, `applying = false` + `plugins:changed`; během `applying` ostatní změny vrací `Busy`.
  - `errors::PluginErrors`: `note(line: &LogLine, by_script_name: &BTreeMap<String, String>) -> Option<String>` (úroveň `error`/`fatal`, `prefix` je `script_name` pluginu → jméno pluginu; vrátí jméno jen poprvé za běh), posledních 50 řádků na plugin, `count(name)`, `lines(name)`.
  - Tauri: `plugins_list`, `plugins_set_enabled(name, enabled)`, `plugins_uninstall(name)`, `plugins_restore_essentials`, `plugins_settings(name)`, `plugins_set_setting(name, key, value)`, `plugins_log(name)`, `plugins_apply` (async, blokující vlákno). Každá změna emituje `plugins:changed` (`PluginsState`); `route` pro `Log` zavolá `note` a při prvním výskytu emituje `plugins:error { name }` a `plugins:changed`. Řádek jde do UI dál (`player:log`).
  - Diagnostika: `Diagnostics.plugins: Vec<String>` = `"<jméno> <verze nebo -> (<source>)"` z `list()`, bez cest.

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn disabling_moves_the_script_and_asks_for_apply() // složka i soubor → scripts-disabled, restart_needed true
#[test] fn re_enabling_before_apply_loads_nothing_twice() // vypnout a zapnout běžící → zpět ve scripts, žádný load-script, restart_needed false
#[test] fn enabling_a_stopped_plugin_loads_it_now() // zaznamenaný příkaz load-script <entry>
#[test] fn uninstalling_an_essential_remembers_it() // removed obsahuje jméno, script-opts zůstal
#[test] fn restoring_essentials_brings_them_back()
#[test] fn managed_keys_cannot_be_set_from_the_ui() // thumbfast mpv_path → Invalid
#[test] fn a_settings_change_of_a_running_plugin_waits_for_apply()
#[test] fn errors_are_attributed_by_script_name_and_told_once() // error "[sub_select] …" ×2 → note vrátí "sub-select" jednou; warn se nepočítá; neznámý prefix nic
#[test] fn diagnostics_list_plugins_without_paths()
#[test] fn changes_while_applying_are_busy()
// skutečná libmpv:
#[test] fn a_plugin_enabled_at_run_time_runs_at_once() // scripts-disabled/probe/main.lua → set_enabled(true) → script-message-to probe ping uspěje
#[test] fn apply_stops_a_disabled_plugin() // běžící probe vypnout, apply → script-message-to probe selže, přehrávání pokračuje
```

```rust
#[test] fn ipc_fixtures_match_serde() // rozšířený o nové příkazy, události a výčty
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido plugins:: && cargo test -p kaleido ipc_fixtures && npx vitest run src/ipc` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido plugins:: && cargo test -p kaleido system:: && cargo test -p kaleido ipc_fixtures && npx vitest run src/ipc` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri src/ipc
git commit -m "feat(plugins): enable, disable, uninstall, settings and Apply, with errors from mpv's log"
```

---

### Task 8: Nástroje – stažení, ověření, výměna, plán kontrol

**Files:**
- Create: `src-tauri/src/tools/mod.rs` (služba bez procesů), `http.rs`, `checksum.rs`, `store.rs`, `schedule.rs`, `replace.rs`
- Modify: `src-tauri/src/paths.rs` (`tools_dir` = `local_dir\tools`, v `ensure_dirs`), `src-tauri/src/lib.rs` (`pub mod tools;`), `src-tauri/Cargo.toml` (`ureq` 3 s `native-tls`, `sha2`, `zip`), `resources/licenses/third-party.json`

**Interfaces:**
- Produces:
  - `ToolId { YtDlp, Deno }` (serde `ytDlp`, `deno`), `Channel { Stable, Nightly }` (serde lowercase; jen yt-dlp).
  - `tools::Source { asset: &'static str, sums: &'static str, base: &'static str }`, `tools::source(tool, channel) -> Source`:
    - yt-dlp stable: `base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/"`, `asset = "yt-dlp.exe"`, `sums = "SHA2-256SUMS"`;
    - yt-dlp nightly: `base = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/"`, jinak stejné;
    - Deno: `base = "https://github.com/denoland/deno/releases/latest/download/"`, `asset = "deno-x86_64-pc-windows-msvc.zip"`, `sums = "deno-x86_64-pc-windows-msvc.zip.sha256sum"`.
  - `INTERVAL`: yt-dlp 24 h, Deno 7 dní (6.6). `BACKOFF_S = [60, 300, 1800, 7200]` (pak stále 7200) (10.7). Limity velikosti: součty 64 KiB, yt-dlp 64 MiB, Deno zip 256 MiB.
  - `http::Fetch: Send + Sync { fn get(&self, url: &str, limit: u64) -> Result<Vec<u8>, FetchError>; }`, `http::Web::github() -> Web` a `http::Web::with_hosts(hosts: &[&str]) -> Web` (pro test s místním serverem). ureq 3 s TLS přes `native-tls` (schannel; ne rustls, které by táhlo ring nebo aws-lc-rs s nástroji pro sestavení C), přesné názvy features implementer ověří v ureq 3.x; přesměrování sleduje ručně a každý hop (i první URL) musí mít host z povolených: `ALLOWED_HOSTS` = `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` (implementer ověří, kam GitHub dnes přesměrovává); User-Agent `Kaleido/<verze>`; časové limity 15 s spojení, 30 s součty, 10 min binárka; čte nejvýš `limit` bajtů. `FetchError { Offline, Status(u16), TooLarge, Host(String), Other(String) }`.
  - `checksum::sha256_hex(bytes) -> String`, `checksum::from_sums(text, asset) -> Option<String>` (řádky `<64 hex>  <jméno>` nebo `<hex> *<jméno>`), `checksum::first_hex(text) -> Option<String>` (Deno `.sha256sum`; přesný tvar ověří implementer na posledním vydání).
  - `store::ToolsFile { version: 1, tools: BTreeMap<ToolId, ToolRecord> }`, `ToolRecord { version: Option<String>, sha256: String /* staženého assetu */, channel: Option<Channel>, installed_at: String, checked_at: Option<String>, failures: u32, next_try: Option<String> }`, v `tools_dir\tools.json`, atomicky.
  - `schedule::due(record: Option<&ToolRecord>, now: OffsetDateTime, interval: Duration) -> bool` (chybí → hned; `next_try` v budoucnu → ne), `schedule::after_failure(record, now) -> (u32, OffsetDateTime)`.
  - `replace::replace_binary(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()>`: zapíše `<name>.new` (`create_new`, `sync_all`), existující `<name>` přejmenuje na `<name>.old-<nanos>`, `.new` na `<name>`; při chybě vrátí; `replace::sweep(dir)` smaže `*.old-*`, které smazat jde (běžící zůstanou). Deno: `deno.exe` z zipu (crate `zip`), pak `replace_binary`.
  - `tools::Tools::new(paths: &AppPaths, fetch: Arc<dyn Fetch>, inspect: Arc<dyn Inspect>) -> Tools`, `trait Inspect: Send + Sync { fn version(&self, tool: ToolId, exe: &Path) -> Option<String>; }` (skutečný přidá Task 9; v testech falešný), `Tools::check(&self, tool, channel, force: bool) -> Result<ToolStatus, ToolError>`: (1) je-li v `resource_dir\tools\` přibalená kopie s `resource_dir\tools\tools.json` (stejný tvar jako `ToolsFile`, zapíše ho instalátor M4) a nástroj chybí, převzít ji, jen když její SHA-256 sedí se záznamem (rozhodnutí 7); (2) stáhnout součty, z nich součet assetu; (3) stejný jako v záznamu a soubor je na disku → jen `checked_at`; (4) jinak stáhnout asset, ověřit součet, vyměnit, `version` přes `Inspect`, záznam; (5) chyba → nástroj na disku beze změny, `failures`, `next_try`. `Tools::status(tool) -> ToolStatus`, `ToolStatus { tool, state: ToolState { Missing, Checking, Downloading, Ready, Failed }, version: Option<String>, checked_at: Option<String>, error: Option<String> }`. `Tools::path(tool) -> Option<PathBuf>` (jen ověřený a existující). Na jeden nástroj nejvýš jedna kontrola najednou (druhá počká na výsledek první).

- [ ] **Step 1: Napsat selhávající testy** (falešný `Fetch` = mapa URL → bajty nebo chyba, dočasná složka)

```rust
#[test] fn a_missing_tool_is_downloaded_verified_and_recorded()
#[test] fn the_same_checksum_downloads_nothing() // jen checked_at
#[test] fn a_new_checksum_replaces_the_tool()
#[test] fn a_checksum_mismatch_changes_nothing() // stažená binárka s jiným součtem → starý soubor, záznam beze změny, failures 1
#[test] fn offline_keeps_the_installed_tool_and_backs_off() // FetchError::Offline → stav Failed, soubor beze změny, next_try = now + 60 s, pak 300 s
#[test] fn a_redirect_to_another_host_is_refused() // Web::with_hosts(&["127.0.0.1"]) a místní TcpListener, který odpoví 302 na http://localhost:<port>/x → FetchError::Host("localhost"); bez přesměrování vrátí tělo; delší tělo než limit → TooLarge
#[test] fn sums_files_are_read_exactly() // řádky s "  " i " *", cizí jména, prázdné; Deno první hex
#[test] fn nightly_uses_the_nightly_repository()
#[test] fn the_exe_is_replaced_while_the_old_one_runs() // kopie cmd.exe jako tools/yt-dlp.exe běží (`/c ping -n 5 127.0.0.1`), replace_binary uspěje, nový obsah na místě, sweep starý smaže až po skončení
#[test] fn deno_comes_out_of_its_zip()
#[test] fn a_bundled_copy_is_taken_over_when_the_tool_is_missing()
#[test] fn two_checks_at_once_download_once()
#[test] fn due_follows_the_daily_and_weekly_intervals()
#[test] #[ignore = "network"] fn the_real_yt_dlp_release_has_a_checksum_for_the_exe()
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido tools::` — Expected: FAIL
- [ ] **Step 3: Implementovat; přegenerovat licence**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido tools::` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri resources/licenses/third-party.json
git commit -m "feat(tools): verified yt-dlp and Deno downloads with a side-by-side swap and a check schedule"
```

---

### Task 9: Nástroje – procesy, mpv, příkazy, kanál

**Files:**
- Create: `src-tauri/src/tools/run.rs`, `ytdlp.rs`, `mpv.rs`
- Modify: `src-tauri/src/tools/mod.rs` (vlákno plánovače, události), `src-tauri/src/lib.rs` (start služby po setupu, volby nástrojů v `prepare` restartu), `src-tauri/src/commands.rs`, `src-tauri/src/settings/store.rs` (`Settings.updates: Updates { ytdlp_channel: Channel }`, výchozí `Stable`, validace jako ostatní sekce), `src-tauri/src/system/diagnostics.rs` (`ytdlp`, `deno`), IPC smlouva (`tools_status`, `tools_check`, `tools:status`, `Settings.updates`), `src/ipc/*`

**Interfaces:**
- Consumes: `Tools`, `Inspect`, `ToolStatus` (Task 8), `restart_engine` a `Restart.prepare` (Task 6).
- Produces:
  - `run::run(exe: &Path, args: &[OsString], timeout: Duration, stdout_limit: usize) -> Result<Output, RunError>`: `Command` s `creation_flags(CREATE_NO_WINDOW)`, stdin null, stdout/stderr čtené ve vláknech, po `timeout` `kill`; `RunError { Spawn(String), Timeout, TooLarge, Exit { code: Option<i32>, stderr: String } }`.
  - `run::Processes` implementuje `Inspect`: yt-dlp `--version` → první řádek (`2026.10.10`), Deno `--version` → `deno X.Y.Z (…)` → `X.Y.Z`.
  - `ytdlp::probe_args(url: &str, deno: Option<&Path>, cookies: Option<&str>) -> Vec<OsString>` = `["-J", "--no-playlist", "--no-warnings", "--js-runtimes", "deno:<cesta>" (jen s Deno), "--cookies-from-browser", <spec> (jen s cookies), "--", url]`.
  - `ytdlp::StreamInfo { title: Option<String>, duration: Option<f64>, live: bool, formats: Vec<StreamFormat> }`, `StreamFormat { format_id: String, ext: String, height: Option<u32>, width: Option<u32>, fps: Option<f64>, vcodec: Option<String> /* None i pro "none" */, acodec: Option<String>, dynamic_range: Option<String>, tbr: Option<f64>, filesize: Option<u64>, filesize_approx: Option<u64>, protocol: Option<String> }` (Serialize camelCase pro UI).
  - `ytdlp::parse_info(stdout: &str) -> Result<StreamInfo, ProbeError>`: šum před prvním řádkem začínajícím `{` přeskočí (`extractDumpJson`), `live` = `live_status` není `null`/`not_live` (`isLiveStream`), `_type: "playlist"` → `ProbeError::Playlist`, chybějící `formats` → prázdný seznam. `ytdlp::probe(exe, deno, cookies, url) -> Result<StreamInfo, ProbeError>` (časový limit 60 s, stdout ≤ 32 MiB), `ProbeError { Missing, Failed { stderr: String }, Timeout, Playlist, BadJson(String) }`.
  - `mpv::hook_commands(paths: &AppPaths) -> Vec<Vec<String>>` = `[["change-list", "script-opts", "append", "ytdl_hook-ytdl_path=<tools_dir>\\yt-dlp.exe"]]` (rozhodnutí 2: `ytdl_hook` volby za běhu přečte a yt-dlp hledá znovu; jen spravovaný yt-dlp, žádný záložní z PATH, spec 9.4). Posílá se hned po `Engine::start` (před čímkoli z UI) a v `prepare` restartu.
  - `mpv::raw_options(deno: Option<&Path>, cookies: Option<&str>) -> Vec<Vec<String>>`: `change-list ytdl-raw-options append js-runtimes=deno:<cesta>` (bez Deno `… remove js-runtimes`), `… append cookies-from-browser=<spec>` (bez cookies `… remove cookies-from-browser`). `ytdl_hook` z každého páru udělá `--<klíč> <hodnota>`; `append` bere jednu položku, takže čárka ani dvojtečka v cestě nevadí.
  - `run::deno_supported(version: &str) -> bool` (≥ 2.3.0, rozhodnutí 20); Deno starší nebo s nečitelnou verzí je pro `Tools::path` a `raw_options` jako chybějící a stav `Failed` s důvodem.
  - Služba: vlákno plánovače každou hodinu (a hned po startu) zkontroluje, co je `due` (kanál z nastavení); po instalaci Deno (a změně cookies, Task 11) pošle `raw_options` do běžícího jádra; `prepare` restartu pošle `hook_commands` i `raw_options`. Každá změna stavu emituje `tools:status` (`ToolStatus`).
  - Tauri: `tools_status() -> Vec<ToolStatus>`, `tools_check(tool) -> ToolStatus` (async, vynucená kontrola teď). `settings_set` se změnou `updates.ytdlpChannel` spustí kontrolu yt-dlp v novém kanálu.
  - Diagnostika: `ytdlp`, `deno` verze z `tools.json` (`-` když chybí).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn probe_args_carry_deno_and_cookies_only_when_set()
#[test] fn the_url_comes_after_a_double_dash() // "-x" jako URL nikdy jako volba
#[test] fn info_skips_noise_before_the_json() // "[debug] …\n{…}" (testy extractDumpJson z downloaderu)
#[test] fn live_status_decides_live() // not_live/null → false; is_live, is_upcoming, post_live → true
#[test] fn a_playlist_is_not_a_video()
#[test] fn formats_keep_what_the_quality_list_needs() // vcodec "none" → None, height, fps, dynamic_range "HDR10", filesize_approx
#[test] fn versions_are_read_from_their_output() // "2026.10.10\n" → "2026.10.10"; "deno 2.5.4 (stable, release, x86_64-pc-windows-msvc)\nv8 …" → "2.5.4"
#[test] fn a_hung_process_is_killed_at_the_timeout() // cmd.exe /c ping -n 30 127.0.0.1 s limitem 500 ms → Timeout do 2 s
#[test] fn raw_options_add_and_remove_only_kaleidos_keys()
#[test] fn the_channel_setting_defaults_to_stable_and_rejects_others()
#[test] fn diagnostics_carry_tool_versions()
#[test] fn deno_older_than_2_3_counts_as_missing() // "2.2.9" false, "2.3.0" true, "2.9.7" true, "x" false
// skutečná libmpv:
#[test] fn the_managed_yt_dlp_path_wins_over_mpv_conf() // mpv.conf script-opts=ytdl_hook-ytdl_path=C:/jiny.exe → po hook_commands je v get_string("script-opts") pro klíč ytdl_hook-ytdl_path naše cesta (poslední výskyt)
#[test] fn a_missing_managed_yt_dlp_is_reported_by_the_hook() // tools/yt-dlp.exe neexistuje → loadfile https://www.youtube.com/watch?v=aqz-KE-bpKQ → log ytdl_hook "youtube-dl failed: not found or not enough permissions" (bez sítě: proces se vůbec nespustí; i když je yt-dlp v PATH, protože neprázdné ytdl_path nahradí výchozí hledání)
#[test] fn raw_options_reach_mpv() // po raw_options get_string("ytdl-raw-options") obsahuje js-runtimes=deno:…; uživatelův klíč z mpv.conf zůstal
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido tools:: && cargo test -p kaleido settings::` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido tools:: && cargo test -p kaleido settings:: && cargo test -p kaleido ipc_fixtures && npx vitest run src/ipc` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri src/ipc
git commit -m "feat(tools): run yt-dlp and Deno without a console, wire them into mpv and report their status"
```

---

### Task 10: Chyby streamů

**Files:**
- Create: `src-tauri/src/player/stream_error.rs`
- Modify: `src-tauri/src/player/state.rs` (řádky `ytdl_hook` od začátku položky, pole `stream_error` v `EndFile`), `src-tauri/src/player/mod.rs`, `src-tauri/src/lib.rs` (`route`: při `Outdated`/`Missing` kontrola yt-dlp), `src-tauri/src/commands.rs` (`stream_retry`), `src-tauri/src/system/clipboard.rs` (sdílené otevření odkazu), IPC smlouva (`player.end-file.json`, `stream_retry`, výčet `StreamError`), `src/ipc/*`

**Interfaces:**
- Consumes: `LogLine`, `StateLoop` (M1), `Tools::check` (Task 8–9), `clipboard::open_text` (M1).
- Produces:
  - `StreamError { Outdated, Missing, Cookies, SignIn, AgeRestricted, GeoBlocked, Private, Removed, Network }` (serde camelCase; `Cookies` = cookies vybraného prohlížeče nejdou přečíst, rozhodnutí 19).
  - `stream_error::classify(lines: &[&str]) -> Option<StreamError>`: projde řádky odzadu, první, který sedí, rozhodne (poslední řádek `youtube-dl failed: unexpected error occurred` nesedí na nic, takže rozhodne řádek stderr před ním). Řádek se porovnává malými písmeny a s `’` nahrazeným `'`; pořadí tříd uvnitř řádku: `Missing` → `Cookies` → `AgeRestricted` → `SignIn` → `GeoBlocked` → `Private` → `Removed` → `Network` → `Outdated`. Vzory jsou v „Podklady z průzkumu → Zprávy yt-dlp“; řádek s `http error 4`/`http error 5` není `Network` (`http error 404` je `Removed`, `http error 403` je `Outdated`).
  - `StateLoop` drží nejvýš 20 řádků s `prefix == "ytdl_hook"` (úroveň `warn`, `error`, `fatal`) od posledního `StartFile`/`FileLoaded`; `PlayerEvent::EndFile { …, stream_error: Option<StreamError> }` jen pro `reason: Error` a jen když položka je http(s).
  - `route`: `EndFile` se `stream_error` `Outdated` nebo `Missing` → `Tools::check(YtDlp, kanál, force=false)` na pozadí (6.6: kontrola vždy při chybě zastaralého extraktoru); událost jde do UI dál.
  - Tauri: `stream_retry(url: String, update: bool) -> Result<(), LoadIssue>` (async): `update` → `Tools::check(YtDlp, kanál, force=true)` a počkat; pak otevřít odkaz jako vložený (`clipboard::open_text`: jen http(s), fronta otevření, „Při otevření souboru za běhu“).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn classify_real_yt_dlp_messages() // tabulka: každá zpráva z „Zprávy yt-dlp“ → její třída; "ERROR: [youtube] x: Unable to download API page: [Errno 11001] getaddrinfo failed (caused by TransportError(...))" → Network; "ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication." → SignIn; "Video unavailable. The uploader has not made this video available in your country" → GeoBlocked, ne Removed; "ERROR: Failed to decrypt with DPAPI. See https://github.com/yt-dlp/yt-dlp/issues/10927 for more info" → Cookies
#[test] fn the_last_matching_line_decides()
#[test] fn unrelated_lines_classify_as_nothing()
#[test] fn end_file_carries_the_stream_error_of_its_entry() // syntetické události: Log ytdl_hook "ERROR: … Private video …", EndFile Error http → stream_error Private; další položka začíná s prázdným bufferem
#[test] fn local_files_never_get_a_stream_error()
#[test] fn retry_refuses_anything_but_http_links() // "file:///C:/a.mkv" → LoadIssue Protocol
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido player::stream_error && cargo test -p kaleido player::state` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido player:: && cargo test -p kaleido ipc_fixtures && npx vitest run src/ipc` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri src/ipc
git commit -m "feat(player): classify stream errors from ytdl_hook and retry links after an update"
```

---

### Task 11: Prohlížeče a cookies

**Files:**
- Create: `src-tauri/src/system/browsers.rs`
- Modify: `src-tauri/src/system/mod.rs`, `src-tauri/src/settings/store.rs` (`Playback.cookies_from_browser: Option<String>`), `src-tauri/src/commands.rs` (`system_browsers`; `settings_set` po změně cookies pošle `tools::mpv::raw_options` do jádra), `src-tauri/src/lib.rs`, IPC smlouva (`system_browsers`, `Browser`, `BrowserWarning`, `Settings.playback`), `src/ipc/*`

**Interfaces:**
- Consumes: `tools::mpv::raw_options` (Task 9), `SettingsStore` (M1).
- Produces:
  - `Browser { id: String, label: String, spec: String, warning: Option<BrowserWarning> }`, `BrowserWarning { ChromiumCookies, NoProfile }` (serde camelCase).
  - `browsers::Roots { local: PathBuf /* %LOCALAPPDATA% */, roaming: PathBuf /* %APPDATA% */ }`, `browsers::detect(roots: &Roots) -> Vec<Browser>`: port `src/lib/browsers.ts` (Windows část) s kontrolou, že prohlížeč je nainstalovaný (složka dat existuje); pořadí: Firefox, Edge, Chrome, Brave, Opera, Vivaldi, Chromium, LibreWolf, Zen, Floorp, Arc.
    - Nativní (`spec` = id yt-dlp): `firefox` (`roaming\Mozilla\Firefox\Profiles`), `edge` (`local\Microsoft\Edge\User Data`), `chrome` (`local\Google\Chrome\User Data`), `brave` (`local\BraveSoftware\Brave-Browser\User Data`), `opera` (`roaming\Opera Software\Opera Stable`), `vivaldi` (`local\Vivaldi\User Data`), `chromium` (`local\Chromium\User Data`).
    - Forky Firefoxu (`spec` = `firefox:<profil>`, profil = podsložka s `cookies.sqlite` s nejnovějším `mtime`, jako `findFirefoxProfile`): `librewolf` (`roaming\librewolf\Profiles`), `zen` (`roaming\zen\Profiles`), `floorp` (`roaming\Floorp\Profiles`). Bez profilu → `warning: NoProfile`.
    - Arc (`spec` = `chromium:<local\Arc\User Data\Default>` jen s `Default\Cookies` nebo `Default\Network\Cookies`, jako `findChromiumProfile`).
    - Prohlížeče na Chromiu (Edge, Chrome, Brave, Opera, Vivaldi, Chromium, Arc) dostanou `warning: ChromiumCookies` (rozhodnutí 19; UI text: „Na Windows yt-dlp cookies z tohoto prohlížeče většinou nepřečte a přehrávání pak selže. Spolehlivě funguje Firefox.“).
  - `Settings.playback.cookies_from_browser: Option<String>` (JSON `cookiesFromBrowser`, výchozí `null`): validace v `SettingsStore` — `BROWSER[:PROFIL]`, `BROWSER` ∈ `brave, chrome, chromium, edge, firefox, opera, safari, vivaldi, whale`, bez řídicích znaků, nejvýš 1024 znaků; jinak `SettingsError::Invalid { key: "playback.cookiesFromBrowser" }`.
  - Tauri: `system_browsers() -> Vec<Browser>` (async, čte disk).

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn installed_browsers_are_found_in_their_folders() // dočasné kořeny s Edge, Firefox, Zen(profil s cookies.sqlite) → [firefox, edge, zen(firefox:<cesta>)]
#[test] fn the_newest_firefox_fork_profile_wins()
#[test] fn a_fork_without_a_profile_says_so()
#[test] fn arc_needs_a_default_profile_with_cookies()
#[test] fn chromium_browsers_carry_the_warning()
#[test] fn cookie_specs_are_checked() // "firefox" ok, "firefox:C:\\P\\x.default" ok, "netscape" Err, "edge\n" Err
#[test] fn cookies_reach_mpvs_raw_options() // settings_set cookiesFromBrowser "firefox" → zaznamenaný change-list … append cookies-from-browser=firefox; null → … remove cookies-from-browser
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido system::browsers && cargo test -p kaleido settings::` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido system:: && cargo test -p kaleido settings:: && cargo test -p kaleido ipc_fixtures && npx vitest run src/ipc` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri src/ipc
git commit -m "feat(system): find installed browsers for yt-dlp cookies and pass the choice to mpv"
```

---

### Task 12: Kvalita streamů v Rustu

**Files:**
- Create: `src-tauri/src/streams.rs`
- Modify: `src-tauri/src/player/state.rs` (`OBSERVED` + `("path", String)`), `src-tauri/src/player/load.rs` (`ValidatedOptions`, M1 Task 4 odložený minor), `src-tauri/src/settings/mpv_keys.rs` (`ytdl-format`), `src-tauri/src/lib.rs` (`route`: změna `path` → sonda; `entry_options` restartu), `src-tauri/src/commands.rs`, IPC smlouva (`stream_formats`, `player_set_quality`, `stream:formats`, `StreamFormats`, `StreamInfo`, `QualityError`), `src/ipc/*`

**Interfaces:**
- Consumes: `ytdlp::probe`, `StreamInfo`, `ProbeError` (Task 9), `classify` (Task 10), `Restart.entry_options` (Task 6), `LoadOptions::validate` (M1).
- Produces:
  - `load::ValidatedOptions` (newtype jen z `LoadOptions::validated(self) -> Result<ValidatedOptions, SourceError>`); `load_commands` bere `&ValidatedOptions` (všechny volající upravit).
  - `mpv_keys::STREAM_QUALITY_PRESETS: &[&str] = &["bv*[height<=?2160]+ba/b[height<=?2160]", "bv*[height<=?1440]+ba/b[height<=?1440]", "bv*[height<=?1080]+ba/b[height<=?1080]", "bv*[height<=?720]+ba/b[height<=?720]", "bv*[height<=?480]+ba/b[height<=?480]", "ba/b"]`; `MPV_SETTINGS` + `live("ytdl-format", ValueKind::ChoiceOrNone(STREAM_QUALITY_PRESETS))` (prázdná = výchozí yt-dlp).
  - `streams::StreamFormats { url: String, state: FormatsState, chosen: Option<String> }`, `FormatsState` (`tag = "type"`): `Loading`, `Ready { info: StreamInfo }`, `Failed { error: Option<StreamError>, message: String }` (`message` z posledního řádku stderr, sanitizovaný jako diagnostika: bez cest).
  - `streams::Streams` (managed): `on_path(app, path: &str)`: http(s) bez záznamu v cache → `Loading` + emit, vlákno: `probe(yt-dlp, Deno, cookies, url)` → `Ready`/`Failed` (`classify` nad stderr) → emit `stream:formats`. Cache nejvýš 32 URL (nejstarší ven). Bez yt-dlp: `Failed { error: Some(Missing) }`.
  - `streams::quality_commands(path: &str, format: Option<&str> /* už prošel kontrolou */, position: Option<f64>, index: i64) -> Vec<Vec<String>>` (čistá): `loadfile <path> insert-next-play -1 autocreate-playlist=no,start=<pozice>[,ytdl-format=<f>]` (hodnoty v `%N%` uvozovkách) a `playlist-remove <index>`. mpv při `insert-next-play` přepne aktuální položku hned (`mp_set_playlist_entry`), takže odebírá už neaktuální starou; kdyby test se skutečnou libmpv ukázal opak, odebrání se pošle až po `file-loaded` nové položky (stejné pořadí jako `reload.lua`).
  - Tauri: `stream_formats() -> Option<StreamFormats>` (pro aktuální `path`), `player_set_quality(format: Option<String>) -> Result<(), QualityError>`: `QualityError { NotAStream, Invalid }`; `format` projde stejnou kontrolou jako `--format` (M1 `LoadOptions::validate`), uloží se do `chosen` pro URL (`None` = výchozí, smaže), pak v jednom `Request::Call` přečte `path`, `playlist-pos`, `time-pos` a pošle `quality_commands`; emit `stream:formats` s novým `chosen`.
  - `entry_options` restartu: pro URL s `chosen` → `[("ytdl-format", f)]`.

- [ ] **Step 1: Napsat selhávající testy**

```rust
#[test] fn presets_pass_the_format_check() // každá předvolba projde LoadOptions::validate
#[test] fn ytdl_format_accepts_only_presets_or_nothing() // "best,vo=gpu" NotAllowed/Invalid
#[test] fn quality_commands_reload_in_place() // přesný seznam příkazů
#[test] fn a_stream_is_probed_once_per_url() // falešná sonda: dvě změny path na stejnou URL → jedna sonda
#[test] fn local_files_are_not_probed()
#[test] fn a_failed_probe_is_classified() // stderr "ERROR: … Sign in to confirm your age" → Failed { error: Some(AgeRestricted) }
#[test] fn chosen_quality_survives_a_restart() // entry_options vrací ytdl-format pro URL
#[test] fn loading_options_are_validated_before_they_reach_mpv() // load_commands nelze zavolat s nevalidovanými volbami (kompilační), CLI --format se špatnými znaky → odmítnuto
// skutečná libmpv (místní klipy místo streamu, mechanismus je stejný):
#[test] fn changing_quality_keeps_the_playlist_and_the_position() // [a,b], hraje b na 3 s → quality_commands → playlist 2 položky, b' aktuální, time-pos 3 ± 0.5
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `cargo test -p kaleido streams:: && cargo test -p kaleido player::load && cargo test -p kaleido settings::` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `cargo test -p kaleido streams:: && cargo test -p kaleido player:: && cargo test -p kaleido settings:: && cargo test -p kaleido ipc_fixtures && npx vitest run src/ipc` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src-tauri src/ipc
git commit -m "feat(streams): probe streams with yt-dlp -J and switch quality in place"
```

---

### Task 13: UI – Moje pluginy

**Files:**
- Create: `src/plugins/PluginsPage.tsx`, `PluginRow.tsx`, `ApplyBar.tsx`, `PluginLog.tsx`, `pluginsStore.ts`, `PluginsPage.module.css` (+ testy)
- Modify: `src/state/uiStore.ts` (`Page` + `'plugins'`), `src/shell/view.ts`, `src/shell/AppShell.tsx` (prop `plugins`), `src/App.tsx`, `src/shell/Sidebar.tsx` (položka Moje pluginy mezi Přehrávač a Nastavení, ikona v `Icon.tsx`), `src/state/noticeStore.ts` + `src/shell/notices/*` (oznámení pluginu), locales

**Interfaces:**
- Consumes: obaly z Task 7 (`pluginsList`, `pluginsSetEnabled`, `pluginsUninstall`, `pluginsRestoreEssentials`, `pluginsLog`, `pluginsApply`, `onPluginsChanged`, `onPluginsError`), `PluginsState`, `PluginInfo`.
- Produces:
  - `pluginsStore` (Zustand): `state: PluginsState | null`, `busy: Set<string>` (jména s běžící akcí), `error: { name: string; message: string } | null`; akce `load()`, `setEnabled(name, on)`, `uninstall(name)`, `restoreEssentials()`, `apply()`; poslouchá `plugins:changed`.
  - `PluginsPage` (spec 7.3): nadpis, `ApplyBar` nahoře (lepivý v toku stránky, `role="status"`) když `restartNeeded`: věta, že změny se projeví po restartu přehrávače, který pokračuje na stejném místě, tlačítko „Použít“ (během `applying` zakázané s indikátorem); seznam `PluginRow`; dole „Obnovit essentials“, když `removedEssentials` není prázdné.
  - `PluginRow`: jméno, verze, štítek zdroje (Essentials / Ručně přidaný), štítek nekompatibilní (vysvětlení v řádku, spec 6.5), duplicita (vysvětlení), štítek „hlásí chyby“ s počtem → rozbalí `PluginLog` (řádky z `pluginsLog`, vypsané jako „Podrobnosti“ v kartě chyb), přepínač zapnuto (`role="switch"`, `aria-checked`), „Nastavení“ (rozbalí `PluginSettings` z Task 14; do té doby tlačítko není), „Odinstalovat“ → potvrzení v řádku („Soubory půjdou do Koše“) Potvrdit / Zrušit. Šipky nahoru a dolů mezi řádky, Esc zavře rozbalené potvrzení.
  - Oznámení (10.4): `NoticeState` + `PluginNotice { kind: 'plugin'; name: string }`, `pushPluginNotice(name)` při `plugins:error`; karta „Plugin <jméno> hlásí chyby“ s akcí „Vypnout“ (`pluginsSetEnabled(name, false)`, pak text, že se projeví po Použít, a odkaz „Moje pluginy“ → `setPage('plugins')`).
  - `selectView`: `page === 'plugins'` → `'plugins'` (stránka s mini přehrávačem jako Nastavení).

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('the sidebar lists My plugins between Player and Settings');
test('each plugin shows its source, version and badges');
test('the switch disables a plugin and the apply bar appears');
test('apply is disabled while it runs and the bar goes when it is done');
test('uninstall asks in the row and says the files go to the Recycle Bin');
test('the errors badge opens the log');
test('restore essentials shows only when one was removed');
test('a plugin error notice offers Disable once');
test('the page has no portal: everything renders inside the page layer', /* žádný prvek mimo main */);
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `npx vitest run src/plugins src/shell src/state` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `npx vitest run src/plugins src/shell src/state && npx eslint . && npx tsc --noEmit` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(plugins-ui): My plugins with apply, badges, logs and error notices"
```

---

### Task 14: UI – nastavení pluginu

**Files:**
- Create: `src/plugins/PluginSettings.tsx`, `SchemaForm.tsx`, `KeyValueEditor.tsx` (+ testy)
- Modify: `src/plugins/PluginRow.tsx`, locales

**Interfaces:**
- Consumes: `pluginsSettings`, `pluginsSetSetting` (Task 7), `PluginSettings`, `SettingSpec`; pole z `src/settings/fields/` (`Toggle`, `Dropdown`, `ColorField`, `Slider` jen pro `int`/`float` s mezemi, jinak textové pole), `useLanguage` (M1).
- Produces:
  - `PluginSettings({ name })`: načte `pluginsSettings(name)`; se schématem `SchemaForm`, jinak `KeyValueEditor`; pod nimi věta, že se změny projeví po „Použít“ (běžící plugin).
  - `SchemaForm({ schema, entries, onChange })`: jedno pole na `SettingSpec`, popisek `label.cs ?? label.en` podle jazyka UI, hodnota ze `entries` nebo `default`; „Výchozí“ u pole pošle `value: null`.
  - `KeyValueEditor({ entries, onChange })`: řádek klíč (jen čtení) | hodnota (textové pole, uloží na Enter nebo opuštění) | Odebrat; „Přidat volbu“ → nový řádek s kontrolou klíče `[A-Za-z0-9_-]+` v UI (Rust znovu). Chyba z Rustu (`PluginError::Invalid`) u pole, hodnota se vrátí.
  - Vše v toku stránky (R46).

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('a schema form uses the field of each type and the Czech label when there is one');
test('defaults show until the user sets a value, and Default clears it');
test('the key-value editor saves on Enter and on blur');
test('a bad key is refused before it reaches Rust');
test('an error from Rust shows inline and restores the value');
test('managed keys never appear');
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `npx vitest run src/plugins` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `npx vitest run src/plugins && npx eslint .` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(plugins-ui): plugin settings from a schema or as keys and values"
```

---

### Task 15: UI – Kvalita v rychlém nastavení

**Files:**
- Create: `src/streams/videoFormat.ts` (+ `videoFormat.test.ts`, převzato z downloaderu `src/lib/video-format.ts` a `tests/video-format.test.ts`), `src/streams/formats.ts` (+ test; z downloaderu `getVideoFormats`, `formatTbr`, `formatFilesize` i s testy), `src/streams/quality.ts` (+ test), `src/streams/streamStore.ts` (+ test), `src/panels/QualityTab.tsx` (+ test)
- Modify: `src/state/uiStore.ts` (`QuickTab` + `'quality'`), `src/panels/QuickSettings.tsx` (záložka jen u streamu), `src/player/ControlsIsland.tsx` (tlačítko Kvalita u streamu), `src/state/bridge.ts` (`stream:formats`), locales

**Interfaces:**
- Consumes: `streamFormats`, `playerSetQuality`, `onStreamFormats` (Task 12), `StreamInfo`, `StreamFormat`, `path` z `playerStore`.
- Produces:
  - Převzaté soubory nesou hlavičku s licencí MIT a oběma řádky copyrightu downloaderu („Copyright (c) 2021 Raycast“, „Copyright (c) 2026 Vojtěch Stehlík“) a typy přizpůsobené na `StreamFormat` (camelCase).
  - `quality.ts`: `QualityOption { id: string; label: string; selector: string | null /* null = výchozí */; height: number | null; fps: number | null; hdr: boolean; audioOnly: boolean }`, `qualityOptions(info: StreamInfo, t: TFunction): QualityOption[]`: „Automaticky“ (`selector: null`) první; pak jedna volba na výšku s video kodekem (sestupně, bez duplicit), štítek `1080p`, `1080p60` (fps > 30), ` HDR` (`dynamicRange` ≠ `SDR`/null), selektor `bv*[height<=?H]+ba/b[height<=?H]`; „Jen zvuk“ (`ba/b`) jen když existuje formát se zvukem bez videa. U živého vysílání stejné.
  - `streamStore`: `formats: StreamFormats | null` pro aktuální `path`; `select(option)` → `playerSetQuality(option.selector)`.
  - `QualityTab`: seznam (`role="radiogroup"`, vybraná = `chosen`, jinak Automaticky), stav načítání, chyba (`Failed` → text podle třídy, Task 16 klíče `errors.stream.*`).
  - `QuickSettings`: `TABS` = `subtitles`, `audio` a `quality` jen pro stream (`path` http(s)); `ControlsIsland`: tlačítko Kvalita (vedle Titulků) jen pro stream otevře panel na záložce `quality`; ukazuje krátký štítek aktuální volby (`1080p`, `Auto`).

- [ ] **Step 1: Napsat selhávající testy**

```ts
// převzaté: videoFormat.test.ts (11), formats testy formatTbr/formatFilesize/getVideoFormats
test('quality options are one per height, best first, with fps and HDR in the label');
test('audio only appears only when the stream has an audio-only format');
test('Auto is first and stands for the default quality');
test('choosing a height sends its selector and marks it chosen');
test('the quality tab and button show only for streams');
test('loading and a failed probe are shown in the tab');
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `npx vitest run src/streams src/panels src/player` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `npx vitest run src/streams src/panels src/player && npx eslint .` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(streams-ui): quality tab and button built from yt-dlp's formats"
```

---

### Task 16: UI – karty chyb streamů s akcemi

**Files:**
- Create: `src/shell/notices/streamError.ts` (+ test), `src/shell/notices/BrowserChooser.tsx` (+ test)
- Modify: `src/state/noticeStore.ts` (`PlaybackNotice` + `stream: StreamError | null`, `url: string | null`; časovač stojí, dokud je ukazatel nad kartou, fokus uvnitř nebo běží akce), `src/shell/notices/ErrorCard.tsx`, `ErrorCards.tsx`, locales

**Interfaces:**
- Consumes: `player:end-file` se `streamError` (Task 10), `streamRetry` (Task 10), `systemBrowsers`, `settingsSet` (Task 11).
- Produces:
  - `streamErrorKey(error: StreamError): string` → `errors.stream.<třída>` (text pro každou třídu v obou jazycích) a `streamErrorAction(error): 'update' | 'cookies' | 'retry' | null` (10.3: `outdated`, `missing` → `update`; `signIn`, `ageRestricted`, `cookies` → `cookies`; `geoBlocked`, `private`, `removed` → `null`; `network` → `retry`). U `cookies` text říká, že cookies zvoleného prohlížeče nejdou přečíst, a výběr nabídne i „Nepoužívat cookies“.
  - `ErrorCard` u streamu: text třídy místo `errors.playback.*`, tlačítko akce: „Aktualizovat a zkusit znovu“ (`streamRetry(url, true)`, během běhu indikátor, chyba v kartě), „Zkusit znovu“ (`streamRetry(url, false)`), „Použít cookies z prohlížeče“ → `BrowserChooser` v kartě.
  - `BrowserChooser`: seznam z `systemBrowsers()` (radiogroup), u `chromiumCookies` varování z Task 11 (rozhodnutí 19), u `noProfile` věta, že profil nebyl nalezen; Firefox a jeho forky nahoře; „Použít a zkusit znovu“ → `settingsSet({ playback: { cookiesFromBrowser: spec } })` → `streamRetry(url, false)`; bez nalezeného prohlížeče věta a odkaz do Nastavení → Přehrávání.

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('each stream error class has its text and its action', /* tabulka 10.3 */);
test('update and retry calls Rust with update and shows progress');
test('cookies opens the browser chooser inside the card');
test('choosing a browser saves it and retries');
test('geo, private and removed only explain');
test('a card with an action in progress or the pointer over it does not go away');
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `npx vitest run src/shell src/state` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `npx vitest run src/shell src/state && npx eslint .` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(notices): stream error cards with update, retry and cookies from a browser"
```

---

### Task 17: UI – Nastavení: Přehrávání a Aktualizace

**Files:**
- Create: `src/settings/sections/Updates.tsx` (+ test), `src/settings/fields/BrowserField.tsx`
- Modify: `src/settings/descriptors.ts` (`SectionId` + `'updates'` před `about`; `ytdl-format`, `playback.cookiesFromBrowser`, `updates.ytdlpChannel`; `FieldKind` + `{ kind: 'browser' }`), `src/settings/SettingsPage.tsx`, `src/settings/SettingField.tsx`, `src/settings/sections/About.tsx` (verze yt-dlp a Deno v seznamu licencí: `managed` → přeložená verze nebo „stahuje se“), locales

**Interfaces:**
- Consumes: `toolsStatus`, `toolsCheck`, `onToolsStatus` (Task 9), `systemBrowsers` (Task 11), `STREAM_QUALITY_PRESETS` (Task 12, zrcadlo v TS hlídané testem nad `mpv_keys.rs` přes `?raw`, jako parity test M1).
- Produces:
  - Přehrávání: „Výchozí kvalita streamů“ (`ytdl-format`: Nejlepší = `''`, 2160p, 1440p, 1080p, 720p, 480p, Jen zvuk; hodnota mimo předvolby se ukáže jako „Vlastní (mpv.conf)“ a výběr předvolby ji nahradí), „Cookies z prohlížeče“ (`BrowserField`: Nepoužívat + nalezené prohlížeče s varováním pod polem).
  - `Updates`: řádek yt-dlp (verze, „Zkontrolováno“ přes `Intl` relativně, stav: stahuje se / aktuální / chyba s textem, „Zkontrolovat teď“ → `toolsCheck('ytDlp')`), kanál (`updates.ytdlpChannel`: Stabilní / Nightly s vysvětlením), řádek Deno (totéž bez kanálu), verze libmpv (jako O aplikaci).
  - Hledání v nastavení najde nové položky (klíčová slova `yt-dlp`, `deno`, `cookies`, `kvalita`).

- [ ] **Step 1: Napsat selhávající testy**

```ts
test('the default stream quality offers the presets Rust allows', /* parity s mpv_keys.rs */);
test('a custom ytdl-format shows as custom and a preset replaces it');
test('the cookies field lists the browsers Rust found with their warnings');
test('updates shows each tool with its version, last check and a check button');
test('the channel switch saves updates.ytdlpChannel');
test('search finds yt-dlp, Deno, cookies and quality');
```

- [ ] **Step 2: Spustit, ověřit selhání** — Run: `npx vitest run src/settings` — Expected: FAIL
- [ ] **Step 3: Implementovat**
- [ ] **Step 4: Ověřit** — Run: `npx vitest run src/settings && npx eslint .` — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(settings): default stream quality, cookies from a browser and the tools in Updates"
```

---

### Task 18: Ruční kontrola M2, README, E2E

**Files:**
- Create: `docs/m2/checklist.md`
- Modify: `README.md` (essentials, `fetch-essentials.ps1`, nástroje a kde leží, tichý režim neplatí pro uživatele), `e2e/smoke.e2e.ts` (Moje pluginy ukáže thumbfast jako Essentials a zapnutý), `docs/m1/checklist.md` (odkaz na M2 tam, kde M1 slibovalo M2: yt-dlp z PATH)

**Interfaces:**
- Consumes: celá větev.
- Produces: `docs/m2/checklist.md` (česky, ve stylu M1): příprava (build, `scripts/install-local.ps1` **spouští uživatel ve vlastním terminálu**, sandbox nástrojů Clauda zápisy do registru a `%APPDATA%` nepropouští), první start bez nástrojů (yt-dlp a Deno se stáhnou, Nastavení → Aktualizace), YouTube s Deno, výběr kvality uprostřed přehrávání (pozice a playlist zůstanou), výchozí kvalita, třídy chyb (jak je vyvolat: soukromé video, video omezené věkem, region, odpojená síť, `yt-dlp.exe` nahrazený starou verzí), cookies z Firefoxu a z Edge, kanál nightly, offline start, Moje pluginy (vypnout, Použít uprostřed filmu, odinstalovat do Koše, Obnovit essentials, ruční skript a uosc se štítkem, plugin s chybou), essentials v praxi (sub-select vybere titulky podle zapsaného sub-select.json, reload u zaseknutého streamu a Ctrl+r, náhledy thumbfastu), HDR náhled po změně `vf` za běhu (Task 2), diagnostika bez cest.

- [ ] **Step 1: Rozšířit E2E** (napsat, nespouštět v tichém režimu)
- [ ] **Step 2: Napsat checklist a README**
- [ ] **Step 3: Ověřit** — Run: `npx tsc --noEmit -p e2e && npx eslint .` — Expected: PASS
- [ ] **Step 4: Commit**

```bash
git add docs/m2 docs/m1/checklist.md README.md e2e
git commit -m "docs(m2): manual checklist, README and the plugins step of the smoke E2E"
```

---

## Podklady z průzkumu (2026-10-18)

Ověřeno ze zdrojů (GitHub API, raw soubory, mpv `player/lua/ytdl_hook.lua` na accb7b2821, zdroj yt-dlp 2026.08.19). Neověřené je výslovně označené.

### Essentials

| | thumbfast | sub-select | reload |
|---|---|---|---|
| Repo | `po5/thumbfast` | `CogentRedTester/mpv-sub-select` | `4e6/mpv-reload` |
| Commit | `0f711de3138c9bd6718209d819ac54022c23ded2` | `26d24a0fd1d69988eaedda6056a2c87d0a55b6cb` | `fb7a26e21e581fcac4eeee9291de0ff788dc1a47` |
| Soubor | `thumbfast.lua` | `sub-select.lua` | `main.lua` |
| SHA-256 | `a3d08e71eae8b892f6cd39f9593ea219768e709312d176bca883841b156448bf` | `16f16b199f5273b9306f9cc48c4c710eb22ba37f6eeefbac074bcc533ade2271` | `a8949ffe64dc557c60ea24c06f8b5593716463fae6235480b77713bfe786c806` |
| Cíl | `scripts/thumbfast/main.lua` | `scripts/sub-select/main.lua` | `scripts/reload/main.lua` |
| `scriptName` (mpv) | `thumbfast` | `sub_select` | `reload` |
| `optsName` (`read_options`) | `thumbfast` | `sub_select` | `reload` (jméno skriptu) |
| Licence | MPL-2.0 (bez „Incompatible With Secondary Licenses“) | MIT | MIT |
| Vazby kláves | žádné | žádné | `Ctrl+r` → `reload/reload_resume` (ne vynucená) |

- thumbfast: zprávy `thumb`, `clear`; `network=no` výchozí (u streamů bez náhledů); s `mpv_path=mpv` by na Windows spustil `user-data/frontend/process-path`, proto ho Kaleido spravuje.
- sub-select: zprávy `select-subtitles`, `sub-select enable|disable|toggle`; vybírá jen při `sid=auto` a `track-auto-selection=yes` (restart s `sid` z Task 6 ho pro tu položku vypne, což je žádoucí: zachová volbu uživatele). Bez shody preferencí výběr mpv nemění.
- reload: hlídá `paused-for-cache` (10 s) a postup cache demuxeru (20 s); znovu načte přes přidání položky se `start`, přesun, přehrání a odebrání staré (playlist v UI se tím na chvíli změní). Vlastní volby pro znovupřipojení nemá.
- evafast (`po5/evafast`, `f9ee7e41dedf0f65186900e0ccdd6ca6a8ced7ed`): **bez licence**, váže `RIGHT` (`mp.add_key_binding`, `complex`), mění `speed`, po krátkém stisku `seek 5` s OSD mpv → nepřibalit (rozhodnutí 17).

### ytdl_hook

- Volby (l. 5–13): `exclude`, `include` (YouTube a Twitch se zkouší přes yt-dlp hned), `try_ytdl_first=no`, `use_manifests=no`, `all_formats=yes`, `force_all_formats=yes`, `thumbnails=none`, `ytdl_path=""`. Čtené pod jménem `ytdl_hook` s obsluhou změn za běhu (l. 23 `read_options(o, nil, function() ytdl.blacklisted = {}; ytdl.searched = false end)`).
- `ytdl_path`: neprázdná hodnota nahradí výchozí hledání (`yt-dlp`, `yt-dlp_x86`, `youtube-dl`), seznam se na Windows dělí `;`.
- `ytdl-raw-options`: každý pár → `--<klíč>` a `<hodnota>`; klíče jsou jedinečné; `append` = jedna položka bez escapování.
- Volání yt-dlp obsahuje mimo jiné `--no-warnings`, `--format <ytdl-format>` (výchozí `bestvideo*+bestaudio/bestvideo+bestaudio/best`; `bestaudio/best` při `vid=no`), raw volby, `--sub-langs all`, `--write-srt`, `--no-playlist` (bez `yes-playlist`), `--` a URL. Proces se spouští s `CREATE_NO_WINDOW`.
- Selhání (l. 1003–1026): nejdřív `msg.error(<stderr yt-dlp oříznutý>)` (mpv víceřádkovou zprávu rozdělí, každý řádek je zvláštní log s prefixem `ytdl_hook` a úrovní `error`), pak `msg.error("youtube-dl failed: " .. <not found or not enough permissions | failed to parse JSON data: … | unexpected error occurred>)`.
- `user-data/mpv/ytdl/json-subprocess-result` (l. 998) nese po každém běhu `status`, `stdout`, `stderr`, `error_string`, `killed_by_us`; Kaleido ho v M2 nepoužívá (stačí log), je to záloha, kdyby log nestačil.

### Nástroje

- yt-dlp: stabilní `2026.08.19`, `yt-dlp.exe` 17 840 399 B; `SHA2-256SUMS` řádky `<64 malých hex><2 mezery><jméno>\n`; `SHA2-256SUMS.sig` je GPG (Kaleido ho neověřuje, stačí součet z HTTPS z GitHubu, jako `yt-dlp -U`). Nightly `yt-dlp/yt-dlp-nightly-builds`, stejná jména assetů, verze `2026.10.10.233141`. `--version` vypíše jen verzi.
- `--js-runtimes RUNTIME[:CESTA]` (dělí se na první `:`, takže `deno:C:\…\deno.exe` funguje), výchozí jen `deno`; řešič EJS je v `yt-dlp.exe`, `--remote-components` netřeba; Deno ≥ 2.3.0; yt-dlp hledá `deno.exe` nejdřív vedle sebe.
- Deno: `v2.9.7`; `deno-x86_64-pc-windows-msvc.zip` 42 630 221 B, `deno.exe` v kořeni zipu; `….zip.sha256sum` je výstup PowerShellu `Get-FileHash` (prázdný první řádek, CRLF, `Hash      : <64 VELKÝCH hex>`), čte se regulárním výrazem `Hash\s*:\s*([0-9A-Fa-f]{64})` (`checksum::first_hex` podle něj); zvlášť `deno-x86_64-pc-windows-msvc.sha256sum` je součet rozbaleného `deno.exe` (Kaleido ověřuje zip). `deno --version`: první řádek `deno X.Y.Z (stable, release, x86_64-pc-windows-msvc)`.
- Přesměrování stahování z GitHub Releases: implementer ověří cílové hosty (`objects.githubusercontent.com`, `release-assets.githubusercontent.com`) a zapíše je do `ALLOWED_HOSTS`.

### Zprávy yt-dlp

Malá písmena, `’` → `'`. Krátké ASCII úseky; řádek může mít předponu `ERROR: [youtube] <id>: `.

| Třída | Úseky (stačí jeden) |
|---|---|
| `missing` | `youtube-dl failed: not found or not enough permissions` |
| `cookies` | `failed to decrypt with dpapi`, `could not copy chrome cookie database`, `cookies database` + `could not find`, `cannot decrypt v10 cookies` |
| `ageRestricted` | `confirm your age`, `age-restricted`, `age restricted`, `inappropriate for some users` |
| `signIn` | `sign in to confirm`, `use --cookies-from-browser or --cookies`, `only available for registered users`, `login required`, `captcha`, `your ip is likely being blocked`, `rate-limited by youtube`, `members-only` |
| `geoBlocked` | `geo restriction`, `not available from your location`, `not made this video available in your country`, `not available in your country` |
| `private` | `private video`, `this video is private` |
| `removed` | `video unavailable`, `has been removed`, `has been terminated`, `no longer available`, `http error 404`, `drm protected` |
| `network` | `unable to download webpage`, `unable to download api page`, `getaddrinfo failed`, `errno 11001`, `failed to resolve`, `max retries exceeded`, `timed out`, `connection reset`, `10054`, `connection aborted`, `remote end closed connection`, `network is unreachable` (ne s `http error 4`/`5`) |
| `outdated` | `please report this issue on`, `confirm you are on the latest version`, `unable to extract`, `failed to extract any player response`, `cannot identify player`, `requested format is not available`, `no video formats found`, `http error 403` |

Spolehlivé znamení zastaralého extraktoru je dovětek `please report this issue` / `Confirm you are on the latest version`: očekávané chyby (přihlášení, region, síť) ho nikdy nemají. Přesné texty z YouTube (`Private video`, `Video unavailable`, `…not a bot`) jsou ze serveru a neověřené, proto krátké úseky.

### Cookies

- Syntaxe `BROWSER[+KEYRING][:PROFIL][::KONTEJNER]` (KEYRING jen Linux), prohlížeče yt-dlp: `brave, chrome, chromium, edge, firefox, opera, safari, vivaldi, whale`; profil = jméno nebo cesta, výchozí naposled použitý.
- `ytdl_hook` cookies, které yt-dlp vrátí, předá i mpv (`cookies-file=memory://…`), takže je mají i požadavky přehrávání.
- Windows: Chromium (`v20`, App-Bound od Chrome 127) → `Failed to decrypt with DPAPI` (issue #10927 zamčené, podpora v20 v kódu není); běžící Chromium → `Could not copy Chrome cookie database` (#7271); obojí je tvrdá chyba celého načtení. Firefox funguje i za běhu. Zda Edge používá App-Bound šifrování, je neověřené (správce yt-dlp v 2024: týká se všech prohlížečů na Chromiu).

## Po závěrečné revizi

Závěrečná revize celé větve (2026-10-19) našla tři mezery plánu; oprava je v kódu a pravidla platí i pro M3 a M4:

- Rozhodnutí 7 neříkalo, že se kontroluje i soubor na disku: součet vydání se porovnával jen se záznamem v `tools.json`, takže nahrazený nebo poškozený nástroj zůstal „aktuální“. Teď každá kontrola přečte SHA-256 souboru (záznam Deno má i součet `deno.exe`) a nesoulad stáhne znovu.
- Rozhodnutí 10 nepočítalo s přibaleným skriptem reload: jeho Ctrl+R a obnova při zaseknutí načtou položku bez `ytdl-format`. V M2 to UI aspoň řekne pravdivě (Ruling R17).
- Spec 10.3 mlčí o yt-dlp, který je už nejnovější: „Aktualizovat a zkusit znovu“ se pak točilo dokola. Teď karta řekne, co kontrola našla, a místo tlačítka nabídne Nastavení → Aktualizace.

Dvě poučení pro M3:

- Jednorázová událost, která může přijít dřív, než UI poslouchá (`plugins:error` při startu), potřebuje přehrání ve chvíli, kdy je UI připravené, jako má fronta otevírání.
- Volby jedné položky odkazu (zvolená kvalita) patří do háku mpv `on_load`, ne do voleb `loadfile` jedné položky, které jiné skripty nepřenesou (navazuje na R17).
