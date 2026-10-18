# M1 – ruční kontrola

Co testy nepokryjí: vzhled, skutečný hardware (měřítko, dva monitory, HDR, GPU), Windows (Snap
Layouts, Mica, průhlednost, vysoký kontrast, Průzkumník, prohlížeč) a výkon. Výsledky zapisuj sem
k bodu, nebo je pošli Claudovi v chatu.

Automaticky běží (ručně neopakovat; jak je spustit, říká [README.md](../../README.md)):

- `cargo test --workspace`: skutečná libmpv s `vo=null` a `ao=null` (otevírání a cesty s
  diakritikou, playlist s rozbitým souborem, sklo a jeho volby shaderu, náhledy thumbfastu,
  nastavení a `mpv.conf`, zkratky, okno mpv a mini rozvržení, jediná instance a fronta otevření).
- `npm test`: UI (vitest).
- `npm run e2e`: sestavená aplikace pod WebView2. `Kaleido.exe --start=0 -- <klip>` předá klip
  běžícímu oknu a skončí; do 5 s ukáže titulní ostrůvek název klipu a štítek 720p; přehrát/pauza
  dojde do mpv a stav se vrátí do tlačítka; Nastavení ukáže zadokovaný mini přehrávač se třemi
  tlačítky; ✕ ukončí `Kaleido.exe` i jeho `kaleido-mpv.exe` do 2 s.

## Příprava

- Vývojový běh: `npm run tauri dev` (F12 = konzole WebView2).
- Build jako u uživatele, z kořene repozitáře:

  ```powershell
  npm run tauri build -- --no-bundle
  cargo build --release -p kaleido-mpv
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local.ps1
  ```

  Skript nainstaluje build M1 do `%LOCALAPPDATA%\Programs\Kaleido-M0\` místo buildu M0.
  Registrace (Přehrát v Kaleidu, Odeslat → Kaleido, Otevřít v programu) zůstává stejná jako v M0
  ([docs/m0/local-install.md](../m0/local-install.md); `install-local.ps1` místo
  `install-local-prototype.ps1`), nahradí ji instalátor v M4. Když Kaleido běží, skript odmítne
  pokračovat.
- Média: `%USERPROFILE%\Videos\kaleido-m0\` z M0 (SDR 1080p, letterbox 2.39:1, 4K 60 fps,
  syntetické HDR10, kopie s českým názvem), skutečné HDR10 video, video s titulky a kapitolami
  (mkv), video 4:3 a na výšku, složka s několika videi, přímý odkaz na `.mp4` a odkaz na YouTube
  (hraje jen s `yt-dlp` v `PATH`).

## Před vydáním M1

### Vzhled ostrůvků a skla

- [ ] Ostrůvky (horní levý, horní pravý, spodní) a lišta vypadají jako v návrzích: zaoblené, pod
  nimi rozmazané video, čitelný text, nic se nepřekrývá ani neořezává; totéž v okně 640×360 a v
  maximalizovaném okně.
- [ ] **Letterbox:** `letterbox-239.mkv` (černé pruhy nahoře a dole): rozmazání pod horními i
  spodním ostrůvkem sedí na jejich tvar i nad pruhy, ne posunuté o výšku pruhu. Když je posunuté:
  `OUTPUT_EXCLUDES_MARGINS = false` v `src-tauri/src/glass.rs` a zkusit znovu (M0 bod 5). Totéž s
  videem užším než okno (pruhy vlevo a vpravo) a v mini přehrávači hned po zmenšení.
- [ ] **Měřítko Windows 150 %** (Nastavení → Systém → Obrazovka → Měřítko): rozmazání, ⬜ (Snap
  Layouts), časová osa i mini přehrávač sedí jako při 100 %, text je ostrý.
- [ ] **Dva monitory s různým měřítkem** (třeba 100 % a 150 %): přetáhnout okno přehrávače i okno
  v mini režimu z jednoho na druhý a zpět, a na každém maximalizovat: video vyplní okno (žádný pruh
  ani zmáčknutý obdélník), rozmazání po puštění okna sedí, mini zůstane v rohu (M0 body 4 a 5).
- [ ] 10 s rychle měnit velikost okna a přesouvat ho: nic nebliká, nezůstávají černé ani bílé
  okraje (M0 bod 1).
- [ ] Po 2,5 s bez pohybu myši ostrůvky zmizí a rozmazání s nimi, bez bliknutí; zapsat, kdyby na
  chvíli zůstal rozmazaný obdélník bez ostrůvku (M0 bod 5).

### Snap Layouts a přetažení odkazu (hroty z Task 16 a z Task 5 a 17)

Oba hroty se zkoušejí v sekcích níže; výsledek zapsat sem.

- [ ] **Snap Layouts** (Task 16, pokus 1: malé okno Win32 nad ⬜, přepínač `SNAP_LAYOUTS` v
  `src/shell/captionButtons.ts`): podle sekce „Okno a horní ostrůvky“ sem zapsat **funguje**, nebo
  **vypnuto, Snap Layouts zatím jen přes Win+Z**.
- [ ] **Přetažení z prohlížeče** (Task 5 a 17: soubory přes `postMessageWithAdditionalObjects`,
  odkazy z `text/uri-list`, zpráva o dropu je JSON objekt): podle sekce „Úvodní obrazovka, vložení
  a přetažení“ sem zapsat, ze kterých prohlížečů odkaz hraje. Kdyby nehrál odnikud, záložní cesta
  z plánu (rozhodnutí 8) je drop Tauri jen pro soubory a přetažení odkazu zůstane otevřené.

### Mica, Snížit průhlednost, vysoký kontrast, čeština a angličtina

- [ ] **Mica** (Windows 11): úvodní obrazovka, Nastavení a stránka kolem mini přehrávače mají
  pozadí Mica (jemně probarvené tapetou), ne černé a ne průhledné na plochu. Nastavení → Vzhled →
  Mica vypnout: gradient. Zapsat, kdyby Mica nebyla vidět vůbec (Task 14: okno bez rámečku ji může
  potřebovat zapnout jinak, přes `DwmExtendFrameIntoClientArea`).
- [ ] **Bez videa není pod stránkou okno mpv (Ruling R52):** s Mica ve světlém i tmavém režimu má
  úvodní obrazovka hned po startu i Nastavení bez videa pozadí Mica, nikde černou plochu, a text je
  čitelný. Desetkrát spustit Kaleido bez souboru a sledovat okno od prvního okamžiku: černá plocha
  nesmí bliknout ani na zlomek vteřiny (Ruling R56; záznam 60 fps Win+Alt+R pomůže). Totéž se
  souborem z Průzkumníku: před prvním snímkem videa žádné černé bliknutí přes úvodní obrazovku. Video otevřené z úvodní obrazovky i z Nastavení (do mini přehrávače) ukáže hned první
  snímek (nezůstane černo ani průhledno); po dohrání nebo Zastavit v mini přehrávači je pozadí
  zase Mica. Kolečko a dvojklik do mezery kolem
  lišty (vlevo od ní, nad ní, mezi ní a stránkou) na úvodní obrazovce a v Nastavení nemění
  hlasitost ani nepřepnou okno na celou obrazovku.
- [ ] **Windows 10 22H2** (jiný počítač nebo VM, pokud je po ruce): místo Mica neprůhledné pozadí
  s gradientem, nic neprosvítá (spec 11.1).
- [ ] **Snížit průhlednost** ve Windows (Nastavení → Přizpůsobení → Barvy → Efekty průhlednosti
  vypnout) i v Kaleidu (Nastavení → Vzhled → Snížit průhlednost): ostrůvky, panely, karty a pruh
  mini přehrávače jsou neprůhledné a bez rozmazání; `I` → `2` v mpv neukazuje průchody
  `kaleido-glass`. Přepnutí ve Windows za běhu se projeví nejpozději po návratu do okna Kaleida
  (známé omezení: změnu za běhu Kaleido čte při získání fokusu).
- [ ] **Vysoký kontrast** (Windows: Usnadnění → Kontrastní motivy): všude systémové barvy, žádné
  sklo; tlačítka, posuvníky, časová osa a značky kapitol jsou vidět a fokus je vidět. Po vypnutí se
  vzhled vrátí.
- [ ] **Světlý režim** (Windows ve světlém režimu, nebo Vzhled → Barevný režim → Světlý): sklo je
  světlé, ne tmavě tónované z tmavého režimu (Ruling R35); text je čitelný a fokus vidět.
- [ ] **Čeština a angličtina:** česká Windows → UI česky. Vzhled → Jazyk → English: celé UI hned
  anglicky, bez restartu (ostrůvky, panely, karty chyb, Nastavení, O aplikaci); Systém → zpět
  česky. Po restartu s jazykem English zapsat, jestli první snímek na chvíli ukáže češtinu
  (Task 15). Popisky filtrů v dialogu Otevřít soubor jdou podle jazyka Windows, ne podle nastavení:
  známé omezení.
- [ ] **České texty projít** (Task 23: zatím je nikdo nečetl): pravopis, všude stejné názvy věcí,
  nic nepřetéká ani se neořezává; čísla a procenta po česku (`1,5×`, `90 %` s pevnou mezerou),
  anglicky `1.5×` a `90%`.

### Výkon (spec 13): `scripts/measure.ps1`

Cíle: okno do 500 ms, první snímek do 1 s, CPU v pauze pod 1 %, při přehrávání nejvýš o 2
procentní body víc než samotná libmpv a UI nepřekresluje, sklo do 1 ms GPU ve 4K, WebView2 do
200 MB. Skript měří místní instalaci (Příprava; vedle `target\release\Kaleido.exe` chybí
`libmpv-2.dll`). Z kořene repozitáře, během měření nehýbat myší:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure.ps1 -Clip "$env:USERPROFILE\Videos\kaleido-m0\uhd-2160p.mkv"
```

