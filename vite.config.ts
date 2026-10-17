import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // The repo root also holds Rust build output (target/), vendored binaries and the
    // prototype; watching them would burn CPU and reload the UI on every cargo build.
    watch: {
      ignored: [
        '**/src-tauri/**',
        '**/crates/**',
        '**/prototype/**',
        '**/target/**',
        '**/vendor/**',
        '**/.claude/**',
        '**/.superpowers/**',
      ],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // Not the prototype's tests, which run from its own folder.
    include: ['src/**/*.test.{ts,tsx}'],
    // Vitest does not process CSS: a stylesheet imports as "" and a CSS module as a proxy of its
    // class names (`App.test.tsx` and the like need nothing more). The exception is a stylesheet
    // read as text with `?raw`: the theme tests check what the CSS says (no `transform: scale`,
    // only known `--k-*` variables). The pattern is tested against the id with its query, so only
    // `x.css?raw` keeps its text; the plain imports are unchanged. Vite's own CSS plugins leave
    // `?raw` alone, so the text comes through as it is.
    css: { include: [/\.css\?raw$/] },
  },
});
