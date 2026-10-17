# M0: místní instalace a otevírání videí z Windows

Samostatný build má UI uvnitř aplikace a nepotřebuje Vite ani npm při spuštění.
Instaluje se pro aktuálního uživatele do `%LOCALAPPDATA%\Programs\Kaleido-M0\`.

## Ověřený postup (2026-10-16)

- **Files:** video → pravé tlačítko → **Send to → Kaleido**.
- **Průzkumník s místním Nilesoft menu:** video → pravé tlačítko →
  **More options → Send to → Kaleido**. Ve standardním klasickém menu je přímo **Odeslat**.

Obě cesty byly skutečně proklikány přes Computer Use. Files spustil samostatnou aplikaci
s vybraným videem; Průzkumník předal soubor `Žluťoučký kůň (zkouška).mkv` do stejného
okna. Původní výchozí přehrávače se nemění.
V místním Nilesoft menu se při opakování v menším okně jednou ukázala neúplná nabídka
Send to. Po maximalizaci byla kompletní a otevření přes Kaleido znovu prošlo.

**Otevřít v programu / Open with stále není ověřená funkční cesta na tomto PC:**
Windows registraci enumeruje, ale jeho skutečný moderní výběr Kaleido nenabízí.
Totéž platí pro přímý statický verb „Přehrát v Kaleidu“, který v prohlédnutých nabídkách chybí.
Pro přehrání z obou správců souborů používej výše ověřenou nabídku **Send to**.

## Sestavení a registrace

Z kořene worktree:

```powershell
cd prototype
npm run tauri build -- --no-bundle
cd ..
cargo build --release -p kaleido-mpv
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local-prototype.ps1
```

Před aktualizací instalace zavři Kaleido. Skript zkopíruje aplikaci, libmpv, helper pro
náhledy a oba skripty do vlastní instalační složky. Registruje 42 video přípon v HKCU:

- `Applications\Kaleido.exe` a `SupportedTypes` pro „Otevřít v programu“.
- `Kaleido.M0.Video` s názvem, vydavatelem a ikonou aplikace; `OpenWithProgids` u přípon
  v `Software\Classes` i `Explorer\FileExts`.
- `Capabilities` a `RegisteredApplications` pro systémové Výchozí aplikace.
- „Přehrát v Kaleidu“ jako statickou akci s filtrem na podporované video přípony.
- Zástupce „Kaleido M0“ v nabídce Start.
- Zástupce „Kaleido“ ve standardní uživatelské nabídce **Odeslat / Send to**.

Stávající výchozí aplikace a klíče `UserChoice` se nemění. Skript po zápisu synchronně
oznamuje změnu asociací shellu (`SHCNE_ASSOCCHANGED`, `SHCNF_FLUSH`). Kontroluje vlastnictví
svých registračních klíčů a obou zástupců; cizí instalaci stejného názvu nepřepíše.
Při aktualizaci znovu vytvoří zástupce a oznámí shellu i změnu jejich cest.

Soubory se předávají jako samostatné argumenty, včetně mezer a diakritiky. Druhé spuštění
předá soubor běžící instanci a obnoví její okno. Požadavky přijaté při startu čekají,
dokud se UI nepřihlásí k událostem přehrávače. Více souborů v jednom spuštění vytvoří playlist.
Toto je integrace prototypu M0; plný instalátor a další integrace patří do M4.
Nově otevřený soubor se začne přehrávat také tehdy, když předchozí video bylo v pauze nebo
dohrálo do konce. Stejné chování používá dialog Otevřít v přehrávači.

## Odebrání registrace

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local-prototype.ps1 -Unregister
```

Odstraní jen vlastní registrace a zástupce; soubory aplikace zůstanou na disku.

## Kontrola

- Otevřít video přes **Send to → Kaleido** v obou správcích souborů bez vývojového serveru.
- Otevřít druhé video; má se přehrát ve stejném okně.
- Otevřít nové video z pauzy nebo po dohrání; má se samo rozběhnout.
- Ověřit cestu s mezerami a diakritikou.
- Ověřit, že Windows enumeruje Kaleido mezi doporučenými handlery pro video.
- Ověřit, že původní výchozí aplikace u videí zůstala zachována.

Reference: [registrace aplikací ve Windows](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration),
[Default Programs](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs),
[Tauri Single Instance](https://v2.tauri.app/plugin/single-instance/).
