import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
