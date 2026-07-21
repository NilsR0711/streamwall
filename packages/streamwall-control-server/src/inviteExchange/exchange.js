// Client-side invite redemption. Served at `/invite-exchange.js` and loaded by
// `page.html` as a module script (which satisfies the strict
// `script-src 'self'` CSP). The invite secret lives in `location.hash`, which
// the browser never sends to the server, so this script reads it client-side,
// scrubs it from the address bar, and POSTs it to redeem the invite for a
// session cookie.
//
// The core logic is factored into `runInviteExchange` with its browser
// dependencies injected, so fragment parsing and the fetch success/error paths
// can be unit-tested under `node:test` without a DOM.

/**
 * Reads the invite token from `location.hash`, scrubs it from the address bar,
 * and exchanges it for a session cookie via POST. On success it navigates to
 * the app; otherwise it reports the failure through `setStatus`.
 *
 * @param {object} deps
 * @param {Location} deps.location - the page location (hash carries the token).
 * @param {History} deps.history - used to scrub the token from the URL.
 * @param {typeof fetch} deps.fetch - performs the redemption request.
 * @param {(text: string) => void} deps.setStatus - surfaces status/errors.
 * @returns {Promise<void>} resolves once the exchange attempt settles.
 */
export function runInviteExchange({ location, history, fetch, setStatus }) {
  const token = new URLSearchParams(location.hash.slice(1)).get('token')
  // Scrub the token from the address bar before doing anything else, so it
  // never lingers in history or a shared screen — even if it is missing.
  history.replaceState(null, '', location.pathname)
  if (!token) {
    setStatus('This invite link is missing its token.')
    return Promise.resolve()
  }
  return fetch(location.pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token }),
  })
    .then(function (res) {
      if (res.ok) {
        location.replace('/')
      } else {
        setStatus('This invite is invalid or has expired.')
      }
    })
    .catch(function () {
      setStatus('Could not reach the server. Please try again.')
    })
}

// Auto-run in the browser only. The guard keeps importing this module under
// `node:test` (to exercise `runInviteExchange`) from touching `window` or
// `document`.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const statusEl = document.querySelector('p')
  runInviteExchange({
    location: window.location,
    history: window.history,
    fetch: window.fetch.bind(window),
    setStatus: (text) => {
      if (statusEl) {
        statusEl.textContent = text
      }
    },
  })
}
