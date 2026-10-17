import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist', 'prototype', 'target', 'vendor', 'src-tauri/gen']),
  js.configs.recommended,
  tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    // The two classic rules only. The React Compiler rules in the plugin's `recommended`
    // preset (set-state-in-effect, refs, purity, ...) are a separate decision.
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Every visible string goes through i18n (spec 8.8); tests may use literals.
    files: ['src/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    plugins: { i18next },
    rules: { 'i18next/no-literal-string': ['error', { mode: 'jsx-only' }] },
  },
  {
    // Tooling runs in Node, not in the WebView.
    files: ['*.config.{js,ts}', 'vitest.setup.ts'],
    languageOptions: { globals: globals.node },
  },
]);
