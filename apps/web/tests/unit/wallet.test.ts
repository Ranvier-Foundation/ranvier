import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS } from '@ranvier/chains';
import { describe, expect, it } from 'vitest';
import { AVATAR_TOKENS, DEFAULT_QUADRANTS, avatarQuadrants } from '../../src/lib/wallet/avatar';
import {
  EVM_CHAINS,
  evmChainId,
  explorerAddressUrl,
  registryChainByWalletId,
  toWagmiChain,
} from '../../src/lib/wallet/chains';
import { createWalletConfig } from '../../src/lib/wallet/config';
import { classifyWalletError } from '../../src/lib/wallet/errors';
import {
  MAX_HINT_LENGTH,
  MAX_ICON_LENGTH,
  MAX_NAME_LENGTH,
  MAX_WALLETS,
  listWallets,
  safeIcon,
  safeName,
  type ConnectorLike,
} from '../../src/lib/wallet/wallets';
import { shortAddress } from '../../src/lib/format';

const A = '0x7a3E1b2C9d4F5a60718293a4B5c6D7e8F9013F9c';
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==';

describe('wallet avatar', () => {
  it('is deterministic and case-insensitive in effect on the same bytes', () => {
    expect(avatarQuadrants(A)).toEqual(avatarQuadrants(A));
    expect(avatarQuadrants(A.toLowerCase())).toEqual(avatarQuadrants(A.toLowerCase()));
  });
  it('uses only design tokens that exist in tokens.css', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8');
    for (const token of AVATAR_TOKENS) expect(css).toContain(`--color-${token}:`);
    for (let i = 0; i < 300; i++) {
      const address = `0x${(BigInt(i) * 0x9e3779b97f4a7c15n * 0x1000193n).toString(16).padStart(40, '0').slice(-40)}`;
      const q = avatarQuadrants(address);
      expect(q).toHaveLength(4);
      for (const token of q) expect(AVATAR_TOKENS).toContain(token);
      // Never a flat disc.
      expect(new Set(q).size).toBeGreaterThan(1);
    }
  });
  it('differs between addresses and falls back to the canvas avatar for bad input', () => {
    const seen = new Set<string>();
    for (let i = 1; i <= 64; i++) {
      const n = BigInt(i) * 0x9e3779b97f4a7c15f39cc0605cedc834n;
      seen.add(avatarQuadrants(`0x${n.toString(16).padStart(40, '0').slice(-40)}`).join());
    }
    expect(seen.size).toBeGreaterThan(8);
    expect(avatarQuadrants('0x1234')).toEqual(DEFAULT_QUADRANTS);
    expect(avatarQuadrants('')).toEqual(DEFAULT_QUADRANTS);
    expect(DEFAULT_QUADRANTS).toEqual(['primary', 'blush', 'blush', 'accent']);
  });
  it('the component source never names a raw colour', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/wallet-avatar.tsx'), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });
});

describe('address shortening', () => {
  it('keeps the first 6 and last 4 characters', () => {
    expect(shortAddress(A)).toBe('0x7a3E…3f9c'.replace('3f9c', '3F9c'));
  });
});

describe('wallet list sanitising', () => {
  const connector = (over: Partial<ConnectorLike>): ConnectorLike => ({
    id: 'io.example.wallet',
    name: 'Example',
    icon: PNG,
    uid: 'u1',
    type: 'injected',
    ...over,
  });

  it('accepts only small base64 png, svg and webp data images', () => {
    expect(safeIcon(PNG)).toBe(PNG);
    expect(safeIcon('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeDefined();
    expect(safeIcon('data:image/webp;base64,UklGRg==')).toBeDefined();
    for (const bad of [
      undefined,
      '',
      'javascript:alert(1)',
      'https://evil.example/x.png',
      'data:text/html;base64,PGgxPg==',
      'data:image/svg+xml;utf8,<svg onload=alert(1)>',
      'data:image/png;base64,AAAA" onerror="x',
      'data:image/gif;base64,R0lGOD==',
      `data:image/png;base64,${'A'.repeat(MAX_ICON_LENGTH)}`,
    ]) {
      expect(safeIcon(bad)).toBeUndefined();
    }
  });

  it('cleans names: control and bidi characters, whitespace, length', () => {
    expect(safeName('  Evil‮  Wallet\u0000 \n')).toBe('Evil Wallet');
    expect(safeName('​​')).toBe('');
    expect(Array.from(safeName('y'.repeat(500)))).toHaveLength(MAX_NAME_LENGTH);
    // Tags are text, never markup: kept as characters for React to escape.
    expect(safeName('<b>x</b>')).toBe('<b>x</b>');
  });

  it('drops invalid rdns, non-injected connectors and empty names; dedupes by rdns and uid', () => {
    const list = listWallets([
      connector({ id: 'a.one', name: 'One', uid: '1' }),
      connector({ id: 'A.ONE', name: 'One again', uid: '2' }),
      connector({ id: 'b.two', name: 'Two', uid: '1' }),
      connector({ id: 'not valid!', name: 'Bad', uid: '3' }),
      connector({ id: 'injected', name: 'Generic', uid: '4' }),
      connector({ id: 'c.three', name: '​', uid: '5' }),
      connector({ id: 'd.four', name: 'Four', uid: '6', type: 'walletConnect' }),
      connector({ id: 'e.five', name: 'Five', uid: '7', icon: 'javascript:1' }),
    ]);
    expect(list.map((w) => w.name)).toEqual(['Five', 'One']);
    expect(list[0]?.icon).toBeUndefined();
  });

  it('caps the list and orders by name so announce order does not matter', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      connector({ id: `w.n${i}`, name: `Wallet ${String(19 - i).padStart(2, '0')}`, uid: `u${i}` }),
    );
    const list = listWallets(many);
    expect(list).toHaveLength(MAX_WALLETS);
    expect(list.map((w) => w.name)).toEqual([...list.map((w) => w.name)].sort());
  });
});

