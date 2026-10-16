/**
 * LOCAL TEST HARNESS ONLY (ADR 0013, work breakdown row 2). Never imported by `src/`, never built
 * into `dist/`.
 *
 * `RANVIER_HARNESS_RPC_URL=http://127.0.0.1:<port> pnpm --filter @ranvier/api harness:smoke:rpc`
 * runs this against an anvil (chain 31337) where `contracts/test/harness/DeployHarness.s.sol` has
 * deployed the mocks and the real FeeWrapper (docs/runbooks/local-harness.md, manual steps).
 * `pnpm harness:smoke` does the same on its own fresh anvil (`smoke.harness.test.ts`).
 *
 * It drives the API's own code, unchanged and not copied: `quoteFee`, `usdCents`,
 * `compareProviderQuotes` with `vetRoute`, `buildRoutePolicy`, `LocalKeySigner`, `canSignChain`,
 * `signedDeadline`, `buildSignedSwap`, `signedAnswerEcho` and, once, the whole `POST /v1/quotes`
 * handler in process. Only the provider and the oracle are harness stand-ins (`fixtures.ts`). The
 * user's transactions are signed locally with EIP-155 chain ID 31337 and sent; every scenario
 * asserts on-chain state (balances, allowances, nonces, receipts, revert selectors), not logs.
 *
 * Refusals come first, before any client exists: the URL must be loopback (`rpc-guard.ts`), then
 * the endpoint must answer chain ID 31337, then the pinned contracts must be on chain with the
 * expected EIP-712 domain, fee signer, collector and router allowlist. Keys are PUBLIC anvil keys,
 * chain 31337 only, derived in memory from the published mnemonic (`dev-accounts.ts`).
 */
import { NATIVE } from '@ranvier/chains';
import { quoteFee } from '@ranvier/fees';
import type { FeeQuote, ProviderQuote, QuoteRequest } from '@ranvier/types';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  BaseError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { LocalKeySigner } from '../../src/adapters/signers/local-key.js';
import { SETTLER_ABI } from '../../src/domain/allowance-holder.js';
import { compareProviderQuotes } from '../../src/domain/orchestrator.js';
import {
  QuoteEchoMismatchError,
  signedAnswerEcho,
  signedDeadline,
  type QuoteTiming,
  type SignedAnswerEcho,
} from '../../src/domain/quote-answer.js';
import { buildRoutePolicy } from '../../src/domain/route-policy.js';
import { UnsafeRouteError, vetRoute, type VettedRoute } from '../../src/domain/route-safety.js';
import {
  buildSignedSwap,
  FEE_WRAPPER_ABI,
  quoteDigest,
  typedData,
  type SignedSwap,
  type SwapQuote,
} from '../../src/domain/swap-quote.js';
import { usdCents } from '../../src/domain/usd.js';
import { buildServer } from '../../src/http/server.js';
import { canSignChain } from '../../src/signing-policy.js';
import { devAccounts, publicAnvilKey } from './dev-accounts.js';
import { FixedPriceOracle, HarnessQuoteProvider, zeroXCalldata } from './fixtures.js';
import {
  HARNESS_CHAIN_ID,
  HARNESS_CHAIN_KEY,
  PINNED,
  WRAPPER_DOMAIN,
  type PinnedName,
} from './pinned.js';
import { assertLoopbackRpcUrl, RPC_URL_ENV, verifyLocalChain } from './rpc-guard.js';

/** `NonceAlreadyUsed()` as the runbook and ADR 0013 record it. */
export const NONCE_ALREADY_USED_SELECTOR = '0x1fb09b80';

const TTL_SECONDS = 60;
const SLIPPAGE_BPS = 50;
const MAX_ORACLE_DEVIATION_BPS = 500;
const PROVIDER_TIMEOUT_MS = 2_500;
/** Gas for a transaction that is expected to revert (skips estimation, so it is mined). */
const REVERT_GAS = 3_000_000n;

const WRAPPER_ABI = [
  ...FEE_WRAPPER_ABI,
  ...parseAbi([
    'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
    'function feeSigner() view returns (address)',
    'function feeCollector() view returns (address)',
    'function paused() view returns (bool)',
    'function isRouterAllowed(address router) view returns (bool)',
    'function nonceUsed(address user, uint256 nonce) view returns (bool)',
    'function hashQuote((address user, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 feeAmount, address router, bytes32 routerCalldataHash, uint256 nonce, uint256 deadline) q) view returns (bytes32)',
    'event RouterSet(address indexed router, bool allowed)',
  ]),
] as const;

const TOKEN_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]);

/** FeeWrapper errors the scenarios expect, by name (selector = keccak256("Name()")[0..4]). */
type WrapperError =
  | 'NonceAlreadyUsed'
  | 'InsufficientOutput'
  | 'QuoteExpired'
  | 'InvalidSignature'
  | 'RouterNotAllowed';

export interface ScenarioResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeReport {
  ok: boolean;
  results: ScenarioResult[];
}

export interface SmokeOptions {
  log?: (line: string) => void;
}

class SmokeAssertionError extends Error {
  override readonly name = 'SmokeAssertionError';
}

function check(cond: boolean, message: string): asserts cond {
  if (!cond) throw new SmokeAssertionError(message);
}

function randomNonce(): bigint {
  return BigInt(`0x${randomBytes(32).toString('hex')}`);
}

const lower = (a: string): string => a.toLowerCase();
const WRAPPER = getAddress(PINNED.feeWrapper);
const HOLDER = getAddress(PINNED.allowanceHolder);
const SETTLER = getAddress(PINNED.settler);

