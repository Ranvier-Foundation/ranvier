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
} from '@ranvier/chains/local-dev';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_SIGNER_DEFAULT_CHAINS as REEXPORTED_DEFAULTS,
  LocalKeySigner,
  NEVER_LOCAL_CHAINS,
} from '../../src/adapters/signers/local-key.js';
import { buildServer } from '../../src/http/server.js';
import { LOCAL_SIGNER_DEFAULT_CHAINS, mainnetRulesApply } from '../../src/mainnet-rules.js';
import {
  TRUSTED_ROUTERS,
  ZEROX_ALLOWANCE_HOLDER,
  ZEROX_SETTLERS,
} from '../../src/trusted-routers.js';
import { devAccounts, publicAnvilKey } from './dev-accounts.js';

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
