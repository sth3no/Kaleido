# M2 – ruční kontrola

Co testy nepokryjí: skutečná síť a weby (GitHub, YouTube), prohlížeče a jejich cookies, Koš Windows,
vzhled stránek Moje pluginy a Aktualizace, chování okna a mini přehrávače při restartu jádra a vše,
co závisí na tvém počítači (HDR, GPU, Windows). Výsledky zapisuj sem k bodu, nebo je pošli Claudovi
v chatu.

**Žádný automatický test M2 zatím neběžel.** Všechny vznikly v tichém režimu, když uživatel hrál hry
(testy a okna by hru zavřely): prošly jen kompilací a kontrolou stylu (`clippy`, `fmt`, `tsc`,
`eslint`). Jejich první běh je poslední sekce, Velký průchod testů. Do té doby je ověřené jen to, co
tu odškrtneš.

Automaticky poběží potom (ručně neopakovat; jak je spustit, říká [README.md](../../README.md)):

- `cargo test --workspace`: skutečná libmpv s `vo=null` a `ao=null` jako v M1, nově jména skriptů
  podle mpv a načtení pluginu za běhu, `plugins.json`, `script-opts` a hodnoty nastavení pluginů,
  atomická instalace essentials a Koš, restart jádra s pokračováním (playlist, pozice, stopy,
  pauza), stažení, ověření a výměna nástrojů na falešném zdroji (testy nikdy nejdou na síť),
  třídění chyb yt-dlp, přepnutí kvality na místě, detekce prohlížečů, HDR řetězec náhledů v
  `kaleido-mpv`, IPC fixtures.
- `npm test`: UI (vitest): Moje pluginy a nastavení pluginu, záložka Kvalita, karty chyb streamů,
  Nastavení → Přehrávání a Aktualizace.
- `npm run e2e`: kroky z M1 a navíc „Moje pluginy ukáže thumbfast jako Essentials a zapnutý“. Běží
  proti tvému `%APPDATA%\Kaleido`: thumbfast, který jsi odinstaloval, vypnul nebo nahradil vlastním
  `thumbfast.lua`, ten krok shodí (README).

## Příprava

- Vývojový běh: `npm run tauri dev` (F12 = konzole WebView2). Nejdřív stáhni essentials
  (`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-essentials.ps1`, README):
  bez nich se aplikace nesestaví.
