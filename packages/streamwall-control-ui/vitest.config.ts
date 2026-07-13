import { defineConfig } from 'vitest/config'

// The control UI ships Preact components. Type-only in production (Vite compiles
// the JSX in the consuming packages), so tests need their own JSX transform and
// a DOM. `preact/compat` is aliased for `react`, matching how react-icons and
// react-hotkeys-hook resolve at runtime, and is loaded in the setup file so
// `onChange` fires on input (React-style), exactly as it does in the app.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
