/**
 * ADR 0013, section 4: the harness API entry refuses to start unless every rule holds, and each
 * refusal comes before any RPC request (environment and signer rules) or before any listen (the
 * chain ID and the on-chain signer check). The happy path runs the real server against a fake
 * JSON-RPC node; `scripts/harness/harness-api.harness.test.ts` runs it against a real anvil.
 */
import { LOCAL_DEV_CONTRACTS } from '@ranvier/chains/local-dev';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { typedData, type SwapQuote } from '../domain/swap-quote.js';
import { FakeRpc, node, type FakeNode } from '../testing/fake-rpc.js';
import { anvilAccount } from './dev-accounts.js';
import { FORBIDDEN_VARIABLES, HarnessRefusedError } from './env-guard.js';
import { PINNED } from './pinned.js';
import { HarnessRpcRefusedError } from './rpc-guard.js';
import { harnessSigner, startHarnessApi, type HarnessApi } from './start.js';

const WRAPPER = LOCAL_DEV_CONTRACTS.feeWrapper;
const SIGNER = anvilAccount(1).address;
const USER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const { port: p } = s.address() as AddressInfo;
        s.close(() => resolve(p));
      });
    });
    if (port !== 3000) return port;
  }
}

/** True when nothing listens on 127.0.0.1:<port>. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function anvilLike(overrides: Partial<FakeNode> = {}): FakeNode {
  return node({
    chainId: 31337,
    block: 12n,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    native: 7n * 10n ** 18n,
    tokens: new Map([
      [PINNED.hUSDC.toLowerCase(), 2_994n * 10n ** 6n],
      [PINNED.hWETH.toLowerCase(), 0n],
    ]),
    wrappers: new Map([
      [
        WRAPPER,
        {
          feeSigner: SIGNER,
          domain: {
            name: 'Ranvier FeeWrapper',
            version: '1',
            chainId: 31337n,
            verifyingContract: WRAPPER,
          },
        },
      ],
    ]),
    ...overrides,
  });
}

let started: HarnessApi | undefined;
afterEach(async () => {
  await started?.close();
  started = undefined;
});

async function setup(nodeOverrides: Partial<FakeNode> = {}) {
  const rpcPort = await freePort();
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const rpc = new FakeRpc();
  rpc.nodes.set(rpcUrl, anvilLike(nodeOverrides));
  const env: Record<string, string | undefined> = {
    RANVIER_ENV: 'harness',
    ZEROX_CHAIN_IDS: '31337',
    RPC_URLS_EVM_31337: rpcUrl,
    PORT: String(port),
  };
  return { rpc, env, port, rpcUrl };
}

/** Starting must fail with `kind` and `message`, before any RPC request and without listening. */
async function refusedBeforeAnything(
  patch: Record<string, string | undefined>,
  message: string | RegExp,
  kind: new (...args: never[]) => Error = HarnessRefusedError,
): Promise<void> {
  const { rpc, env, port } = await setup();
  const err = await startHarnessApi({ ...env, ...patch }, { fetch: rpc.fetch, log: silent }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(kind);
  expect((err as Error).message).toMatch(message);
  expect(rpc.calls).toEqual([]);
  expect(await portIsFree(port)).toBe(true);
}

describe('refusals before any RPC request or listen (environment)', () => {
  it.each([undefined, '', 'Harness', 'production', 'harness '])('RANVIER_ENV=%j', async (value) => {
    await refusedBeforeAnything({ RANVIER_ENV: value }, 'RANVIER_ENV must be exactly "harness"');
  });

  it.each(['production', ' Production\n', 'PRODUCTION'])('NODE_ENV=%j', async (value) => {
    await refusedBeforeAnything({ NODE_ENV: value }, 'NODE_ENV is production');
  });

  it.each([
    undefined,
    '',
    '1',
    '8453',
    '84532',
    '31337,1',
    '1,31337',
    ' 31337',
    '31337 ',
    '0x7a69',
  ])('ZEROX_CHAIN_IDS=%j', async (value) => {
    await refusedBeforeAnything({ ZEROX_CHAIN_IDS: value }, 'ZEROX_CHAIN_IDS must be exactly');
  });

  it.each(FORBIDDEN_VARIABLES.flatMap((name) => [[name, 'x'] as const, [name, ''] as const]))(
    '%s=%j (even empty)',
    async (name, value) => {
      await refusedBeforeAnything({ [name]: value }, `${name} is set`);
    },
  );

  it.each(['RPC_URLS_EVM_1', 'RPC_URLS_EVM_8453', 'RPC_URLS_EVM_84532', 'RPC_URLS_EVM_42161'])(
    '%s set (leaked from a shell), even to loopback',
    async (name) => {
      await refusedBeforeAnything(
        { [name]: 'http://127.0.0.1:8545' },
        `${name} is set; only RPC_URLS_EVM_31337 may be`,
      );
    },
  );

  it.each([
    [undefined, 'must be exactly one URL'],
    ['http://127.0.0.1:8545,http://127.0.0.1:8546', 'must be exactly one URL'],
    ['https://127.0.0.1:8545', 'exactly http://127.0.0.1:<port>'],
    ['http://localhost:8545', 'exactly http://127.0.0.1:<port>'],
    ['http://10.0.0.1:8545', 'exactly http://127.0.0.1:<port>'],
    ['http://127.0.0.2:8545', 'exactly http://127.0.0.1:<port>'],
    ['http://base-mainnet.example:8545', 'exactly http://127.0.0.1:<port>'],
    ['http://u:p@127.0.0.1:8545', 'exactly http://127.0.0.1:<port>'],
    ['http://127.0.0.1:8545/rpc', 'exactly http://127.0.0.1:<port>'],
    ['http://127.0.0.1', 'exactly http://127.0.0.1:<port>'],
    ['http://127.0.0.1:3000', 'port 3000 is the owner dev server'],
  ])('RPC_URLS_EVM_31337=%j', async (value, message) => {
    await refusedBeforeAnything({ RPC_URLS_EVM_31337: value }, message);
  });

  it('RANVIER_HARNESS_RPC_URL naming another endpoint', async () => {
    await refusedBeforeAnything(
      { RANVIER_HARNESS_RPC_URL: 'http://127.0.0.1:1' },
      'RANVIER_HARNESS_RPC_URL is set to another URL',
    );
  });

  it.each(['0.0.0.0', '::', 'localhost', '192.168.1.2', ''])('HOST=%j', async (value) => {
    await refusedBeforeAnything({ HOST: value }, 'HOST must be 127.0.0.1 or ::1');
  });

  it.each([
    ['3000', 'PORT 3000 is the owner dev server'],
    ['0', 'PORT must be 1..65535'],
    ['65536', 'PORT must be 1..65535'],
    ['abc', 'PORT must be 1..65535'],
  ])('PORT=%j', async (value, message) => {
    await refusedBeforeAnything({ PORT: value }, message);
  });

  it.each(['https://app.example', 'http://192.168.1.2:3310', 'http://127.0.0.1:3310,https://x.io'])(
    'WEB_ORIGINS=%j',
    async (value) => {
      await refusedBeforeAnything({ WEB_ORIGINS: value }, 'WEB_ORIGINS must be loopback origins');
    },
  );

  it('a malformed WEB_ORIGINS', async () => {
    await refusedBeforeAnything({ WEB_ORIGINS: 'http://127.0.0.1:3310/' }, 'WEB_ORIGINS:');
  });

  it('FEE_WRAPPER_ADDRESS other than the pinned wrapper', async () => {
    await refusedBeforeAnything(
      { FEE_WRAPPER_ADDRESS: '0x000000000000000000000000000000000000fee1' },
      'FEE_WRAPPER_ADDRESS is not the pinned local FeeWrapper',
    );
  });

  it('another invalid setting, named by its path only', async () => {
    await refusedBeforeAnything(
      { QUOTE_TTL_SECONDS: '5' },
      'the API configuration is invalid: QUOTE_TTL_SECONDS',
    );
  });
});

describe('refusals after the first RPC request, before any listen (chain)', () => {
  it('an endpoint that does not answer chain 31337: one eth_chainId, nothing else', async () => {
    const { rpc, env, port } = await setup({ chainId: 1 });
    await expect(startHarnessApi(env, { fetch: rpc.fetch, log: silent })).rejects.toThrow(
      HarnessRpcRefusedError,
    );
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_chainId']);
    expect(await portIsFree(port)).toBe(true);
  });

  it('an unreachable endpoint', async () => {
    const { rpc, env, port } = await setup({ mode: 'down' });
    await expect(startHarnessApi(env, { fetch: rpc.fetch, log: silent })).rejects.toThrow(
      'eth_chainId failed on the harness RPC',
    );
    expect(await portIsFree(port)).toBe(true);
  });

  it.each<[string, Partial<FakeNode>, string]>([
    [
      'feeSigner() is not the harness signer (rotated)',
      {
        wrappers: new Map([
          [
            WRAPPER,
            {
              feeSigner: anvilAccount(2).address,
              domain: {
                name: 'Ranvier FeeWrapper',
                version: '1',
                chainId: 31337n,
                verifyingContract: WRAPPER,
              },
            },
          ],
        ]),
      },
      'fee_signer_differs',
    ],
    ['no wrapper deployed', { wrappers: new Map() }, 'no_code'],
    [
      'the wrapper reports another chain in its domain',
      {
        wrappers: new Map([
          [
            WRAPPER,
            {
              feeSigner: SIGNER,
              domain: {
                name: 'Ranvier FeeWrapper',
                version: '1',
                chainId: 1n,
                verifyingContract: WRAPPER,
              },
            },
          ],
        ]),
      },
      'domain_chain_id',
    ],
  ])('%s', async (_name, overrides, reason) => {
    const { rpc, env, port } = await setup(overrides);
    await expect(startHarnessApi(env, { fetch: rpc.fetch, log: silent })).rejects.toThrow(reason);
    expect(await portIsFree(port)).toBe(true);
    // Read-only: no transaction or state-changing method was ever sent.
    const methods = new Set(rpc.calls.map((c) => c.method));
    expect([...methods].sort()).toEqual(
      ['eth_blockNumber', 'eth_call', 'eth_chainId', 'eth_getCode'].sort(),
    );
  });
});

describe('the harness signer', () => {
  it('is anvil account 1, a local key for 31337 only', () => {
    const signer = harnessSigner();
    expect(signer.address).toBe(SIGNER);
    expect(signer.kind).toBe('local-key');
    expect(signer.canSign(31337)).toBe(true);
    for (const id of [1, 10, 56, 137, 8453, 42161, 43114, 84532, 11155111, 421614, 31338]) {
      expect(signer.canSign(id)).toBe(false);
    }
  });

  it('allowedChainIds is the literal [31337], once, in the source', () => {
    const source = readFileSync(new URL('./start.ts', import.meta.url), 'utf8');
    expect(source.match(/allowedChainIds/g)).toHaveLength(1);
    expect(source).toMatch(/allowedChainIds: \[31337\],/);
    // No key literal anywhere in the harness entry: 64 hex characters.
    for (const url of [
      new URL('./start.ts', import.meta.url),
      new URL('./main.ts', import.meta.url),
      new URL('./env-guard.ts', import.meta.url),
      new URL('./catalog.ts', import.meta.url),
    ]) {
      const text = readFileSync(url, 'utf8');
      expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);
    }
  });
});

