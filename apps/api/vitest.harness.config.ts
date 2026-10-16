import { defineConfig } from 'vitest/config';

/** `pnpm harness:smoke` (ADR 0013): only the anvil smoke, one file, no coverage. */
export default defineConfig({
  test: {
    include: ['scripts/harness/**/*.harness.test.ts'],
    fileParallelism: false,
  },
});
