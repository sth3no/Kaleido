# M0 – zpráva z ověřovacího prototypu

Spec: `docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md`, kapitola 5.4.
libmpv: shinchiro `mpv-dev-x86_64-20261011-git-accb7b2821.7z` (mpv `accb7b2821`).

## Prostředí

| Položka | Hodnota |
|---|---|
| Windows (verze, build) | Windows 11 Pro, 10.0.26200 (2026-10-16) |
| GPU | NVIDIA GeForce RTX 5060 Ti; AMD Radeon (integrovaná) |
| Monitory (rozlišení, DPI, HDR) | aktivní NVIDIA výstup 1920×1080, 239 Hz dle WMI; jiné DPI a Windows HDR neověřeny |

## Výsledky

| # | Ověřit | Kritérium | Výsledek | Měření / pozorování | Rozhodnutí |
|---|---|---|---|---|---|
| 1 | průhledné WebView2 nad D3D11 podoknem | bez blikání při změně velikosti a přesunu, 60 fps | částečně | UI: SDR, letterbox, 4K i syntetické HDR jsou vidět pod kapslemi; změna velikosti a maximalizace fungují. Záznam blikání/60 fps neproveden. | `wid` = hlavní okno, přesouvá se okno `mpv` |
| 2 | HDR | HDR10 se zapnutým i vypnutým HDR ve Windows, UI nerozbije HDR | částečně | UI: syntetické HDR10 se načte, štítek „4K HDR“, obraz a sklo se vykreslí. Skutečný jas HDR, přepínání Windows HDR a oba režimy neověřeny. | otevřené |
| 3 | přeposílání vstupu | klávesy s modifikátory, myš, kolečko; konzole; menu v obraze | částečně | UI: Space, šipka, seekbar, hlasitost, kolečko (60→62 %), click-target (0→1), dvojklik fullscreen, konzole a český text prošly. Držení/modifikátory a 150 % DPI zbývají. | |
| 4 | fullscreen a DPI | černá clona, přesun mezi monitory s různým DPI | částečně | UI: tlačítko fullscreen a dvojklik zvětší video na 1920×1080; Escape vrátí okno. Snímky nezměří přechodové bliknutí; jiné DPI a 10 rychlých přepnutí zbývají. | |
| 5 | shader sklo | oblasti za běhu, ≤ 1 ms GPU ve 4K, sleduje animaci | částečně | UI: rozmazání pod kapslemi; `g` vypne/zapne i při pauze; při autohide rozmazání mizí s kapslemi (bliknutí neměřeno); letterbox je vidět, sedění rozmazání nad pruhy nepotvrzeno. Statistika u 4K zdroje v okně 1280×720 ukázala průměr H/V/composite 20+6+24 µs; není to měření 4K výstupu ani obou GPU. | výkon ve 4K a DPI zbývá |
| 6 | mini přehrávač | podokno synchronně s animací UI | částečně | UI: zmenšení do rohu, pauza/přehrání a návrat tlačítkem fungují po opravě zachytávání ukazatele. Záznam animace po snímcích neproveden. | oprava nainstalována |
| 7 | thumbfast | `kaleido-mpv.exe` + `thumbfast-render` v React bublině | částečně | UI: SDR i opravený syntetický HDR náhled v bublině fungují bez konzolového okna; červená a modrá se již neposouvají ani nebělají. Limit 300 ms a skutečný HDR materiál neověřeny. | společný AVFilter graf, Mobius → sRGB/BT.709; upstream thumbfast nezměněn |
| 8 | snímek obrazovky | bez rozmazaných oblastí skla | prošlo | UI: `s` vytvořilo čistý JPG 1920×804 na Ploše, `Shift+s` obsahuje rozmazané oblasti. Oba výstupy vizuálně zkontrolovány. Opravena neplatná mpv cesta `~~desktop/`. | používá Windows cestu z Tauri |

## Další zjištění

### Okno pro mpv musí být přímý potomek hlavního okna (Task 7)

