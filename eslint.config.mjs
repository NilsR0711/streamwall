// Flat ESLint configuration (ESLint 10+).
// Replaces the legacy .eslintrc.json, which ESLint 9+ no longer reads.
import js from '@eslint/js'
import importX from 'eslint-plugin-import-x'
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
    },
  },
  {
    // Tests use `any` freely for mocks and invalid-input fixtures.
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
