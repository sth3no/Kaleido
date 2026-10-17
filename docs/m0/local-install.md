# M0: místní instalace a otevírání videí z Windows

Samostatný build má UI uvnitř aplikace a nepotřebuje Vite ani npm při spuštění.
Instaluje se pro aktuálního uživatele do `%LOCALAPPDATA%\Programs\Kaleido-M0\`.
Podklad: výzkum „Kaleido — Open with, asociace souborů a výchozí přehrávač“ (AFFiNE,
2026-10-17) a jeho ověření na tomto PC v [report.md](report.md) (sekce Open with, 2026-10-17).

## Co funguje (ověřeno 2026-10-17)

| Cesta | Stav | Jak ověřeno |
|---|---|---|
| Klasické menu → **Přehrát v Kaleidu** | funguje pro všechny přípony | menu sestavené samotným Windows (`scripts/diagnose-associations.ps1`, sekce 7) pro `.mkv`, `.mp4`, `.y4m` |
| Podnabídka **Otevřít v programu ›** (Průzkumník, panel Files) | Kaleido v ní je | objekt `OpenWithMenu`, který používá Průzkumník i Files (sekce 5) |
| **Odeslat / Send to → Kaleido** | funguje | 2026-10-16 proklikáno v Průzkumníku i ve Files |
| Dialog **Vybrat aplikaci** (OpenWith.exe) | Kaleido chybí, zřejmě do nového přihlášení | celý den 2026-10-17 nenabízel nic, co se zapsalo po přihlášení (report.md, sekce Open with) |
| Výchozí přehrávač | volí uživatel ve Windows | po novém přihlášení v dialogu nebo přes `-ChooseDefault`; výsledek přečte diagnostika (sekce 3) |

### Jak to zprovoznit (jednou, u počítače)

1. Odhlásit se a znovu přihlásit (nebo restartovat). Registraci už neměnit.
2. Pravé tlačítko na video → **Otevřít v programu → Vybrat jinou aplikaci** → **Kaleido** →
   **Vždy**. Nebo `scripts/install-local-prototype.ps1 -ChooseDefault` a vybrat Kaleido v Nastavení.
3. Kontrola: `scripts/diagnose-associations.ps1` (sekce 3) ukáže `Kaleido.M0.Video` a dvojklik
   otevře Kaleido.

Otevírání souborů z registrovaného příkazu (`"Kaleido.exe" -- "%1"`) i ze Send to prošlo
za studena i do běžící instance: diakritika, mezery, `%`, `&`, `#`, emoji, název začínající
pomlčkou za `--`, relativní cesta z jiného pracovního adresáře, dva soubory najednou
(playlist) a tři téměř současná otevření (jedna instance). Po zavření nezůstane Kaleido
ani `kaleido-mpv`.

Dvojklik na `.mkv` na tomto PC nevede nikam: `UserChoice` ukazuje na odinstalovanou AppX
aplikaci, takže se Windows zeptá. Kaleido to nemění; výchozí aplikaci vyber přes `-ChooseDefault`.

## Sestavení a registrace

Z kořene worktree:

```powershell
cd prototype
npm run tauri build -- --no-bundle
cd ..
cargo build --release -p kaleido-mpv
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local-prototype.ps1
```

`-BuildDir <složka>` vezme `kaleido-proto.exe` a `kaleido-mpv.exe` z jiného buildu (např.
z jiného worktree). Skript odmítne pokračovat, když Kaleido nebo `kaleido-mpv` z instalační
složky běží, nebo když stejná jména patří jinému programu.

Registruje 41 video přípon, jen v HKCU a jen jako **schopnost** otevírat soubory:

- `Applications\Kaleido.exe` (název, ikona, příkaz) a `SupportedTypes`.
- ProgID `Kaleido.M0.Video` s ikonou, metadaty `Application` a výchozí akcí „Přehrát“;
  `AllowSilentDefaultTakeOver`, aby Kaleido zůstalo volbou v „Otevřít v programu“, ale Windows
  ho samo nedosadilo jako výchozí.
- `Classes\<přípona>\OpenWithProgids\Kaleido.M0.Video` (dokumentovaná cesta pro alternativní
  aplikace).
- `Capabilities` a `RegisteredApplications\Kaleido` pro Výchozí aplikace.
- „Přehrát v Kaleidu“ jako doplňkovou akci v `SystemFileAssociations\<přípona>\shell`, takže je
  v klasickém menu i u přípon, které otevírá jiná aplikace.
- `App Paths\Kaleido.exe`, zástupce „Kaleido M0“ v nabídce Start a „Kaleido“ v **Odeslat**.

Skript **nikdy** nezapisuje ani nemaže `UserChoice`, nepočítá hash, neobchází UCPD, nemění
výchozí hodnotu přípony a nezapisuje do `Explorer\FileExts` (historie Windows). Hodnoty
`Kaleido.M0.Video`, které tam zapsaly starší verze skriptu, při instalaci odstraní, a nic jiného.
Přípona `.mod` (zároveň moduly Go a trackerová hudba, ve spec 8.12 není) se už neregistruje.
Po zápisu oznamuje změnu asociací shellu (`SHCNE_ASSOCCHANGED`, `SHCNF_FLUSH`).

## Výchozí přehrávač

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local-prototype.ps1 -ChooseDefault
```

Otevře `ms-settings:defaultapps?registeredAppUser=Kaleido`, stránku Kaleida ve Výchozích
aplikacích. Výběr udělá uživatel ve Windows; skript neohlásí úspěch, dokud ho neověří
diagnostika (sekce 3, `QueryCurrentDefault`).

## Diagnostika

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/diagnose-associations.ps1
```

Jen čte: uložené registrace v HKCU i HKLM, příkaz ProgID přes `AssocQueryString`, skutečné
výchozí aplikace (`QueryCurrentDefault`), `SHAssocEnumHandlers`, podnabídku „Otevřít
v programu“ a klasické menu. `-PickerDialog` navíc zkusí otevřít dialog „Vybrat aplikaci“,
přečte ho přes UI Automation a zavře bez výběru; z procesu bez vlastního okna popředí ho ale
Windows většinou nezobrazí.

## Odebrání registrace

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local-prototype.ps1 -Unregister
```

Odstraní jen položky, které stále ukazují na tuto instalaci (u cizích jen varuje), a prázdné
klíče, které po nich zůstanou. Soubory aplikace a výchozí aplikace zvolené ve Windows nechá.
Ověřeno snímky registru před a po: `UserChoice` ani hodnoty jiných programů se nezměnily
a po odebrání nezůstala žádná položka Kaleida.

Reference: [registrace aplikací ve Windows](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration),
[Default Programs](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs),
[Tauri Single Instance](https://v2.tauri.app/plugin/single-instance/); zdroje W1–W30 a T1–T13
v reportu z AFFiNE.
