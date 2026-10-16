/**
 * LOCAL TEST HARNESS ONLY (ADR 0013, section 2). Imported as `@ranvier/chains/local-dev`, never
 * through the package index.
 *
 * The local test chain (plain anvil, chain 31337) and the harness mock contracts. Every address is
 * a fixed CREATE2 result from `contracts/test/harness/HarnessConfig.sol` (also tabled in
 * docs/runbooks/local-harness.md); `apps/api/scripts/harness/pinned.test.ts` checks all three
 * agree, and the harness smoke checks them on chain before it trusts them.
 *
 * This chain must stay OUT of everything production serves or trusts: `CHAINS`, `TOKEN_LIST`,
 * `PUBLIC_RPC_URLS`, the API's `TRUSTED_ROUTERS` and `ZEROX_SETTLERS`, and the package index.
 * Putting 31337 into `CHAINS` or `TRUSTED_ROUTERS` would also put it into the API's
 * `NEVER_LOCAL_CHAINS` and deny the local key the harness uses. Guard tests: `local-dev.test.ts`
 * here and `apps/api/scripts/harness/local-chain-guards.test.ts`.
 *
 * Mock data, worthless tokens, no real network. EVM addresses are lowercase, as in the registry.
 */
import type { ChainKey } from '@ranvier/types';
import { deepFreeze } from './freeze.js';
import type { ChainConfig } from './registry.js';
import type { CuratedToken } from './tokens.js';

/** Anvil's default chain ID. Not reserved: the harness also requires a loopback RPC. */
export const LOCAL_DEV_CHAIN_ID = 31337;
export const LOCAL_DEV_CHAIN_KEY = 'evm:31337' satisfies ChainKey;

/** The registry's chain shape plus the numeric chain ID and the chain's (mock) token list. */
export interface LocalDevChain extends ChainConfig {
  chainId: number;
  /** In display order: the native coin, then the listed mock tokens. */
  tokens: readonly CuratedToken[];
}

/** Harness mock tokens that only exist to make one scenario fail (runbook pair table). */
export type ScenarioTokenSymbol =
  | 'hUSDT'
  | 'hFALSE'
  | 'hTAX'
  | 'hHOOK'
  | 'hUNDER'
  | 'hPAYWRAP'
  | 'hSPEND'
  | 'hREVERT'
  | 'hBIGREV'
  | 'hREENTER'
  | 'hORACLE';

/** The harness contracts that do not fit `ChainConfig`. Addresses lowercase. */
export interface LocalDevContracts {
  /** Anvil's CREATE2 factory (Arachnid deterministic deployer, present at genesis). */
  create2Factory: string;
  /** `MockAllowanceHolder`: the 0x AllowanceHolder ABI, the wrapper's only allowed router. */
  allowanceHolder: string;
  /** `MockSettler`: the 0x Settler ABI, the holder's only target. */
  settler: string;
  /** The real `FeeWrapper` deployed by `Deploy.s.sol`'s path with the runbook's roles and salt. */
  feeWrapper: string;
  /** Scenario tokens: never listed in `LOCAL_DEV_CHAIN.tokens`, never shown to a user. */
  scenarioTokens: Readonly<Record<ScenarioTokenSymbol, string>>;
}

/** hUSDC and hWETH, from HarnessConfig.sol (`HUSDC`, `HWETH`). */
const HUSDC = '0x5784f90419222088ac18ae5b62ef381f4cb2deb1';
const HWETH = '0x47fa559be608137ea4d28588b6c57d0d1ac6552d';

const TOKENS: CuratedToken[] = [
  {
    chain: LOCAL_DEV_CHAIN_KEY,
    address: 'native',
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    tags: ['native'],
  },
  {
    // WETH9-style: deposit() and withdraw() (HarnessTokens.sol `HarnessWETH`).
    chain: LOCAL_DEV_CHAIN_KEY,
    address: HWETH,
    symbol: 'hWETH',
    name: 'Harness Wrapped Ether',
    decimals: 18,
    tags: ['wrapped-native'],
  },
  {
    // Deliberately not tagged `stablecoin` and not in `stablecoins`: a mock token never
    // selects a fee rate. Changing that is fee data and goes to the security reviewer.
    chain: LOCAL_DEV_CHAIN_KEY,
    address: HUSDC,
    symbol: 'hUSDC',
    name: 'Harness USD Coin',
    decimals: 6,
  },
];

