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
  },
});