describe('hostile provider values', () => {
  const base = { id: 'io.example.wallet', name: 'Example', icon: PNG, uid: 'u1', type: 'injected' };
  const hostile = (value: unknown) => value as string;
  const flip = (first: string, later: string) => {
    let n = 0;
    return {
      length: 10,
      toString: () => (n++ === 0 ? first : later),
      valueOf: () => later,
      [Symbol.toPrimitive]: () => later,
    };
  };

  it('refuses every non-string icon, id, name, uid and type', () => {
    const objects: unknown[] = [
      flip(PNG, 'https://evil.example/x.png'),
      new String(PNG),
      { length: 10, toString: () => PNG },
      new Proxy({}, { get: (_t, k) => (k === 'length' ? 10 : () => PNG) }),
      [PNG],
      42,
      null,
      Symbol('x'),
    ];
    for (const o of objects) {
      expect(safeIcon(o)).toBeUndefined();
      expect(safeName(o)).toBe('');
      expect(listWallets([{ ...base, icon: hostile(o) }])[0]?.icon).toBeUndefined();
      expect(listWallets([{ ...base, id: hostile(o) }])).toEqual([]);
      expect(listWallets([{ ...base, name: hostile(o) }])).toEqual([]);
      expect(listWallets([{ ...base, uid: hostile(o) }])).toEqual([]);
      expect(listWallets([{ ...base, type: hostile(o) }])).toEqual([]);
    }
  });

  it('reads each field once: a getter that changes between reads cannot swap the value', () => {
    let reads = 0;
    const connector = {
      ...base,
      get icon() {
        return reads++ === 0 ? PNG : 'https://evil.example/getter.png';
      },
    };
    const [wallet] = listWallets([connector]);
    expect(wallet?.icon).toBe(PNG);
    expect(reads).toBe(1);
    // The same for the name and the id.
    let nameReads = 0;
    let idReads = 0;
    const second = {
      ...base,
      get name() {
        return nameReads++ === 0 ? 'Good' : 'https://evil.example/name';
      },
      get id() {
        return idReads++ === 0 ? 'good.wallet' : 'evil.rdns';
      },
    };
    const [w2] = listWallets([second]);
    expect([w2?.name, w2?.key, nameReads, idReads]).toEqual(['Good', 'good.wallet', 1, 1]);
  });

  it('a connector that is itself a Proxy returning changing values is read once per field', () => {
    const counts: Record<string, number> = {};
    const proxy = new Proxy(base, {
      get(target, key: string) {
        counts[key] = (counts[key] ?? 0) + 1;
        return counts[key] === 1 ? target[key as keyof typeof target] : 'https://evil.example';
      },
    });
    const [wallet] = listWallets([proxy]);
    expect(wallet?.icon).toBe(PNG);
    expect(wallet?.name).toBe('Example');
    for (const key of ['id', 'name', 'icon', 'uid', 'type']) expect(counts[key]).toBe(1);
  });
});

describe('name cleaning', () => {
  it('removes hidden characters and normalises', () => {
    expect(safeName('Meta​Mask')).toBe('MetaMask');
    expect(safeName('Meta­Mask⁠')).toBe('MetaMask');
    expect(safeName('Wal️let\u{e0100}')).toBe('Wallet');
    expect(safeName('A\u{e0041}\u{e0042}B')).toBe('AB');
    expect(safeName('Ｍｅｔａ')).toBe('Meta');
    expect(safeName('Line break here')).toBe('Line break here');
    expect(safeName('Wal᠎let')).toBe('Wallet');
  });
  it('drops names with no letter or digit', () => {
    for (const blank of ['ㅤ', 'ᅟᅠ', 'ㅤㅤ ', '   ', '---', '​', '!!!', '⁠­']) {
      expect(safeName(blank)).toBe('');
    }
    expect(listWallets([{ id: 'a.b', name: 'ㅤ', icon: PNG, uid: 'u', type: 'injected' }])).toEqual(
      [],
    );
    expect(safeName('ㅤ Okay')).toBe('Okay');
    expect(safeName('1Wallet')).toBe('1Wallet');
  });
});