Výstup skriptu zapsat sem nebo poslat Claudovi.

- [ ] RTX 5060 Ti, `sdr-1080p.mkv`: okno, CPU při přehrávání proti referenci, CPU v pauze, paměť
  WebView2, zavření.
- [ ] RTX 5060 Ti, `uhd-2160p.mkv`.
- [ ] Integrovaná AMD (Windows: Nastavení → Systém → Obrazovka → Grafika → `Kaleido.exe` a
  `kaleido-mpv.exe` → Úspora energie), oba klipy (v M0 neměřeno).
- [ ] **Sklo ve 4K:** `uhd-2160p.mkv` na celé obrazovce s viditelnými ostrůvky, `I` → `2` (časy
  průchodů): součet `kaleido-glass` blur H, blur V a composite do 1 ms, na obou GPU (M0 bod 5).
- [ ] **První snímek do 1 s** skript neměří: záznam obrazovky (Win+Alt+R) dvojkliku na video v
  Průzkumníku při zavřeném Kaleidu, od kliknutí po první snímek videa; zapsat čas.

### HDR10 (M0 body 2 a 7)

- [ ] Windows HDR zapnuté → HDR10 video: štítek „HDR“ v titulním ostrůvku, světla jasnější než
  bílé UI, UI není vybledlé.
- [ ] Windows HDR vypnuté → totéž video je tónově mapované, barvy nejsou vybledlé.
- [ ] Náhledy na časové ose u HDR videa nejsou šedé ani přepálené, se zapnutým i vypnutým HDR.

### Jediná instance (Ruling R9)

