import { defineConfig } from 'vitest/config'

// Most tests here are plain Node unit tests, but the renderer ships Preact
// components. Component tests opt into a DOM via `// @vitest-environment
// happy-dom` per file. `preact/compat` is aliased for `react`/`react-dom`,
// matching how react-icons and react-hotkeys-hook resolve at runtime.
//
// `react-icons` and `styled-components` ship both a CJS build (whose internal
// `require('react')` bypasses the alias above under Vitest's SSR-like module
// runner) and an ESM build (whose `import ... from 'react'` resolves through
// Vite's resolver, honoring the alias). `mainFields` prefers their ESM/browser
// builds, and `deps.inline` forces both through Vite's transform pipeline
// instead of being loaded as opaque external CJS modules - without both, they
// resolve the real `react` package instead of `preact/compat`, which crashes
// react-icons (`Cannot add property __, object is not extensible`, a frozen
// React element hitting Preact's reconciler) and makes styled-components
// render elements with their generated class name as the tag instead of the
// real DOM tag. `svg-loaders-react` used to have the same CJS-only problem
// (see issue #182); it was replaced with a first-party inlined component
// (see OverlayViewTile.tsx's TailSpin import) rather than extending this fix
// to a third dependency.
//
// `logger.ts` imports `electron-log/main`, whose entry point is CJS-only (no
// ESM/browser build to route through the fix above) and does a bare
// `require('electron')` at module scope. That require is real Node
// resolution rooted at electron-log's own install location, not this
// package's - so it only finds `electron` when npm happens to hoist both to
// the same node_modules directory, and throws "Cannot find module 'electron'"
// whenever npm nests `electron` under this package instead (see issue #439).
// electron-log also ships `electron-log/node`, a Node-only build with the
// same Logger API (transports, log levels) that never touches `electron` at
// all - main-process code under test never runs inside a real Electron
// process anyway, so redirecting to it here sidesteps the hoisting-dependent
// require entirely instead of trying to make it resolve reliably.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  resolve: {
    mainFields: ['browser', 'module', 'main'],
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'electron-log/main': 'electron-log/node',
    },
  },
  test: {
    server: {
      deps: {
        inline: [/react-icons/, /styled-components/],
      },
    },
  },
})