describe('look-alike names', () => {
  const c = (id: string, name: string, uid: string): ConnectorLike => ({
    id,
    name,
    icon: PNG,
    uid,
    type: 'injected',
  });
  it('shows the rdns on every row that shares a cleaned, case-folded name', () => {
    const list = listWallets([
      c('io.metamask', 'Impostor', '1'),
      c('io.metamask.fake', 'MetaMask', '2'),
      c('io.metamask.two', 'metamask​', '3'),
      c('io.metamask.three', 'ＭｅｔａＭａｓｋ', '4'),
      c('solo.wallet', 'Solo', '5'),
    ]);
    const by = Object.fromEntries(list.map((w) => [w.key, w.hint]));
    expect(by['io.metamask']).toBeUndefined();
    expect(by['solo.wallet']).toBeUndefined();
    expect(by['io.metamask.fake']).toBe('io.metamask.fake');
    expect(by['io.metamask.two']).toBe('io.metamask.two');
    expect(by['io.metamask.three']).toBe('io.metamask.three');
  });
  it('truncates a long rdns and keeps the first announcement of an rdns', () => {
    const long = `a.${'b'.repeat(100)}`;
    const list = listWallets([c(long, 'Same', '1'), c('x.y', 'Same', '2'), c('X.Y', 'Same', '3')]);
    expect(list).toHaveLength(2);
    const hint = list.find((w) => w.key === long)?.hint ?? '';
    expect(Array.from(hint)).toHaveLength(MAX_HINT_LENGTH);
    expect(hint.endsWith('…')).toBe(true);
    // First wins: the second 'x.y' (different case) is the same rdns and is ignored.
    expect(list.filter((w) => w.key === 'x.y')).toHaveLength(1);
    expect(list.find((w) => w.key === 'x.y')?.connector.uid).toBe('2');
  });
});

describe('chains and config derive from the registry', () => {
  it('maps every EVM registry chain, in order, with the registry values', () => {
    expect(EVM_CHAINS.map((c) => c.key)).toEqual(
      CHAINS.filter((c) => c.family === 'evm').map((c) => c.key),
    );
    for (const chain of EVM_CHAINS) {
      const w = toWagmiChain(chain);
      expect(String(w.id)).toBe(chain.key.split(':')[1]);
      expect(w.name).toBe(chain.name);
      expect(w.nativeCurrency.symbol).toBe(chain.nativeSymbol);
      expect(w.nativeCurrency.decimals).toBe(chain.nativeDecimals);
      expect(w.blockExplorers?.default.url).toBe(chain.explorer);
      expect(w.rpcUrls.default.http).toEqual([]);
    }
    expect(evmChainId(CHAINS.find((c) => c.family === 'solana')!)).toBeUndefined();
  });
  it('every chain the network menu can offer is an EVM chain with a numeric id', () => {
    expect(EVM_CHAINS.length).toBeGreaterThan(0);
    for (const chain of EVM_CHAINS) {
      expect(chain.family).toBe('evm');
      expect(evmChainId(chain)).toBeTypeOf('number');
    }
  });
  it('looks chains up by wallet id and builds explorer links', () => {
    expect(registryChainByWalletId(1)?.key).toBe('evm:1');
    expect(registryChainByWalletId(8453)?.name).toBe('Base');
    expect(registryChainByWalletId(137)).toBeUndefined();
    expect(registryChainByWalletId(undefined)).toBeUndefined();
    expect(explorerAddressUrl(EVM_CHAINS[0]!, A)).toBe(`${EVM_CHAINS[0]!.explorer}/address/${A}`);
  });
  it('the wagmi config lists exactly the registry chains, in order, with SSR on', () => {
    const config = createWalletConfig();
    expect(config.chains.map((c) => c.id)).toEqual(EVM_CHAINS.map((c) => evmChainId(c)));
    expect(config.chains[0]?.id).toBe(evmChainId(EVM_CHAINS[0]!));
    expect(config._internal.ssr).toBe(true);
  });
  it('transports refuse every request (no browser RPC reads)', async () => {
    const config = createWalletConfig();
    const first = config.chains[0]!;
    await expect(
      config.getClient({ chainId: first.id }).request({ method: 'eth_chainId' }),
    ).rejects.toThrow();
  });
});

describe('wallet error classification', () => {
  it('knows rejection, pending requests and everything else', () => {
    expect(classifyWalletError(Object.assign(new Error('x'), { code: 4001 }))).toBe('rejected');
    expect(classifyWalletError(Object.assign(new Error('x'), { code: -32002 }))).toBe('pending');
    expect(classifyWalletError(new Error('boom'))).toBe('other');
    expect(classifyWalletError(undefined)).toBe('other');
    expect(
      classifyWalletError({ name: 'UserRejectedRequestError', code: 4001, cause: { code: 4001 } }),
    ).toBe('rejected');
    // wagmi wraps a failed "add network" in the same error: not a user rejection.
    expect(
      classifyWalletError({ name: 'UserRejectedRequestError', code: 4001, cause: { code: 4200 } }),
    ).toBe('other');
    expect(classifyWalletError({ name: 'SwitchChainError', cause: { code: -32002 } })).toBe(
      'pending',
    );
  });
});
