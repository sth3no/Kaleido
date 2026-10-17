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
  ani za horní okraj lišty okno nepřesune, klik na ně lištu jen zavře.
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