/** Everything a scenario needs; built only after the URL and chain checks passed. */
async function connect(url: string) {
  const chain = defineChain({
    id: HARNESS_CHAIN_ID,
    name: 'Local test chain (not a real network)',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  // Redirects refused, no retries: a loopback endpoint cannot hand a request on.
  const transport = http(url, { fetchOptions: { redirect: 'error' }, retryCount: 0 });
  const accounts = devAccounts();
  const pub = createPublicClient({ chain, transport, pollingInterval: 100 });
  const wallet = createWalletClient({
    account: accounts.user,
    chain,
    transport,
    pollingInterval: 100,
  });
  const test = createTestClient({ chain, transport, mode: 'anvil' });
  // Allowed for chain 31337 ONLY, never the default list (which includes three testnets).
  const signer = new LocalKeySigner(publicAnvilKey(accounts.feeSigner), {
    allowedChainIds: [HARNESS_CHAIN_ID],
  });
  const policy = buildRoutePolicy({
    [HARNESS_CHAIN_ID]: [
      {
        kind: 'zerox-allowance-holder',
        address: PINNED.allowanceHolder,
        targets: [PINNED.settler],
      },
    ],
  });
  return {
    pub,
    wallet,
    test,
    accounts,
    signer,
    policy,
    provider: new HarnessQuoteProvider(),
    oracle: new FixedPriceOracle(),
  };
}

type Env = Awaited<ReturnType<typeof connect>>;

interface Tx {
  to: Hex;
  data: Hex;
  value: bigint;
}

// ------------------------------------------------------------------ chain helpers

async function send(env: Env, tx: Tx, gas?: bigint): Promise<TransactionReceipt> {
  const hash = await env.wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    ...(gas === undefined ? {} : { gas }),
  });
  return env.pub.waitForTransactionReceipt({ hash });
}

async function sendOk(env: Env, tx: Tx, what: string): Promise<TransactionReceipt> {
  const receipt = await send(env, tx);
  check(receipt.status === 'success', `${what}: transaction reverted`);
  return receipt;
}

function tokenTx(token: Hex, data: Hex): Tx {
  return { to: token, data, value: 0n };
}

async function mint(env: Env, token: Hex, amount: bigint): Promise<void> {
  const data = encodeFunctionData({
    abi: TOKEN_ABI,
    functionName: 'mint',
    args: [env.accounts.user.address, amount],
  });
  await sendOk(env, tokenTx(token, data), 'mint');
}

/** Exact-amount approval to the wrapper, never unlimited; asserts the allowance on chain. */
async function approveWrapper(env: Env, token: Hex, amount: bigint): Promise<void> {
  const data = encodeFunctionData({
    abi: TOKEN_ABI,
    functionName: 'approve',
    args: [WRAPPER, amount],
  });
  await sendOk(env, tokenTx(token, data), 'approve');
  const allowance = await allowanceOf(env, token, env.accounts.user.address, WRAPPER);
  check(allowance === amount, `allowance to the wrapper is ${allowance}, expected ${amount}`);
}

function balanceOf(env: Env, token: Hex | 'eth', who: Hex): Promise<bigint> {
  if (token === 'eth') return env.pub.getBalance({ address: who });
  return env.pub.readContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: 'balanceOf',
    args: [who],
  });
}

function allowanceOf(env: Env, token: Hex, owner: Hex, spender: Hex): Promise<bigint> {
  return env.pub.readContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  });
}

function nonceUsed(env: Env, nonce: bigint): Promise<boolean> {
  return env.pub.readContract({
    address: WRAPPER,
    abi: WRAPPER_ABI,
    functionName: 'nonceUsed',
    args: [env.accounts.user.address, nonce],
  });
}

/** Hex revert data on an error, as viem attaches it (`data` or `data.data`). */
function revertDataOf(e: unknown): Hex | undefined {
  const data = field(e, 'data');
  const hex = typeof data === 'string' ? data : field(data, 'data');
  return typeof hex === 'string' && /^0x[0-9a-fA-F]{8}/.test(hex) ? (hex as Hex) : undefined;
}

/** The 4-byte selector of the revert behind a viem error, from the first error carrying data. */
function revertSelector(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const carrier = err.walk((e) => revertDataOf(e) !== undefined);
  const data = revertDataOf(carrier);
  return data === undefined ? undefined : (lower(data.slice(0, 10)) as Hex);
}

