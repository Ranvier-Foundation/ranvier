/**
 * The on-chain FeeWrapper signer check (ADR 0005 follow-up, ADR 0013 row 5): the reader adapter
 * against a fake JSON-RPC node, the comparison, the startup refusal (fail closed) and the
 * runtime refresh and gate.
 */
import { padHex, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ViemChainReader } from './adapters/rpc/viem-chain-reader.js';
import { LocalKeySigner } from './adapters/signers/local-key.js';
import { buildRoutePolicy } from './domain/route-policy.js';
import {
  FeeSignerCheckError,
  FeeSignerMonitor,
  signingChainIds,
  wrapperMismatch,
  type WrapperExpectation,
} from './fee-signer-check.js';
import { ChainReadError, type EvmAddress } from './ports/chain-reader.js';
import type { FeeWrapperReader, FeeWrapperState } from './ports/fee-wrapper-reader.js';
import { SigningUnavailableError, type QuoteSigner } from './ports/quote-signer.js';
import { FakeRpc, node, type FakeWrapper } from './testing/fake-rpc.js';
import { TRUSTED_ROUTERS } from './trusted-routers.js';

// URLs carry a fake key: no log line or error may contain it.
const KEY = 'SECRETKEY123';
const A = `https://rpc-a.example/v2/${KEY}`;
const B = `https://rpc-b.example/v2/${KEY}`;
const WRAPPER = '0x000000000000000000000000000000000000fee1';
const SIGNER = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7';
const OTHER = '0x000000000000000000000000000000000000bEEF';

function goodWrapper(chainId: number, overrides: Partial<FakeWrapper> = {}): FakeWrapper {
  return {
    feeSigner: SIGNER,
    domain: {
      name: 'Ranvier FeeWrapper',
      version: '1',
      chainId: BigInt(chainId),
      verifyingContract: WRAPPER,
    },
    ...overrides,
  };
}

function setup(urls: Record<string, Partial<Parameters<typeof node>[0]>>, chainId = 8453) {
  const rpc = new FakeRpc();
  for (const [url, n] of Object.entries(urls)) rpc.nodes.set(url, node({ chainId, ...n }));
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const log = {
    info: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'info', obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'warn', obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'error', obj, msg }),
  };
  const reader = new ViemChainReader({
    endpoints: new Map([[chainId, Object.keys(urls).map((url, i) => ({ url, label: `E[${i}]` }))]]),
    fetch: rpc.fetch,
    log,
    requestTimeoutMs: 200,
    retryCount: 0,
    retryDelayMs: 1,
  });
  return { rpc, reader, lines };
}

const wrappers = (w: FakeWrapper) => new Map([[WRAPPER, w]]);
const read = (reader: ViemChainReader, chainId = 8453) =>
  reader.readFeeWrapper(chainId, WRAPPER, AbortSignal.timeout(2_000));

