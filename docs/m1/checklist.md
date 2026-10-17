# M1 – ruční kontrola

Task 24 tento seznam doplní (vzhled ostrůvků a skla, výkon, Mica, vysoký kontrast, otevřené body
z M0). Výsledky zapisuj sem, nebo je pošli Claudovi v chatu.

## Ověřit ve velkém průchodu

Kontroly, které úkoly M1 připravily, ale v tichém režimu je nikdo nespustil ani neviděl. Spustit
`npm run tauri dev` (nebo build z Task 24) a mít po ruce krátké 1080p video.

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
- [ ] Přetáhnout okno za horní levý ostrůvek (název videa) i za pozadí pravého ostrůvku; na úvodní
  obrazovce a v Nastavení za prázdný pruh nahoře vpravo od lišty.
- [ ] Dvojklik na horní levý ostrůvek okno maximalizuje a obnoví. S pokusem 1 ukáže pravé tlačítko
  na ostrůvku systémovou nabídku okna (Obnovit, Přesunout, Minimalizovat…).
- [ ] — minimalizuje okno; obnovení z hlavního panelu vrátí video na celé okno.
- [ ] ✕ zavře aplikaci do 2 s a uloží pozici (další otevření téhož videa pokračuje, kde skončilo).
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

Měřítko je v Nastavení → Vzhled (Task 22); do té doby `"uiScale": 0.9` nebo `1.5` v části
`appearance` souboru `%APPDATA%\Kaleido\settings.json` (a znovu spustit).

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
  z Nastavení také, a okno se přepne na přehrávač. Přetažený odkaz `file://…` nebo text bez odkazu
  nic neotevře.
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
- [ ] Nic z ovládání úvodní obrazovky neleží v horním pruhu (48 px), kde se okno přetahuje; při
  nízkém okně (640×360) se obsah dá posunout a nahoře se nic neořízne.
- [ ] Známé omezení M1: Ctrl+V bez odkazu ve schránce **při přehrávání** pole neukáže (pole je jen na
  úvodní obrazovce). Zapsat sem, jestli to vadí.
