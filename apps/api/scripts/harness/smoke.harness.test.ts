/**
 * LOCAL TEST HARNESS ONLY (ADR 0013). `pnpm harness:smoke`: its own anvil on a free 127.0.0.1
 * port, chain 31337, `DeployHarness.s.sol` through forge, every smoke scenario, then that anvil
 * stopped by its own PID. Skipped, with a message, when anvil or forge is not installed.
 * Not part of `pnpm test` (excluded in vitest.config.ts); run with vitest.harness.config.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deployHarness,
  findFoundry,
  freeLoopbackPort,
  startAnvil,
  type AnvilHandle,
} from './anvil.js';
import { runSmoke, SCENARIOS } from './smoke.js';

const foundry = findFoundry();
if (!foundry) {
  console.warn(
    'harness smoke SKIPPED: anvil and forge were not found on PATH or in ~/.foundry/bin. ' +
      'Install Foundry (https://getfoundry.sh) to run it.',
  );
}

describe.skipIf(!foundry)('harness smoke on a fresh anvil (chain 31337)', () => {
  let anvil: AnvilHandle | undefined;

  beforeAll(async () => {
    if (!foundry) return;
    anvil = await startAnvil(foundry, await freeLoopbackPort());
    await deployHarness(foundry, anvil.url);
  }, 16 * 60_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  it(
    'passes every scenario against the real API code and the real FeeWrapper',
    async () => {
      if (!anvil) throw new Error('anvil not started');
      const lines: string[] = [];
      const report = await runSmoke(anvil.url, { log: (l) => lines.push(l) });
      console.log(lines.join('\n'));
      expect(report.results.filter((r) => !r.ok)).toEqual([]);
      expect(report.results.map((r) => r.name)).toEqual([...SCENARIOS]);
      expect(report.ok).toBe(true);
    },
    5 * 60_000,
  );
});