- **Původní návrh selhal:** vlastní podokno `KaleidoVideoSurface` (potomek hlavního okna) předané
  mpv jako `wid`. mpv uvnitř vytvoří své okno, takže vznikne vnuk hlavního okna. Jeho flip-model
  swapchain (D3D11, `R8G8B8A8_UNORM`) DWM v průhledném okně Tauri nesložil a oblast videa byla
  průhledná, přes okno byla vidět plocha. Bez GDI pozadí (`hbrBackground = NULL`) se nic nezměnilo.
- **Funguje:** `wid` = HWND hlavního okna (stejně jako tauri-plugin-libmpv). mpv si vytvoří vlastní
  okno třídy `mpv` jako přímého potomka pod WebView2 a video je vidět pod průhledným UI.
- **Mini přehrávač:** místo vlastního podokna se přesouvá přímo okno `mpv` (`SetWindowPos`). mpv
  ho při testu po 1,5 s nevrátil na celou plochu. Při změně velikosti okna ho `SurfaceState`
  znovu umístí.
- **Oprava 2026-10-17 (review):** při každém přesunu nebo změně velikosti hlavního okna libmpv
  vrátí své okno na celou klientskou plochu (`SetWindowPos` se `SWP_NOSENDCHANGING`, ověřeno
  testem se skutečnou libmpv). Prototyp reagoval jen na změnu velikosti, takže po přetažení okna
  v mini režimu bylo za „stránkou“ video v plné velikosti. `SurfaceState` teď při obdélníku mini
  přehrávače obalí proceduru okna `mpv` a změnu ve `WM_WINDOWPOSCHANGED` vrátí dřív, než ji mpv
  uvidí (mpv nedostane `WM_SIZE` s plnou velikostí). Režim celého okna nechává chování mpv.
  Hlídá to test `mini_player_survives_moving_and_resizing_the_window`. Vizuálně (bez bliknutí při
  tažení okna v mini režimu) zbývá ověřit ručně.
- GDI obsah podoken se v průhledném okně Tauri neskládá vůbec (alfa 0). Vidět je jen obsah
  DXGI/DirectComposition.
- Riziko pro M1: spoléháme na název třídy okna `mpv`, což je interní detail upstreamu. Pokud se
  změní, `find_child` okno nenajde a mini přehrávač nebude umisťovat video (video zůstane na celém
  okně). Hlídá to test `surface_moves_the_window_libmpv_creates_inside_wid` (2026-10-17): spustí
  připnutou libmpv s `wid`, `vo=gpu-next` a `gpu-api=d3d11`, ověří okno třídy `mpv` jako přímého
  potomka a jeho přesun do obdélníku mini přehrávače. Běží v CI v jobu `prototype`, který si nově
  stahuje libmpv. Projde i s vynuceným WARP (`d3d11-warp=yes`, „software adapter“), takže CI runner
  bez GPU okno vytvoří a `#[ignore]` není potřeba. Se změněným názvem třídy test selže.

### Výkon (Task 13, 2026-10-17)

Nainstalovaný release build (`Kaleido.exe` má stejný hash jako `target/release/kaleido-proto.exe`),
`sdr-1080p.mkv` (H.264 1080p30, bez zvuku), okno 1280×720, bez pohybu myši a bez vstupu do okna.
Měřeno skriptem [`scripts/measure-m0.ps1`](../../scripts/measure-m0.ps1). CPU je podíl ze všech
16 logických procesorů jako ve Správci úloh a zahrnuje `Kaleido.exe` i celý jeho strom procesů
(6× `msedgewebview2.exe`).

Zopakování na integrované AMD a se 4K zdrojem (Kaleido zavřené, během měření nehýbat myší):

1. Ve Windows nastavit Nastavení → Systém → Obrazovka → Grafika → `Kaleido.exe` i
   `kaleido-mpv.exe` z instalační složky → **Úspora energie** (pro AMD), jinak výchozí.
