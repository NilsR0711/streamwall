// Same-document channel between mediaPreload.ts and the bundled HLS player
// page (renderer/playHLS.ts), used to stop segment fetching for a parked view
// rather than only pausing its <video> (issue #384).
//
// These must be dispatched on `document`, not `window`: under
// contextIsolation the preload's isolated world has its own `window` object,
// so a window-dispatched event never reaches the page's own listeners, while
// DOM nodes -- `document` included -- are shared between the worlds.
//
// This file deliberately carries constants only. playHLS.ts is renderer
// bundle code and must not pull in mediaPreload.ts's `electron` imports, so
// the names cannot simply live there alongside the IPC handlers.
export const MEDIA_PAUSE_EVENT = 'streamwall:media-pause'
export const MEDIA_RESUME_EVENT = 'streamwall:media-resume'
