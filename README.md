# Streamwall

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

The following hotkeys are available with the "control" webpage focused:

- **alt+[1...9]**: Listen to the numbered stream
- **alt+shift+[1...9]**: Toggle blur on the numbered stream
- **alt+s**: Select the currently focused stream box to be swapped
- **alt+c**: Activate [Streamdelay](https://github.com/chromakode/streamdelay) censor mode
- **alt+shift+c**: Deactivate [Streamdelay](https://github.com/chromakode/streamdelay) censor mode
