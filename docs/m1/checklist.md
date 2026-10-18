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

### Spodní ostrůvek, časová osa, autohide a fullscreen (Task 18)

Potřeba: krátký 1080p klip, film delší než hodina (nebo klip, který hlásí délku přes hodinu), video
s kapitolami (mkv), video s titulky, složka s několika videi (playlist). `npm run tauri dev`.

- [ ] **1080p klip:** spodní ostrůvek je dole uprostřed (nejvýš 960 px široký), nahoře čas, lišta
  a délka, dole hlasitost, předchozí / přehrát / další a vpravo Titulky, Playlist, Celá obrazovka.
  Čas a délka mají číslice stejné šířky (neskáčou), u filmu přes hodinu jsou oba s hodinami
  (`0:05:12` a `1:42:00`). Při objevení se ostrůvek vysune zdola a prolne (s vypnutými animacemi
  ve Windows se jen prolne). Rozmazání pod ním sedí přesně na jeho tvar, i při měřítku UI 90 % a
  150 % a v okně 640×360 (nic se nepřekrývá ani neřeže).
- [ ] **Náhled na časové ose:** najetí na lištu ukáže nad ní bublinu s náhledem snímku a časem pod
  ukazatelem; náhled jde za myší plynule a bez zpoždění, před prvním náhledem je v bublině jen
  čas. U levého i pravého okraje okna bublina okno nepřesáhne. Rozmazání pod bublinou sleduje
  bublinu (nezůstane na starém místě). Odjetí bublinu schová a po novém najetí se neukáže starý
  snímek; po přepnutí na další video v playlistu také ne. Rychlé jezdění myší po liště UI ani mpv
  nezahltí (požadavky na náhled jdou nejvýš asi 33× za sekundu).
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
  `sub-margin-y=22`, nebo hodnota z `mpv.conf`; zkusit `sub-margin-y=60` a ověřit, že skrytí
  ostrůvku nechá titulky ve výšce 60, ne níž); po návratu ostrůvku zase nahoru; stejně po změně
  velikosti okna a ve fullscreenu. (Tlačítka Titulky a Playlist zatím jen nastaví, který panel je otevřený:
  panely přijdou s Task 20; tlačítko Titulky má `aria-expanded`.)
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

Potřeba: video 16:9, video 4:3 a video na výšku (z telefonu), složka s několika videi. Stránka
Nastavení je do Task 22 prázdná; mini přehrávač je na ní i tak.

- [ ] **Otevřít Nastavení během přehrávání** (lišta → Nastavení): video se asi za čtvrt vteřiny
  plynule zmenší do pravého dolního rohu (360 px široké, 16 px od okrajů) a okno mpv jde s
  rámečkem snímek po snímku. Zapsat sem, jestli video za rámečkem viditelně zaostává (spec 8.6:
  pak náhradní cesta skok + prolnutí, která už je hotová pro omezené animace). Kolem videa je
  stránka neprůhledná (gradient; ve Windows 11 s Mica pozadí Mica), nikde neprosvítá plocha ani
  černá, ani během animace.
- [ ] **Rámeček:** zaoblené rohy (roh videa nepřečnívá přes zaoblení), tenký okraj a stín. Po
  dojetí do rohu se dole prolne skleněný pruh s ▶/❚❚, „Zpět do přehrávače“ a „Zastavit“.
  **Rozmazání pod pruhem sedí přesně na pruh** (ne posunuté k levému hornímu rohu okna: Ruling
  R45, Rust posouvá oblasti skla o místo okna mpv), i při měřítku UI 90 % a 150 % a na monitoru
  se 150 %. Žádné rozmazání nikde jinde.
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
  (`_` dvakrát) a pustit video s jiným rozlišením. mpv přitom své okno může vytvořit znovu, a Rust
  mu rozvržení po vytvoření znovu nepošle (Task 6): zapsat sem, jestli video zůstane v rohu, nebo
  skočí na celé okno (pak je v díře vidět jen jeho výřez nebo nic) a vrátí se až po změně
  velikosti okna.
- [ ] **Měřítko UI** (Nastavení → Vzhled, Task 22) změněné při mini přehrávači: mini se zvětší nebo
  zmenší s UI (při 150 % je 540 px široké) a díra pořád sedí na video.
- [ ] **Omezené animace** (Windows: Nastavení → Usnadnění → Vizuální efekty → Efekty animace
  vypnout): po otevření Nastavení je video hned v rohu, nic se nehýbe a rámeček s videem se
  prolnou; „Zpět do přehrávače“ skočí na celé okno bez pohybu.
- [ ] **Snížit průhlednost:** pruh mini přehrávače je neprůhledný (bez rozmazání). **Vysoký
  kontrast:** rámeček a pruh v systémových barvách, tlačítka jsou vidět.
- [ ] **Spotřeba v klidu:** v mini režimu v DevTools (Paint flashing) nic nebliká a WebView2 má
  kolem 0 % CPU, video přitom hraje (spec 13).
