import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig paths so route modules, which import via '@/lib/...',
      // resolve under vitest exactly as they do under Next.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@db': fileURLToPath(new URL('./db', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests share one database; running files in parallel would have
    // them tripping over each other's fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
