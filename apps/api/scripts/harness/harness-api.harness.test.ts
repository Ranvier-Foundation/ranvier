/**
 * LOCAL TEST HARNESS ONLY (ADR 0013, work breakdown row 4). Runs with `pnpm harness:smoke` and
 * `pnpm --filter @ranvier/api harness:api:test`; skipped, with a message, when anvil or forge is
 * not installed. Not part of `pnpm test`.
 *
 * Its own anvil on a free 127.0.0.1 port (chain 31337), `DeployHarness.s.sol`, then the real
 * harness API entry (`startHarnessApi`, in process) on another free loopback port. Everything goes
 * over HTTP: GET /v1/chains and /v1/tokens, POST /v1/balances for the funded user, POST /v1/quotes
 * for hWETH -> hUSDC; then the user (anvil account 2, a PUBLIC anvil key, chain 31337 only) sends
 * the exact-amount approval and the returned swap transaction, and the chain is checked as in the
 * smoke's scenario 1. Last, `feeSigner` is rotated on chain: a new harness start is refused and the
 * running one stops signing, until the chain is reverted.
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Hex,
} from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FeeSignerCheckError } from '../../src/fee-signer-check.js';
import { devAccounts } from '../../src/harness/dev-accounts.js';
import { PINNED } from '../../src/harness/pinned.js';
import { startHarnessApi, type HarnessApi } from '../../src/harness/start.js';
import {
  deployHarness,
  findFoundry,
  freeLoopbackPort,
  startAnvil,
  type AnvilHandle,
} from './anvil.js';

const foundry = findFoundry();
if (!foundry) {
  console.warn(
    'harness API test SKIPPED: anvil and forge were not found on PATH or in ~/.foundry/bin. ' +
      'Install Foundry (https://getfoundry.sh) to run it.',
  );
}

const TOKEN_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function mint(address, uint256)',
]);
const WRAPPER_ABI = parseAbi([
  'function nonceUsed(address user, uint256 nonce) view returns (bool)',
  'function setFeeSigner(address newSigner)',
]);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Answer {
  fee: { bps: number; reason: string; amount: string };
  best: { provider: string; buyAmount: string; minBuyAmount: string };
  sellChain: string;
  buyChain: string;
  chainId: number;
  serverTime: number;
  ttlSeconds: number;
  swap: {
    quote: Record<string, string>;
    signature: Hex;
    transaction: { to: Hex; data: Hex; value: string };
  };
}

describe.skipIf(!foundry)('harness API over HTTP on a fresh anvil (chain 31337)', () => {
  let anvil: AnvilHandle | undefined;
  let api: HarnessApi | undefined;
  let env: Record<string, string> = {};
  const accounts = devAccounts();
  const user = accounts.user.address;

  const clients = () => {
    if (!anvil) throw new Error('anvil not started');
    const chain = defineChain({
      id: 31337,
      name: 'anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvil.url] } },
    });
    const transport = http(anvil.url, { fetchOptions: { redirect: 'error' }, retryCount: 0 });
    return {
      pub: createPublicClient({ chain, transport, pollingInterval: 100 }),
      wallet: createWalletClient({
        account: accounts.user,
        chain,
        transport,
        pollingInterval: 100,
      }),
      // Anvil's unlocked account 0 (owner): eth_sendTransaction, no key.
      owner: createWalletClient({ account: accounts.deployer, chain, transport }),
      test: createTestClient({ chain, transport, mode: 'anvil' }),
    };
  };

  const call = async (path: string, body?: unknown): Promise<Response> => {
    if (!api) throw new Error('harness API not started');
    return fetch(`${api.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  };

  beforeAll(async () => {
    if (!foundry) return;
    anvil = await startAnvil(foundry, await freeLoopbackPort());
    await deployHarness(foundry, anvil.url);
    env = {
      RANVIER_ENV: 'harness',
      ZEROX_CHAIN_IDS: '31337',
      RPC_URLS_EVM_31337: anvil.url,
      PORT: String(await freeLoopbackPort()),
    };
    api = await startHarnessApi(env, { log: silent });
  }, 16 * 60_000);

  afterAll(async () => {
    await api?.close();
    await anvil?.stop();
  });

  it('listens on loopback and lists chain 31337 only', async () => {
    expect(api?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const chains = (await (await call('/v1/chains')).json()) as Record<string, unknown>[];
    expect(chains).toEqual([
      expect.objectContaining({ key: 'evm:31337', quoting: true, balances: true }),
    ]);
    const tokens = (await (await call('/v1/tokens?chain=evm:31337')).json()) as {
      symbol: string;
      address: string;
    }[];
    expect(tokens.map((t) => [t.symbol, t.address])).toEqual([
      ['ETH', 'native'],
      ['hUSDC', PINNED.hUSDC.toLowerCase()],
      ['hWETH', PINNED.hWETH.toLowerCase()],
    ]);
  });

  it('POST /v1/balances reads the funded user at one block (no Multicall3 on anvil)', async () => {
    const { pub, wallet } = clients();
    expect(await pub.getCode({ address: '0xcA11bde05977b3631167028862bE2a173976CA11' })).toBe(
      undefined,
    );
    const hash = await wallet.writeContract({
      address: PINNED.hWETH,
      abi: TOKEN_ABI,
      functionName: 'mint',
      args: [user, 10n ** 18n],
    });
    await pub.waitForTransactionReceipt({ hash });
    const res = await call('/v1/balances', { chain: 'evm:31337', address: user });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      blockNumber: string;
      balances: { address: string; balance: string | null }[];
    };
    const block = BigInt(body.blockNumber);
    const [native, usdc, weth] = await Promise.all([
      pub.getBalance({ address: user, blockNumber: block }),
      pub.readContract({
        address: PINNED.hUSDC,
        abi: TOKEN_ABI,
        functionName: 'balanceOf',
        args: [user],
        blockNumber: block,
      }),
      pub.readContract({
        address: PINNED.hWETH,
        abi: TOKEN_ABI,
        functionName: 'balanceOf',
        args: [user],
        blockNumber: block,
      }),
    ]);
    expect(weth).toBeGreaterThanOrEqual(10n ** 18n);
    expect(body.balances).toEqual([
      { address: 'native', balance: native.toString() },
      { address: PINNED.hUSDC.toLowerCase(), balance: usdc.toString() },
      { address: PINNED.hWETH.toLowerCase(), balance: weth.toString() },
    ]);
  });

  let answer: Answer | undefined;

  it('POST /v1/quotes, then approve exactly and send the swap: scenario 1 outcomes', async () => {
    const { pub, wallet } = clients();
    const amountIn = 10n ** 18n;
    const res = await call('/v1/quotes', {
      sellToken: { chain: 'evm:31337', address: PINNED.hWETH },
      buyToken: { chain: 'evm:31337', address: PINNED.hUSDC },
      sellAmount: amountIn.toString(),
      taker: user,
      slippageBps: 50,
    });
    expect(res.status).toBe(200);
    answer = (await res.json()) as Answer;
    const q = answer.swap.quote;
    const tx = answer.swap.transaction;
    // The echo (ADR 0012) and the signed values.
    expect([answer.sellChain, answer.buyChain, answer.chainId]).toEqual([
      'evm:31337',
      'evm:31337',
      31337,
    ]);
    expect(BigInt(q.deadline ?? '')).toBe(BigInt(answer.serverTime + answer.ttlSeconds));
    expect(answer.fee).toMatchObject({ bps: 20, reason: 'tier-under-10k' });
    expect(q.feeAmount).toBe(answer.fee.amount);
    expect(q.minAmountOut).toBe(answer.best.minBuyAmount);
    expect(isAddressEqual(q.router as Hex, PINNED.allowanceHolder)).toBe(true);
    expect(isAddressEqual(tx.to, PINNED.feeWrapper)).toBe(true);
    expect(tx.value).toBe('0');

    const collector = accounts.collector;
    const read = (token: Hex, who: Hex) =>
      pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [who] });
    const [inBefore, outBefore, feeBefore] = await Promise.all([
      read(PINNED.hWETH, user),
      read(PINNED.hUSDC, user),
      read(PINNED.hWETH, collector),
    ]);
    const approve = await wallet.sendTransaction({
      to: PINNED.hWETH,
      data: encodeFunctionData({
        abi: TOKEN_ABI,
        functionName: 'approve',
        args: [tx.to, amountIn],
      }),
    });
    expect((await pub.waitForTransactionReceipt({ hash: approve })).status).toBe('success');
    const swap = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value),
    });
    expect((await pub.waitForTransactionReceipt({ hash: swap })).status).toBe('success');

    const [inAfter, outAfter, feeAfter] = await Promise.all([
      read(PINNED.hWETH, user),
      read(PINNED.hUSDC, user),
      read(PINNED.hWETH, collector),
    ]);
    expect(inBefore - inAfter).toBe(amountIn);
    expect(outAfter - outBefore).toBeGreaterThanOrEqual(BigInt(q.minAmountOut ?? ''));
    expect(feeAfter - feeBefore).toBe(BigInt(q.feeAmount ?? ''));
    // The wrapper keeps nothing: no token, no ETH, no allowance to the holder or from the user.
    for (const token of [PINNED.hWETH, PINNED.hUSDC]) {
      expect(await read(token, PINNED.feeWrapper)).toBe(0n);
      const left = await pub.readContract({
        address: token,
        abi: TOKEN_ABI,
        functionName: 'allowance',
        args: [PINNED.feeWrapper, PINNED.allowanceHolder],
      });
      expect(left).toBe(0n);
    }
    expect(await pub.getBalance({ address: PINNED.feeWrapper })).toBe(0n);
    const userAllowance = await pub.readContract({
      address: PINNED.hWETH,
      abi: TOKEN_ABI,
      functionName: 'allowance',
      args: [user, PINNED.feeWrapper],
    });
    expect(userAllowance).toBe(0n);
    const used = await pub.readContract({
      address: PINNED.feeWrapper,
      abi: WRAPPER_ABI,
      functionName: 'nonceUsed',
      args: [user, BigInt(q.nonce ?? '')],
    });
    expect(used).toBe(true);
    expect(q.tokenIn).not.toBe(zeroAddress);
  });

  it('feeSigner rotated on chain: a new start is refused, the running API stops signing', async () => {
    const { pub, owner, test } = clients();
    const snapshot = await test.snapshot();
    try {
      const hash = await owner.writeContract({
        address: PINNED.feeWrapper,
        abi: WRAPPER_ABI,
        functionName: 'setFeeSigner',
        args: [getAddress(accounts.collector)],
      });
      expect((await pub.waitForTransactionReceipt({ hash })).status).toBe('success');

      const second = await startHarnessApi(
        { ...env, PORT: String(await freeLoopbackPort()) },
        { log: silent },
      ).catch((e: unknown) => e);
      expect(second).toBeInstanceOf(FeeSignerCheckError);
      expect((second as Error).message).toContain('fee_signer_differs');

      await api?.refreshSignerCheck();
      const res = await call('/v1/quotes', {
        sellToken: { chain: 'evm:31337', address: PINNED.hWETH },
        buyToken: { chain: 'evm:31337', address: PINNED.hUSDC },
        sellAmount: (10n ** 18n).toString(),
        taker: user,
        slippageBps: 50,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'signing_unavailable' });
    } finally {
      await test.revert({ id: snapshot });
    }
    await api?.refreshSignerCheck();
    const again = await call('/v1/quotes', {
      sellToken: { chain: 'evm:31337', address: PINNED.hWETH },
      buyToken: { chain: 'evm:31337', address: PINNED.hUSDC },
      sellAmount: (10n ** 18n).toString(),
      taker: user,
      slippageBps: 50,
    });
    expect(again.status).toBe(200);
  });
});
