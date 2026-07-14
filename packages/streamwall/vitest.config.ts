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
// real DOM tag. `svg-loaders-react` (used via `styled(TailSpin)` in
// OverlayViewTile) has no ESM build, so this fix doesn't reach it - see the
// `vi.mock('svg-loaders-react', ...)` in OverlayViewTile.test.tsx for the
// remaining workaround.
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