/** eth_call as the user: undefined on success, else the revert selector (or 'no-data'). */
async function simulate(env: Env, tx: Tx): Promise<Hex | 'no-data' | undefined> {
  try {
    await env.pub.call({
      account: env.accounts.user.address,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    return undefined;
  } catch (err: unknown) {
    return revertSelector(err) ?? 'no-data';
  }
}

function errorSelector(name: WrapperError): Hex {
  return toFunctionSelector(`${name}()`);
}

/**
 * The wrapper refuses `tx` with `name`: first the revert selector from eth_call, then the same
 * transaction mined (gas given, so nothing is estimated away) with a reverted receipt.
 */
async function expectWrapperRevert(env: Env, tx: Tx, name: WrapperError): Promise<void> {
  const selector = await simulate(env, tx);
  check(
    selector === errorSelector(name),
    `expected ${name} (${errorSelector(name)}), got ${selector ?? 'success'}`,
  );
  const receipt = await send(env, tx, REVERT_GAS);
  check(receipt.status === 'reverted', `mined transaction did not revert with ${name}`);
}

/** Balances and nonce a refused swap must leave untouched. */
async function swapState(env: Env, q: SwapQuote): Promise<string> {
  const user = env.accounts.user.address;
  const values = await Promise.all([
    balanceOf(env, q.tokenIn, user),
    balanceOf(env, q.tokenOut, user),
    balanceOf(env, q.tokenIn, env.accounts.collector),
    balanceOf(env, q.tokenIn, WRAPPER),
    balanceOf(env, q.tokenOut, WRAPPER),
    balanceOf(env, 'eth', WRAPPER),
    allowanceOf(env, q.tokenIn, user, WRAPPER),
    nonceUsed(env, q.nonce),
  ]);
  return values.map(String).join(',');
}

/** The wrapper never keeps funds: 0 of both tokens, 0 ETH, 0 allowance to the holder. */
async function expectWrapperEmpty(env: Env, tokens: readonly Hex[]): Promise<void> {
  for (const token of tokens) {
    if (token === zeroAddress) continue;
    check((await balanceOf(env, token, WRAPPER)) === 0n, `wrapper holds ${token}`);
    const left = await allowanceOf(env, token, WRAPPER, HOLDER);
    check(left === 0n, `wrapper allowance to the holder is ${left}, not 0`);
  }
  check((await balanceOf(env, 'eth', WRAPPER)) === 0n, 'wrapper holds ETH');
}

// ------------------------------------------------------------------ the API flow

interface Quoted {
  request: QuoteRequest;
  fee: FeeQuote;
  route: VettedRoute;
  swap: SignedSwap;
  timing: QuoteTiming;
  echo: SignedAnswerEcho;
}

function harnessRequest(env: Env, sell: string, buy: string, sellAmount: bigint): QuoteRequest {
  return {
    sellToken: { chain: HARNESS_CHAIN_KEY, address: sell === NATIVE ? NATIVE : lower(sell) },
    buyToken: { chain: HARNESS_CHAIN_KEY, address: buy === NATIVE ? NATIVE : lower(buy) },
    sellAmount,
    taker: lower(env.accounts.user.address),
    slippageBps: SLIPPAGE_BPS,
  };
}

interface Priced {
  request: QuoteRequest;
  fee: FeeQuote;
  netSell: QuoteRequest;
  vet: (quote: ProviderQuote) => VettedRoute;
}

/** As POST /v1/quotes: trusted prices first, then the fee, then the request net of the fee. */
async function priceAndFee(env: Env, request: QuoteRequest): Promise<Priced> {
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const [sellPrice, buyPrice] = await Promise.all([
    env.oracle.price(request.sellToken, signal),
    env.oracle.price(request.buyToken, signal),
  ]);
  const fee = quoteFee({
    ...request,
    usdValue: usdCents(sellPrice, request.sellAmount),
    isFirstSwap: false,
  });
  const netSell = { ...request, sellAmount: request.sellAmount - fee.amount };
  const vet = (quote: ProviderQuote): VettedRoute =>
    vetRoute(
      {
        request: netSell,
        sellPrice,
        buyPrice,
        policy: env.policy,
        maxOracleDeviationBps: MAX_ORACLE_DEVIATION_BPS,
      },
      quote,
    );
  return { request, fee, netSell, vet };
}

/** Quote, vet, sign and echo exactly as the /v1/quotes handler does, with the real functions. */
async function quoteAndSign(env: Env, request: QuoteRequest): Promise<Quoted> {
  const { fee, netSell, vet } = await priceAndFee(env, request);
  const failures: unknown[] = [];
  const comparison = await compareProviderQuotes([env.provider], netSell, {
    timeoutMs: PROVIDER_TIMEOUT_MS,
    vet,
    onFailure: (_failure, err) => failures.push(err),
  });
  const route = comparison.best;
  if (!route) {
    const reason = failures[0] instanceof UnsafeRouteError ? failures[0].reason : 'no route';
    throw new SmokeAssertionError(`no vetted route: ${reason}`);
  }
  check(canSignChain(env.signer, env.policy, HARNESS_CHAIN_ID), 'canSignChain refused 31337');
  const timing: QuoteTiming = {
    serverTime: Math.floor(Date.now() / 1000),
    ttlSeconds: TTL_SECONDS,
  };
  const swap = await buildSignedSwap({
    request,
    fee,
    route,
    feeWrapper: WRAPPER,
    signer: env.signer,
    deadline: signedDeadline(timing),
    nonce: randomNonce(),
  });
  const echo = signedAnswerEcho(request, swap, timing);
  return { request, fee, route, swap, timing, echo };
}

function swapTx(quoted: Pick<Quoted, 'swap'>): Tx {
  const { to, data, value } = quoted.swap.transaction;
  return { to, data, value };
}

/** The wrapper call for `quote`, signed with `signature`, as `buildSignedSwap` encodes it. */
function wrapperCall(quote: SwapQuote, signature: Hex, routerCalldata: Hex): Tx {
  const data = encodeFunctionData({
    abi: FEE_WRAPPER_ABI,
    functionName: 'swap',
    args: [quote, signature, routerCalldata],
  });
  return { to: WRAPPER, data, value: quote.tokenIn === zeroAddress ? quote.amountIn : 0n };
}

// ------------------------------------------------------------------ scenarios

/** 0. The pinned table is what is on chain, before anything is sent. */
async function preflight(env: Env): Promise<string> {
  const chainId = await env.pub.getChainId();
  check(chainId === HARNESS_CHAIN_ID, `chain ID ${chainId}`);
  for (const name of Object.keys(PINNED) as PinnedName[]) {
    const code = await env.pub.getCode({ address: PINNED[name] });
    check(code !== undefined && code !== '0x', `no code at the pinned ${name} address`);
  }
  const [, name, version, domainChainId, verifyingContract] = await env.pub.readContract({
    address: WRAPPER,
    abi: WRAPPER_ABI,
    functionName: 'eip712Domain',
  });
  check(name === WRAPPER_DOMAIN.name, `eip712Domain name ${name}`);
  check(version === WRAPPER_DOMAIN.version, `eip712Domain version ${version}`);
  check(domainChainId === BigInt(HARNESS_CHAIN_ID), `eip712Domain chainId ${domainChainId}`);
  check(isAddressEqual(verifyingContract, WRAPPER), 'eip712Domain verifyingContract');

  const read = <F extends 'feeSigner' | 'feeCollector'>(functionName: F) =>
    env.pub.readContract({ address: WRAPPER, abi: WRAPPER_ABI, functionName });
  const feeSigner = await read('feeSigner');
  check(isAddressEqual(feeSigner, env.signer.address), 'feeSigner() is not the LocalKeySigner');
  check(
    isAddressEqual(env.signer.address, env.accounts.feeSigner.address),
    'signer is not anvil account 1',
  );
  check(isAddressEqual(await read('feeCollector'), env.accounts.collector), 'feeCollector()');
  const paused = await env.pub.readContract({
    address: WRAPPER,
    abi: WRAPPER_ABI,
    functionName: 'paused',
  });
  check(!paused, 'wrapper is paused');

  // The router allowlist is a mapping; rebuild it from every RouterSet event since genesis.
  const logs = await env.pub.getContractEvents({
    address: WRAPPER,
    abi: WRAPPER_ABI,
    eventName: 'RouterSet',
    fromBlock: 0n,
    toBlock: 'latest',
  });
  const allowed = new Set<string>();
  for (const log of logs) {
    const { router, allowed: on } = log.args;
    if (router === undefined) continue;
    if (on) allowed.add(lower(router));
    else allowed.delete(lower(router));
  }
  check(
    allowed.size === 1 && allowed.has(lower(HOLDER)),
    `router allowlist is [${[...allowed].join(', ')}], expected exactly the mock holder`,
  );
  for (const [router, expected] of [
    [HOLDER, true],
    [SETTLER, false],
  ] as const) {
    const on = await env.pub.readContract({
      address: WRAPPER,
      abi: WRAPPER_ABI,
      functionName: 'isRouterAllowed',
      args: [router],
    });
    check(on === expected, `isRouterAllowed(${router}) is ${on}`);
  }

  // Signing gates (ADR 0004, 0005): 31337 only, never a mainnet, never the default list.
  check(canSignChain(env.signer, env.policy, HARNESS_CHAIN_ID), 'canSignChain(31337) is false');
  check(!canSignChain(env.signer, env.policy, 8453), 'canSignChain(8453) is true');
  for (const id of [1, 8453, 84532, 11155111, 421614]) {
    check(!env.signer.canSign(id), `the harness signer accepts chain ${id}`);
  }
  let refused = false;
  try {
    new LocalKeySigner(publicAnvilKey(env.accounts.feeSigner), { allowedChainIds: [8453] });
  } catch {
    refused = true;
  }
  check(refused, 'a LocalKeySigner allowed for [8453] was constructed');
  return `pinned contracts, domain (${name} v${version}, 31337), feeSigner, collector, allowlist {holder}`;
}

/** 1. Happy path through the real functions: approve exactly, swap, check every balance. */
async function happyPath(env: Env): Promise<{ detail: string; quoted: Quoted }> {
  const amountIn = 10n ** 18n; // 1 hWETH
  const quoted = await quoteAndSign(env, harnessRequest(env, PINNED.hWETH, PINNED.hUSDC, amountIn));
  const q = quoted.swap.quote;
  check(quoted.fee.bps === 20 && quoted.fee.reason === 'tier-under-10k', 'fee tier');
  check(q.feeAmount === quoted.fee.amount && q.feeAmount === 2n * 10n ** 15n, 'signed fee');
  check(isAddressEqual(q.router, HOLDER), 'signed router is not the mock holder');
  check(quoted.swap.transaction.value === 0n, 'ERC-20 input must send no value');
  check(isAddressEqual(quoted.swap.transaction.to, WRAPPER), 'transaction is not to the wrapper');
  // The TypeScript digest equals the contract's own hashQuote.
  const onChainDigest = await env.pub.readContract({
    address: WRAPPER,
    abi: WRAPPER_ABI,
    functionName: 'hashQuote',
    args: [q],
  });
  check(
    onChainDigest === quoteDigest(q, HARNESS_CHAIN_ID, WRAPPER),
    'digest differs from hashQuote',
  );
  check(
    quoted.echo.chainId === HARNESS_CHAIN_ID &&
      quoted.echo.sellChain === HARNESS_CHAIN_KEY &&
      quoted.echo.buyChain === HARNESS_CHAIN_KEY &&
      BigInt(quoted.echo.serverTime + quoted.echo.ttlSeconds) === q.deadline,
    'answer echo',
  );

  await mint(env, PINNED.hWETH, amountIn);
  const out = await executeAndCheck(env, quoted);
  return {
    detail: `paid 1 hWETH, received ${out} hUSDC (min ${q.minAmountOut}), fee ${q.feeAmount}`,
    quoted,
  };
}

/**
 * Approves exactly `amountIn` (ERC-20), sends the signed swap as the user and checks: the user got
 * at least the signed minimum, spent exactly `amountIn`, the collector got exactly the signed fee,
 * the nonce is used and the wrapper is empty. Returns the output received.
 */
async function executeAndCheck(env: Env, quoted: Pick<Quoted, 'swap'>): Promise<bigint> {
  const q = quoted.swap.quote;
  const user = env.accounts.user.address;
  const nativeIn = q.tokenIn === zeroAddress;
  const nativeOut = q.tokenOut === zeroAddress;
  const inToken = nativeIn ? 'eth' : q.tokenIn;
  const outToken = nativeOut ? 'eth' : q.tokenOut;
  if (!nativeIn) await approveWrapper(env, q.tokenIn, q.amountIn);
  check(!(await nonceUsed(env, q.nonce)), 'nonce already used before the swap');

  const [inBefore, outBefore, collectorBefore] = await Promise.all([
    balanceOf(env, inToken, user),
    balanceOf(env, outToken, user),
    balanceOf(env, inToken, env.accounts.collector),
  ]);
  const tx = swapTx(quoted);
  check(tx.value === (nativeIn ? q.amountIn : 0n), `value ${tx.value} for amountIn ${q.amountIn}`);
  const receipt = await sendOk(env, tx, 'swap');
  const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
  const [inAfter, outAfter, collectorAfter] = await Promise.all([
    balanceOf(env, inToken, user),
    balanceOf(env, outToken, user),
    balanceOf(env, inToken, env.accounts.collector),
  ]);

  const spent = inBefore - inAfter - (nativeIn ? gasPaid : 0n);
  const received = outAfter - outBefore + (nativeOut ? gasPaid : 0n);
  check(spent === q.amountIn, `user spent ${spent}, signed amountIn ${q.amountIn}`);
  check(received >= q.minAmountOut, `user received ${received} < signed minimum ${q.minAmountOut}`);
  check(
    collectorAfter - collectorBefore === q.feeAmount,
    'collector did not get exactly the signed fee',
  );
  check(await nonceUsed(env, q.nonce), 'nonce not marked used');
  if (!nativeIn) {
    check((await allowanceOf(env, q.tokenIn, user, WRAPPER)) === 0n, 'user allowance left over');
  }
  await expectWrapperEmpty(env, [q.tokenIn, q.tokenOut]);
  return received;
}

/** 2. The identical signed swap, sent again with balance and approval in place, reverts. */
async function replay(env: Env, quoted: Quoted): Promise<string> {
  check(errorSelector('NonceAlreadyUsed') === NONCE_ALREADY_USED_SELECTOR, 'selector drift');
  const q = quoted.swap.quote;
  await mint(env, q.tokenIn, q.amountIn);
  await approveWrapper(env, q.tokenIn, q.amountIn);
  const before = await swapState(env, q);
  await expectWrapperRevert(env, swapTx(quoted), 'NonceAlreadyUsed');
  check((await swapState(env, q)) === before, 'a refused replay changed balances');
  await approveWrapper(env, q.tokenIn, 0n);
  return `replay reverted ${NONCE_ALREADY_USED_SELECTOR} (NonceAlreadyUsed); balances unchanged`;
}

/** 3. A route 10% under the oracle is never signed; the same route would really underpay. */
async function oracleRefusal(env: Env): Promise<string> {
  const amountIn = 1_000n * 10n ** 6n;
  const request = harnessRequest(env, PINNED.hUSDC, PINNED.hORACLE, amountIn);
  const { fee, netSell, vet } = await priceAndFee(env, request);
  const route = await env.provider.quote(netSell, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
  let reason = 'accepted';
  try {
    vet(route);
  } catch (err: unknown) {
    reason = err instanceof UnsafeRouteError ? err.reason : String(err);
  }
  check(reason === 'below_oracle_value', `vetRoute: ${reason}`);
  // The whole quote path refuses too (nothing signed).
  let refused = '';
  try {
    await quoteAndSign(env, request);
  } catch (err: unknown) {
    refused = err instanceof Error ? err.message : String(err);
  }
  check(refused === 'no vetted route: below_oracle_value', `quote path: ${refused || 'signed'}`);

  // Control, on chain: the mock router really pays 90%. Signed outside the API (raw PUBLIC key),
  // simulated only: the wrapper would let it through, so vetRoute is the guard that matters here.
  const q: SwapQuote = {
    user: env.accounts.user.address,
    tokenIn: getAddress(PINNED.hUSDC),
    tokenOut: getAddress(PINNED.hORACLE),
    amountIn,
    minAmountOut: route.minBuyAmount,
    feeAmount: fee.amount,
    router: HOLDER,
    routerCalldataHash: keccak256(route.tx.data as Hex),
    nonce: randomNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000) + TTL_SECONDS),
  };
  const sig = await env.accounts.feeSigner.signTypedData(typedData(q, HARNESS_CHAIN_ID, WRAPPER));
  await mint(env, PINNED.hUSDC, amountIn);
  await approveWrapper(env, PINNED.hUSDC, amountIn);
  const { result } = await env.pub.simulateContract({
    account: env.accounts.user.address,
    address: WRAPPER,
    abi: WRAPPER_ABI,
    functionName: 'swap',
    args: [q, sig, route.tx.data as Hex],
  });
  const fair = amountIn - fee.amount;
  check(result * 10n === fair * 9n, `control: router paid ${result}, expected 90% of ${fair}`);
  await approveWrapper(env, PINNED.hUSDC, 0n);
  return `vetRoute refused below_oracle_value; unsigned route would have paid ${result} for ${fair}`;
}

/** 4. A vetted, signed route whose router underpays: the wrapper's own minimum check reverts. */
async function underpay(env: Env): Promise<string> {
  const amountIn = 1_000n * 10n ** 6n;
  const quoted = await quoteAndSign(
    env,
    harnessRequest(env, PINNED.hUSDC, PINNED.hUNDER, amountIn),
  );
  const q = quoted.swap.quote;
  await mint(env, PINNED.hUSDC, amountIn);
  await approveWrapper(env, PINNED.hUSDC, amountIn);
  const before = await swapState(env, q);
  await expectWrapperRevert(env, swapTx(quoted), 'InsufficientOutput');
  check((await swapState(env, q)) === before, 'a refused swap changed balances or the nonce');
  await approveWrapper(env, PINNED.hUSDC, 0n);
  return `signed min ${q.minAmountOut}, router paid min-1: InsufficientOutput from the wrapper; nothing moved`;
}

/** 5. A valid quote, sent after its deadline (chain time moved, then restored), reverts. */
async function expired(env: Env): Promise<string> {
  const amountIn = 10n ** 18n;
  const quoted = await quoteAndSign(env, harnessRequest(env, PINNED.hWETH, PINNED.hUSDC, amountIn));
  const q = quoted.swap.quote;
  await mint(env, PINNED.hWETH, amountIn);
  await approveWrapper(env, PINNED.hWETH, amountIn);
  check((await simulate(env, swapTx(quoted))) === undefined, 'control: the fresh quote must pass');

  const snapshot = await env.test.snapshot();
  try {
    await env.test.increaseTime({ seconds: TTL_SECONDS + 120 });
    await env.test.mine({ blocks: 1 });
    const latest = await env.pub.getBlock();
    check(latest.timestamp > q.deadline, 'chain time is not past the deadline');
    const before = await swapState(env, q);
    await expectWrapperRevert(env, swapTx(quoted), 'QuoteExpired');
    check((await swapState(env, q)) === before, 'an expired swap changed balances');
  } finally {
    await env.test.revert({ id: snapshot });
  }
  const restored = await env.pub.getBlock();
  check(restored.timestamp <= q.deadline, 'chain time was not restored');
  await approveWrapper(env, PINNED.hWETH, 0n);
  return 'QuoteExpired after the deadline; chain time restored by evm_revert';
}

/** 6. The same quote signed for chain 8453 is refused by the signer, the API and the wrapper. */
async function wrongChain(env: Env): Promise<string> {
  const amountIn = 10n ** 18n;
  const quoted = await quoteAndSign(env, harnessRequest(env, PINNED.hWETH, PINNED.hUSDC, amountIn));
  const q = quoted.swap.quote;
  const baseDomain = typedData(q, 8453, WRAPPER);

  let signerRefused = false;
  try {
    await env.signer.signTypedData(baseDomain);
  } catch {
    signerRefused = true;
  }
  check(signerRefused, 'LocalKeySigner signed for chain 8453');
  let builderRefused = '';
  try {
    const baseRequest: QuoteRequest = {
      ...quoted.request,
      sellToken: { ...quoted.request.sellToken, chain: 'evm:8453' },
      buyToken: { ...quoted.request.buyToken, chain: 'evm:8453' },
    };
    await buildSignedSwap({
      request: baseRequest,
      fee: quoted.fee,
      route: quoted.route,
      feeWrapper: WRAPPER,
      signer: env.signer,
      deadline: q.deadline,
      nonce: q.nonce,
    });
  } catch (err: unknown) {
    builderRefused = err instanceof Error ? err.message : String(err);
  }
  check(builderRefused === 'signer refuses chain 8453', `buildSignedSwap: ${builderRefused}`);

  // A signature over the 8453 domain (raw PUBLIC key, outside the API) on chain 31337.
  const sig = await env.accounts.feeSigner.signTypedData(baseDomain);
  const tx = wrapperCall(q, sig, quoted.route.tx.data as Hex);
  await mint(env, PINNED.hWETH, amountIn);
  await approveWrapper(env, PINNED.hWETH, amountIn);
  check((await simulate(env, swapTx(quoted))) === undefined, 'control: the 31337 signature passes');
  const before = await swapState(env, q);
  await expectWrapperRevert(env, tx, 'InvalidSignature');
  check((await swapState(env, q)) === before, 'a refused swap changed balances');
  await approveWrapper(env, PINNED.hWETH, 0n);
  return 'signer and buildSignedSwap refuse 8453; an 8453-domain signature reverts InvalidSignature';
}

/** 7. The signed quote with its fee changed (signature kept) is refused. */
async function tamperedFee(env: Env): Promise<string> {
  const amountIn = 10n ** 18n;
  const quoted = await quoteAndSign(env, harnessRequest(env, PINNED.hWETH, PINNED.hUSDC, amountIn));
  const q = quoted.swap.quote;
  const tampered: SwapQuote = { ...q, feeAmount: 0n };
  const tx = wrapperCall(tampered, quoted.swap.signature, quoted.route.tx.data as Hex);
  await mint(env, PINNED.hWETH, amountIn);
  await approveWrapper(env, PINNED.hWETH, amountIn);
  check((await simulate(env, swapTx(quoted))) === undefined, 'control: the signed fee passes');
  const before = await swapState(env, q);
  await expectWrapperRevert(env, tx, 'InvalidSignature');
  check((await swapState(env, q)) === before, 'a refused swap changed balances');
  await approveWrapper(env, PINNED.hWETH, 0n);
  return `fee ${q.feeAmount} -> 0 with the same signature: InvalidSignature; nothing moved`;
}

/** 8. Routers off the allowlist: vetRoute refuses them, and the wrapper refuses a direct call. */
async function unlistedRouter(env: Env): Promise<string> {
  const amountIn = 1_000n * 10n ** 6n;
  const request = harnessRequest(env, PINNED.hUSDC, PINNED.hWETH, amountIn);
  const { fee, netSell, vet } = await priceAndFee(env, request);
  const honest = await env.provider.quote(netSell, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
  const reasonOf = (route: ProviderQuote): string => {
    try {
      vet(route);
      return 'accepted';
    } catch (err: unknown) {
      return err instanceof UnsafeRouteError ? err.reason : String(err);
    }
  };
  check(reasonOf(honest) === 'accepted', 'control: the honest route must pass');
  // The Settler called directly (not through the holder): not a trusted router.
  const settlerDirect: ProviderQuote = { ...honest, tx: { ...honest.tx, to: lower(SETTLER) } };
  check(
    reasonOf(settlerDirect) === 'unknown_router',
    `settler as router: ${reasonOf(settlerDirect)}`,
  );
  // Through the holder, but handing the input to a contract that is not a trusted Settler.
  const otherTarget: ProviderQuote = {
    ...honest,
    tx: {
      ...honest.tx,
      data: zeroXCalldata({
        operator: getAddress(PINNED.hUNDER),
        token: getAddress(PINNED.hUSDC),
        amount: netSell.sellAmount,
        target: getAddress(PINNED.hUNDER),
        recipient: env.accounts.user.address,
        buyToken: getAddress(PINNED.hWETH),
        minAmountOut: honest.minBuyAmount,
      }),
    },
  };
  check(reasonOf(otherTarget) === 'unknown_target', `other target: ${reasonOf(otherTarget)}`);

  // Direct wrapper call with a router that is not allowlisted on chain, correctly signed by the
  // fee signer key (raw PUBLIC key, outside the API): the wrapper refuses it.
  const inner = encodeFunctionData({
    abi: SETTLER_ABI,
    functionName: 'execute',
    args: [
      {
        recipient: env.accounts.user.address,
        buyToken: getAddress(PINNED.hWETH),
        minAmountOut: honest.minBuyAmount,
      },
      [],
      `0x${'00'.repeat(32)}`,
    ],
  });
  const q: SwapQuote = {
    user: env.accounts.user.address,
    tokenIn: getAddress(PINNED.hUSDC),
    tokenOut: getAddress(PINNED.hWETH),
    amountIn,
    minAmountOut: honest.minBuyAmount,
    feeAmount: fee.amount,
    router: SETTLER,
    routerCalldataHash: keccak256(inner),
    nonce: randomNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000) + TTL_SECONDS),
  };
  const sig = await env.accounts.feeSigner.signTypedData(typedData(q, HARNESS_CHAIN_ID, WRAPPER));
  await mint(env, PINNED.hUSDC, amountIn);
  await approveWrapper(env, PINNED.hUSDC, amountIn);
  const before = await swapState(env, q);
  await expectWrapperRevert(env, wrapperCall(q, sig, inner), 'RouterNotAllowed');
  check((await swapState(env, q)) === before, 'a refused swap changed balances');
  await approveWrapper(env, PINNED.hUSDC, 0n);
  return 'vetRoute: unknown_router, unknown_target; wrapper: RouterNotAllowed for a signed direct call';
}

