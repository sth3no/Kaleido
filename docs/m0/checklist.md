# M0 – ruční kontrola

Výsledky zapisuj do `docs/m0/report.md` (řádky 1–8), nebo je pošli Claudovi v chatu.

Průchody Computer Use z 2026-10-15 a 2026-10-16 a nalezené chyby jsou v [report.md](report.md).
Zaškrtnuté jsou pouze dokončené kontroly; složené body s neověřeným DPI, rychlostí či opakováním
zůstávají otevřené, i když základní funkce prošla.

## Spuštění

Pro otevírání videí z Průzkumníku a aplikace Files je k dispozici
[místní instalace s ověřenou nabídkou **Send to → Kaleido**](local-install.md).
Moderní „Open with“ na tomto PC Kaleido stále nenabízí; stav registrace je v uvedeném postupu.

```bash
cd C:/Users/PC/Projects/Apps/Kaleido/app/.claude/worktrees/m0-prototype/prototype
npm run tauri dev
```

První spuštění sestaví `kaleido-mpv.exe` a aplikaci (asi minutu). Média jsou v
`%USERPROFILE%\Videos\kaleido-m0\` (vygenerovaná: SDR 1080p, letterbox 2.39:1, 4K 60 fps,
syntetické HDR10, kopie s českým názvem). Pro bod 2 se hodí i skutečné HDR10 video.

Zkratky v prototypu: `g` zapne/vypne sklo, `s` snímek bez skla, `S` výchozí snímek mpv,
`I` statistiky mpv (pak `2` = časy průchodů), `` ` `` konzole mpv (na české klávesnici klávesa,
která píše zpětný apostrof).

## 1 · Video pod průhledným UI
- [x] Otevřít `sdr-1080p.mkv` → video je vidět pod poloprůhlednými kapslemi.
- [ ] 10 s rychle měnit velikost okna a přesouvat ho: bliká něco? Zůstávají černé/bílé okraje?
- [x] `Žluťoučký kůň (zkouška).mkv` se otevře.
- [x] ✕ během přehrávání → aplikace skončí do 2 s, `tasklist | findstr /i kaleido` nic nevypíše.
  (✕ ukončilo procesy 2026-10-15; čas změřen přes `WM_CLOSE` 2026-10-17: ≤ 236 ms.)

## 2 · HDR
- [ ] Windows HDR zapnuté → HDR10 video: štítek „HDR“, světla jasnější než bílé UI, UI není vybledlé.
- [ ] Windows HDR vypnuté → totéž video je tónově mapované, barvy nejsou vybledlé.

## 3 · Vstup
- [ ] Mezerník = pauza; šipky přetáčí; podržená šipka přetáčí plynule a po puštění přestane.
- [ ] Pustit Ctrl dřív než šipku → nic se nezasekne.
- [x] Konzole: napsat `show-text "ahoj ěščř" 5000` + Enter → text s diakritikou; Esc ji zavře.
- [ ] Klik do modrého rámečku `click-target` → počítadlo +1 (i při měřítku Windows 150 %).
- [x] Kolečko myši něco udělá (výchozí vazba mpv).
- [x] Dvojklik do videa → fullscreen se přepne právě jednou; Esc ho ukončí.
  Když nic: `SEND_EXPLICIT_DOUBLE_CLICK = true` v `prototype/src/input/forward.ts`.
- [ ] Klik na ▶ a pak mezerník → pauza se přepne jen jednou.

## 4 · Fullscreen a DPI
- [ ] ⛶ → přechod jen přes černou, bez roztaženého snímku a bez bílého bliknutí; totéž zpět.
- [ ] 10× rychle ⛶ → nic se nezasekne.
- [ ] Přetažení mezi monitory s různým měřítkem → video vyplní okno.

## 5 · Sklo
- [ ] Pod kapslemi je video rozmazané, tvar sedí (zaoblené konce, žádný posun ani převrácení), i při 150 %.
- [ ] `letterbox-239.mkv`: rozmazání sedí i nad pruhy. Když je posunuté o výšku pruhu →
  `OUTPUT_EXCLUDES_MARGINS = false` v `prototype/src-tauri/src/glass.rs`.
- [ ] 2,5 s bez pohybu myši → kapsle zmizí a rozmazání mizí s nimi bez bliknutí.
  (Částečně: zmizení kapslí i rozmazání potvrdily snímky UI; bliknutí nikdo neměřil.)
- [ ] `uhd-2160p.mkv` na celé obrazovce, `I` → `2`: součet časů `kaleido-glass blur H/V/composite`
  (cíl ≤ 1 ms) na RTX 5060 Ti a na integrované AMD (Nastavení → Grafika → Úspora energie).

## 6 · Mini přehrávač
- [x] ▣ → video se zmenší do rohu, kolem neprůhledná „stránka“; ⤢ zpět.
- [ ] Záznam 60 fps (Win+Alt+R): hrana videa zaostává za rámečkem nejvýš o 1 snímek?
- [ ] V mini režimu funguje ▶/❚❚ a dvojklik.
- [ ] V mini režimu přetáhnout okno a změnit jeho velikost → video zůstane v rámečku a nebliká
  (oprava 2026-10-17; dřív se po přesunu okna vrátilo na celou plochu). Nainstalovaný build
  z 2026-10-16 opravu nemá: zkoušet v `npm run tauri dev` nebo po nové instalaci.

## 7 · Náhledy
- [ ] Najetí na časovou osu → do 300 ms náhled ve skleněné bublině, mění se s pohybem.
- [x] Žádné konzolové okno; běží `kaleido-mpv.exe` (UI a doplňková kontrola procesů).
- [ ] HDR video → náhledy nejsou šedé ani přepálené.
- [x] Syntetické HDR10 pruhy → po opravě náhledu zůstává červená červená a modrá modrá,
  náhled není vybledlý (nainstalovaný build, Computer Use 2026-10-16).
- [x] Po zavření aplikace nezůstane `kaleido-mpv.exe`.

## 8 · Snímek obrazovky
- [x] S viditelným ovládáním `s` a `S` → soubory na ploše. Ve snímku z `s` nesmí být rozmazané
  obdélníky. Obsahuje je snímek z `S`?

## Měření pro Task 13 (lze až po ruční kontrole)
- [x] `npm run tauri build -- --no-bundle`, spustit `target/release/kaleido-proto.exe`: čas do okna (≤ 500 ms),
  CPU v pauze 60 s (< 1 %), paměť `msedgewebview2.exe` (≤ 200 MB). Výsledky v [report.md](report.md)
  (Výkon, 2026-10-17); integrovaná AMD a 4K zdroj neměřeny.
- [ ] Totéž na integrované AMD a s `uhd-2160p.mkv`: `scripts/measure-m0.ps1` (postup v report.md,
  sekce Výkon).