describe('the harness API on a fake anvil', () => {
  it('serves 31337 with the real server: chains, tokens, balances, a signed quote', async () => {
    const { rpc, env, port } = await setup();
    started = await startHarnessApi(
      {
        ...env,
        WEB_ORIGINS: 'http://127.0.0.1:3310',
        FEE_WRAPPER_ADDRESS: WRAPPER.toUpperCase().replace('0X', '0x'),
      },
      { fetch: rpc.fetch, log: silent },
    );
    expect(started.url).toBe(`http://127.0.0.1:${port}`);
    expect(started.signer).toBe(SIGNER);
    const get = (path: string) => fetch(`${started?.url ?? ''}${path}`);

    const chains = (await (await get('/v1/chains')).json()) as Record<string, unknown>[];
    expect(chains).toEqual([
      {
        key: 'evm:31337',
        name: 'Local test chain (not a real network)',
        family: 'evm',
        nativeSymbol: 'ETH',
        nativeDecimals: 18,
        explorer: '',
        quoting: true,
        balances: true,
      },
    ]);
    const tokens = (await (await get('/v1/tokens?chain=evm:31337')).json()) as { symbol: string }[];
    expect(tokens.map((t) => t.symbol)).toEqual(['ETH', 'hUSDC', 'hWETH']);
    expect((await get('/v1/tokens?chain=evm:1')).status).toBe(200); // the registry is still there

    const balances = await fetch(`${started.url}/v1/balances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'evm:31337', address: USER }),
    });
    expect(await balances.json()).toEqual({
      chain: 'evm:31337',
      address: USER,
      blockNumber: '12',
      balances: [
        { address: 'native', balance: '7000000000000000000' },
        { address: PINNED.hUSDC.toLowerCase(), balance: '2994000000' },
        { address: PINNED.hWETH.toLowerCase(), balance: '0' },
      ],
    });
    // No Multicall3 on plain anvil: the individual-call path, pinned to one block.
    expect(rpc.calls.some((c) => c.method === 'eth_getBlockByNumber')).toBe(true);

    const res = await fetch(`${started.url}/v1/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sellToken: { chain: 'evm:31337', address: PINNED.hWETH },
        buyToken: { chain: 'evm:31337', address: PINNED.hUSDC },
        sellAmount: (10n ** 18n).toString(),
        taker: USER,
        slippageBps: 50,
      }),
    });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as {
      fee: { bps: number; amount: string };
      sellChain: string;
      buyChain: string;
      chainId: number;
      serverTime: number;
      ttlSeconds: number;
      swap: { quote: Record<string, string>; signature: Hex; transaction: { to: string } };
    };
    expect(answer.fee).toMatchObject({ bps: 20, amount: '2000000000000000' });
    expect([answer.sellChain, answer.buyChain, answer.chainId]).toEqual([
      'evm:31337',
      'evm:31337',
      31337,
    ]);
    expect(BigInt(answer.swap.quote.deadline ?? '0')).toBe(
      BigInt(answer.serverTime + answer.ttlSeconds),
    );
    expect(answer.swap.transaction.to).toBe(getAddress(WRAPPER));
    const q = answer.swap.quote;
    const quote: SwapQuote = {
      user: q.user as Hex,
      tokenIn: q.tokenIn as Hex,
      tokenOut: q.tokenOut as Hex,
      amountIn: BigInt(q.amountIn ?? '0'),
      minAmountOut: BigInt(q.minAmountOut ?? '0'),
      feeAmount: BigInt(q.feeAmount ?? '0'),
      router: q.router as Hex,
      routerCalldataHash: q.routerCalldataHash as Hex,
      nonce: BigInt(q.nonce ?? '0'),
      deadline: BigInt(q.deadline ?? '0'),
    };
    expect(quote.router).toBe(PINNED.allowanceHolder);
    const recovered = await recoverTypedDataAddress({
      ...typedData(quote, 31337, getAddress(WRAPPER)),
      signature: answer.swap.signature,
    });
    expect(recovered).toBe(SIGNER);
  });

  it('a pair on a registry chain is never signed by the harness', async () => {
    const { rpc, env } = await setup();
    started = await startHarnessApi(env, { fetch: rpc.fetch, log: silent });
    const res = await fetch(`${started.url}/v1/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sellToken: { chain: 'evm:8453', address: 'native' },
        buyToken: { chain: 'evm:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
        sellAmount: '1000',
        taker: USER,
        slippageBps: 50,
      }),
    });
    // The fixed oracle prices 31337 only, so nothing is even quoted.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'price_unavailable' });
  });

  it('a port already in use: the start fails and nothing is left open', async () => {
    const { rpc, env, port } = await setup();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', () => r()));
    try {
      await expect(startHarnessApi(env, { fetch: rpc.fetch, log: silent })).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