/** 9a. Native input: value == amountIn, fee paid in ETH to the collector. */
async function nativeIn(env: Env): Promise<string> {
  const amountIn = 10n ** 18n;
  const quoted = await quoteAndSign(env, harnessRequest(env, NATIVE, PINNED.hUSDC, amountIn));
  const q = quoted.swap.quote;
  check(q.tokenIn === zeroAddress, 'native input must be signed as the zero address');
  check(quoted.swap.transaction.value === amountIn, 'value must equal amountIn');
  const out = await executeAndCheck(env, quoted);
  return `paid 1 ETH as value, received ${out} hUSDC, collector got ${q.feeAmount} wei`;
}

/** 9b. Native output: the user receives ETH, the fee is paid in the input token. */
async function nativeOut(env: Env): Promise<string> {
  const amountIn = 3_000n * 10n ** 6n;
  const quoted = await quoteAndSign(env, harnessRequest(env, PINNED.hUSDC, NATIVE, amountIn));
  const q = quoted.swap.quote;
  check(q.tokenOut === zeroAddress, 'native output must be signed as the zero address');
  await mint(env, PINNED.hUSDC, amountIn);
  const out = await executeAndCheck(env, quoted);
  return `paid 3,000 hUSDC, received ${out} wei (net of gas), collector got ${q.feeAmount} hUSDC`;
}