`tauri-plugin-single-instance` je ve verzi 2.5.4, nejnovější 2.x (ověřeno 2026-10-18; novější je
jen 3.0.0-alpha). Oprava startovního závodu na Windows, kterou chce spec 9.3, přišla až po 2.5.4:
když se dvě spuštění sejdou za studena téměř současně, může vzniknout druhé okno, nebo se ztratí
první požadavek. Až vyjde 2.x s opravou, zvednout verzi v `src-tauri/Cargo.toml`.

- [ ] Kaleido zavřené: v Průzkumníku označit tři videa a Enter; zvlášť Odeslat → Kaleido se třemi
  soubory; zvlášť rychle za sebou dvojklik na dvě videa. Každé pětkrát. Vždy jedno okno a všechna
  videa v jednom playlistu v pořadí z Průzkumníku; zapsat, kolikrát vzniklo druhé okno nebo nějaké
  video chybělo.
- [ ] Kaleido běží: video otevřené z Průzkumníku hraje ve stejném okně a okno se obnoví z
  minimalizace a přejde do popředí. S Nastavení → Přehrávání → Při otevření souboru za běhu →
  Přidat do playlistu se video přidá na konec a přehrávání se nepřeruší.

### Otevírání z Windows (M0 bod 9)

Po místní instalaci (Příprava):

- [ ] Klasické menu „Přehrát v Kaleidu“, Odeslat → Kaleido a „Otevřít v programu ›“ otevřou video
  v M1, za studena i do běžícího okna; soubor s diakritikou a mezerami v názvu také.
- [ ] **Po odhlášení a novém přihlášení** (registraci mezitím neměnit): pravé tlačítko na `.mkv` →
  Otevřít v programu → Vybrat jinou aplikaci: je v seznamu Kaleido? Ano = hypotéza stavu z
  přihlášení potvrzená; ne = čistý profil nebo VM a Procmon (docs/m0/report.md, sekce Open with).
- [ ] `scripts/install-local.ps1 -ChooseDefault` → v Nastavení Windows vybrat Kaleido pro `.mkv` →
  `scripts/diagnose-associations.ps1` (sekce 3) ukáže `Kaleido.M0.Video` a dvojklik na `.mkv`
  otevře Kaleido.

### Vstup a fullscreen (M0 body 3 a 4)

- [ ] Mezerník = pauza; šipky ←/→ přetáčí o 5 s, ↑/↓ o minutu; podržená šipka přetáčí plynule a po
  puštění přestane; pustit Ctrl dřív než šipku (Ctrl+šipka) → nic se nezasekne.
- [ ] `Alt+F4` zavře aplikaci a pozice se uloží jako u ✕.
- [ ] 10× rychle za sebou fullscreen (tlačítko, `f`, dvojklik do videa) → nic se nezasekne,
  nezůstane černá clona ani špatná ikona.
- [ ] **Kolečko při měřítku 125 % a 150 %:** jeden zářez kolečka nad videem změní hlasitost právě o
  jeden krok (2), ne o dva ani o nic (Task 7: Chromium může při necelém měřítku hlásit jiný posun
  než 100 px na zářez). Touchpad: posun dvěma prsty mění hlasitost po krocích, ne skokem.
- [ ] **Boční tlačítka myši** (Zpět, Vpřed) nad videem dělají, co mají v mpv (výchozí: předchozí a
  další v playlistu), a okno nikdy „nepřejde zpět“ (bílá stránka, nové načtení UI). Totéž zkusit nad
  úvodní obrazovkou a nad Nastavením: tam Kaleido navigaci WebView2 neblokuje (Ruling R19 jen na
  vrstvě videa); zapsat, kdyby se stránka vrátila nebo načetla znovu.

### Snímky obrazovky (Task 8, rozhodnutí plánu 5)

- [ ] S ostrůvky viditelnými nad videem: `s` (s titulky), `S` (jen video), `Ctrl+s` (okno) a `Alt+s`
  (každý snímek: zapnout, pár sekund, vypnout) → soubory na Ploše; v žádném nejsou rozmazané
  obdélníky skla. (Snímek, který plugin pořídí přímo příkazem `screenshot`, sklo obsahuje: M1 to
  přijímá a říká to O aplikaci.)

### Otevřít soubor a titulky ze souboru (Task 5, 17 a 20)

- [ ] Úvodní obrazovka → Otevřít soubor, a `Ctrl+O` při přehrávání: dialog Windows s filtrem videí;
  několik vybraných souborů je jeden playlist v pořadí výběru; Zrušit nic neudělá.
- [ ] Rychlé nastavení (tlačítko Titulky) → titulky ze souboru: dialog s filtrem titulků (`.srt`,
  `.ass`, …); vybrané titulky se ukážou a jsou vybrané v seznamu stop.

### Karty chyb, načítání a indikátor (Task 19)

- [ ] **Rozbitý soubor uprostřed playlistu** (složka s poškozeným nebo nepodporovaným souborem,
  odkaz s 404): karta chyby se srozumitelnou zprávou, správným názvem souboru a textem, že přehrávání
  pokračuje dalším souborem; „Podrobnosti“ rozbalí úryvek logu; přehrávání opravdu pokračuje.
- [ ] Jediný rozbitý soubor: okno je na úvodní obrazovce a karta nabídne „Otevřít soubor“ (dialog
  se otevře).
- [ ] Karta zmizí po 8 s nebo po ✕; nejvýš tři najednou; rozmazání pod kartami sedí. Z klávesnice k
  nim Tab dojde přes ostrůvky (do 8 s: známé omezení).
- [ ] `Ctrl+V` bez odkazu ve schránce **při přehrávání** a v Nastavení ukáže upozornění v kartě
  (Ruling R40); přetažený odkaz, který Kaleido odmítne, také.
- [ ] **Načítání:** pomalý odkaz (YouTube s `yt-dlp`) ukazuje při načítání název serveru a potom
  název videa; nic nebliká.
