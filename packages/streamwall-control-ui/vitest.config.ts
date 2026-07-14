import { defineConfig } from 'vitest/config'

// The control UI ships Preact components. Type-only in production (Vite compiles
// the JSX in the consuming packages), so tests need their own JSX transform and
// a DOM. `preact/compat` is aliased for `react`, matching how react-icons and
// react-hotkeys-hook resolve at runtime, and is loaded in the setup file so
// `onChange` fires on input (React-style), exactly as it does in the app.
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
// real DOM tag.
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
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    server: {
      deps: {
        inline: [/react-icons/, /styled-components/],
      },
    },
  },
})
