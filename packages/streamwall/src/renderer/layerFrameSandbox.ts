/**
 * Sandbox policy for the `<iframe>` elements that host `overlay` and
 * `background` custom streams inside the wall's layer renderers
 * (see `overlay.tsx` and `background.tsx`).
 *
 * Trust model
 * -----------
 * Overlay/background URLs are supplied by control-UI operators as custom
 * streams (see `CreateCustomStreamInput` in `streamwall-control-ui`). Anyone
 * with control access can point a `background`/`overlay` tile at an arbitrary
 * URL, so the framed document must be treated as untrusted and confined.
 *
 * These frames intentionally grant ONLY `allow-scripts`:
 *
 *   - Scripts are required so widget-style overlays (scoreboards, alerts,
 *     embedded players, …) can render.
 *   - `allow-same-origin` is deliberately omitted. Pairing `allow-scripts`
 *     with `allow-same-origin` is a documented no-op: a same-origin document
 *     can reach its own frame element and remove the `sandbox` attribute,
 *     which is no more secure than not sandboxing at all. Without
 *     `allow-same-origin` the framed document runs in an opaque origin — it
 *     cannot strip its own sandbox, cannot reach the layer renderer's
 *     privileged `streamwallLayer` bridge, and has no access to the app's
 *     cookies or storage.
 *   - Top-level navigation, popups, forms, modals and downloads stay blocked
 *     because their `allow-*` tokens are not present.
 *
 * Trade-off: because the frame runs in an opaque origin, an overlay/background
 * document cannot read or write its own origin's cookies or local storage.
 * Widgets that depend on same-origin persistence are unsupported by design;
 * that is the cost of an effective sandbox.
 */
export const LAYER_FRAME_SANDBOX = 'allow-scripts'
