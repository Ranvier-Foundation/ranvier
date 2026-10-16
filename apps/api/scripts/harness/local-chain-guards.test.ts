/**
 * ADR 0013, section 2 (PR 3): the local test chain stays outside everything production trusts or
 * serves, and the signing guards stay exactly as they are. Lives under scripts/harness/ because it
 * imports `@ranvier/chains/local-dev`, which nothing under `src/` may import.
 *
 * - `CHAINS`, `TOKEN_LIST`, `TRUSTED_ROUTERS` and `ZEROX_SETTLERS` hold no 31337 and no harness
 *   address; GET /v1/chains and /v1/tokens never serve it, even when 31337 is a served chain.
 * - 31337 is in `LOCAL_SIGNER_DEFAULT_CHAINS` and not in `NEVER_LOCAL_CHAINS`: asserted, never
 *   changed. Putting the chain in the registry or the router policy would flip the second one.
 */
import { CHAINS, getChain, TOKEN_LIST } from '@ranvier/chains';
import {
  LOCAL_DEV_CHAIN,
  LOCAL_DEV_CHAIN_ID,
  LOCAL_DEV_CHAIN_KEY,
  localDevAddresses,
  localDevToken,
} from '@ranvier/chains/local-dev';
import { quoteFee } from '@ranvier/fees';
import type { TokenRef } from '@ranvier/types';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DefiLlamaPriceOracle } from '../../src/adapters/prices/defillama.js';
import { assertCatalogExtendsRegistry, ChainCatalogError } from '../../src/chain-catalog.js';
import { BalanceService } from '../../src/domain/balances.js';
import { harnessCatalog } from '../../src/harness/catalog.js';
import { productionSourceFiles, REPO } from './build-output.js';
import {
  LOCAL_SIGNER_DEFAULT_CHAINS as REEXPORTED_DEFAULTS,
  LocalKeySigner,
  NEVER_LOCAL_CHAINS,
} from '../../src/adapters/signers/local-key.js';
import { buildServer, buildServerWithCatalog, type ServerDeps } from '../../src/http/server.js';
import { LOCAL_SIGNER_DEFAULT_CHAINS, mainnetRulesApply } from '../../src/mainnet-rules.js';
import {
  TRUSTED_ROUTERS,
  ZEROX_ALLOWANCE_HOLDER,
  ZEROX_SETTLERS,
} from '../../src/trusted-routers.js';
import { devAccounts, publicAnvilKey } from '../../src/harness/dev-accounts.js';

const LOCALS = localDevAddresses();
const evmIds = (): number[] =>
  CHAINS.flatMap((c) => (c.family === 'evm' ? [Number(c.key.slice('evm:'.length))] : []));

describe('the local chain is in no production list', { timeout: 30_000 }, () => {
  it('is chain 31337', () => {
    expect(LOCAL_DEV_CHAIN_ID).toBe(31337);
    expect(LOCAL_DEV_CHAIN.key).toBe('evm:31337');
  });

  it('CHAINS has no 31337', () => {
    expect(CHAINS.map((c) => c.key)).not.toContain(LOCAL_DEV_CHAIN_KEY);
    expect(evmIds()).not.toContain(LOCAL_DEV_CHAIN_ID);
    expect(getChain(LOCAL_DEV_CHAIN_KEY)).toBeUndefined();
  });

  it('TOKEN_LIST has no 31337 token and no harness address', () => {
    expect(TOKEN_LIST.filter((t) => t.chain === LOCAL_DEV_CHAIN_KEY)).toEqual([]);
    for (const t of TOKEN_LIST) expect(LOCALS).not.toContain(t.address.toLowerCase());
  });

  it('TRUSTED_ROUTERS has no 31337 and no harness router or target', () => {
    expect([...TRUSTED_ROUTERS.keys()]).not.toContain(LOCAL_DEV_CHAIN_ID);
    expect(TRUSTED_ROUTERS.get(LOCAL_DEV_CHAIN_ID)).toBeUndefined();
    for (const routers of TRUSTED_ROUTERS.values()) {
      for (const r of routers) {
        expect(LOCALS).not.toContain(r.address.toLowerCase());
        for (const t of r.targets) expect(LOCALS).not.toContain(t.toLowerCase());
      }
    }
    expect(LOCALS).not.toContain(ZEROX_ALLOWANCE_HOLDER.toLowerCase());
  });

  it('ZEROX_SETTLERS has no 31337 and no harness settler', () => {
    expect(Object.keys(ZEROX_SETTLERS).map(Number)).not.toContain(LOCAL_DEV_CHAIN_ID);
    for (const s of Object.values(ZEROX_SETTLERS).flat()) {
      expect(LOCALS).not.toContain(s.toLowerCase());
    }
  });

  it('GET /v1/chains and /v1/tokens never serve it, even with 31337 served', async () => {
    const app = buildServer({ providers: [], servedChainIds: [1, 8453, 42161, 31337] });
    const chains = await app.inject({ method: 'GET', url: '/v1/chains' });
    expect(chains.statusCode).toBe(200);
    expect(chains.json<{ key: string }[]>().map((c) => c.key)).toEqual([
      'evm:1',
      'evm:8453',
      'evm:42161',
    ]);
    expect(chains.body).not.toContain('Local test chain');
    const tokens = await app.inject({ method: 'GET', url: '/v1/tokens?chain=evm:31337' });
    // Refused as an unknown chain, or answered empty: either way nothing local is listed.
    if (tokens.statusCode === 200) expect(tokens.json()).toEqual([]);
    else expect(tokens.statusCode).toBe(400);
    for (const a of LOCALS) expect(tokens.body.toLowerCase()).not.toContain(a);
    await app.close();
  });
});

