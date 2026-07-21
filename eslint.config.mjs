// Flat ESLint configuration (ESLint 10+).
// Replaces the legacy .eslintrc.json, which ESLint 9+ no longer reads.
import js from '@eslint/js'
import importX from 'eslint-plugin-import-x'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/.vite/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.min.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Import hygiene backed by the TypeScript resolver, so import paths
  // (including workspace packages and `.ts` extensions) are validated.
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // Allow intentionally-unused identifiers prefixed with `_`, and don't
      // flag unused `catch` bindings (idiomatic `catch (err)`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      // Default-importing a CJS module whose interop name collides with one of
      // its named exports (e.g. `import WebSocket from 'ws'`) is intentional
      // and idiomatic here; these stylistic checks add noise without value.
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',
      // The workspace standardizes on the ESM build of lodash. Importing the
      // CJS package (or one of its `lodash/<fn>` subpaths) pulls a second copy
      // of lodash into the Vite/Forge bundles and reintroduces ESM/CJS interop
      // surprises in the main and preload builds.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lodash',
              message: "Use named imports from 'lodash-es' instead.",
            },
          ],
          patterns: [
            {
              group: ['lodash/*'],
              message: "Use named imports from 'lodash-es' instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // Tests use `any` freely for mocks and invalid-input fixtures.
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Preact mirrors the React hooks API via `preact/hooks`, so the React
    // Hooks rules apply to these Preact-based packages. Scoped to
    // rules-of-hooks/exhaustive-deps only (not the plugin's full
    // "recommended" set), since v7's recommended config also pulls in
    // React Compiler-oriented rules (e.g. purity, immutability, gating)
    // that don't apply here — this project doesn't use the React Compiler.
    files: [
      'packages/streamwall-control-ui/src/**/*.{ts,tsx}',
      'packages/streamwall-control-client/src/**/*.{ts,tsx}',
      'packages/streamwall/src/renderer/**/*.{ts,tsx}',
    ],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Start at warn to land the tooling without blocking CI; promote to
      // error once the existing violations it surfaces are cleared.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