/** 10. The same flow through the real POST /v1/quotes handler (in process), then sent. */
async function httpHandler(env: Env): Promise<string> {
  const amountIn = 10n ** 18n;
  const app = buildServer({
    providers: [env.provider],
    prices: env.oracle,
    history: { hasCompletedSwap: () => Promise.resolve(true) },
    routePolicy: env.policy,
    maxOracleDeviationBps: MAX_ORACLE_DEVIATION_BPS,
    signing: { feeWrapper: WRAPPER, signer: env.signer, ttlSeconds: TTL_SECONDS },
  });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        sellToken: { chain: HARNESS_CHAIN_KEY, address: PINNED.hWETH },
        buyToken: { chain: HARNESS_CHAIN_KEY, address: PINNED.hUSDC },
        sellAmount: amountIn.toString(),
        taker: env.accounts.user.address,
        slippageBps: SLIPPAGE_BPS,
      }),
    });
    check(res.statusCode === 200, `POST /v1/quotes answered ${res.statusCode}`);
    const answer = parseAnswer(res.json());
    check(
      answer.chainId === HARNESS_CHAIN_ID &&
        answer.sellChain === HARNESS_CHAIN_KEY &&
        answer.buyChain === HARNESS_CHAIN_KEY &&
        answer.ttlSeconds === TTL_SECONDS &&
        answer.deadline === BigInt(answer.serverTime + answer.ttlSeconds),
      'answer echo',
    );
    check(isAddressEqual(answer.to, WRAPPER), 'answer transaction is not to the pinned wrapper');
    await mint(env, PINNED.hWETH, amountIn);
    const quote: SwapQuote = { ...answer.quote, deadline: answer.deadline };
    const out = await executeAndCheck(env, {
      swap: {
        quote,
        signature: answer.signature,
        transaction: { to: answer.to, data: answer.data, value: answer.value },
        context: {
          sellChain: HARNESS_CHAIN_KEY,
          buyChain: HARNESS_CHAIN_KEY,
          chainId: HARNESS_CHAIN_ID,
        },
      },
    });
    return `POST /v1/quotes answered a signed swap for 31337; sent, received ${out} hUSDC`;
  } finally {
    await app.close();
  }
}

