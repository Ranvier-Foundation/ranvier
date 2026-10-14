import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  erc20Abi,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';

/**
 * An in-memory JSON-RPC node behind a fake `fetch`, keyed by URL, for the chain reader tests.
 * It answers the methods the reader uses, including Multicall3 `aggregate3`, and can fail in
 * every way a real provider does: connection errors, HTTP errors, hangs, reverts and junk.
 */

export const MC = '0xca11bde05977b3631167028862be2a173976ca11';

const MC_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getChainId() view returns (uint256 chainid)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);

export type FakeMode = 'ok' | 'down' | 'http500' | 'http429' | 'hang' | 'revert-call';

/** A token's answer: a balance, a revert, or raw return data. */
export type TokenAnswer = bigint | 'revert' | { raw: Hex };

export interface FakeNode {
  /** Answer to `eth_chainId`. */
  chainId: number;
  /** `block.chainid` inside a call (default `chainId`). */
  callChainId?: number;
  block: bigint;
  /** Seconds. */
  timestamp: bigint;
  native: bigint;
  tokens: Map<string, TokenAnswer>;
  mode: FakeMode;
  /** Raw `result` per method, replacing the computed one (junk injection). */
  results?: Record<string, unknown>;
  /** Replaces the whole aggregate3 return data. */
  aggregateRaw?: Hex;
  /** Replaces the aggregate3 results (wrong lengths, failed own calls...). */
  aggregateResults?: (computed: { success: boolean; returnData: Hex }[]) => {
    success: boolean;
    returnData: Hex;
  }[];
}

export interface RecordedCall {
  url: string;
  method: string;
  params: unknown[];
}

const word = (v: bigint): Hex => encodeAbiParameters([{ type: 'uint256' }], [v]);

export function node(overrides: Partial<FakeNode> = {}): FakeNode {
  return {
    chainId: 1,
    block: 1_000n,
    timestamp: 1_700_000_000n,
    native: 5n * 10n ** 18n,
    tokens: new Map(),
    mode: 'ok',
    ...overrides,
  };
}

/** viem moves URL credentials into an Authorization header, so nodes are keyed without them. */
export function withoutCredentials(url: string): string {
  const u = new URL(url);
  u.username = '';
  u.password = '';
  return u.href;
}

class NodeMap extends Map<string, FakeNode> {
  override get(url: string): FakeNode | undefined {
    return super.get(withoutCredentials(url));
  }
  override set(url: string, n: FakeNode): this {
    return super.set(withoutCredentials(url), n);
  }
}

export class FakeRpc {
  readonly nodes: Map<string, FakeNode> = new NodeMap();
  /** Authorization headers seen, per URL (credentials from the URL's user info). */
  readonly authorization: (string | null)[] = [];
  readonly calls: RecordedCall[] = [];
  readonly signals: AbortSignal[] = [];

  callsTo(url: string, method?: string): RecordedCall[] {
    const key = withoutCredentials(url);
    return this.calls.filter((c) => c.url === key && (method === undefined || c.method === method));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = withoutCredentials(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    this.authorization.push(new Headers(init?.headers).get('authorization'));
    const n = this.nodes.get(url);
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params?: unknown[];
    };
    this.calls.push({ url, method: body.method, params: body.params ?? [] });
    if (init?.signal) this.signals.push(init.signal);
    // Real fetch errors quote the URL, which may hold a key.
    if (!n || n.mode === 'down') throw new TypeError(`fetch failed: connect ECONNREFUSED ${url}`);
    if (n.mode === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (n.mode === 'http500') return new Response(`upstream failure at ${url}`, { status: 500 });
    if (n.mode === 'http429') {
      return Response.json(
        { jsonrpc: '2.0', id: body.id, error: { code: 429, message: `limit for ${url}` } },
        { status: 429 },
      );
    }
    const reply = (payload: Record<string, unknown>): Response =>
      Response.json({ jsonrpc: '2.0', id: body.id, ...payload });
    if (n.results && body.method in n.results) return reply({ result: n.results[body.method] });
    const params = body.params ?? [];
    switch (body.method) {
      case 'eth_chainId':
        return reply({ result: toHex(n.chainId) });
      case 'eth_blockNumber':
        return reply({ result: toHex(n.block) });
      case 'eth_getBalance':
        return reply({ result: toHex(n.native) });
      case 'eth_getBlockByNumber':
        return reply({
          result:
            params[0] === toHex(n.block)
              ? { number: toHex(n.block), timestamp: toHex(n.timestamp) }
              : null,
        });
      case 'eth_call':
        return this.call(n, params, reply);
      default:
        return reply({ error: { code: -32601, message: 'method not found' } });
    }
  };

  private call(
    n: FakeNode,
    params: unknown[],
    reply: (payload: Record<string, unknown>) => Response,
  ): Response {
    const revert = { error: { code: 3, message: 'execution reverted', data: '0x' } };
    if (n.mode === 'revert-call') return reply(revert);
    const { to, data } = params[0] as { to: string; data: Hex };
    if (to !== MC) {
      const answer = n.tokens.get(to);
      if (answer === undefined) return reply({ result: '0x' });
      if (answer === 'revert') return reply(revert);
      return reply({ result: typeof answer === 'bigint' ? word(answer) : answer.raw });
    }
    if (n.aggregateRaw !== undefined) return reply({ result: n.aggregateRaw });
    const decoded = decodeFunctionData({ abi: MC_ABI, data });
    const calls = decoded.args[0] as readonly { target: string; callData: Hex }[];
    const computed = calls.map(({ target, callData }) => {
      const t = target.toLowerCase();
      if (t === MC) {
        const own = decodeFunctionData({ abi: MC_ABI, data: callData });
        const value =
          own.functionName === 'getChainId'
            ? BigInt(n.callChainId ?? n.chainId)
            : own.functionName === 'getCurrentBlockTimestamp'
              ? n.timestamp
              : n.native;
        return { success: true, returnData: word(value) };
      }
      const call = decodeFunctionData({ abi: erc20Abi, data: callData });
      if (call.functionName !== 'balanceOf') throw new Error('unexpected token call');
      const answer = n.tokens.get(t);
      if (answer === undefined) return { success: true, returnData: '0x' as Hex };
      if (answer === 'revert') return { success: false, returnData: '0x' as Hex };
      return { success: true, returnData: typeof answer === 'bigint' ? word(answer) : answer.raw };
    });
    const results = n.aggregateResults ? n.aggregateResults(computed) : computed;
    return reply({
      result: encodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', result: results }),
    });
  }
}
