# Design: Per-Stream „contain"-Fit (Video ohne Crop einpassen)

**Issue:** [#13 – Size video to contain (instead of cover) grid space](https://github.com/chromakode/streamwall/issues/13)
**Datum:** 2026-07-04

## Problem

Videos werden aktuell mit `object-fit: cover` gerendert (siehe
`packages/streamwall/src/preload/mediaPreload.ts`, `VIDEO_OVERRIDE_STYLE`). Das
füllt die zugewiesene(n) Grid-Zelle(n) vollständig, beschneidet aber Quellen mit
abweichendem Seitenverhältnis. Nutzer wünschen sich die Möglichkeit, eine Quelle
**ohne Beschneidung** einzupassen (`object-fit: contain`) — auf Kosten von
schwarzen Rändern bei ungewöhnlich geformten Quellen.

## Ziel

Eine **pro Stream** wählbare Option, die zwischen `cover` (Standard) und
`contain` umschaltet. Standardmäßig **nicht** aktiv — das bestehende Verhalten
bleibt unverändert.

## Nicht-Ziele (YAGNI)

- Kein globaler Toggle für alle Streams gleichzeitig.
- Keine weiteren `object-fit`-Modi (`fill`, `scale-down`, …) — der Typ ist aber
  erweiterbar gewählt.
- Keine Persistenz über Neustarts hinaus (siehe „Persistenz").

## Architektur-Ansatz

Die Option folgt **exakt dem etablierten `rotation`-Muster**. `rotation` ist
bereits eine per-Stream-`ContentDisplayOption`, die diesen Weg nimmt:

```
Control-UI (Toggle-Button)
  → ControlCommand  → Control-Server → Main-Prozess (onCommand)
  → overlayStreamData.update(url, { fit })
  → combineDataSources → updateState → StreamWindow.onState
  → getDisplayOptions() → View-State-Machine (OPTIONS-Event)
  → IPC 'options' → mediaPreload (FitController) → CSS-Klasse am <video>
```

Es wird ein **dedizierter Command** `set-stream-fit` eingeführt (analog zu
`rotate-stream`), kein generischer „set-display-options"-Command. Begründung:
minimal-invasiv, konsistent mit dem vorhandenen Muster; eine generische
Umstellung lohnt sich erst bei einer dritten Option.

## Datenmodell

Neue Property auf `ContentDisplayOptions`
(`packages/streamwall-shared/src/types.ts`):

```typescript
export interface ContentDisplayOptions {
  rotation?: number
  fit?: 'cover' | 'contain'
}
```

Modellierung als String-Union (nicht `boolean`), weil sie direkt dem
CSS-`object-fit`-Wert entspricht, selbstdokumentierend und erweiterbar ist.
`undefined` ⇒ Default `cover`.

Neuer `ControlCommand`:

```typescript
| { type: 'set-stream-fit'; url: string; fit: 'cover' | 'contain' }
```

## Komponenten & Änderungen

### 1. `packages/streamwall-shared/src/types.ts`
- `fit?: 'cover' | 'contain'` zu `ContentDisplayOptions` hinzufügen.
- `set-stream-fit`-Variante zur `ControlCommand`-Union hinzufügen.

### 2. `packages/streamwall-shared/src/roles.ts`
- `'set-stream-fit'` in `operatorActions` aufnehmen (analog zu `'rotate-stream'`).
  Dadurch dürfen `local`, `admin`, `operator` die Option schalten. `StreamwallAction`
  erweitert sich automatisch über den `typeof`-Ausdruck.

### 3. `packages/streamwall-control-ui/src/index.tsx`
- Neuer Handler `handleFitStream(streamId)` analog zu `handleRotateStream`:
  liest den aktuellen `fit` des Streams, sendet `set-stream-fit` mit dem
  umgeschalteten Wert (`contain` ⇄ `cover`).
- `GridControls` erhält den aktuellen `fit`-Wert (bzw. ein `isContain`-Flag) und
  einen `onFitView`-Callback als Props — dieselbe Verdrahtung wie `onRotateView`.
- Neuer Icon-Toggle-Button neben dem Rotate-Button, sichtbar unter
  `roleCan(role, 'set-stream-fit')`. Aktiv-Zustand (`isActive`) wenn
  `fit === 'contain'` — nach dem Muster des vorhandenen Blur/Swap-Toggles.
  Icon: ein „einpassen"-Symbol aus `react-icons/fa` (z. B. `FaCompressArrowsAlt`
  oder `FaExpand`; finale Wahl bei der Umsetzung).

### 4. `packages/streamwall/src/main/index.ts`
- `onCommand`-Zweig für `set-stream-fit`:
  ```typescript
  } else if (msg.type === 'set-stream-fit') {
    overlayStreamData.update(msg.url, { fit: msg.fit })
  }
  ```

### 5. `packages/streamwall/src/main/StreamWindow.ts`
- `getDisplayOptions()` extrahiert zusätzlich `fit`:
  ```typescript
  const { rotation, fit } = stream
  return { rotation, fit }
  ```

### 6. `packages/streamwall/src/preload/mediaPreload.ts`
- Default `object-fit: cover` bleibt auf `video`. Neue Klasse im
  `VIDEO_OVERRIDE_STYLE`:
  ```css
  video.__contain__ { object-fit: contain !important; }
  ```
- Kleiner `FitController` (analog `RotationController`), der die Klasse
  `__contain__` je nach `fit`-Wert am Video-Element setzt/entfernt.
- `updateOptions()` ruft `fitController.set(options.fit)` auf.
- `FitController` wird — wie `RotationController` — nur für `content.kind === 'video'`
  instanziiert.

## Persistenz

Wie `rotation` läuft die Option über `overlayStreamData` (In-Memory-Overlay,
**nicht** an die Storage-Schicht gebunden). Der Wert überlebt keinen
App-Neustart und fällt dann auf `cover` zurück. Das ist bewusst konsistent mit
dem bestehenden Rotations-Verhalten; eine Persistenz wäre eine separate,
breitere Änderung (beträfe auch `rotation`).

## Zusammenspiel mit Rotation

Bei 90°/270°-Rotation positioniert das bestehende CSS das Video mit
vertauschten Dimensionen und wendet ein `transform` an. `object-fit` wirkt auf
den Videoinhalt **innerhalb** der Element-Box (vor dem `transform`), sollte also
korrekt mit der Rotation kombinierbar sein. Wird beim Testen mit einem gedrehten
Stream verifiziert.

## Fehlerbehandlung

- Ungültige `fit`-Werte sind durch die TypeScript-String-Union ausgeschlossen.
  Der `FitController` behandelt jeden Wert ≠ `'contain'` (inkl. `undefined`) als
  `cover` (Klasse entfernen) — fail-safe zum bisherigen Verhalten.

## Testing / Verifikation

Manuell (kein automatisiertes UI-Test-Harness im Projekt vorhanden):
1. Streamwall starten, einen Stream mit abweichendem Seitenverhältnis auf mehrere
   Zellen legen.
2. Toggle-Button in der Control-UI klicken → Video passt sich ohne Crop ein
   (schwarze Ränder), Button zeigt Aktiv-Zustand.
3. Erneut klicken → zurück auf `cover` (vollflächig, beschnitten).
4. Gedrehten Stream (90°) mit `contain` prüfen — korrekte, unbeschnittene
   Darstellung.
5. `tsc --noEmit` über die betroffenen Pakete läuft sauber durch.
