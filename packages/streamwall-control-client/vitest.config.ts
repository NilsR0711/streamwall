import { defineConfig } from 'vitest/config'

// This package ships Preact components/hooks. Type-only in production (Vite
// compiles the JSX when building), so tests need their own JSX transform and
// a DOM, matching streamwall-control-ui's vitest setup.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  test: {
    environment: 'happy-dom',
  },
})