2. Spustit
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-m0.ps1 -Clip "$env:USERPROFILE\Videos\kaleido-m0\uhd-2160p.mkv"`
   (bez `-Clip` měří `sdr-1080p.mkv`).
3. Řádky `GPU …, hwdec …` ve výstupu ověří, kterou GPU Kaleido i reference skutečně použily (čte se
   z logu mpv). Délka vzorku přehrávání se u krátkého 4K klipu (20 s) sama zkrátí, aby nedohrál.

| Měření | Cíl | Výsledek | Rozhodnutí |
|---|---|---|---|
| spuštění → viditelné okno | ≤ 500 ms | 257 ms za studena, pak 77–95 ms (medián 79 ms, 5 běhů) | prošlo; měřeno do viditelného okna, ne do vykreslení UI |
| CPU v pauze, 60 s | < 1 % | `Kaleido.exe` 0,00 %, celý strom 0,01 % | prošlo |
| CPU při přehrávání proti mpv | nejvýš +2 p. b. | Kaleido 0,56 % a 0,55 %, referenční libmpv 0,14 % a 0,07 % → rozdíl 0,4–0,5 p. b. | prošlo |
| paměť WebView2 | ≤ 200 MB | soukromá pracovní sada 85–99 MB; soukromé bajty 177 MB; pracovní sada se sdílenou pamětí 341 MB | prošlo |
| zavření (`WM_CLOSE`) při přehrávání i v pauze | ≤ 2 s | `Kaleido.exe` skončí za 97–183 ms, celý strom za ≤ 236 ms (jednou 1,1 s po studeném startu); nic nezůstalo | prošlo |

Odchylky od plánu:

- `mpv.exe` na tomto PC není. Referencí je `kaleido-mpv.exe` se stejnou libmpv (`accb7b2821`) ve
  vlastním okně 1280×720 se stejnými volbami (`--vo=gpu-next --gpu-api=d3d11 --hwdec=auto-safe`,
  `--osc=no`). Oba přehrávače dekódují přes d3d11va (log mpv).
- Pauza je stav po dohrání s `keep-open=yes`, ne stisk mezerníku.
- Platí pro výchozí GPU (RTX 5060 Ti, výstup 1920×1080 při 239 Hz). Integrovaná AMD a 4K zdroj
  měřeny nebyly.

## Otevírání z Windows (2026-10-14)

Na žádost uživatele je k M0 doplněna místní instalace a registrace videí; postup a odebrání
registrace jsou v [local-install.md](local-install.md).

- Samostatný release build s vloženým UI, instalace pro aktuálního uživatele do
  `%LOCALAPPDATA%\Programs\Kaleido-M0\`.
- Registrované „Otevřít v programu → Kaleido“ pro 42 video přípon a klasická akce „Přehrát v Kaleidu“;
  níže je následné UI ověření, které odhalilo neúplnost této integrace.
- Soubory z příkazové řádky a druhé instance čekají na připravené UI; druhé spuštění obnoví
  stejné okno. Součástí je synchronizace počátečního stavu přehrávače.
- Ověřeno přes Windows Shell: Kaleido je doporučený handler pro MKV, MP4, AVI, WebM a MOV;
  registrovaný handler otevřel video bez Vite a druhý soubor s mezerami a diakritikou ve stejném procesu.
- Původní `UserChoice` (ProgID i hash) pro uvedené přípony zůstal beze změny.
- Kontroly: 53 Rust testů, 63 UI testů, Clippy, rustfmt a produkční sestavení prošly.

Tato kontrola nenahrazuje zbývající vizuální, HDR a výkonnostní ověření M0 z tabulky výše.

## Computer Use (2026-10-15)

Testován samostatný nainstalovaný build v `%LOCALAPPDATA%\Programs\Kaleido-M0\Kaleido.exe`
bez vývojového serveru. Akce byly provedeny přes Windows UI pomocí `@oai/sky`;
log a kontrola procesů doplnily zjištění, nenahrazují UI výsledek.
Po opravách znovu prošlo 53 Rust testů, 63 UI unit testů, produkční build,
Clippy s `-D warnings`, rustfmt a `git diff --check`.

### Opravené chyby

1. **Tlačítka mini přehrávače nefungovala.** Rodič zachytával pointer a přebíral kliknutí
   tlačítek. Předávání vstupu je nyní jen na samostatné vrstvě videa pod lištou. V nainstalovaném
   buildu znovu ověřeno přehrávání/pauza i viditelné tlačítko návratu na celé okno.
2. **Snímky se neukládaly.** libmpv překládalo `~~desktop/` na prázdnou cestu a pokoušelo se
   zapisovat do pracovního adresáře (`Permission denied`). `Paths` nyní používá skutečnou
   cestu Plochy z Tauri. Obě klávesy `s`/`Shift+s` po nové instalaci vytvořily JPG a vizuální
   porovnání potvrdilo odstranění skla u `s`. Testovací soubory byly poté přesunuty z Plochy
   do ignorované složky `target/ui-test-artifacts/`.
3. V checklistu opraven příkaz konzole na `show-text "ahoj ěščř" 5000`; text s mezerou musí být
   v uvozovkách. Zadání, vykreslení diakritiky i zavření konzole přes Escape prošly.

Zavření viditelným tlačítkem ukončilo okno i procesy `Kaleido.exe` a `kaleido-mpv.exe`;
potvrzeno po prvním i druhém opraveném buildu. Přesný limit 2 s nebyl stopován.

### Integrace Explorer / Files – stále otevřené

- Skutečný výběr **Open with** vyvolaný z obou aplikací původně ukázal Canva, VLC a WMP Legacy;
  Kaleido chybělo i v prohlédnutém seznamu dalších aplikací. To odporuje dřívějšímu úspěšnému
  testu `SHAssocEnumHandlers`; API test sám nestačí.
- Doplněny kandidáty do `Explorer\FileExts\<ext>\OpenWithProgids` a `ApplicationCompany`
  do vlastního ProgID. Čerstvý výběr vyvolaný z Files stále Kaleido mezi doporučenými aplikacemi
  neukázal. Přímá akce nebyla vidět ani v prohlédnutém **Show more options** ve Files.
- `OpenWith.exe` nevystavil nástroji ovladatelné okno ani po pokusu o jeho samostatné spuštění:
  `launched app did not expose a targetable window`. Kliknutí na jeho dialog přes Explorer
  bylo odmítnuto, protože bod patří jinému procesu. Ruční výběr exe a volba **Just once** tak
  zůstaly nedokončené; uživatel byl požádán o zavření blokujícího dialogu.
- Po doplnění registrací znovu ověřeny původní `UserChoice` ProgID i hashe: beze změny.
- Integrace není označena jako funkční koncová cesta z obou správců souborů. Následující krok je
  dokončit výběr exe v cílitelném systémovém dialogu a znovu zkontrolovat čerstvé nabídky.

### Zbývající ověření

HDR náhled měl vybledlé barvy; oprava a nové ověření jsou níže v průchodu z 2026-10-16.
Porovnání se skutečným HDR materiálem stále zbývá. Plný HDR jas, jiné DPI/monitor,
snímkový záznam resize/mini/fullscreen, výkon skla při 4K výstupu na obou GPU a paměť/CPU
limity z Task 13 nebyly tímto průchodem potvrzeny. M0 proto zůstává rozpracované.

## Computer Use (2026-10-16)

### Otevírání ze správců souborů

Přidán vlastní zástupce **Kaleido** do uživatelské nabídky **Send to / Odeslat**.
Ověřeno skutečnými kliknutími bez vývojového serveru:

- Files: **Send to → Kaleido** otevřelo `sdr-1080p.mkv` v nové instanci a video se přehrávalo.
- Průzkumník s místním Nilesoft menu: **More options → Send to → Kaleido** předalo
  `Žluťoučký kůň (zkouška).mkv` do téhož okna i procesu. Titulek i vykreslený obraz potvrzeny.
- Po nové instalaci Files otevřelo také `hdr10-synthetic.mkv`; přehrával se obraz s označením
  **4K HDR**. Správná cesta byla také v příkazové řádce procesu.
- Původní ProgID i hashe `UserChoice` u MKV, MP4, AVI, WebM a MOV zůstaly zachované.

Při prvním opakování se projevila další chyba: po skončení předchozího souboru nový zůstal
v pauze. Společná funkce otevírání nyní nastaví `pause=no`; používá ji shell i vlastní dialog
Otevřít. Regresní test s libmpv načte video z předchozího stavu `pause=yes` a ověřuje přehrávání.
Po opravě Průzkumník znovu předal český soubor z pozastaveného HDR do stejného procesu;
video se samo rozběhlo (viditelná pauzovací ikona a postupující čas ve vypáleném OSD).

Při opakování v menším okně se nabídka Send to jednou vykreslila jen se třemi systémovými
položkami. V maximalizovaném Průzkumníku byla kompletní a opakované otevření přes Kaleido
prošlo. Skript při aktualizaci nově vytváří vlastní zástupce a oznamuje jejich změnu shellu;
příčina omezeného menu v místním Nilesoft prostředí není tímto potvrzena.

**Open with zůstává samostatné nevyřešené omezení na tomto PC.** Moderní systémový výběr
Kaleido stále nenabízí, přestože `SHAssocEnumHandlers` ho enumeruje jako doporučený handler.
Statická akce „Přehrát v Kaleidu“ také v prohlédnutém menu chybí. Změna typu hodnoty
`OpenWithProgids`, doplnění metadat, synchronní notifikace asociací a obnovení testovacích
hostů tento výsledek nezměnily. Pro uživatelské otevření jsou výše ověřené cesty **Send to**.
Nilesoft konfigurace ani systémové výchozí přehrávače nebyly změněny.

Předchozí ruční test volby exe byl neplatný: samostatně spuštěné `OpenWith.exe` nemělo
navázaný video soubor a Kaleido se spustilo bez argumentů. Startovní obrazovka nebyla důkazem
přehrání; uživatel výsledek opravil. Nové ověření výše kontroluje skutečný název, obraz i argumenty.

### HDR náhledy

Oprava je pouze v adaptéru `kaleido-mpv`; připnutý upstream thumbfast ani libmpv nejsou změněny.
Pro známý raw BGRA/image2 HDR filtr se potlačí desaturace, převede výstup do sRGB/BT.709 a celý
převod včetně škálování běží v **jednom** AVFilter grafu. Oddělené mpv filtry mezi kroky měnily
barevné hodnoty (červená → oranžová, modrá → azurová). Výstup jednoho grafu se na kontrolních
pixelech shodoval s přímým FFmpeg převodem.

Zpřísněný regresní test kontroluje sytou červenou, ne jen rozdíl největšího a nejmenšího kanálu.
V konečném nainstalovaném buildu byl přes Computer Use zobrazen HDR náhled na časové ose;
červená, zelená, modrá i purpurová jsou syté a odstíny odpovídají testovacím pruhům.
Toto není ověření skutečného HDR jasu ani všech zdrojových barevných prostorů.

### Kontroly sestavení

58 Rust testů, 63 frontendových testů, Clippy s `-D warnings`, rustfmt, produkční frontend
a samostatný Tauri release build prošly. Instalační skript prošel opakovanou instalací
a režimem `-WhatIf` pro instalaci i odebrání registrace. Zástupce i registrační klíče mají
kontrolu vlastnictví a odebrání registrace ponechává soubory aplikace.
Po posledním zavření přes viditelné ✕ nezůstal proces Kaleida ani helperu. Poslední opakovaná
instalace prošla a znovu byly porovnány všechny původní ProgID i hashe: beze změny.

## Závěr a doporučení pro M1 (koncept)

> **Koncept z 2026-10-17, ne konečný závěr.** Ruční kontroly z [checklist.md](checklist.md), které
> potřebují oči uživatele, HDR monitor, jiné DPI nebo druhou GPU, zatím neproběhly a M0 je do té
> doby rozpracované. Body označené **OTEVŘENÉ** se po kontrolách doplní nebo přepíšou; konečná
> zpráva nesmí obsahovat čekající ani otevřené body (Task 13, krok 2).

### Body 5.4

| # | Stav | Prošlo | OTEVŘENÉ (čeká na ruční kontrolu) |
|---|---|---|---|
| 1 | částečně | video pod průhledným WebView2 v okně mpv; SDR, letterbox, 4K i syntetické HDR pod kapslemi; změna velikosti a maximalizace | blikání při rychlé změně velikosti a přesunu, 60 fps |
| 2 | částečně | syntetické HDR10 se načte, štítek „4K HDR“, obraz i sklo se vykreslí | skutečné HDR10 na HDR monitoru, Windows HDR zapnuté i vypnuté |
| 3 | částečně | mezerník, šipka, seekbar, hlasitost, kolečko, `click-target`, dvojklik, konzole s diakritikou | podržená šipka, Ctrl puštěný dřív než šipka, `click-target` při 150 %, ▶ a mezerník přepnou pauzu jen jednou |
| 4 | částečně | fullscreen tlačítkem i dvojklikem, Esc vrátí okno | přechod přes černou clonu bez bliknutí, 10 rychlých přepnutí, monitory s různým DPI |
| 5 | částečně | rozmazání pod kapslemi, `g`, mizí s kapslemi při autohide; 20 + 6 + 24 µs (4K zdroj v okně 1280×720, RTX 5060 Ti) | tvar při 150 %, sedění nad pruhy letterboxu, bliknutí při autohide, ≤ 1 ms při 4K výstupu na RTX 5060 Ti i integrované AMD |
| 6 | částečně | zmenšení do rohu, ▶/❚❚ a návrat tlačítkem; obdélník přežije přesun a změnu velikosti okna (test s libmpv) | záznam 60 fps (hrana videa zaostává nejvýš o 1 snímek), dvojklik v mini režimu, tažení okna v mini režimu bez bliknutí |
| 7 | částečně | `kaleido-mpv.exe` jako `mpv_path`, náhled v bublině bez konzolového okna, syntetické HDR barvy | náhled do 300 ms, skutečný HDR materiál |
| 8 | prošlo | `s` bez skla, `S` se sklem, složka Plochy z Tauri | — |

**Výkon (Task 13, krok 1):** všech pět cílů prošlo na RTX 5060 Ti s 1080p SDR. **OTEVŘENÉ:**
integrovaná AMD a 4K zdroj (`scripts/measure-m0.ps1`, postup v sekci Výkon).

**Záložní řešení ze spec 5.4:** žádný bod zatím neselhal, takže žádné záložní řešení není potřeba.
**OTEVŘENÉ** do ručních kontrol: bod 1 (dvě okna), bod 5 (tónované sklo bez rozmazání, případně
rozmazání ve sníženém rozlišení podle spec 13) a bod 6 (skok + prolnutí podle 8.6).

**Uzavřená rozhodnutí**, promítnutá do spec 2026-10-17 (kapitoly 3, 4.1, 4.2, 5.1, 5.2, 5.4, 8.2,
8.6, 9.3 a 15):

- `wid` = hlavní okno; mpv si vytvoří okno třídy `mpv` pod WebView2 a mini přehrávač ho přesouvá
  přes `SetWindowPos`. Vlastní podokno jako `wid` je zamítnuté. Proti tomu, že libmpv při přesunu
  hlavního okna vrací své okno na celou plochu, se obdélník mini přehrávače drží obalením
  procedury okna `mpv`.
- `kaleido-mpv` přepisuje HDR filtr thumbfastu na jeden `lavfi` graf; upstream thumbfast se nemění.
- `screenshot-dir` je cesta Plochy z Tauri, ne `~~desktop/`.
- Jediná instance: požadavky čekají na připravené UI a otevřený soubor se vždy začne přehrávat.

### Konstanty

| Konstanta | Hodnota v kódu | Ověření |
|---|---|---|
| `SEND_EXPLICIT_DOUBLE_CLICK` (`prototype/src/input/forward.ts`) | `false`: dvojklik si mpv skládá samo z přeposlaných stisků tlačítka | potvrzeno v celém okně: dvojklik přepne fullscreen právě jednou (Computer Use 2026-10-15). **OTEVŘENÉ:** dvojklik v mini režimu |
| `OUTPUT_EXCLUDES_MARGINS` (`prototype/src-tauri/src/glass.rs`) | `true`: textura OUTPUT začíná u obdélníku videa, ne u okraje okna | **nepotvrzeno, OTEVŘENÉ:** letterbox byl pod kapslemi vidět, ale kontrola, že rozmazání sedí i nad pruhy, neproběhla |

### Co jde do M1

Beze změny:

- `crates/mpv-ffi`: načtení libmpv za běhu, kontrola API 2.x, příkazy, vlastnosti, události,
  `testing::write_y4m` a 16 testů nad skutečnou libmpv.
- `crates/kaleido-mpv`: bezhlavé CLI pro thumbfast včetně přepisu HDR filtru a testu s připnutým
  thumbfastem.
- `scripts/fetch-libmpv.ps1`, `scripts/fetch-thumbfast.ps1` a job `rust` v CI.

Jen jako reference (`prototype/`; M1 to napíše znovu podle spec 4.2 a převezme testy):

- `src-tauri/src/surface.rs` → modul `surface`: hledání a umisťování okna `mpv`, `to_physical`;
  **převzít test se skutečnou libmpv**.
- `glass.rs`: generátor shaderu a `glsl-shader-opts` (tři průchody H/V/composite, nejvýš 6 oblastí).
- `input.rs` a `src/input/` (`keys`, `mouse`, `tracker`): převod vstupu včetně testů na českou
  klávesnici, AltGr a zaseknuté klávesy.
- `thumbs.rs`: ověření zprávy `thumbfast-render` (jen soubory v `%TEMP%`, velikost `w*h*4`).
- `open_requests.rs`: fronta do připravenosti UI, `pause=no` a filtr argumentů shellu; v M1 ho
  nahradí parser z 9.1 a 9.2.
- `engine.rs`, `options.rs`: vlákno událostí, omezení `time-pos`, snímek bez skla. M0 má
  `config=no`, M1 bude mít `config=yes` a `config-dir` (5.1).
- UI: `fullscreen.ts` (černá clona), `surface/mini.ts` (animace obdélníku), `glass/regions.ts`,
  `playerState.ts`.
- `scripts/install-local-prototype.ps1` a `scripts/measure-m0.ps1` jsou pomůcky M0. Instalátor
  přijde v M4 (11.2), skript měření může posloužit jako základ benchmarku (13).

### Otevřené otázky pro plán M1

1. Záložní řešení bodů 1, 5 a 6 podle ručních kontrol (viz výše).
2. `OUTPUT_EXCLUDES_MARGINS` podle letterboxu; při 150 % a smíšeném DPI také přepočet oblastí skla.
3. Výkon skla na integrované AMD při 4K výstupu; nad 1 ms rozmazání ve sníženém rozlišení (13).
4. HDR: chování UI a náhledů na skutečném HDR10 se zapnutým i vypnutým HDR ve Windows a zda
   stačí `target-colorspace-hint`.
5. „Otevřít v programu“: moderní výběr Windows Kaleido na tomto PC nenabízí, ověřená je jen cesta
   Send to (2026-10-16). Řeší se samostatně; pro M4 to určí registraci v instalátoru (8.12, 11.2).
6. Co dělat, když test v CI odhalí změnu třídy okna `mpv` po aktualizaci libmpv: hledat okno jinak,
   nebo aktualizaci odložit.