/** 11. The echo helpers: the real answer passes; a tampered chain or timing throws. */
async function echoHelpers(env: Env, quoted: Quoted): Promise<string> {
  const { request, swap, timing } = quoted;
  const echo = signedAnswerEcho(request, swap, timing);
  check(echo.chainId === HARNESS_CHAIN_ID && echo.serverTime === timing.serverTime, 'echo values');
  const cases: [string, () => unknown][] = [
    [
      'chainId',
      () =>
        signedAnswerEcho(request, { ...swap, context: { ...swap.context, chainId: 8453 } }, timing),
    ],
    [
      'sellChain',
      () =>
        signedAnswerEcho(
          request,
          { ...swap, context: { ...swap.context, sellChain: 'evm:8453' } },
          timing,
        ),
    ],
    [
      'serverTime',
      () => signedAnswerEcho(request, swap, { ...timing, serverTime: timing.serverTime + 1 }),
    ],
    [
      'ttlSeconds',
      () => signedAnswerEcho(request, swap, { ...timing, ttlSeconds: timing.ttlSeconds + 1 }),
    ],
    [
      'deadline',
      () =>
        signedAnswerEcho(
          request,
          { ...swap, quote: { ...swap.quote, deadline: swap.quote.deadline + 1n } },
          timing,
        ),
    ],
  ];
  for (const [what, run] of cases) {
    let threw = false;
    try {
      run();
    } catch (err: unknown) {
      threw = err instanceof QuoteEchoMismatchError;
    }
    check(threw, `signedAnswerEcho accepted a tampered ${what}`);
  }
  // The signed swap from scenario 1 is on chain under the echoed chain: its nonce is used there.
  check(await nonceUsed(env, swap.quote.nonce), 'the echoed swap is not on chain 31337');
  return 'real answer passes; tampered chainId, sellChain, serverTime, ttlSeconds, deadline throw';
}

