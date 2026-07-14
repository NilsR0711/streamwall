import { defineConfig } from 'vitest/config'

// Most tests here are plain Node unit tests, but the renderer ships Preact
// components. Component tests opt into a DOM via `// @vitest-environment
// happy-dom` per file. `preact/compat` is aliased for `react`/`react-dom`,
// matching how react-icons and react-hotkeys-hook resolve at runtime.
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
})
