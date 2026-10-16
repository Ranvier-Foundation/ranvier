import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The anvil smoke (ADR 0013) needs Foundry; it runs with `pnpm harness:smoke` instead.
    exclude: [...configDefaults.exclude, 'scripts/harness/**/*.harness.test.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/main.ts', 'src/harness/main.ts'],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
