import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      // verify-cli.ts is the networked runner; its logic (verify.ts) is unit-tested.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/verify-cli.ts'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
