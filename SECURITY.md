# Security Policy

## Supported versions

Streamwall is distributed as a rolling release: only the latest published
[GitHub Release](https://github.com/NilsR0711/streamwall/releases/latest) and
the current `main` branch receive security fixes. There are no long-term
support branches — please update to the newest release before reporting an
issue you found in an older build.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Public issues disclose
the vulnerability to everyone before a fix exists.

Instead, report privately through GitHub's built-in vulnerability reporting:

1. Go to the [Security tab](https://github.com/NilsR0711/streamwall/security).
2. Click **Report a vulnerability** to open a private advisory.
3. Describe the issue, the affected component, and reproduction steps.

This opens a private channel visible only to you and the maintainers. You will
get an acknowledgement, and once a fix is prepared the advisory is published
with credit to you unless you ask to stay anonymous.

If you cannot use the Security tab (for example the feature is disabled for
your account), open a regular issue that says only "security report — please
enable a private channel" with **no technical details**, and wait for a
maintainer to establish a private contact.

## Scope

Streamwall has two internet-facing surfaces worth extra scrutiny:

- **Control server** (`packages/streamwall-control-server`) — WebSocket and
  HTTP endpoints, session authentication, role-based permissions, message
  validation, and rate limiting. This process is designed to be self-hosted
  behind a public domain, so authentication bypass, message-validation gaps,
  and privilege escalation between roles are in scope.
- **Electron app** (`packages/streamwall`) — the Content Security Policy,
  `<iframe>` sandboxing for overlay/background streams, navigation guards, and
  the isolation between renderer content and the app's internal APIs. See
  [Security: overlay and background streams](README.md#security-overlay-and-background-streams)
  for the intended trust boundaries.

Reports that a control operator can point an overlay tile at an arbitrary URL
are **not** vulnerabilities — that is the documented design (overlays run in an
opaque, script-only sandbox). Anything that lets such a page escape its
sandbox, reach Streamwall's internal APIs, or read app cookies/storage **is** a
vulnerability.

Out of scope: findings that require an already-compromised host, physical
access to the operator's machine, or social engineering of a control operator.