describe('ViemChainReader.readFeeWrapper', () => {
  it('reads code, feeSigner and eip712Domain at one block, through proved endpoints only', async () => {
    const { rpc, reader } = setup({ [A]: { block: 77n, wrappers: wrappers(goodWrapper(8453)) } });
    await reader.verifyEndpoints();
    const state = await read(reader);
    expect(state).toEqual({
      blockNumber: 77n,
      hasCode: true,
      feeSigner: SIGNER.toLowerCase(),
      domain: {
        name: 'Ranvier FeeWrapper',
        version: '1',
        chainId: 8453n,
        verifyingContract: WRAPPER,
      },
    });
    const pinned = rpc.calls.filter((c) => c.method === 'eth_call' || c.method === 'eth_getCode');
    expect(pinned).toHaveLength(3);
    for (const c of pinned) expect(c.params[1]).toBe('0x4d'); // block 77
    expect(new Set(rpc.redirectModes)).toEqual(new Set(['error']));
  });

  it('refuses before any read when no endpoint proved the chain', async () => {
    const { rpc, reader } = setup({ [A]: { chainId: 1, wrappers: wrappers(goodWrapper(8453)) } });
    await reader.verifyEndpoints(); // answers chain 1: dropped
    const err = await read(reader).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainReadError);
    expect((err as ChainReadError).reason).toBe('no_verified_endpoint');
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  it('refuses an unconfigured chain and an aborted signal', async () => {
    const { reader } = setup({ [A]: {} });
    await expect(reader.readFeeWrapper(1, WRAPPER, AbortSignal.timeout(1_000))).rejects.toThrow(
      'chain_not_configured',
    );
    await reader.verifyEndpoints();
    await expect(reader.readFeeWrapper(8453, WRAPPER, AbortSignal.abort())).rejects.toThrow(
      'timeout: aborted',
    );
  });

  it('a redirecting endpoint is refused and the next one answers', async () => {
    const { rpc, reader, lines } = setup({
      [A]: { wrappers: wrappers(goodWrapper(8453, { feeSigner: OTHER })) },
      [B]: { wrappers: wrappers(goodWrapper(8453)) },
    });
    await reader.verifyEndpoints();
    // A proved its chain, then starts redirecting: its answer is never used.
    const a = rpc.nodes.get(A);
    if (a) a.mode = 'redirect';
    const state = await read(reader);
    expect(state.feeSigner).toBe(SIGNER.toLowerCase());
    expect(lines.some((l) => l.obj.reason === 'redirect' && l.obj.endpoint === 'E[0]')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });

  it('every endpoint redirecting: rpc_unavailable, never a followed redirect', async () => {
    const { rpc, reader, lines } = setup({ [A]: { wrappers: wrappers(goodWrapper(8453)) } });
    await reader.verifyEndpoints();
    const n = rpc.nodes.get(A);
    if (n) n.mode = 'redirect';
    const err = await read(reader).catch((e: unknown) => e);
    expect((err as ChainReadError).code).toBe('rpc_unavailable');
    expect(JSON.stringify(lines)).not.toMatch(/SECRETKEY123|rpc-a\.example/);
  });

  it('a hanging endpoint times out under the caller deadline', async () => {
    const { rpc, reader } = setup({ [A]: { wrappers: wrappers(goodWrapper(8453)) } });
    await reader.verifyEndpoints();
    const n = rpc.nodes.get(A);
    if (n) n.mode = 'hang';
    const err = await reader
      .readFeeWrapper(8453, WRAPPER, AbortSignal.timeout(300))
      .catch((e: unknown) => e);
    expect((err as ChainReadError).code).toBe('timeout');
  });

  it('a reverting or malformed view is null; no contract has no code', async () => {
    const cases: [FakeWrapper, Partial<FeeWrapperState>][] = [
      [
        goodWrapper(8453, { feeSigner: 'revert', domain: 'revert' }),
        { feeSigner: null, domain: null },
      ],
      // Dirty high bytes in the address word: not an ABI address.
      [
        goodWrapper(8453, { feeSigner: { raw: `0x${'ff'.repeat(12)}${SIGNER.slice(2)}` as Hex } }),
        { feeSigner: null },
      ],
      [
        goodWrapper(8453, { feeSigner: { raw: '0x1234' }, domain: { raw: '0x1234' } }),
        { feeSigner: null, domain: null },
      ],
      [goodWrapper(8453, { code: '0x' }), { hasCode: false }],
    ];
    for (const [w, expected] of cases) {
      const { reader } = setup({ [A]: { wrappers: wrappers(w) } });
      await reader.verifyEndpoints();
      expect(await read(reader)).toMatchObject(expected);
    }
    // No wrapper at the address at all.
    const { reader } = setup({ [A]: {} });
    await reader.verifyEndpoints();
    expect(await read(reader)).toMatchObject({ hasCode: false, feeSigner: null, domain: null });
  });

  it('malformed code or block number fails the read', async () => {
    for (const results of [
      { eth_getCode: '0x123' },
      { eth_blockNumber: '0x0' },
      { eth_blockNumber: 'x' },
    ]) {
      const { reader } = setup({ [A]: { wrappers: wrappers(goodWrapper(8453)), results } });
      await reader.verifyEndpoints();
      await expect(read(reader)).rejects.toBeInstanceOf(ChainReadError);
    }
  });
});

describe('wrapperMismatch', () => {
  const expected: WrapperExpectation = { chainId: 8453, feeWrapper: WRAPPER, signer: SIGNER };
  const good: FeeWrapperState = {
    blockNumber: 1n,
    hasCode: true,
    feeSigner: SIGNER.toLowerCase() as EvmAddress,
    domain: {
      name: 'Ranvier FeeWrapper',
      version: '1',
      chainId: 8453n,
      verifyingContract: WRAPPER,
    },
  };
  const domain = good.domain ?? { name: '', version: '', chainId: 0n, verifyingContract: WRAPPER };

  it('matches the configured wrapper, in any letter case', () => {
    expect(wrapperMismatch(good, expected)).toBeUndefined();
    expect(
      wrapperMismatch(good, { ...expected, signer: SIGNER.toUpperCase().replace('0X', '0x') }),
    ).toBeUndefined();
  });

  it.each([
    ['no_code', { hasCode: false }],
    ['no_fee_signer', { feeSigner: null }],
    ['fee_signer_differs', { feeSigner: OTHER.toLowerCase() as EvmAddress }],
    ['no_domain', { domain: null }],
    ['domain_name', { domain: { ...domain, name: 'Other' } }],
    ['domain_version', { domain: { ...domain, version: '2' } }],
    ['domain_chain_id', { domain: { ...domain, chainId: 1n } }],
    [
      'domain_contract',
      { domain: { ...domain, verifyingContract: OTHER.toLowerCase() as EvmAddress } },
    ],
  ] as const)('%s', (reason, patch) => {
    expect(wrapperMismatch({ ...good, ...patch }, expected)).toBe(reason);
  });
});

describe('signingChainIds', () => {
  it('a local key signs no production chain (no trusted router on a testnet)', () => {
    const local = new LocalKeySigner(padHex('0xa11ce', { size: 32 }), { nodeEnv: 'test' });
    expect(signingChainIds([84532, 31337], local, TRUSTED_ROUTERS)).toEqual([]);
    const policy = buildRoutePolicy({ 84532: TRUSTED_ROUTERS.get(1) ?? [] });
    expect(signingChainIds([84532, 84532, 31337], local, policy)).toEqual([84532]);
  });

  it('a KMS-kind signer signs every quoted mainnet with a router policy', () => {
    const kms: QuoteSigner = {
      kind: 'kms',
      address: SIGNER,
      canSign: () => true,
      signTypedData: () => Promise.resolve('0x'),
    };
    expect(signingChainIds([1, 8453, 42161, 10], kms, TRUSTED_ROUTERS)).toEqual([1, 8453, 42161]);
  });
});

/** A reader whose answers per chain are scripted, counting reads and endpoint proofs. */
function scripted(answers: Record<number, (FeeWrapperState | Error)[]>) {
  const reads: number[] = [];
  let proofs = 0;
  const reader: FeeWrapperReader = {
    canRead: () => true,
    verifyEndpoints: () => {
      proofs++;
      return Promise.resolve();
    },
    readFeeWrapper: (chainId) => {
      reads.push(chainId);
      const queue = answers[chainId] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) return Promise.reject(new ChainReadError('rpc_unavailable', 'none'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { reader, reads, proofs: () => proofs };
}

const state = (chainId: number, signer = SIGNER): FeeWrapperState => ({
  blockNumber: 5n,
  hasCode: true,
  feeSigner: signer.toLowerCase() as EvmAddress,
  domain: {
    name: 'Ranvier FeeWrapper',
    version: '1',
    chainId: BigInt(chainId),
    verifyingContract: WRAPPER,
  },
});
const down = () => new ChainReadError('rpc_unavailable', 'no_verified_endpoint');

function monitor(reader: FeeWrapperReader, chainIds = [1, 8453]) {
  const sleeps: number[] = [];
  const lines: { level: string; msg: string; obj: Record<string, unknown> }[] = [];
  const m = new FeeSignerMonitor({
    reader,
    chainIds,
    feeWrapper: WRAPPER,
    signer: SIGNER,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    log: {
      info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => lines.push({ level: 'error', obj, msg }),
    },
  });
  return { m, sleeps, lines };
}

describe('FeeSignerMonitor at startup (fail closed)', () => {
  it('passes when every signing chain matches', async () => {
    const s = scripted({ 1: [state(1)], 8453: [state(8453)] });
    const { m } = monitor(s.reader);
    await m.verifyAtStartup();
    expect(m.matches(1) && m.matches(8453)).toBe(true);
    expect(s.reads).toEqual([1, 8453]);
  });

  it('refuses at once on a mismatch, naming the chain and the on-chain signer', async () => {
    const s = scripted({ 1: [state(1)], 8453: [state(8453, OTHER)] });
    const { m, sleeps } = monitor(s.reader);
    const err = await m.verifyAtStartup().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeeSignerCheckError);
    expect((err as Error).message).toContain(
      `FeeWrapper ${WRAPPER} on chain 8453 does not match the configured signer ${SIGNER}: ` +
        `fee_signer_differs (feeSigner() is ${OTHER.toLowerCase()}) at block 5`,
    );
    expect(sleeps).toEqual([]); // never retried
    expect(m.matches(8453)).toBe(false);
  });

  it('refuses after the last attempt when a chain cannot be read', async () => {
    const s = scripted({ 1: [state(1)], 8453: [down()] });
    const { m, sleeps } = monitor(s.reader);
    await expect(m.verifyAtStartup()).rejects.toThrow(
      'Could not read the FeeWrapper on chain(s) 8453 (no_verified_endpoint)',
    );
    expect(s.reads).toEqual([1, 8453, 8453, 8453]); // 3 attempts; chain 1 read once
    expect(s.proofs()).toBe(2);
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(m.matches(8453)).toBe(false);
  });

  it('a chain that becomes readable on a retry passes', async () => {
    const s = scripted({ 8453: [down(), state(8453)] });
    const { m } = monitor(s.reader, [8453]);
    await m.verifyAtStartup();
    expect(m.matches(8453)).toBe(true);
    expect(s.proofs()).toBe(1);
  });

  it('a non-ChainReadError read failure is named only, and still fails closed', async () => {
    const s = scripted({ 8453: [new TypeError(`fetch failed ${A}`)] });
    const { m } = monitor(s.reader, [8453]);
    const err = (await m.verifyAtStartup().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('8453 (TypeError)');
    expect(err.message).not.toContain(KEY);
  });

  it('nothing to check: passes without reading', async () => {
    const s = scripted({});
    const { m } = monitor(s.reader, []);
    await m.verifyAtStartup();
    expect(s.reads).toEqual([]);
  });
});

describe('FeeSignerMonitor at runtime', () => {
  const inner = (): QuoteSigner & { signed: number } => {
    const s = {
      kind: 'kms' as const,
      address: SIGNER as Hex,
      signed: 0,
      canSign: (id: number) => id !== 42161,
      signTypedData: () => {
        s.signed++;
        return Promise.resolve('0xsig' as Hex);
      },
    };
    return s;
  };
  const typed = (chainId: number) =>
    ({ domain: { chainId }, types: {}, primaryType: 'X', message: {} }) as never;

  it('a confirmed mismatch stops signing on that chain; a later match resumes it', async () => {
    const s = scripted({ 1: [state(1), state(1, OTHER), state(1)], 8453: [state(8453)] });
    const { m, lines } = monitor(s.reader);
    await m.verifyAtStartup();
    const signer = inner();
    const gated = m.gate(signer);
    expect(gated.kind).toBe('kms');
    expect(gated.address).toBe(SIGNER);
    expect(gated.canSign(1)).toBe(true);

    await m.refresh();
    expect(gated.canSign(1)).toBe(false);
    expect(gated.canSign(8453)).toBe(true);
    await expect(gated.signTypedData(typed(1))).rejects.toBeInstanceOf(SigningUnavailableError);
    expect(signer.signed).toBe(0);
    expect(lines.some((l) => l.level === 'error' && l.obj.chainId === 1)).toBe(true);

    await m.refresh();
    expect(gated.canSign(1)).toBe(true);
    await expect(gated.signTypedData(typed(1))).resolves.toBe('0xsig');
    expect(lines.some((l) => l.msg.includes('signing resumed'))).toBe(true);
  });

  it('a failed re-check keeps the last confirmed result', async () => {
    const s = scripted({ 8453: [state(8453), down()] });
    const { m, lines } = monitor(s.reader, [8453]);
    await m.verifyAtStartup();
    await m.refresh();
    await m.refresh();
    expect(m.matches(8453)).toBe(true);
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });

  it('chains outside the monitored set keep the inner answer', async () => {
    const s = scripted({ 8453: [state(8453)] });
    const { m } = monitor(s.reader, [8453]);
    const gated = m.gate(inner());
    // Not yet verified: refused.
    expect(gated.canSign(8453)).toBe(false);
    await m.verifyAtStartup();
    expect(gated.canSign(8453)).toBe(true);
    expect(gated.canSign(10)).toBe(true); // inner says yes, not monitored
    expect(gated.canSign(42161)).toBe(false); // inner says no
    await expect(gated.signTypedData(typed(10))).resolves.toBe('0xsig');
  });

  it('start() refreshes on its interval (unref) and stop() ends it', async () => {
    vi.useFakeTimers();
    try {
      const s = scripted({ 8453: [state(8453)] });
      const m = new FeeSignerMonitor({
        reader: s.reader,
        chainIds: [8453],
        feeWrapper: WRAPPER,
        signer: SIGNER,
        refreshIntervalMs: 1_000,
      });
      await m.verifyAtStartup();
      m.start();
      m.start(); // idempotent
      await vi.advanceTimersByTimeAsync(3_100);
      expect(s.reads).toHaveLength(4);
      m.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.reads).toHaveLength(4);
      expect(m.chainIds).toEqual([8453]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the gate reaches the HTTP signing check', () => {
  it('canSignChain refuses a chain whose wrapper stopped matching (503 signing_unavailable)', async () => {
    const { canSignChain } = await import('./signing-policy.js');
    const s = scripted({ 1: [state(1), state(1, OTHER)] });
    const { m } = monitor(s.reader, [1]);
    await m.verifyAtStartup();
    const kms: QuoteSigner = {
      kind: 'kms',
      address: SIGNER,
      canSign: () => true,
      signTypedData: () => Promise.resolve('0x'),
    };
    const gated = m.gate(kms);
    expect(canSignChain(gated, TRUSTED_ROUTERS, 1)).toBe(true);
    await m.refresh();
    expect(canSignChain(gated, TRUSTED_ROUTERS, 1)).toBe(false);
  });
});