- Build jako u uživatele, z kořene repozitáře:

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-essentials.ps1
  npm run tauri build -- --no-bundle
  cargo build --release -p kaleido-mpv
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local.ps1
  ```

  Skript nainstaluje build M2 do `%LOCALAPPDATA%\Programs\Kaleido-M0\` (složka a registrace zůstávají
  jako v M1, [docs/m0/local-install.md](../m0/local-install.md)) a nově kopíruje celou složku
  `resources\essentials\` buildu (manifest a složku se soubory každého essentialu). Když běží
  Kaleido spuštěný z té instalační složky, odmítne pokračovat; vývojový běh z `npm run tauri dev`
  ho nezastaví, takže ho před instalací zavři sám.
- **`scripts/install-local.ps1` a `scripts/diagnose-associations.ps1` spouštíš ty, ve vlastním
  terminálu**, ne Claude. Nástroje, kterými Claude pracuje (jeho PowerShell a Bash), běží v
  sandboxu: co z nich zapíše do registru (HKCU) a do `%APPDATA%` nebo `%LOCALAPPDATA%`, se do tvé
  skutečné relace Windows nedostane. Skript tam „uspěje“ a diagnostika zapsané klíče vidí, ale
  Průzkumník, Otevřít v programu i Výchozí aplikace nevidí nic (ověřeno 2026-10-18). Totéž platí pro
  všechno níže, co se dívá do `%APPDATA%\Kaleido` a `%LOCALAPPDATA%\Kaleido` (nástroje, pluginy,
  `tools.json`, logy): dívej se ty. Stav, který by Claude přečetl ze svého shellu, není tvůj. Build
  uvnitř složky repozitáře (`target\...`) je skutečný.
- **Zálohuj, než začneš:** zkopíruj `%APPDATA%\Kaleido` a `%LOCALAPPDATA%\Kaleido` (třeba na plochu).
  Kroky „první start“ přejmenovávají složku `tools` a hrají si se `scripts`, `script-opts` a
  `plugins.json`; po testu je vrať. Stejné složky používá E2E.
- Média: vše z přípravy M1 ([docs/m1/checklist.md](../m1/checklist.md)) a navíc:
  - odkaz na YouTube (běžné video) a dva další do playlistu odkazů; odkaz na soukromé video, na
    video s věkovým omezením, na video nedostupné ve tvém regionu a na smazané video;
  - mkv s anglickým zvukem a českými i anglickými titulky; mkv s českým zvukem a stopou vynucených
    titulků (forced); skutečné HDR10; složka se třemi videi;
  - Firefox, v němž jsi přihlášený na YouTube, a Edge;
  - síť, kterou jde na povel vypnout (Wi-Fi, kabel, režim Letadlo);
  - starší `yt-dlp.exe` (z vydání `yt-dlp/yt-dlp` na GitHubu, aspoň rok staré);
  - kopie `thumbfast.lua` (třeba z `%APPDATA%\Kaleido\scripts\thumbfast\main.lua`).

## Před vydáním M2

### Nástroje: první start, aktualizace a offline (Task 8, 9 a 17)

yt-dlp a Deno jsou Kaleidovy vlastní: leží v `%LOCALAPPDATA%\Kaleido\tools\` (`yt-dlp.exe`,
`deno.exe`, `tools.json`), stahuje, ověřuje (SHA-256 podle seznamu součtů u vydání) a vyměňuje je
Rust. yt-dlp z `PATH` Kaleido nepoužije. Soubory v `tools\` upravuj jen se zavřeným Kaleidem.

- [ ] **První start bez nástrojů:** Kaleido zavřít, `%LOCALAPPDATA%\Kaleido\tools` přejmenovat na
  `tools.bak` a Kaleido spustit. Okno běží hned a nic se neptá. V Nastavení → Aktualizace se yt-dlp
  ukáže jako „Hledám novou verzi…“, pak „Stahuji novou verzi…“ a skončí jako „Aktuální“ s verzí
  (`Verze 2026.…`) a „Zkontrolováno nyní“ (později „před N minutami“, „před N hodinami“).
  Deno totéž, ale déle (zip má asi 43 MB, rozbalený
  `deno.exe` asi 120 MB). Při tom nikde neproblikne okno konzole. V nové složce `tools\` je
  `yt-dlp.exe`, `deno.exe` a `tools.json`. Přibalené první kopie přijdou až s instalátorem M4, do
  té doby se stahuje vždy.
- [ ] **Verze jsou všude stejné:** Nastavení → O aplikaci: v seznamu licencí třetích stran mají
  yt-dlp a Deno skutečnou verzi z předchozího kroku (ne slovo „managed“; za stahování „Stahuje
  se…“). Zkopírovat diagnostiku (vložit do Poznámkového bloku) má řádky `yt-dlp: <verze>` a
  `Deno: <verze>`.
- [ ] **Kontrola, která nic nestahuje:** Kaleido zavřít a v `tools.json` přepsat `checkedAt` u
  `ytDlp` i `deno` na dva dny zpátky (tvar `2026-10-17T12:00:00Z`). Po spuštění se yt-dlp zkontroluje
  sám (denní kontrola je splatná): „Zkontrolováno“ se vrátí na „nyní“, ale `yt-dlp.exe`
  zůstal týž soubor (stejný čas změny), protože vydání má pořád stejný součet (pokud mezitím
  nevyšla nová verze). Deno se nezkontroluje (týdenní kontrola ještě splatná není). Popisky řádků
  to říkají: „každý den“ a „každý týden“.
- [ ] **Zkontrolovat teď:** u yt-dlp i Deno řádek ukáže „Hledám novou verzi…“; po dobu kontroly
  tlačítko nic nespustí a nemizí mu fokus; potom „Zkontrolováno nyní“.
- [ ] **Kanál Nightly:** Nastavení → Aktualizace → Kanál yt-dlp → Nightly: řádek yt-dlp hned ukáže
  kontrolu a stahování a skončí s verzí z nightly (má čas, třeba `2026.10.10.233141`). Zpět na
  Stabilní: stáhne se zase stabilní verze, a to hned. Deno žádný kanál nemá (hint pod kanálem to
  říká).
- [ ] **Offline start s nástroji:** nástroje jsou nainstalované; vypnout síť, Kaleido spustit.
  Místní soubory hrají, nástroje zůstaly, jak byly. Stisknout Zkontrolovat teď u yt-dlp: stav
  „Vyžaduje pozornost“ s anglickým důvodem a verze se nezměnila. Zapnout síť a stisknout
  Zkontrolovat teď: „Aktuální“. (Automatické pokusy po selhání jdou po 1 minutě, 5 minutách, 30
  minutách a pak po 2 hodinách; tlačítko ten odstup obchází.)
- [ ] **První start offline, bez nástrojů (rozhodnutí 8):** `tools` přejmenovat na `tools.bak`, síť
  vypnout, Kaleido spustit a vložit odkaz na YouTube. Karta: „yt-dlp, nástroj, který čte webové
  odkazy, ještě není nainstalovaný, nebo se ho nepodařilo stáhnout.“ s tlačítkem „Aktualizovat a
  zkusit znovu“. V Aktualizacích je yt-dlp „Není nainstalováno“ a „Vyžaduje pozornost“. Zapnout síť
  a tlačítko stisknout: karta říká „Aktualizuji yt-dlp, pak odkaz zkusím znovu…“, yt-dlp se
  stáhne a odkaz se přehraje.
- [ ] **Známé omezení (Task 8): jedno stažení má 10 minut.** Pod asi 70 KB/s (43 MB / 600 s) se zip s
  Deno nikdy nedokončí; yt-dlp (asi 18 MB) potřebuje jen kolem 30 KB/s. Uživatel to uvidí tak, že
  Deno zůstane „Vyžaduje pozornost“ s anglickým důvodem (pravděpodobně časový limit) a další pokus
  přijde po odstupu; yt-dlp při tom může být v pořádku. Kdo má jak omezit rychlost, může to vyzkoušet;
  jinak jen zapsat „nezkoušeno“.
- [ ] **Známé omezení (Task 8): jen proměnné `HTTP_PROXY` a `HTTPS_PROXY`.** Kaleido nečte proxy
  nastavenou jen ve Windows (Nastavení → Síť a internet → Proxy). Za takovou proxy zůstanou nástroje
  offline: Aktualizace ukážou „Vyžaduje pozornost“ a „Zkontrolovat teď“ to nezmění. Obejít to jde
  uživatelskou proměnnou prostředí `HTTPS_PROXY` a restartem Kaleida. Jen zapsat, jestli jsi za
  takovou proxy; jinak „nezkoušeno“.

### YouTube s Deno (Task 9 a rozhodnutí 20)

- [ ] **YouTube hraje:** běžný odkaz na YouTube se přehraje (obraz i zvuk) a v záložce Kvalita je víc
  výšek. Při načítání a přehrávání neproblikne okno konzole a po zavření Kaleida nezůstane
  `yt-dlp.exe` ani `deno.exe` ve Správci úloh (nástroje běží jako potomci Kaleida).
- [ ] **Před Deno a po něm:** hned po „První start bez nástrojů“, dokud u Deno není „Aktuální“, vlož
  odkaz na YouTube a podívej se do záložky Kvalita: YouTube bez Deno jen tiše nabídne méně formátů
  (Kaleido to nehlásí). Až je Deno „Aktuální“, vlož odkaz znovu, bez restartu Kaleida: Kaleido pošle
  běžícímu přehrávači cestu k Deno, takže kvalit je víc. Zapsat, co jsi viděl; rozdíl může být
  malý, podle videa a podle toho, co YouTube právě dělá.

### Kvalita streamů (Task 12, 15 a 17, Ruling R13)

- [ ] **Tlačítko jen u odkazu:** u odkazu je vedle Titulků tlačítko „Kvalita: Auto“ a v Rychlém
  nastavení záložka Kvalita; u místního souboru ani jedno.
- [ ] **Seznam kvalit:** záložka ukáže „Načítám kvality…“ a pak „Automaticky“ (s popiskem „Výchozí
  kvalita z Nastavení“) a jednu volbu na výšku obrazu od nejvyšší (`1080p`, `1080p60`, `2160p HDR`,
  …); „Jen zvuk“ jen tehdy, když odkaz má formát jen se zvukem. Odkaz, který yt-dlp nedokáže
  přečíst, ukáže v záložce větu své třídy chyby.
- [ ] **Výběr uprostřed přehrávání (R13):** Nastavení → Přehrávání → Při otevření souboru za běhu →
  Přidat do playlistu, vložit dva odkazy (Ctrl+V), přehrávat první, dojít na asi 1:00 a v záložce
  Kvalita vybrat třeba 480p. Panel se zavře hned; přehrávač ukáže titulek načítání a pokračuje na
  stejné pozici (o vteřinu dvě vedle je v pořádku); playlist má pořád ty dvě položky, bez zdvojení
  a bez zbytku staré. Po novém otevření panelu je nová kvalita označená a tlačítko říká „Kvalita:
  480p“.
- [ ] **Klávesnice (R13):** stejný výběr z klávesnice (Tab do panelu, šipky, Enter). Zapsat, kam
  fokus po zavření panelu skončil (zpět na tlačítko Kvalita, nebo nikam); nesmí zůstat na zmizelé
  volbě a mezerník i šipky pak mají dělat to, co v přehrávači.
- [ ] **Dvě volby rychle za sebou (R13):** vybrat kvalitu, panel hned znovu otevřít a vybrat jinou.
  Platí poslední volba, playlist nemá zdvojenou ani zbylou položku a pozice neuskočila daleko.
- [ ] **Zpět na Automaticky** vrátí výchozí kvalitu z Nastavení.
- [ ] **Znovu otevřený odkaz (Ruling R12):** zvolit pro odkaz jinou kvalitu a vložit stejný odkaz
  znovu: hraje ve výchozí kvalitě, ne ve zvolené. Naopak Použít v Moje pluginy (restart jádra) uprostřed
  téhož odkazu zachová zvolenou kvalitu.
- [ ] **Výchozí kvalita (Task 17):** Nastavení → Přehrávání → Výchozí kvalita streamů nabízí
  Nejlepší, 2160p, 1440p, 1080p, 720p, 480p a Jen zvuk; hint říká „Platí pro odkazy otevřené od
  teď.“ S 480p odkaz otevřený potom hraje ve 480p (štítek v titulním ostrůvku) a záložka Kvalita u
  něj má „Automaticky“ s popiskem výchozí kvality; odkaz otevřený předtím se nemění. „Jen zvuk“
  přehraje jen zvuk (zapsat, co ukáže okno).
- [ ] **Vlastní hodnota z mpv.conf:** do `%APPDATA%\Kaleido\mpv.conf` dát vlastní řádek
  `ytdl-format=bestvideo[height<=360]+bestaudio/best`. Pole „Výchozí kvalita streamů“ ukáže „Vlastní
  (mpv.conf)“. Výběr předvolby přepíše hodnotu na témže řádku (Kaleido mění jen poslední výskyt klíče)
  a ostatní řádky a komentáře zůstanou.

### Chyby streamů (Task 10 a 16)

Rust třídí chyby podle řádků, které `ytdl_hook` píše do logu mpv, a ty mohou přijít až po konci
souboru. U každé třídy proto zapsat, jestli karta ukázala **větu své třídy**, nebo obecnou „Soubor
nebo odkaz se nepodařilo otevřít…“ (pak řádky přišly pozdě; úryvek je v „Podrobnosti“ a v
`%LOCALAPPDATA%\Kaleido\logs\mpv.log`). Název v kartě je server odkazu.

- [ ] **Soukromé video:** „Video je soukromé.“ Bez tlačítka, karta jen vysvětluje.
- [ ] **Video s věkovým omezením:** „Video má věkové omezení a web vyžaduje přihlášení.“ s tlačítkem
  „Použít cookies z prohlížeče“ (viz Cookies z prohlížeče).
- [ ] **Region:** „Video není ve tvém regionu dostupné.“ Bez tlačítka. (Nemáš-li video omezené ve
  tvém regionu, jde to přes VPN do jiné země; jinak „nezkoušeno“.) Smazané video: „Video bylo
  odstraněno nebo už neexistuje.“ Také bez tlačítka.
- [ ] **Odpojená síť:** síť vypnout a vložit odkaz: „yt-dlp se nepodařilo spojit s webem. Zkontroluj
  připojení k internetu.“ s tlačítkem „Zkusit znovu“. Síť zapnout a stisknout: odkaz se přehraje a
  karta zmizí. Síťová chyba se nikdy nesmí tvářit jako zastaralý yt-dlp.
- [ ] **Chybějící `yt-dlp.exe`:** Kaleido zavřít, `tools\yt-dlp.exe` přejmenovat, spustit, vložit
  odkaz: „yt-dlp, nástroj, který čte webové odkazy, ještě není nainstalovaný, nebo se ho nepodařilo
  stáhnout.“ s „Aktualizovat a zkusit znovu“, což ho stáhne a odkaz přehraje. V Aktualizacích může
  na chvíli být „Vyžaduje pozornost“ s důvodem, že soubor zmizel: kontrola, kterou nikdo nevynutil,
  ho napoprvé nestáhne, jen zapíše selhání a počká (Ruling R10; antivirus, který ho pořád odnáší,
  se tak nezahltí stahováním). Tlačítko na kartě kontrolu vynutí.
- [ ] **`yt-dlp.exe` nahrazený starou verzí, `tools.json` beze změny (varianta B):** Kaleido
  zavřít. Současný `tools\yt-dlp.exe` odložit (třeba přejmenovat na `yt-dlp.new`) a na jeho místo
  dát starý `yt-dlp.exe`. `tools.json` nechat, jak je, jen se podívat na `checkedAt` u `ytDlp`:
  má být z posledních 24 hodin, ale starší než pár minut (jinak ho přepsat na čas před hodinou, v
  UTC, tvaru `RRRR-MM-DDThh:mm:ssZ`), aby se při startu neudělala plánovaná kontrola. Kaleido pozná
  „novou verzi“ podle součtu zapsaného v `tools.json`, ne podle samotného souboru. Tady se součet
  shoduje s vydáním, takže žádná kontrola nic nestáhne, jen přepíše `checkedAt`, a starý soubor
  zůstane na místě. Aktualizace přitom říkají „Aktuální“ a ukazují zapsanou novou verzi, ne verzi
  souboru. Spustit Kaleido čerstvě (hlídání deseti minut níže se počítá od prvního takového selhání
  v tomto běhu) a vložit odkaz na YouTube: karta „yt-dlp už tomuto webu nerozumí. Novější yt-dlp by
  mohl.“ s „Aktualizovat a zkusit znovu“. **Každý odkaz na YouTube teď selže takto**, dokud se
  soubor nevymění. Kaleido první takovou chybu za běh sám zkontroluje na pozadí; kontrola nic
  nenajde, a „Zkontrolováno“ u yt-dlp v Nastavení → Aktualizace se přepne na „nyní“. Selže-li starý
  yt-dlp jinak (třeba „Tento web vyžaduje přihlášení.“), zapsat jak a řádek z `mpv.log`.
- [ ] **Kontrola při chybě nejvýš jednou za 10 minut (Ruling R11), ve variantě B:** před prvním
  odkazem si přečíst „Zkontrolováno“ u yt-dlp v Aktualizacích (třeba „před N hodinami“); po prvním
  selhání je „nyní“. Za dvě tři minuty (Aktualizace otevřít znovu: „před N minutami“) vložit další
  odkaz, který selže: „Zkontrolováno“ se **nezmění**, protože druhá chyba do deseti minut novou
  kontrolu sama nespustí (a plánovaná kontrola splatná není). Víc než deset minut po první chybě
  další selhání kontrolu zase spustí a „Zkontrolováno“ je znovu „nyní“. Tlačítko na kartě kontrolu
  vynutí kdykoli, takže po jeho stisku je „nyní“ vždycky.
- [ ] **Tlačítko na kartě ve variantě B:** „Aktualizovat a zkusit znovu“ na kartě zastaralého yt-dlp:
  karta říká „Aktualizuji yt-dlp, pak odkaz zkusím znovu…“, vynucená kontrola nenajde nic nového a
  nic nestáhne („Zkontrolováno“ je „nyní“), karta se zavře (odkaz je předán přehrávači) a odkaz
  selže stejně, takže přijde nová karta téže třídy. Tlačítko tu starý soubor opravit neumí; to
  ukazuje varianta A níže.
- [ ] **Dvě karty zastaralého yt-dlp najednou (Task 16), ve variantě B:** dva odkazy na YouTube za
  sebou, aby byly otevřené dvě karty (ukazatel nad kartou ji drží, takže 8 s netlačí), a na obou
  hned stisknout „Aktualizovat a zkusit znovu“. Rust nespustí dvě kontroly zároveň (druhý požadavek
  počká na běžící kontrolu), obě tlačítka dokončí, žádná karta nehlásí spor a oba odkazy se
  zkusí znovu; zapsat, kolik nových karet přišlo. Ve variantě B se nic nestahuje: jedno stahování v
  Aktualizacích ukáže jen varianta A, a to jen když stisk stihneš dřív, než kontrola vyvolaná
  první chybou soubor vymění.
- [ ] **`yt-dlp.exe` nahrazený starou verzí, změněný součet (varianta A):** po variantě B (starý
  soubor je už na místě) Kaleido zavřít a v `tools.json` u `ytDlp` změnit v `sha256` jeden znak
  (`checkedAt` nechat z posledních 24 hodin). Samostatně: totéž plus výměna souboru jako ve
  variantě B. Kaleido spustit a vložit odkaz na YouTube: karta „yt-dlp už tomuto webu nerozumí.
  Novější yt-dlp by mohl.“ První takovou chybu za běh Kaleido zkontroluje sám na pozadí, tentokrát
  se součet liší, a tak se v Aktualizacích krátce ukáže stahování a `yt-dlp.exe` se vymění;
  tlačítko na kartě na tu kontrolu počká (nebo ji vynutí) a odkaz **přehraje**. Po tomhle je
  yt-dlp zase aktuální a zapsaný součet sedí. (Odložený `yt-dlp.new` z varianty B už není
  potřeba.)

### Cookies z prohlížeče (Task 11, 16 a 17)

- [ ] **Nabídka na kartě (Task 16):** na kartě s věkovým omezením stisknout „Použít cookies z
  prohlížeče“. V kartě (ne ve vyskakovacím okně) se otevře výběr „Brát cookies z“: nahoře Firefox a
  jeho odnože (LibreWolf, Zen, Floorp), pod nimi prohlížeče na Chromiu s větou „yt-dlp cookies
  prohlížečů na Chromiu ve Windows většinou nepřečte a odkaz pak selže celý. Firefox funguje.“,
  nakonec ty bez profilu („Profil s cookies se nenašel.“), které jdou jen přečíst, ne vybrat.
  „Použít a zkusit znovu“ čeká na volbu; Esc nejdřív zavře výběr, až potom kartu.
- [ ] **Firefox:** Firefox, v němž jsi přihlášený, vybrat a „Použít a zkusit znovu“ (karta říká
  „Ukládám volbu, pak odkaz zkusím znovu…“): karta zmizí a video s věkovým omezením hraje. Funguje i
  s běžícím Firefoxem. Nastavení → Přehrávání → Cookies z prohlížeče ukáže Firefox.
- [ ] **Edge (rozhodnutí 19):** totéž s Edge, s větou o Chromiu. Plán čeká, že yt-dlp jeho cookies
  nepřečte a odkaz selže celý: karta „Cookies zvoleného prohlížeče se nepodařilo přečíst.“ a výběr
  nabídne i „Nepoužívat cookies“; po jeho výběru a novém pokusu je z toho zase karta o věku.
  **Zapsat, jak to dopadlo, s běžícím Edge i s Edge zavřeným**: jestli Edge používá šifrování,
  které yt-dlp nezvládá, je v plánu neověřené.
- [ ] **Co kartu drží (Task 16):** otevřený výběr kartu sám nedrží: nech ruce pryč od myši i
  klávesnice a po 8 s karta zmizí. Drží ji ukazatel nad kartou, fokus v ní a běžící akce („Použít a
  zkusit znovu“, „Aktualizovat a zkusit znovu“); po ní karta zmizí sama.
- [ ] **Odkaz do Nastavení (Task 16):** bez nalezeného prohlížeče, nebo když se seznam nepodařilo
  vypsat, výběr řekne větu a ukáže odkaz „Nastavení → Přehrávání“: zavře kartu a otevře Nastavení
  (karta nezůstane nad stránkou). Jde to vyvolat jen na počítači bez prohlížeče; jinak „nezkoušeno“.
- [ ] **Malé okno a 150 % (Task 16):** výběr v okně 640×360 a při měřítku UI 150 %: vybraná volba s
  fokusem zůstane vidět.
- [ ] **Detekce prohlížečů (Task 11):** Nastavení → Přehrávání → Cookies z prohlížeče nabízí
  „Nepoužívat“ a každý nainstalovaný prohlížeč: Firefox, jeho odnože (podle profilu s nejnovějšími
  cookies), Edge, Chrome, Brave, Opera, Vivaldi, Chromium, Arc. Arc ve Windows může být aplikace
  MSIX (`Packages\…\LocalCache\Local\Arc`): zapsat, jestli ho Kaleido najde (pokud ho máš).
- [ ] **Uložená volba, která už neexistuje (Task 17):** Kaleido zavřít a do `%APPDATA%\Kaleido\
  settings.json` do části `playback` dát `"cookiesFromBrowser": "firefox:C:\\neexistuje"`. Pole
  ukáže tuto hodnotu jako vybranou s poznámkou „Tento prohlížeč nebo profil se na tomto počítači
  nenašel. Nastavení zůstane, dokud ho nezměníš.“ a nic ji nepřepíše.
- [ ] **Kaleidovy hodnoty přebíjejí tvůj mpv.conf (Task 9 a 11):** jen za běhu, `mpv.conf` zůstane,
  jak je. (a) Do `mpv.conf` dát `ytdl-raw-options=cookies-from-browser=firefox`, v Kaleidu mít
  „Nepoužívat“ a otevřít video s věkovým omezením: chová se, jako by cookies nebyly (karta o věku),
  protože „Nepoužívat“ odebere `cookies-from-browser` i z tvého řádku. (b) Do `mpv.conf` dát
  `ytdl-raw-options=js-runtimes=deno:C:\neexistuje\deno.exe`: YouTube hraje dál, protože cestu k
  spravovanému Deno Kaleido dosadí místo tvé (bez nainstalovaného Deno by tvůj `js-runtimes`
  odebral). V obou případech pak otevřít `mpv.conf` a ověřit, že řádky jsou tam pořád a beze změny.

### Moje pluginy (Task 5, 6, 7, 13 a 14)

Stránka je v liště mezi Přehrávačem a Nastavením. Plugin je obyčejný skript mpv ve
`%APPDATA%\Kaleido\scripts\`; vypnutý leží ve `scripts-disabled\`.

- [ ] **Seznam po prvním startu:** `scripts`, `scripts-disabled`, `script-opts` a `plugins.json`
  dočasně přejmenovat (zálohovat), Kaleido spustit a otevřít Moje pluginy. Jsou tam thumbfast,
  sub-select a reload v tomto pořadí, každý se štítkem „Essentials“, verzí (`Verze 0f711de`,
  `26d24a0`, `fb7a26e`), českou větou, co dělá, a „Zapnuto“. Na disku jsou
  `scripts\thumbfast\main.lua`, `scripts\sub-select\main.lua`, `scripts\reload\main.lua`;
  `script-opts\thumbfast.conf` má `mpv_path` (cesta ke `kaleido-mpv.exe`), `network=no` a
  `tone_mapping=mobius`; `script-opts\sub-select.json` existuje; `plugins.json` je má se `source`
  `bundled`. Vypnutí/zapnutí přepínačem jde i z klávesnice, šipky nahoru a dolů přecházejí mezi
  řádky.
- [ ] **Vypnout:** vypnout reload (nebo sub-select). Řádek ukáže „Vypnuto“ a větu „Vypnuto. Běží,
  dokud změny nepoužiješ.“, nahoře se přilepí lišta „Změny se projeví po restartu přehrávače, který
  pokračuje na stejném místě.“ s tlačítkem „Použít“ a složka je ve `scripts-disabled\`. Před
  Použít plugin ještě běží (vypnutý thumbfast pořád ukazuje náhledy).
- [ ] **Použít uprostřed filmu (Task 6):** přehrávat složku se třemi videi. Přejít na druhé, přetočit
  na asi 1:00, v Titulky načíst externí titulky ze souboru a vybrat je, vybrat jinou zvukovou stopu
  (soubor mkv se dvěma), hlasitost 40, ztlumit (`m`) a pozastavit. Na Moje pluginy vypnout plugin a
  stisknout Použít. Lišta říká „Restartuji přehrávač…“ a tlačítko „Používám…“ (nic se nedá měnit);
  asi za vteřinu lišta zmizí a fokus se vrátí na nadpis stránky. Zpět v přehrávači je to, jak to
  bylo: stejný playlist (druhá položka aktuální), pozice (o vteřinu dvě vedle), pauza, obě vybrané
  stopy včetně externích titulků, hlasitost 40 a ztlumení. **Sledovat dvě věci:**
  - V mini přehrávači (video hraje v rohu stránky) při Použít: nebliká, nebo se schová a ukáže znovu?
    Nové jádro nejdřív hlásí prázdný playlist a nečinnost, stránka to má brát jako restart, ne jako
    zastavení.
  - Neblikne při restartu nové okno mpv nebo černá plocha?
  Zapsat obojí.
- [ ] **Použít v nečekaném stavu (Review Focus 2):** Použít bez otevřeného videa (zůstane úvodní
  obrazovka, žádná chyba); Použít, když video dohrálo a stojí na konci (`keep-open`; zůstane tam,
  nezačne od začátku); Použít uprostřed odkazu (pokračuje; zvolená kvalita se zachová).
- [ ] **Zapnout zpět před Použít:** plugin vypnout a hned zapnout: lišta zmizí (není co použít) a nic
  se nenačte podruhé. Vypnutý a použitý plugin zase zapnout: načte se hned (u thumbfastu se
  náhledy vrátí bez restartu; zapsat, jestli hned, nebo až u dalšího souboru).
- [ ] **Odinstalovat do Koše (Task 5 a 7):** u thumbfastu Odinstalovat. V řádku se (ne ve
  vyskakovacím okně) objeví „Odinstalovat thumbfast? Soubory půjdou do Koše a tvoje nastavení
  pluginu zůstane.“ a „Essential vrátíš tlačítkem Obnovit essentials.“ s Potvrdit a Zrušit; fokus je
  na Zrušit, šipky mezi nimi přepínají, Esc otázku zavře. Potvrdit: řádek zmizí, složka
  `scripts\thumbfast` je v **Koši Windows** (jde z něj obnovit) a `script-opts\thumbfast.conf`
  zůstal. Plugin běží do Použít (náhledy jsou), lišta vybízí k Použít a dole je „Obnovit essentials“ s
  hintem „Vrátí odebrané essentials: thumbfast.“ Po restartu Kaleida se thumbfast znovu **nezkopíruje**.
- [ ] **Obnovit essentials:** stisknout: „Obnoveno: thumbfast.“, řádek je zpět se štítkem
  Essentials a „Zapnuto“, náhledy fungují a plugin se nenačetl podruhé (při najetí na lištu běží
  jeden pomocník `kaleido-mpv.exe`, ne dva).
- [ ] **Vlastní kopie v cestě (Task 5 a 7):** thumbfast znovu odinstalovat. Pak složku z Koše
  **obnovit ručně v Průzkumníku** (Obnovit na `scripts\thumbfast`). Moje pluginy ji ukáže jako
  ručně přidanou („Ručně přidaný“, bez verze) s větou „Tvoje vlastní kopie essentialu thumbfast.
  Kaleido pro ni nenastavuje žádné volby, takže náhledy a další chování závisí na tvém skriptu a
  nastavení.“ „Obnovit essentials“ (pořád se nabízí) **nic neobnoví** a stránka řekne proč:
  „Neobnoveno: thumbfast. Brání tomu ručně přidaný skript stejného jména. Odstraň ho nebo
  přejmenuj a Kaleido essential nainstaluje při dalším spuštění.“ Pak se tlačítko ztratí. Složku
  `scripts\thumbfast` přesunout mimo `scripts\` a Kaleido restartovat: thumbfast je zase Essentials.
- [ ] **Ruční kopie vedle essentialu (Task 5):** vedle `scripts\thumbfast\` dát `scripts\thumbfast.lua`
  (kopie skriptu), Kaleido restartovat. Oba řádky, `thumbfast` i `thumbfast.lua`, mají štítek
  „Duplicita“ s větou „Jiný zapnutý skript má stejné jméno. mpv jeden z nich očísluje (například
  thumbfast2) a spustí oba. Jeden z nich vypni.“ a řádek `thumbfast.lua` je ručně přidaný s větou o
  vlastní kopii. Zapsat, jestli náhledy fungují a jestli se nezdvojují. Vypnout vlastní kopii a
  Použít: Duplicita zmizí.
- [ ] **Kopie bez voleb Kaleida (Task 5):** essential odinstalovat (Koš), v `script-opts` smazat
  `thumbfast.conf`, dát do `scripts\` jen vlastní `thumbfast.lua` a Kaleido restartovat. Kaleido pro
  vlastní kopii nezapíše nic (volby spravuje jen u svého essentialu), takže má výchozí `mpv_path=mpv`.
  S tím se thumbfast na Windows nejdřív zeptá mpv na vlastnost `user-data/frontend/process-path`;
  Kaleido ji nenastavuje, takže může zkusit spustit `Kaleido.exe`, nebo nenajde žádné `mpv` a
  náhledy nebudou. Najet na lištu a zapsat, co se děje (náhledy chybí? druhé okno nebo proces
  `Kaleido.exe` navíc? karta chyby?). Potom vlastní kopii smazat a nechat Obnovit essentials, které
  `thumbfast.conf` zapíše znovu.
- [ ] **Vlastní `script-opts` v mpv.conf přebíjí Kaleido (rozhodnutí 2, Task 5):** do `mpv.conf`
  (mimo blok Kaleida) dát `script-opts=thumbfast-max_height=100` a Kaleido restartovat. Náhledy
  fungují dál (ostatní volby jsou Kaleidovy) a jsou nejvýš 100 px vysoké: tvoje hodnota vyhrává nad
  `script-opts\thumbfast.conf`, i nad tím, co nastavíš ve formuláři pluginu. Je to známé omezení
  (kompromis): nastavení pluginu v Moje pluginy čte jen soubor, takže hodnotu z `mpv.conf` neukáže.
  Řádek pak vrátit.
- [ ] **Ruční skript, uosc a ModernZ se štítkem (Task 3):** se zavřeným Kaleidem dát do `scripts\`
  `hello.lua` (`mp.msg.info("ahoj")`), složku `uosc\` s prázdným `main.lua` a `ModernZ.lua`
  (**jen prázdné zkušební soubory, ne skutečný uosc nebo ModernZ**, ty kreslí přes video). Po
  spuštění: `hello.lua` je „Ručně přidaný“, bez verze, „Zapnuto“; `uosc` a `ModernZ.lua` mají
  štítek „Nekompatibilní“ s větou „Tento plugin kreslí přes video vlastní rozhraní, které se
  střetává s ovládáním Kaleida. Nemusí fungovat správně.“ Kaleido je nevypne, jen upozorní. Soubor
  `.txt` nebo složka bez `main` se v seznamu neobjeví.
- [ ] **Vestavěné skripty mpv (Task 7):** do `scripts\` dát zkušební `stats.lua`, který v
  `file-loaded` zavolá `mp.msg.error("x")`. mpv ho očísluje (`stats2`, vestavěný `stats` je dřív), v
  seznamu je jako `stats.lua` a „Hlásí chyby: 1“ patří jemu, ne vestavěnému skriptu.
- [ ] **Plugin s chybou (Task 7 a 13):** do `scripts\` dát `chyba-start.lua`
  (`mp.msg.error("zkušební chyba při načtení")`) a `chyba-beh.lua`
  (`mp.register_event("file-loaded", function() mp.msg.error("zkušební chyba za běhu") end)`).
  - Po spuštění Kaleida: na Moje pluginy má `chyba-start.lua` štítek „Hlásí chyby: 1“, který po
    stisknutí rozbalí log pluginu („Chyby pluginu chyba-start.lua“) s řádkem chyby a po dalším
    stisknutí ho zase sbalí. **Karta se neukázala.** To je známé omezení: událost o první chybě
    pluginu se pošle jednou, ještě než stránka poslouchá, takže plugin, který chybuje už při
    startu jádra, má štítek a log, ale ne kartu.
  - Otevřít video: `chyba-beh.lua` chybuje až za běhu, a tak **karta přijde**: „Plugin chyba-beh.lua
    hlásí chyby“, „Dál běží. Kaleido sám nic nevypíná.“ a „Vypnout“. Vypnout: „chyba-beh.lua je
    vypnutý. Změna se projeví po Použít.“ a odkaz „Moje pluginy“ otevře stránku. Plugin běží až do
    Použít (štítek počítá dál), další chyba téhož pluginu v tomto běhu novou kartu nedělá.
- [ ] **Přilepená lišta při 150 % (Task 13):** Nastavení → Vzhled → Měřítko rozhraní 150 %, do
  `scripts\` dát tak deset prázdných skriptů (`a1.lua` … `a10.lua`), aby byl seznam dlouhý, a změnou
  přepínače vyvolat lištu „Použít“. Seznam odjet na konec: poslední řádek ani „Obnovit essentials“ se
  neschová pod lištu. Tab řádkem dolů posune řádek s fokusem pod lištu, ne za ni. Totéž v okně
  640×360.
- [ ] **Nastavení pluginu (Task 14):** u thumbfastu Nastavení: formulář s českými popisky („Největší výška
  náhledu (px)“, „Největší šířka náhledu (px)“, „Spustit pomocníka náhledů při otevření souboru“,
  „Hardwarové dekódování náhledů“) a hodnotami z `script-opts\thumbfast.conf`, jinak výchozími.
  Změnit výšku na 120: pod formulářem je věta „Běžící plugin čte své nastavení při spuštění, takže
  se změna projeví až po Použít.“ a nahoře lišta „Použít“. Po Použít jsou náhledy nejvýš 120 px
  vysoké; „Výchozí“ u pole hodnotu vrátí. `mpv_path`, `network` ani `tone_mapping` se v
  nabídce neobjeví (spravuje je Kaleido). Esc formulář zavře a fokus se vrátí na „Nastavení“.
  U `hello.lua` je místo formuláře seznam voleb s „Nová volba“: klíč `foo`, hodnota `bar` se zapíše
  do `script-opts\hello.conf`; klíč s mezerou se odmítne; hodnota napsaná do souboru ručně se po
  znovuotevření ukáže.
- [ ] **Kaleidovy volby se zapisují znovu (Task 5):** v `script-opts\thumbfast.conf` rozbít `mpv_path`
  a přidat `max_height=150`, potom Použít (nebo restart Kaleida): `mpv_path` je zase Kaleidova cesta,
  `max_height=150` zůstal a ostatní řádky a komentáře souboru taky.

### Essentials v praxi (Task 1, 2 a 5)

- [ ] **sub-select a `sub-select.json` (rozhodnutí 18):** `script-opts\sub-select.json` při češtině
  jako jazyce UI říká: zvuk česky → jen vynucené titulky, jinak žádné; jakýkoli jiný zvuk → titulky
  česky, potom anglicky. S videem, které Kaleido ještě nepřehrálo (jinak mpv obnoví uloženou volbu
  stop z `watch_later`): mkv s anglickým zvukem a českými i anglickými titulky se otevře s
  **českými** titulky vybranými v Titulky; mkv s českým zvukem a stopou forced vybere **jen
  forced**, bez ní **žádné titulky**. Pak soubor upravit na
  `[ { "alang": "*", "slang": ["eng", "en"] } ]`, Kaleido restartovat a otevřít další nepřehrané
  video s oběma jazyky: vybere se **anglická** stopa. Soubor smazat a restartovat: Kaleido ho před
  startem napíše znovu (sub-select bez něj vůbec nenaběhne). Upravený soubor Kaleido nikdy
  nepřepíše, ani po restartu a po Obnovit essentials. S angličtinou jako jazykem UI při prvním
  startu je v souboru angličtina místo češtiny.
- [ ] **reload (Ctrl+R):** u odkazu stisknout `Ctrl+R`: položka se načte znovu a pokračuje na
  stejné pozici (playlist se na okamžik změní, než se stará položka odebere; je to zamýšlené). Pak
  uprostřed odkazu vypnout síť a počkat, až přehrávání začne čekat na data (až se vyčerpá to, co
  bylo načteno předem), a nechat to 10 až 20 s: skript stream sám načte znovu. Po zapnutí sítě to
  jde dál od stejného místa. Zapsat, co jsi viděl a po jaké době.
- [ ] **Náhledy thumbfastu:** najetí na časovou osu u místního souboru ukáže náhled (M1), u
  odkazu ne (`network=no`, záměrně). Po vypnutí thumbfastu a Použít se ukazuje jen čas a po
  zapnutí náhledy zase.
- [ ] **HDR náhled po změně `vf` za běhu (Task 2):** se skutečným HDR10 videem. Do
  `%APPDATA%\Kaleido\input.conf` (mimo blok Kaleida) dát řádek `Alt+h vf toggle hflip` a Kaleido
  restartovat. Najet na časovou osu (spustí se pomocník náhledů), potom stisknout `Alt+h` a najet
  znovu: náhled je převrácený a **pořád tónově mapovaný**, ne šedý ani přepálený, stejný jako před
  tím. Druhé `Alt+h` ho vrátí. Zkusit s HDR ve Windows zapnutým i vypnutým. (Kdyby mpv hlásil, že
  filtr s hardwarovým dekódováním nejde použít, v Nastavení → Přehrávání dát Hardwarové dekódování
  na „Vypnuto (software)“.)

### Nastavení a diagnostika (Task 7, 17)

- [ ] **Čeština a angličtina:** nové texty Moje pluginy, Aktualizace, karet chyb streamů, záložky
  Kvalita a Přehrávání (Výchozí kvalita streamů, Cookies z prohlížeče) projít česky i anglicky:
  pravopis, jednotné názvy (Použít, Essentials, yt-dlp, Deno), nic nepřetéká ani se neořezává,
  čas „Zkontrolováno“ se tvoří v jazyce UI. Texty jsou nová práce, nikdo je zatím nečetl.
- [ ] **Přehrávání (Task 17):** „Výchozí kvalita streamů“ s volbami a hintem (viz Kvalita streamů)
  a „Cookies z prohlížeče“ (viz Cookies z prohlížeče). Změna kvality platí pro odkazy otevřené
  potom.
- [ ] **Aktualizace (Task 17):** sekce stojí před O aplikaci. yt-dlp a Deno mají každý verzi,
  „Zkontrolováno …“, stav a „Zkontrolovat teď“; mezi nimi je „Kanál yt-dlp“ (Stabilní, Nightly) s
  vysvětlením; pod nimi verze libmpv s větou, že se mění s vydáními Kaleida. Stav „Vyžaduje
  pozornost“ nese anglický důvod. Řádky nemají zástupné texty (kanál aplikace přijde s M4).
- [ ] **Hledání v nastavení:** „deno“ ukáže celou sekci Aktualizace (sedí jedna položka, kanál, a
  ukáže se celá; je to záměr). „yt-dlp“, „cookies“ a „kvalita“ najdou své položky.
- [ ] **O aplikaci:** verze yt-dlp a Deno v seznamu licencí jsou skutečné (viz Nástroje).
- [ ] **Diagnostika bez cest (Task 7, spec 10.8):** Zkopírovat diagnostiku, vložit do Poznámkového
  bloku. Řádky `yt-dlp:` a `Deno:` mají verzi (`-`, když nástroj chybí) a řádek `Plugins:` seznam
  `jméno verze (zdroj)`: třeba `thumbfast 0f711de (bundled)`, `hello.lua - (manual)`. **V těchto
  řádcích není žádná úplná cesta** (`C:\Users\…`, `%APPDATA%`) ani adresa odkazu, ani u ručně
  přidaných skriptů; zbytek textu má cesty zakryté jako v M1.

## Velký průchod testů

Všechny automatické testy M2 vznikly v tichém režimu a nikdy neběžely. Spustit je najednou, až
dohraješ, v pořadí z [README.md](../../README.md) (`cargo fmt --all --check`, `cargo clippy
--workspace --all-targets -- -D warnings`, `cargo test --workspace`, `npm run lint`, `npm test`,
`npm run build`, `npm run e2e:build`, `npm run e2e`). Nejdřív se podívat na tohle:

- **Napřed `cargo test -p kaleido-mpv a_vf_set_at_runtime -- --nocapture`.** Vypíše skutečný tvar
  seznamu `vf`, jak ho hlásí mpv (Task 2). Kdyby se lišil od předpokladu, mění se jen `LISTED` a
  `vf_list` v `crates/kaleido-mpv/src/thumbnail.rs`.
- `cargo test -p kaleido settings::mpv_conf:: settings::input_conf:: settings::lines::`: kód řádků
  se přestěhoval do `settings/lines.rs` (Task 4).
- Pořadí a jména skriptů v mpv a plugin zapnutý za běhu, který hned běží:
  `script_names_match_mpvs_clients` (scan.rs), `a_plugin_enabled_at_run_time_runs_at_once` (Task 3
  a 7).
- Jména z `BUILT_IN_CLIENTS` (names.rs) pro připnutou libmpv: skutečný `stats.lua` se musí jmenovat
  `stats2` (Task 7).
- `a_failed_move_restores_the_previous_version`: přejmenování složky odmítne soubor uvnitř, který je
  otevřený bez sdílení (Task 5).
- `sub_select_starts_with_kaleidos_preferences`: vybere českou stopu (Task 5).
- Restart jádra (Task 6): `sub-files` s uvozením `\;`, `playback-restart` v pauze a zničení a
  nové vytvoření skutečného okna gpu-next; k tomu `restart_resumes_the_playlist_where_it_was`.
- `changing_quality_keeps_the_playlist_and_the_position` (streams.rs, Task 12).
- `the_newest_firefox_fork_profile_wins`: případ shody (Task 11).
- `src/settings/SettingsPage.test.tsx`: jeho očekávání se v Task 17 upravovala rukou, takže když
  vitest selže, dívat se nejdřív tam.
- **Předem varovat:** tyto testy vkládají malé zástupné soubory do skutečného Koše Windows:
  `uninstalling_an_essential_remembers_it`, `every_script_has_a_name_of_its_own` a
  `the_recycle_bin_takes_files_and_folders`. Po průchodu je z Koše vysypej, nebo je tam nech.
- E2E krok Moje pluginy z tohoto úkolu (thumbfast jako Essentials, zapnutý) taky nikdy neběžel. Běží
  proti tvému `%APPDATA%\Kaleido`, takže pro něj nesmí být thumbfast odinstalovaný ani vypnutý (README).