describe('the signing guards are unchanged (asserted, never widened)', () => {
  it('31337 is in LOCAL_SIGNER_DEFAULT_CHAINS (one list, re-exported unchanged)', () => {
    expect(LOCAL_SIGNER_DEFAULT_CHAINS).toContain(LOCAL_DEV_CHAIN_ID);
    expect(REEXPORTED_DEFAULTS).toBe(LOCAL_SIGNER_DEFAULT_CHAINS);
    expect([...LOCAL_SIGNER_DEFAULT_CHAINS].sort((a, b) => a - b)).toEqual([
      31337, 84532, 421614, 11155111,
    ]);
  });

  it('31337 is not in NEVER_LOCAL_CHAINS, which still covers every registry and router chain', () => {
    expect(NEVER_LOCAL_CHAINS.has(LOCAL_DEV_CHAIN_ID)).toBe(false);
    for (const id of [...evmIds(), ...TRUSTED_ROUTERS.keys(), 1, 8453, 42161]) {
      expect(NEVER_LOCAL_CHAINS.has(id), String(id)).toBe(true);
    }
  });

  it('31337 alone does not trigger mainnet rules; any registry chain does', () => {
    expect(mainnetRulesApply([LOCAL_DEV_CHAIN_ID], 'development')).toBe(false);
    for (const id of evmIds()) {
      expect(mainnetRulesApply([LOCAL_DEV_CHAIN_ID, id], 'development')).toBe(true);
    }
  });

  it('a local key allowed for [31337] signs 31337 only (PUBLIC anvil key, chain 31337 only)', () => {
    const signer = new LocalKeySigner(publicAnvilKey(devAccounts().feeSigner), {
      allowedChainIds: [LOCAL_DEV_CHAIN_ID],
      nodeEnv: 'development',
    });
    expect(signer.canSign(LOCAL_DEV_CHAIN_ID)).toBe(true);
    for (const id of [...evmIds(), 84532]) expect(signer.canSign(id)).toBe(false);
  });
});

describe('the harness catalog reaches only what the harness entry builds (ADR 0013, section 2)', () => {
  const routing = { providers: [], servedChainIds: [1, 8453, 42161, 31337] };

  it('is the registry, unchanged, plus LOCAL_DEV_CHAIN', () => {
    const catalog = harnessCatalog();
    expect(() => assertCatalogExtendsRegistry(catalog)).not.toThrow();
    expect(catalog.chains.slice(0, CHAINS.length)).toEqual([...CHAINS]);
    expect(catalog.chains.slice(CHAINS.length)).toEqual([LOCAL_DEV_CHAIN]);
    expect(catalog.listTokens(LOCAL_DEV_CHAIN_KEY).map((t) => t.symbol)).toEqual([
      'ETH',
      'hUSDC',
      'hWETH',
    ]);
  });

  it('production buildServer refuses it, as a catalog and inside a balance service', () => {
    const catalog = harnessCatalog();
    expect(() => buildServer({ ...routing, catalog } as unknown as ServerDeps)).toThrow(
      ChainCatalogError,
    );
    const reader = { canRead: () => true, readBalances: () => Promise.reject(new Error('no')) };
    const service = new BalanceService({ reader, servedChainIds: [31337], catalog });
    expect(() => buildServer({ ...routing, balances: { service } })).toThrow(
      'the balance service was built on another chain catalog',
    );
    service.close();
  });

  it('control: through the harness path it is listed after the registry', async () => {
    const app = buildServerWithCatalog(routing, harnessCatalog());
    const chains = await app.inject({ method: 'GET', url: '/v1/chains' });
    expect(chains.json<{ key: string }[]>().map((c) => c.key)).toEqual([
      'evm:1',
      'evm:8453',
      'evm:42161',
      'evm:31337',
    ]);
    await app.close();
  });

  it('the fee schedule and the real oracle never see the local chain', async () => {
    const usdc: TokenRef = { chain: LOCAL_DEV_CHAIN_KEY, address: localDevToken('hUSDC').address };
    const weth: TokenRef = { chain: LOCAL_DEV_CHAIN_KEY, address: localDevToken('hWETH').address };
    const native: TokenRef = { chain: LOCAL_DEV_CHAIN_KEY, address: 'native' };
    const fee = (sellToken: TokenRef, buyToken: TokenRef) =>
      quoteFee({
        sellToken,
        buyToken,
        sellAmount: 10n ** 6n,
        usdValue: 100_00n,
        isFirstSwap: false,
      });
    expect(fee(usdc, usdc).reason).toBe('tier-under-10k'); // never the stablecoin rate
    expect(fee(native, weth).reason).toBe('tier-under-10k'); // never a free wrap
    const fetch = vi.fn<typeof globalThis.fetch>();
    const oracle = new DefiLlamaPriceOracle({ fetch });
    for (const token of [usdc, weth, native]) {
      await expect(oracle.price(token, AbortSignal.timeout(1_000))).rejects.toThrow(
        'unknown chain',
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('no production source calls buildServerWithCatalog (only server.ts defines it)', () => {
    const callers = productionSourceFiles(REPO)
      .filter((f) => /\.(?:ts|tsx|mts|cts|js|mjs)$/.test(f) && !/\.test\.[cm]?[jt]sx?$/.test(f))
      // A use (call, import or export), not a mention in a comment written as `code`.
      .filter((f) => /(?<!`)\bbuildServerWithCatalog\b(?!`)/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(REPO.length));
    expect(callers).toEqual(['apps/api/src/http/server.ts']);
  });

  it('NEVER_LOCAL_CHAINS is exactly the mainnets it was (unchanged by the catalog)', () => {
    expect([...NEVER_LOCAL_CHAINS].sort((a, b) => a - b)).toEqual([
      1, 10, 56, 137, 8453, 42161, 43114,
    ]);
  });
});