- [ ] **Indikátor:** šipky, `9` a `0`, `m`, `[` a `]` krátce ukážou skleněný indikátor (přetáčení,
  hlasitost, rychlost) se správnou hodnotou, i se skrytým ovládáním; rozmazání pod ním sedí; v
  Nastavení a v mini přehrávači se neukazuje.

### Nepovedený start (Ruling R53)

- [ ] V místní instalaci (Příprava) přejmenovat `libmpv-2.dll` vedle `Kaleido.exe` (třeba na
  `libmpv-2.dll.off`) a Kaleido spustit: ukáže se okno se zprávou „Kaleido se nepodařilo spustit.“
  (anglicky „Kaleido could not start.“), důvodem (libmpv nejde načíst) a složkou
  `%LOCALAPPDATA%\Kaleido\logs`; po OK aplikace skončí a v nejnovějším `kaleido.*.log` je řádek
  `ERROR … Kaleido could not start: cannot start the player: cannot load libmpv: …`. Po
  přejmenování zpět se Kaleido spustí jako dřív. (Ve vývojovém buildu, který si libmpv jinak najde
  ve `vendor\`, totéž udělá `$env:KALEIDO_LIBMPV = 'C:\neni\libmpv-2.dll'` před
  `npm run tauri dev`.)

### Panely: Rychlé nastavení a Playlist (Task 20)

- [ ] Tlačítko Titulky otevře nad sebou Rychlé nastavení (záložky Titulky a Zvuk), tlačítko
  Playlist playlist; panel se vysune pružně (150–250 ms), s vypnutými animacemi se jen prolne;
  rozmazání pod panelem sedí.
- [ ] Výběr stopy titulků a zvuku, velikost titulků (posuvník) a vypnutí titulků se v mpv projeví
  hned; při tažení posuvníku se video nepřetáčí.
- [ ] Playlist: aktuální položka je označená, klik ji přehraje, tažení přeřadí (u okraje se seznam
  sám neposouvá: známé omezení), z klávesnice přeřazení podle nápovědy, odebrání. Při měřítku UI 90
  % a 150 % a v okně 640×360 panel nepřesahuje okno.
- [ ] Esc panel zavře a fokus se vrátí na tlačítko (z klávesnice); po zavření myší (klik vedle, na
  tlačítko, do videa) nemá fokus nic a mezerník pozastaví video (Ruling R44). Klik do videa s
  otevřeným panelem panel jen zavře.
- [ ] Všechno najednou (panel, karta chyby, indikátor a ostrůvky): má rozmazání každý prvek? Oblastí
  skla je omezený počet; zapsat, který zůstal bez rozmazání.

### Nastavení (Task 22 a 23)

- [ ] Sekce Přehrávání, Titulky, Zvuk, Obraz, Vzhled, Zkratky a O aplikaci: změna, která platí
  hned, se při přehrávání projeví hned (velikost a barva titulků, maximální hlasitost, …), ta, která
  potřebuje restart, to řekne. V `%APPDATA%\Kaleido\mpv.conf` se mění jen blok Kaleida; vlastní
  řádky a komentáře zůstanou (spec 8.10).
- [ ] **Okraj titulků** (Barva okraje, Šířka okraje = `sub-border-*`): po změně není v
  `%LOCALAPPDATA%\Kaleido\logs\mpv.log` varování „was replaced with“ (Task 10: v novém mpv to mohou
  být zastaralé aliasy `sub-outline-*`). Zapsat, kdyby bylo.
- [ ] Hledání najde položky podle názvu i popisu, i bez diakritiky; ↓ a Enter skočí do výsledků,
  Esc zpět do pole.
- [ ] Rozbalovací seznamy (písmo, zvukové zařízení, …) se otevírají ve stránce a nepřekryjí mini
  přehrávač; poslední položku stránky jde odsunout nad mini přehrávač.
- [ ] Barvy: hex a vzorek; neplatný hex se neuloží a pole řekne proč.
- [ ] Vzhled: tónování, krytí, rozmazání, sytost a zaoblení skla, barva zvýraznění a měřítko
  rozhraní 90–150 % se projeví hned a náhled jim odpovídá; „Obnovit výchozí“ vrátí hodnoty.
- [ ] **Zkratky:** Změnit → nová klávesa → zkratka se přesune a hned funguje; obsazená klávesa →
  otázka Nahradit / Zrušit; Obnovit vrátí výchozí; Tab a klávesa Windows se odmítnou s
  vysvětlením. Zkratky pluginů (stats, thumbfast) jsou ve skupinách se svým jménem.
- [ ] **O aplikaci:** verze Kaleida a libmpv, seznam licencí; odkazy na zdroje Kaleida a libmpv
  otevřou prohlížeč, a to jednou; Kopírovat diagnostiku dá do schránky text se zakrytými cestami k
  souborům; Otevřít logy otevře Průzkumník ve složce `%LOCALAPPDATA%\Kaleido\logs`; je tam poznámka o
  snímcích z pluginů se sklem.

## Podle úkolů M1

Kontroly, které úkoly M1 připravily v tichém režimu. Velký průchod testů je mezitím spustil
automaticky; tady zůstává, co je potřeba vidět. Spustit `npm run tauri dev` nebo místní instalaci
(Příprava) a mít po ruce krátké 1080p video.

### Okno a horní ostrůvky (Task 16)

- [ ] **Snap Layouts:** najetí myší na ⬜ (maximalizovat) v horním pravém ostrůvku ukáže nabídku
  rozložení Windows 11, v normálním i maximalizovaném okně a i při měřítku Windows 150 %.
  - Když se nabídka neukáže, nebo ⬜ či přetahování za ostrůvky přestane fungovat: v
    `src/shell/captionButtons.ts` přepnout `SNAP_LAYOUTS` na `false`, ověřit, že ⬜ zase
    maximalizuje a obnovuje okno a ostrůvky okno přetáhnou, a sem zapsat: **Snap Layouts zatím
    jdou jen přes Win+Z.** (Než to vzdát, lze zkusit ještě variantu popsanou nahoře v
    `src-tauri/src/surface/caption.rs`.)
- [ ] S pokusem 1 (`SNAP_LAYOUTS = true`, výchozí): klik na ⬜ okno maximalizuje a další klik ho obnoví,
  vždy právě jednou; ikona se přepne (⬜ / dvě okna). ⬜ jde ovládat i klávesnicí (Tab, Enter).
  Známé omezení: nad ⬜ stránka nevidí myš, takže tlačítko při najetí nezesvětlí.
- [ ] Najet na ⬜, počkat na nabídku rozložení a pak na ⬜ kliknout (bez výběru rozložení): okno se
  maximalizuje. Nabídka nesmí zmizet hned po otevření a klik nesmí propadnout (Task 16: sledování
  odchodu myši a ztráty zachycení myši nad ⬜).
- [ ] Přetáhnout okno za horní levý ostrůvek (název videa) i za pozadí pravého ostrůvku; na úvodní
  obrazovce a v Nastavení za prázdný pruh nahoře vpravo od lišty.
- [ ] Dvojklik na horní levý ostrůvek okno maximalizuje a obnoví, vždy právě jednou (ne maximalizovat
  a hned zase obnovit). S pokusem 1 ukáže pravé tlačítko na ostrůvku systémovou nabídku okna
  (Obnovit, Přesunout, Minimalizovat…).
- [ ] — minimalizuje okno; obnovení z hlavního panelu vrátí video na celé okno.
- [ ] ✕ zavře aplikaci (do 2 s hlídá E2E) a uloží pozici: další otevření téhož videa pokračuje,
  kde skončilo.
- [ ] ☰ (myší i Enter) otevře lištu nad videem; najetí k levému okraji okna ji ukáže a odjetí
  doprava ji zase schová; Esc ji zavře a video přitom **neopustí** fullscreen; šipky nahoru a dolů
  přecházejí mezi Přehrávačem a Nastavením; klik vedle lišty ji zavře a video se nepozastaví.
- [ ] Otevřená lišta nad videem začíná pod horním levým ostrůvkem (☰ je vidět); tažení za ostrůvky
  ani za horní okraj lišty okno nepřesune. Klik na ostrůvek (☰, —, ✕, název) lištu jen zavře a
  nic dalšího neudělá. **Výjimka je ⬜:** jeho malé okno z Win32 (Snap Layouts) leží nad záclonou,
  takže klik na ⬜ okno maximalizuje nebo obnoví a lištu **nezavře**. Je to tak v pořádku; zapsat
  sem, kdyby vadilo.
- [ ] Ve fullscreenu je ⬜ zašedlé a nic nedělá.
- [ ] Bez videa (úvodní obrazovka, Nastavení) je lišta vidět stále, vlevo vedle stránky.
- [ ] Klik myší na tlačítko (☰, ⬜, položku lišty) a pak mezerník → pauza videa. Tab na tlačítko
  a mezerník → stiskne tlačítko, video se nepozastaví.

### Měřítko UI 90 % a 150 % (Task 16)

Nastavení → Vzhled → Měřítko rozhraní.

- [ ] Rozmazání pod horními ostrůvky a pod otevřenou lištou sedí přesně na jejich tvar (zaoblené
  konce, žádný posun) při 90 % i 150 %, i po přetažení okna na monitor s jiným měřítkem.
- [ ] Při 90 % i 150 % najetí na ⬜ trefí ⬜ (Snap Layouts) a ne sousední tlačítko.
- [ ] Při 90 % i 150 % stránka vyplní celé okno: bez posuvníků, bez pruhu dole nebo vpravo.

### Úvodní obrazovka, vložení a přetažení (Task 17)

Potřeba: krátké video, video s diakritikou a mezerami v cestě (`žluťoučký kůň (2026).mkv`), složka
s několika videi, přímý odkaz na `.mp4` a odkaz na YouTube (ten hraje jen s `yt-dlp` v `PATH`).
`npm run tauri dev`, F12 (konzole WebView2) otevřená.

- [ ] **Soubor z Průzkumníku:** přetáhnout video na úvodní obrazovku. Při tažení nad oknem se
  přerušovaný okraj zóny změní na plný barevný se září, a to bez blikání, i když pointer přejíždí
  přes tlačítka a lištu. Po pustění video hraje a okno je na přehrávači.
- [ ] Více souborů najednou se zařadí do jednoho playlistu v pořadí z Průzkumníku; přetažená složka
  se otevře jako playlist; soubor s diakritikou a mezerami i soubor ze sdílené složky (UNC) se
  otevřou stejně jako ASCII soubor.
- [ ] **Soubor na přehrávané video i na Nastavení:** okno nikdy nepřejde na soubor (aplikace nezmizí,
  neukáže se stránka prohlížeče) a soubor se otevře. V konzoli při pustění **není** žádná chyba
  `console.error` od Tauri IPC (zpráva o dropu je JSON objekt, který Tauri nezpracovává).
- [ ] Pustění něčeho, co Kaleido neotevře (označený text, obrázek ze stránky): okno nikam nepřejde,
  ukazatel myši při tažení ukáže „nelze pustit“ a nic se nestane.
- [ ] **Odkaz z prohlížeče:** přetáhnout adresu z adresního řádku (Edge, Chrome, Firefox) a odkaz
  přímo ze stránky na okno: hraje hned (přímý `.mp4`, s `yt-dlp` i YouTube); na přehrávané video i
  z Nastavení také, a okno se přepne na přehrávač. S Nastavení → Přehrávání → Při otevření souboru
  za běhu → Přidat do playlistu se odkaz přetažený na přehrávané video přidá na konec playlistu a
  přehrávání se nepřeruší, jako u souborů (Ruling R54). Přetažený odkaz `file://…` nebo text bez
  odkazu nic neotevře.
- [ ] Tažení přes okno a zpět ven bez pustění, i zrušené klávesou Esc, zruší zvýraznění zóny.
- [ ] **Vložit odkaz** (tlačítko) s odkazem ve schránce (zkopírovat adresu videa): hraje bez dalšího
  kroku, pole se neukáže. Bez odkazu (prázdná schránka, nebo zkopírovaný obyčejný text, nebo
  soubor): ukáže se malé pole a kurzor je v něm.
- [ ] **Ctrl+V** na úvodní obrazovce: s odkazem hraje, bez odkazu se ukáže pole s kurzorem; druhé
  Ctrl+V při otevřeném poli vrátí kurzor do pole a napsaný text zůstane. Ctrl+V uvnitř pole vloží
  text a nejde do mpv.
- [ ] V poli: Enter s platným odkazem přehraje a pole zmizí. Enter s textem, který odkaz není, a s
  `file:///…` ukáže u pole srozumitelnou zprávu (česky při české Windows, jinak anglicky) a pole
  zůstane s napsaným textem. Esc a Zrušit pole zavřou a fokus se vrátí na „Vložit odkaz“; po
  Esc video nic nedělá (Esc nejde do mpv).
- [ ] Karta „Pokračovat ve sledování“ má štítek ROADMAPA. Klik kamkoli na kartu i na „Co chystáme →“
  otevře roadmapu v prohlížeči, a to jednou. Tab projde Otevřít soubor, Vložit odkaz, Co chystáme.
- [ ] **Prohlížeč přežije zavření Kaleida (Ruling R51):** zavřít všechna okna výchozího prohlížeče
  tak, aby žádný jeho proces neběžel (Správce úloh; u Edge vypnout Nastavení → Systém a výkon →
  Posílení spuštění), v Kaleidu kliknout na „Co chystáme →“, počkat na roadmapu, otevřít v
  prohlížeči ještě jednu kartu a zavřít Kaleido (✕): prohlížeč zůstane otevřený se všemi kartami.
  Totéž s odkazy na zdroje v Nastavení → O aplikaci a s „Otevřít složku s logy“ (okno Průzkumníka
  zůstane).
- [ ] Nic z ovládání úvodní obrazovky neleží v horním pruhu (48 px), kde se okno přetahuje; při
  nízkém okně (640×360) se obsah dá posunout a nahoře se nic neořízne.
- [ ] Ctrl+V bez odkazu ve schránce **při přehrávání** pole neukáže (pole je jen na úvodní
  obrazovce); místo něj přijde upozornění v kartě (viz „Karty chyb, načítání a indikátor“).

### Spodní ostrůvek, časová osa, autohide a fullscreen (Task 18)

Potřeba: krátký 1080p klip, film delší než hodina (nebo klip, který hlásí délku přes hodinu), video
s kapitolami (mkv), video s titulky, složka s několika videi (playlist). `npm run tauri dev`.

- [ ] **1080p klip:** spodní ostrůvek je dole uprostřed (nejvýš 960 px široký), nahoře čas, lišta
  a délka, dole hlasitost, předchozí / přehrát / další a vpravo Titulky, Playlist, Celá obrazovka.
  Čas a délka mají číslice stejné šířky (neskáčou), u filmu přes hodinu jsou oba s hodinami
  (`0:05:12` a `1:42:00`). Při objevení se ostrůvek vysune zdola a prolne (s vypnutými animacemi
  ve Windows se jen prolne). Rozmazání pod ním sedí přesně na jeho tvar, i při měřítku UI 90 % a
  150 % a v okně 640×360 (nic se nepřekrývá ani neřeže).
- [ ] **Náhled na časové ose:** najetí na lištu ukáže do 300 ms nad ní bublinu s náhledem snímku a
  časem pod ukazatelem (M0 bod 7); náhled jde za myší plynule a bez zpoždění, před prvním náhledem
  je v bublině jen čas. U levého i pravého okraje okna bublina okno nepřesáhne. Rozmazání pod
  bublinou sleduje bublinu (nezůstane na starém místě). Odjetí bublinu schová a po novém najetí se
  neukáže starý snímek; po přepnutí na další video v playlistu také ne. Rychlé jezdění myší po
  liště UI ani mpv nezahltí (požadavky na náhled jdou nejvýš asi 33× za sekundu).
- [ ] **Tažení za lištu:** video se při tažení přetáčí (rychle, po klíčových snímcích) a po
  puštění skočí přesně na místo; čas a lišta při tažení ukazují polohu myši a po puštění
  neskočí zpět; tažení pokračuje, i když myš vyjede z lišty. Prostý klik na lištu přeskočí na
  místo. Po kliku nebo tažení mezerník **pozastaví video** (fokus se vrátil do mpv a lišta se
  nepřepnula).
- [ ] **Tažení, které skončí bez puštění:** za tažení stisknout Esc: video skočí přesně na místo,
  kde myš byla, tažení skončí a Esc se do mpv nedostane (nezavře se panel ani fullscreen).
  Totéž, když se tažení přeruší jinak (Win+D, Alt+Tab nebo zamknutí obrazovky za tažení; po
  návratu se video nesmí přetočit na začátek ani na jiné místo, než kde tažení skončilo) a když
  se tlačítko pustí mimo okno (myš zpět nad lištou už nepřetáčí).
- [ ] **Klávesnice na liště:** Tab ji najde (viditelný fokus); šipky ←/→ posunou o 5 s (ne o 10: mpv
  je nedostane podruhé), Home na začátek, End na konec; Ctrl+←/→ a Shift+←/→ dělají to, co v mpv.
  Čtečka obrazovky čte „Časová osa“ a polohu jako „0:12 z 1:42:00“, jednou za sekundu.
- [ ] **Kapitoly:** ve videu s kapitolami jsou na liště značky v místech kapitol; u videa bez nich
  nejsou žádné.
- [ ] **Hlasitost:** tlačítko ztlumí a zase vrátí zvuk; posuvník jde od 0 do 130 (nebo do
  `volume-max` z `mpv.conf`) a má značku na 100 %; při tažení se palec nevrací zpět a hlasitost
  zní průběžně; šipky na posuvníku mění hlasitost a mpv je nedostane (video se nepřetáčí);
  kolečko na videu hlasitost změní a posuvník ji ukáže.
- [ ] **Předchozí / další:** u jednoho videa jsou zašedlé, u složky s videi fungují a přepnou
  video (na prvním a posledním mpv nic neudělá).
- [ ] **Titulky nad ostrůvkem:** u videa s titulky leží titulky nad spodním ostrůvkem a nedotýkají se
  ho; po skrytí ostrůvku sjedou dolů, ale **ne na spodní hranu**: na vlastní okraj mpv (výchozí
  `sub-margin-y=34` u přibaleného libmpv, nebo hodnota z `mpv.conf`; zkusit `sub-margin-y=60` a ověřit, že skrytí
  ostrůvku nechá titulky ve výšce 60, ne níž); po návratu ostrůvku zase nahoru; stejně po změně
  velikosti okna a ve fullscreenu.
- [ ] **Autohide:** při přehrávání po 2,5 s bez pohybu myši zmizí spodní ostrůvek, oba horní ostrůvky
  a kurzor; pohyb myši i kterákoli klávesa (a kolečko, klik) je hned vrátí. V pauze, při načítání
  a při otevřené postranní liště ☰ zůstávají. Zůstávají i tehdy, když myš v klidu leží nad
  ostrůvkem (třeba nad tlačítkem pauzy) a když je v ostrůvku fokus z klávesnice (Tab); po
  odjetí myši, nebo po odchodu fokusu, zmizí za dalších 2,5 s. Skrytý ostrůvek nepřetahuje okno
  (tažení za místo, kde byl horní ostrůvek, okno nepřesune) a klik na místo, kde byl, jde do
  videa (pozastaví ho).
- [ ] **Tab ze skrytého stavu:** po zmizení ovládání stisknout Tab: ovládání se hned ukáže a fokus
  skončí na prvním ovládacím prvku (viditelný fokus), ne na skrytém prvku ani nikde mimo. Pak 2,5 s
  nic nedělat: ovládání zůstane, dokud má fokus; klik do videa fokus vrátí a po 2,5 s zmizí. Totéž
  zkusit hned po zmizení a s ovládáním skrytým déle než vteřinu (to je už odebrané z okna).
- [ ] **⬜ a autohide:** najet na ⬜ (maximalizovat), nehýbat 5 s a nabídka rozložení (Snap Layouts)
  zůstane, ostrůvky nezmizí. Odjet z ⬜ do videa: po 2,5 s zmizí. Zapsat sem, jak se chová odjetí z
  okna **přes** pravý horní ostrůvek ven: správně zmizí 2,5 s po opuštění okna; v nejhorším
  zůstanou, dokud se myš nevrátí (WebView2 hlásí odchod myši se souřadnicí, podle které stránka
  pozná, jestli myš opustila okno nebo je nad oknem Windows; kdyby to nebylo spolehlivé, je to
  jediné místo k úpravě: `leftWindow` v `src/player/useAutohide.ts`).
- [ ] **Spotřeba se skrytým ovládáním:** v DevTools (F12 → Rendering → Paint flashing) nic nebliká a
  procesy WebView2 ve Správci úloh mají kolem 0 % CPU, jakmile ostrůvky zmizí (spec 13);
  v konzoli nejsou chyby.
- [ ] **Fullscreen tlačítkem:** okno přejde na celou obrazovku, během přepnutí kryje okno černá
  clona (žádný roztažený ani napůl vykreslený snímek) a do půl vteřiny zmizí; ikona i popisek
  tlačítka se změní („Zrušit celou obrazovku“); druhý klik vrátí okno. Totéž dvojklikem na video
  a klávesou `f`. Při rychlém dvojitém přepnutí nezůstane clona ani nesprávný stav. Okno se
  nepřepíná dvakrát (UI nevolá okno Tauri, přepíná ho Rust podle mpv). Zapsat sem, jestli je při
  přepnutí vidět záblesk dřív, než se clona objeví (UI se o změně dozví až od mpv, Rust okno
  přepíná o chvilku dřív).
- [ ] **Fullscreen z maximalizovaného okna** (a jinak velikostně shodný přechod): clona skončí
  nejpozději za 0,5 s a obraz je v pořádku.
- [ ] **Snížit průhlednost** a **vysoký kontrast** (Windows): ostrůvek je neprůhledný / v systémových
  barvách, lišta, posuvník a značky jsou vidět, tlačítka mají viditelný fokus.

### Mini přehrávač (Task 21)

Potřeba: video 16:9, video 4:3 a video na výšku (z telefonu), složka s několika videi, video 2.39:1
s letterboxem.

- [ ] **Otevřít Nastavení během přehrávání** (lišta → Nastavení): video se asi za čtvrt vteřiny
  plynule zmenší do pravého dolního rohu (360 px široké, 16 px od okrajů) a okno mpv jde s
  rámečkem snímek po snímku. Záznam 60 fps (Win+Alt+R) při zmenšení i zvětšení: hrana videa
  zaostává za rámečkem nejvýš o jeden snímek (M0 bod 6); když víc, zapsat (spec 8.6: pak náhradní
  cesta skok + prolnutí, která už je hotová pro omezené animace). Kolem videa je stránka
  neprůhledná (gradient; ve Windows 11 s Mica pozadí Mica), nikde neprosvítá plocha ani černá, ani
  během animace.
- [ ] **Rámeček:** zaoblené rohy (roh videa nepřečnívá přes zaoblení), tenký okraj a stín. Po
  dojetí do rohu se dole prolne skleněný pruh s ▶/❚❚, „Zpět do přehrávače“ a „Zastavit“.
  **Rozmazání pod pruhem sedí přesně na pruh** (ne posunuté k levému hornímu rohu okna: Ruling
  R45, Rust posouvá oblasti skla o místo okna mpv), i při měřítku UI 90 % a 150 % a na monitoru
  se 150 %, i u videa s letterboxem hned po zmenšení. Žádné rozmazání nikde jinde.
- [ ] ▶/❚❚ video pozastaví a pustí (ikona i popisek se změní); „Zastavit“ video zastaví, mini
  přehrávač zmizí a Nastavení zůstane; „Zpět do přehrávače“ video plynule zvětší na celé okno a
  ukáže přehrávač s ovládáním.
- [ ] **Dvojklik do videa** vrátí přehrávač a video **nepřejde do fullscreenu**; jeden klik nedělá
  nic (video se nepozastaví).
- [ ] **Myš nad stránkou nejde do mpv:** kolečko nad Nastavením nemění hlasitost, klik do prázdna
  video nepozastaví, pravé tlačítko neotevře nabídku WebView.
- [ ] **Klávesnice:** Tab dojde po obsahu stránky na tři tlačítka mini přehrávače (viditelný fokus,
  čtečka čte „Mini přehrávač“ a popisky tlačítek), Enter je stiskne. Po kliku myší na tlačítko
  mezerník pozastaví video (fokus se vrátil). Klávesy z input.conf jdou do mpv dál (šipky
  přetáčí, `m` ztlumí).
- [ ] **Přetáhnout okno a změnit jeho velikost v mini režimu** (za okraj i za roh, maximalizovat a
  obnovit, přetáhnout na monitor s jiným měřítkem): mini zůstane 16 px od pravého dolního rohu,
  video sedí v díře během tažení i po něm a nikde nezůstane pruh stránky ani kus videa navíc. Ve
  velmi malém okně se mini zmenší se stejným poměrem stran a nikdy se nezmáčkne.
- [ ] **Minimalizovat a obnovit** v mini režimu: video je zase v rohu. **Fullscreen** klávesou `f`
  v mini režimu: okno je na celé obrazovce a mini v jejím rohu; `f` znovu vrátí okno.
- [ ] **Poměr stran:** video 4:3 má mini 360 × 270, video na výšku je 360 px vysoké (užší); další
  video v playlistu s jiným poměrem mini přetvaruje a díra pořád sedí. Přechod na další video v
  playlistu mini nezavře ani nebliká na celé okno.
- [ ] **Mini přežije restart výstupu videa (vo):** v mini režimu vypnout a zapnout video stopu
  (`_` dvakrát) a pustit video s jiným rozlišením. mpv přitom své okno může vytvořit znovu; Rust
  nové okno umístí, jakmile mpv nahlásí jeho velikost (`osd-dimensions`, Ruling R52): video má
  zůstat v rohu. Zapsat sem, kdyby skočilo na celé okno (pak je v díře vidět jen jeho výřez nebo
  nic) a vrátilo se až po změně velikosti okna.
- [ ] **Měřítko UI** (Nastavení → Vzhled → Měřítko rozhraní) změněné při mini přehrávači: mini se
  zvětší nebo zmenší s UI (při 150 % je 540 px široké) a díra pořád sedí na video.
- [ ] **Omezené animace** (Windows: Nastavení → Usnadnění → Vizuální efekty → Efekty animace
  vypnout): po otevření Nastavení je video hned v rohu, nic se nehýbe a rámeček s videem se
  prolnou; „Zpět do přehrávače“ skočí na celé okno bez pohybu a přehrávač se prolne z pozadí
  stránky. Totéž ve Windows 11 s Mica (prolnutí je vidět i tam).
- [ ] **Žádná spára (Ruling R47):** při měřítku Windows 100, 125, 150 a 175 % a v okně libovolné
  velikosti (tažením za okraj po jednom pixelu) není mezi stránkou a videem ani na jedné straně
  světlá nebo černá linka (okno mpv sahá na každé straně o pixel pod stránku).
- [ ] **Stránka nekreslí přes video (Ruling R46):** obsah Nastavení u pravého dolního rohu (dlouhý
  seznam posunutý dolů, rozbalená nabídka) je v díře useknutý a video zůstává celé vidět; během
  zmenšování se text stránky nekreslí přes zmenšující se video. Skleněné prvky stránky vypadají s
  mini přehrávačem stejně jako bez něj.
- [ ] **Fokus z klávesnice:** Tab na „Zastavit“ a Enter: video se zastaví a fokus je na první
  položce stránky (bez ní na položce Nastavení v liště), ne nikde. Tab na „Zpět do přehrávače“
  a Enter: přehrávač se vrátí a fokus je na tlačítku přehrát/pozastavit (viditelný fokus).
- [ ] Během zmenšování a zvětšování (čtvrt vteřiny) klik do stránky mimo video trefí stránku, ne
  rámeček.
- [ ] **Snížit průhlednost:** pruh mini přehrávače je neprůhledný (bez rozmazání). **Vysoký
  kontrast:** rámeček a pruh v systémových barvách, tlačítka jsou vidět.
- [ ] **Spotřeba v klidu:** v mini režimu v DevTools (Paint flashing) nic nebliká a WebView2 má
  kolem 0 % CPU, video přitom hraje (spec 13).
