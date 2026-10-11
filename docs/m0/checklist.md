# M0 – ruční kontrola

Výsledky zapisuj do `docs/m0/report.md` (řádky 1–8), nebo je pošli Claudovi v chatu.

## Spuštění

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
- [ ] Otevřít `sdr-1080p.mkv` → video je vidět pod poloprůhlednými kapslemi.
- [ ] 10 s rychle měnit velikost okna a přesouvat ho: bliká něco? Zůstávají černé/bílé okraje?
- [ ] `Žluťoučký kůň (zkouška).mkv` se otevře.
- [ ] ✕ během přehrávání → aplikace skončí do 2 s, `tasklist | findstr /i kaleido` nic nevypíše.

## 2 · HDR
- [ ] Windows HDR zapnuté → HDR10 video: štítek „HDR“, světla jasnější než bílé UI, UI není vybledlé.
- [ ] Windows HDR vypnuté → totéž video je tónově mapované, barvy nejsou vybledlé.

## 3 · Vstup
- [ ] Mezerník = pauza; šipky přetáčí; podržená šipka přetáčí plynule a po puštění přestane.
- [ ] Pustit Ctrl dřív než šipku → nic se nezasekne.
- [ ] Konzole: napsat `show-text ahoj ěščř` + Enter → text s diakritikou; Esc ji zavře.
- [ ] Klik do modrého rámečku `click-target` → počítadlo +1 (i při měřítku Windows 150 %).
- [ ] Kolečko myši něco udělá (výchozí vazba mpv).
- [ ] Dvojklik do videa → fullscreen se přepne právě jednou; Esc ho ukončí.
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
- [ ] `uhd-2160p.mkv` na celé obrazovce, `I` → `2`: součet časů `kaleido-glass blur H/V/composite`
  (cíl ≤ 1 ms) na RTX 5060 Ti a na integrované AMD (Nastavení → Grafika → Úspora energie).

## 6 · Mini přehrávač
- [ ] ▣ → video se zmenší do rohu, kolem neprůhledná „stránka“; ⤢ zpět.
- [ ] Záznam 60 fps (Win+Alt+R): hrana videa zaostává za rámečkem nejvýš o 1 snímek?
- [ ] V mini režimu funguje ▶/❚❚ a dvojklik.

## 7 · Náhledy
- [ ] Najetí na časovou osu → do 300 ms náhled ve skleněné bublině, mění se s pohybem.
- [ ] Žádné konzolové okno; ve Správci úloh běží `kaleido-mpv.exe`.
- [ ] HDR video → náhledy nejsou šedé ani přepálené.
- [ ] Po zavření aplikace nezůstane `kaleido-mpv.exe`.

## 8 · Snímek obrazovky
- [ ] S viditelným ovládáním `s` a `S` → soubory na ploše. Ve snímku z `s` nesmí být rozmazané
  obdélníky. Obsahuje je snímek z `S`?

## Měření pro Task 13 (lze až po ruční kontrole)
- [ ] `npm run tauri build -- --no-bundle`, spustit `target/release/kaleido-proto.exe`: čas do okna (≤ 500 ms),
  CPU v pauze 60 s (< 1 %), paměť `msedgewebview2.exe` (≤ 200 MB).
