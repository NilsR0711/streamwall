# Changelog

All notable changes to Streamwall are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Only the Electron app is distributed (via [GitHub Releases](https://github.com/NilsR0711/streamwall/releases));
no workspace is published to npm. The release line is driven by
`packages/streamwall/package.json` — see
[CONTRIBUTING.md](CONTRIBUTING.md#cutting-a-release) for how versions and this
changelog are kept in step.

## [Unreleased]

### Added

- Consent-gated update downloads with a determinate progress indicator (#454).
- In-app update notification with an install-and-restart flow (#434).
- Update notifications for Linux users via GitHub Releases (#443).
- Control server reports its own version and surfaces new releases (#430); the
  control UI shows the server version and an update notice to admins (#444).
- Stop HLS segment loading for parked views to save bandwidth (#424).
- Weekly cross-platform packaging workflow that runs `electron-forge make`, so
  maker regressions surface before a release instead of during one (#425).

### Changed

- The Twitch chat bot uses the maintained `@twurple` libraries instead of the
  deprecated `dank-twitch-irc` (#406). **Breaking:** `twitch.username` is
  replaced by `twitch.client-id` (the client ID of a Twitch application — the
  bot account is derived from the token), and setting `twitch.color` now needs
  the `user:manage:chat_color` scope on the token; without it the bot keeps
  reading and posting messages and only logs a warning.
- Release version bumps are automated across the release-tracking workspace
  manifests via `npm run release:version` (#448).
- Windows releases ship an NSIS installer instead of Squirrel.Windows (#432).
  Installs from v0.9.1 or older cannot see newer releases and must be
  reinstalled once by hand — README and the release-notes checklist in
  CONTRIBUTING now spell out the steps (#452).

### Fixed

- Control server registers its `onClose` hook before `app.listen()` so shutdown
  cleanup runs reliably (#449).
- IPC command errors are returned to the `CommandErrorBanner` instead of being
  swallowed (#417).
- Uplink state payloads are validated against a strict schema (#416).

## [0.9.1] - 2026-07-15

### Added

- Double-click a grid stream to expand it to fullscreen (#368).
- Optionally pause parked views during a fullscreen expansion (#383).

### Changed

- GitHub releases are published as non-prerelease builds (#361).

### Fixed

- Non-focused streams stay alive across a fullscreen expand/collapse (#373).
- Unresolved playlist URLs are retried when stream data updates (#365).
- The control server defaults its listen port when the URL has no port (#378).
- `trustProxy` is opt-in so per-client rate limits work behind a reverse proxy
  (#379).

## [0.9.0] - 2026-07-15

Initial public release: the first GitHub Release of the Streamwall Electron app,
with unsigned pre-release builds for macOS, Windows, and Linux.

[Unreleased]: https://github.com/NilsR0711/streamwall/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/NilsR0711/streamwall/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/NilsR0711/streamwall/releases/tag/v0.9.0
