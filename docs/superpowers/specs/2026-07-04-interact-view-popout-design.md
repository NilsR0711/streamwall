# Interact-Popout pro Feed (Issue #15)

## Problem

Streamwall zeigt fremde Livestreams (YouTube, Facebook, Twitch, …) in einem Grid.
`mediaPreload.ts` reißt bei Video-/Audio-Feeds das nackte `<video>`-Element aus der
Seite und blendet via `VIDEO_OVERRIDE_STYLE` (`* { display: none }`) **alle** übrigen
Seiten-Elemente aus — inklusive der nativen Player-Bedienelemente (z. B. das
YouTube-Zahnrad zur Qualitätswahl). Dadurch kann der Operator die Qualität/Bitrate
eines laufenden Feeds nicht mehr steuern. Viele Feeds pushen dauerhaft 1080p mit hoher
Bitrate, obwohl das im Grid nicht nötig ist.

Issue [#15](https://github.com/streamwall/streamwall/issues/15) fordert die Fähigkeit,
Views „herauszupoppen" und mit ihnen zu interagieren, um u. a. die Bitrate pro Feed zu
senken.

## Entscheidung

**Interact-Popout (OBS-artig).** Ein neuer Per-View-Button im „cog wheel" öffnet den
Feed in einem separaten, interaktiven Fenster mit **nativen** Player-Bedienelementen.
Der Operator senkt die Qualität dort selbst (echtes YouTube-/Facebook-Zahnrad).

Verworfen:
- **Programmatische Qualitätssteuerung** (plattformspezifisches JS): fragil, bricht bei
  jedem Player-Update, hoher Wartungsaufwand — unvereinbar mit „produktionsreif/wartbar".
- **Nur HLS-Level-Auswahl**: trifft den eigentlichen Use-Case (YouTube/Facebook) nicht,
  da diese nicht über `hls.js` laufen.

## Funktionsweise

Seit den Sicherheits-Fixes #94/#97 hat **jede Stream-View ihre eigene, isolierte
ephemere Session** (`view.webContents.session`, Partition `view-N`) — Cookies,
`localStorage` und Cache werden weder zwischen Views noch mit dem Browse-Fenster oder
der Platte geteilt.

Damit eine im Interact-Fenster vorgenommene Qualitätsänderung den Wall-Feed erreicht,
wird das Interact-Fenster **gegen genau die Session der Ziel-View** erzeugt (Electron
`webPreferences.session`). So teilen sich Interact-Fenster und View `localStorage`/
Cookies (z. B. YouTube `yt-player-quality`, Twitch `video-quality`). Beim Schließen des
Interact-Fensters wird die zugehörige Wall-View **automatisch neu geladen** und übernimmt
die gesenkte Qualität. Die Isolation zwischen den Views bleibt dabei erhalten — geteilt
wird ausschließlich die eine Ziel-View-Session.

## Architektur

Bestehender Datenfluss: Control-UI-Button → `ControlCommand` → `onCommand` (main) →
`StreamWindow`. Rollen-Gating über `roles.ts`/`roleCan`.

1. **`ControlCommand`** um `{ type: 'interact-view'; viewIdx: number }` erweitern
   (`streamwall-shared/src/types.ts`). View-gebunden (nicht nur URL wie `browse`), damit
   der Auto-Reload die richtige View trifft.
2. **`InteractWindow<Session>`** (neu, `streamwall/src/main/InteractWindow.ts`): kapselt
   den Fenster-Lifecycle.
   - `open(target, onApply)`: öffnet/wiederverwendet ein Fenster für `target.session`.
     Da jede View eine andere isolierte Session hat (bei Fenster-Erzeugung gebunden),
     wird beim Wechsel auf eine andere View das Fenster **ersetzt** und die vorherige
     View via `onApply` neu geladen. Beim Schließen wird die aktuelle View neu geladen.
   - Die `BrowserWindow`-Factory ist **injizierbar** und generisch über den Session-Typ,
     sodass die Klasse ohne echtes Electron unit-testbar ist.
3. **`onCommand`-Handler** (`streamwall/src/main/index.ts`): löst zur `viewIdx` die
   `content.url`, das Label und die `session` über `StreamWindow` auf, validiert die URL
   (`await ensureValidURL`, SSRF-Schutz), erzeugt das Interact-Fenster gegen die
   View-Session (`webPreferences.session`) und registriert `reloadView(viewIdx)` als
   `onApply`.
4. **`StreamWindow`**: neue Methoden `getViewContent(viewIdx)` und `getViewSession(viewIdx)`.
5. **Control-UI** (`streamwall-control-ui/src/index.tsx`): Zahnrad-Button (`FaCog`) im
   Per-View-`StyledGridButtons`, immer sichtbar (nicht nur Debug-Modus), gated über
   `roleCan(role, 'interact-view')`.
6. **Rollen** (`streamwall-shared/src/roles.ts`): `interact-view` als **operator**-Aktion.

`browse` (admin, generische URL, eigene `BROWSE_PARTITION`) bleibt unverändert.

## Tests

Der Node.js-Test-Runner (`node --experimental-strip-types --test`, bestehende Konvention):

- **`roles`**: `interact-view` ist für `operator`, `admin`, `local` erlaubt, nicht für
  `monitor`; bestehende Berechtigungen unverändert.
- **`InteractWindow`**: öffnet Fenster gegen die Ziel-Session mit korrekter URL/Titel;
  wiederverwendet das Fenster bei gleicher Session; ersetzt es bei Session-Wechsel und
  lädt die vorherige View neu; lädt beim Schließen die aktuelle View neu; wendet jede
  View genau einmal an (kein Doppel-Reload über den asynchronen `closed`-Event). Getestet
  mit einer gefakten Fenster-Factory (EventEmitter).

Electron-spezifische UI-/Integrationsdetails werden manuell beim App-Start verifiziert.

## Grenzen (bewusst, dokumentiert)

- Qualitätsübernahme ist **best effort** und plattformabhängig: zuverlässig für
  YouTube/Twitch (localStorage-Präferenz), unsicherer für Facebook. Rohe `.m3u8`-Feeds
  haben kein natives Zahnrad und werden vom Feature nicht abgedeckt.
- Der Reload verursacht eine kurze Unterbrechung des betroffenen Feeds — bewusster
  Trade-off gegen fragile Live-Manipulation der laufenden View.