/**
 * The local test chain. Deep-frozen like `CHAINS`. `explorer` and `defillama` are empty: there is
 * no explorer, and the harness prices its tokens with a fixed oracle, never DefiLlama.
 */
export const LOCAL_DEV_CHAIN: Readonly<LocalDevChain> = deepFreeze<LocalDevChain>({
  key: LOCAL_DEV_CHAIN_KEY,
  chainId: LOCAL_DEV_CHAIN_ID,
  family: 'evm',
  name: 'Local test chain (not a real network)',
  nativeSymbol: 'ETH',
  nativeDecimals: 18,
  wrappedNative: HWETH,
  stablecoins: {},
  knownDecimals: Object.fromEntries(
    TOKENS.filter((t) => t.address !== 'native').map((t) => [t.address, t.decimals]),
  ),
  explorer: '',
  defillama: '',
  tokens: TOKENS,
});

/** The harness mock contracts and the wrapper, from HarnessConfig.sol. Deep-frozen. */
export const LOCAL_DEV_CONTRACTS: Readonly<LocalDevContracts> = deepFreeze<LocalDevContracts>({
  create2Factory: '0x4e59b44847b379578588920ca78fbf26c0b4956c',
  allowanceHolder: '0xc0b06d1e9e0bb6e4b5d903a2b5afc57e1bf41ce2',
  settler: '0x2c7959766740c57e7615b9452fde5e7273bb6e3c',
  feeWrapper: '0x60a10abb52c31ec38f1f93c70b64d2fb00913859',
  scenarioTokens: {
    hUSDT: '0x591c8458edf8fd663317fd0d9f712b304829f996',
    hFALSE: '0x76faf45c3e69f33e64fd1448a18cde535a80b3c7',
    hTAX: '0x60bd9a310df2ad9dfbc230ebf0ae49c35f547229',
    hHOOK: '0x3f7e44dc6b1f3465c2e453bf5b37ddf2403c3dec',
    hUNDER: '0x3d186379d8afb89332aa0b11cfd399d4966eb917',
    hPAYWRAP: '0x2412e0ece709981e91b3a54cf44a5558162e36de',
    hSPEND: '0x00f68444cd6325033d2b51cb61a0de7e781413d1',
    hREVERT: '0x6a30b9ffa7b7353699d1b8f309554a979018a3e4',
    hBIGREV: '0x8114705c3eb8885ce22d5f14590788992f136668',
    hREENTER: '0xa6673ad0094b3c28e672a9e1e28f03dbcbe7cfb5',
    hORACLE: '0xa03b74d8a5289b2a6278554183ce5d51deb12c09',
  },
});

/** A listed token of the local chain by symbol; throws for any other symbol. */
export function localDevToken(symbol: 'ETH' | 'hWETH' | 'hUSDC'): CuratedToken {
  const token = LOCAL_DEV_CHAIN.tokens.find((t) => t.symbol === symbol);
  if (!token) throw new Error(`local-dev lists no ${symbol}`);
  return token;
}

/**
 * Every harness address this module pins, lowercase: for guards that prove production code and
 * build output contain none of them. The CREATE2 factory is left out: it is a public, real
 * contract on many chains, not a harness value.
 */
export function localDevAddresses(): string[] {
  return [
    ...LOCAL_DEV_CHAIN.tokens.filter((t) => t.address !== 'native').map((t) => t.address),
    LOCAL_DEV_CONTRACTS.allowanceHolder,
    LOCAL_DEV_CONTRACTS.settler,
    LOCAL_DEV_CONTRACTS.feeWrapper,
    ...Object.values(LOCAL_DEV_CONTRACTS.scenarioTokens),
  ];
}
