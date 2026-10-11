# M0 – zpráva z ověřovacího prototypu

Spec: `docs/superpowers/specs/2026-10-11-kaleido-1.0-design.md`, kapitola 5.4.
libmpv: shinchiro `mpv-dev-x86_64-20261011-git-accb7b2821.7z` (mpv `accb7b2821`).

## Prostředí

| Položka | Hodnota |
|---|---|
| Windows (verze, build) | ⏳ |
| GPU | NVIDIA GeForce RTX 5060 Ti; AMD Radeon (integrovaná) |
| Monitory (rozlišení, DPI, HDR) | ⏳ |

## Výsledky

| # | Ověřit | Kritérium | Výsledek | Měření / pozorování | Rozhodnutí |
|---|---|---|---|---|---|
| 1 | průhledné WebView2 nad D3D11 podoknem | bez blikání při změně velikosti a přesunu, 60 fps | ⏳ | Auto: video se skládá pod průhledným UI jen s `wid` = hlavní okno (viz Další zjištění). Ruční: blikání při změně velikosti. | `wid` = hlavní okno, přesouvá se okno `mpv` |
| 2 | HDR | HDR10 se zapnutým i vypnutým HDR ve Windows, UI nerozbije HDR | ⏳ | | |
| 3 | přeposílání vstupu | klávesy s modifikátory, myš, kolečko; konzole; menu v obraze | ⏳ | Auto: 37 testů převodu kláves/myši, `click-target.lua` se načte a zaregistruje `MBTN_LEFT`. | |
| 4 | fullscreen a DPI | černá clona, přesun mezi monitory s různým DPI | ⏳ | Auto: pořadí kroků clony (3 testy). | |
| 5 | shader sklo | oblasti za běhu, ≤ 1 ms GPU ve 4K, sleduje animaci | ⏳ | Auto: libplacebo zaregistroval 3 průchody, shaderc 0 chyb; UI posílá oblasti (`count=3`) i během animace. | |
| 6 | mini přehrávač | podokno synchronně s animací UI | ⏳ | Auto: umístění okna podle třídy ověřeno testem se skutečnými okny. | |
| 7 | thumbfast | `kaleido-mpv.exe` + `thumbfast-render` v React bublině | ⏳ | Auto: e2e test `thumbfast_renders_through_kaleido_mpv` – thumbfast v libmpv spustí `kaleido-mpv`, pošle `thumbfast-render`, soubor `.bgra` má w·h·4 B (0,65 s). Ruční: bublina v UI. | |
| 8 | snímek obrazovky | bez rozmazaných oblastí skla | ⏳ | | |

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
- GDI obsah podoken se v průhledném okně Tauri neskládá vůbec (alfa 0). Vidět je jen obsah
  DXGI/DirectComposition.
- Riziko pro M1: spoléháme na název třídy okna `mpv`, což je interní detail upstreamu. Pokud se
  změní, `find_child` okno nenajde a mini přehrávač nebude umisťovat video (video zůstane na celém
  okně). Ošetřit testem v CI s libmpv.

## Závěr a doporučení pro M1