// ------------------------------------------------------------------ answer parsing

interface ParsedAnswer {
  quote: Omit<SwapQuote, 'deadline'>;
  deadline: bigint;
  signature: Hex;
  to: Hex;
  data: Hex;
  value: bigint;
  sellChain: unknown;
  buyChain: unknown;
  chainId: unknown;
  serverTime: number;
  ttlSeconds: number;
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function hexField(obj: unknown, key: string): Hex {
  const v = field(obj, key);
  check(typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v), `answer ${key} is not hex`);
  return v as Hex;
}

function intField(obj: unknown, key: string): bigint {
  const v = field(obj, key);
  check(typeof v === 'string' && /^\d{1,78}$/.test(v), `answer ${key} is not a decimal string`);
  return BigInt(v);
}

function numField(obj: unknown, key: string): number {
  const v = field(obj, key);
  check(typeof v === 'number' && Number.isSafeInteger(v), `answer ${key} is not an integer`);
  return v;
}

function parseAnswer(json: unknown): ParsedAnswer {
  const swap = field(json, 'swap');
  const quote = field(swap, 'quote');
  const tx = field(swap, 'transaction');
  return {
    quote: {
      user: hexField(quote, 'user'),
      tokenIn: hexField(quote, 'tokenIn'),
      tokenOut: hexField(quote, 'tokenOut'),
      amountIn: intField(quote, 'amountIn'),
      minAmountOut: intField(quote, 'minAmountOut'),
      feeAmount: intField(quote, 'feeAmount'),
      router: hexField(quote, 'router'),
      routerCalldataHash: hexField(quote, 'routerCalldataHash'),
      nonce: intField(quote, 'nonce'),
    },
    deadline: intField(quote, 'deadline'),
    signature: hexField(swap, 'signature'),
    to: hexField(tx, 'to'),
    data: hexField(tx, 'data'),
    value: intField(tx, 'value'),
    sellChain: field(json, 'sellChain'),
    buyChain: field(json, 'buyChain'),
    chainId: field(json, 'chainId'),
    serverTime: numField(json, 'serverTime'),
    ttlSeconds: numField(json, 'ttlSeconds'),
  };
}

