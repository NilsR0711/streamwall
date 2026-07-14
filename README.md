# Streamwall

[![CI](https://github.com/NilsR0711/streamwall/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NilsR0711/streamwall/actions/workflows/ci.yml)
[![CodeQL](https://github.com/NilsR0711/streamwall/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/NilsR0711/streamwall/actions/workflows/codeql.yml)

Streamwall makes it easy to compose multiple livestreams into a mosaic, with source attributions and audio control.

It's a cross-platform desktop app built with Electron and TypeScript. Streams are arranged in a grid you can rearrange on the fly, audio is switchable per tile, and the whole wall runs locally with an optional control server for remote operation.

## How it works

Under the hood, think of Streamwall as a specialized web browser for mosaicing video streams. It uses [Electron](https://www.electronjs.org) to create a grid of web browser views, loading the specified webpages into them. Once the page loads, Streamwall finds the `<video>` tag and reformats the page so that the video fills the space. This works for a wide variety of web pages without specialized scrapers.

## Configuration

Streamwall has a growing number of configuration options. To get a summary run:

```
npm run start:app -- --help
```

For long-term installations, it's recommended to put your options into a
configuration file. Development runs use the root `start:app` script:

```
npm run start:app -- --config="../streamwall.toml"
```

Packaged app builds also auto-load `config.toml` from Electron's user data
directory before applying any `--config` file or CLI flags:

| OS      | Default user data config path                          |
| ------- | ------------------------------------------------------ |
| macOS   | `~/Library/Application Support/Streamwall/config.toml` |
| Windows | `%APPDATA%\\Streamwall\\config.toml`                   |
| Linux   | `~/.config/Streamwall/config.toml`                     |

Configuration precedence is:

1. user data `config.toml`
2. `--config` file
3. CLI flags

See `example.config.toml` for an example.

## Remote control server

For multi-operator setups, `streamwall-control-server` lets you control the
wall from a web browser instead of (or in addition to) the local "control"
webpage. Build the web client and start the server with:

```
npm run start:server
```

On first run it prints two links to the console:

```
🔌 Streamwall uplink (shown once — save it now): ws://localhost:3000/streamwall/<id>/ws?token=<secret>
🔑 Admin invite: http://localhost:3000/invite/<id>#token=<secret>
```

- **Uplink endpoint** connects this app to the server. Pass it via
  `--control.endpoint` on the command line, or set `endpoint` under
  `[control]` in your config file (see `example.config.toml`). The endpoint
  must use `wss://` (or `ws://` to a loopback host) — Streamwall refuses to
  connect over an insecure remote endpoint.
- **Admin invite** opens the web control client and signs you in as an admin.
  From there, admins can create invite links for the other roles.

Three roles are available: **admin** (full control, including managing
invites), **operator** (control the grid and streams), and **monitor**
(blur/censor only, read-only otherwise).

See
[`packages/streamwall-control-server/README.md`](packages/streamwall-control-server/README.md)
for environment variable configuration (hostname/port, storage location, rate
limits).

## Data sources

Streamwall can load stream data from both JSON APIs and TOML files. Data sources can be specified in a config file (see `example.config.toml` for an example) or the command line:

```
npm run start:app -- --data.json-url="https://your-site/api/streams.json" --data.toml-file="./streams.toml"
```

## Security: overlay and background streams

Streams added with the `overlay` or `background` kind are loaded as live web
pages layered over the whole wall, inside sandboxed `<iframe>`s. Anyone with
control access can point these tiles at an arbitrary URL, so treat their
contents as untrusted.

These frames run with `sandbox="allow-scripts"` only. Scripts are allowed so
widget-style overlays (scoreboards, alerts, players) still work, but the page
runs in an opaque origin: it cannot escape its sandbox, reach Streamwall's
internal APIs, or read the app's cookies and storage. Top-level navigation,
popups, forms and downloads stay blocked.

`allow-same-origin` is intentionally not granted — combined with `allow-scripts`
it would let a page remove its own sandbox attribute and defeat the protection.
As a result, overlay/background pages have no access to their own origin's
cookies or local storage; widgets that depend on same-origin persistence are not
supported by design.

## Hotkeys

The following hotkeys are available with a "control" webpage focused, whether
that's the Electron control UI or the standalone web control client:

- **alt+[1...9,0,q,w,e,r,t,y,u,i,o,p]**: Listen to the corresponding stream
  (20 grid positions, in that key order)
- **alt+shift+[1...9,0,q,w,e,r,t,y,u,i,o,p]**: Toggle blur on the
  corresponding stream
- **alt+s**: Select the currently focused stream box to be swapped
- **alt+c**: Activate [Streamdelay](https://github.com/chromakode/streamdelay) censor mode
- **alt+shift+c**: Deactivate [Streamdelay](https://github.com/chromakode/streamdelay) censor mode

The overlay window has its own hotkey:

- **ctrl+shift+i**: Open devtools for the overlay