// ------------------------------------------------------------------ runner

/** Every scenario name, in order (the integration test checks all of them ran and passed). */
export const SCENARIOS = [
  '0 preflight: pinned contracts, domain, roles, allowlist, signing gates',
  '1 happy path: quote, vet, sign, approve exactly, swap',
  '2 replay reverts NonceAlreadyUsed',
  '3 route 10% under the oracle refused by vetRoute',
  '4 underpaying router reverts InsufficientOutput in the wrapper',
  '5 expired deadline reverts QuoteExpired',
  '6 quote signed for chain 8453 refused',
  '7 tampered fee amount refused',
  '8 router not on the allowlist refused',
  '9a native input (value == amountIn)',
  '9b native output',
  '10 POST /v1/quotes handler in process, then sent',
  '11 signedAnswerEcho passes the real answer, throws on tampering',
] as const;

/**
 * Runs every scenario against `rawUrl`. Throws `HarnessRpcRefusedError` before any request when
 * the URL is not loopback, and before any transaction when the chain is not 31337. A failed
 * preflight stops the run (nothing is sent to a chain that does not match the pinned table).
 */
export async function runSmoke(
  rawUrl: string | undefined,
  opts: SmokeOptions = {},
): Promise<SmokeReport> {
  const url = assertLoopbackRpcUrl(rawUrl);
  await verifyLocalChain(url);
  const env = await connect(url);
  const log = opts.log ?? (() => undefined);
  const results: ScenarioResult[] = [];
  const run = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
      log(`PASS ${name}: ${detail}`);
      return true;
    } catch (err: unknown) {
      const detail =
        err instanceof Error ? `${err.name}: ${err.message.slice(0, 300)}` : String(err);
      results.push({ name, ok: false, detail });
      log(`FAIL ${name}: ${detail}`);
      return false;
    }
  };

  const [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9a, s9b, s10, s11] = SCENARIOS;
  if (!(await run(s0, () => preflight(env)))) return { ok: false, results };
  let happy: Quoted | undefined;
  await run(s1, async () => {
    const r = await happyPath(env);
    happy = r.quoted;
    return r.detail;
  });
  await run(s2, () => (happy ? replay(env, happy) : Promise.reject(new Error('needs scenario 1'))));
  await run(s3, () => oracleRefusal(env));
  await run(s4, () => underpay(env));
  await run(s5, () => expired(env));
  await run(s6, () => wrongChain(env));
  await run(s7, () => tamperedFee(env));
  await run(s8, () => unlistedRouter(env));
  await run(s9a, () => nativeIn(env));
  await run(s9b, () => nativeOut(env));
  await run(s10, () => httpHandler(env));
  await run(s11, () =>
    happy ? echoHelpers(env, happy) : Promise.reject(new Error('needs scenario 1')),
  );
  return { ok: results.every((r) => r.ok) && results.length === SCENARIOS.length, results };
}

async function main(): Promise<number> {
  const report = await runSmoke(process.env[RPC_URL_ENV], { log: (line) => console.log(line) });
  console.log(report.ok ? 'harness smoke: PASS' : 'harness smoke: FAIL');
  return report.ok ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      process.exit(2);
    },
  );
}
