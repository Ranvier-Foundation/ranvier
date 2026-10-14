import { describe, expect, it } from 'vitest';
import { CHAINS } from './registry.js';
import { PUBLIC_RPC_URLS } from './rpc-defaults.js';
import { TOKEN_LIST } from './tokens.js';

describe('PUBLIC_RPC_URLS', () => {
  it('has keyless https endpoints, two or more per EVM chain with a token list', () => {
    const listed = new Set(TOKEN_LIST.map((t) => t.chain).filter((c) => c.startsWith('evm:')));
    for (const chain of listed) {
      const urls = PUBLIC_RPC_URLS[chain] ?? [];
      expect(urls.length, chain).toBeGreaterThanOrEqual(2);
      expect(new Set(urls).size).toBe(urls.length);
      for (const url of urls) {
        const parsed = new URL(url);
        expect(parsed.protocol).toBe('https:');
        expect(parsed.username + parsed.password + parsed.search).toBe('');
      }
    }
    for (const chain of Object.keys(PUBLIC_RPC_URLS)) {
      expect(CHAINS.some((c) => c.key === chain && c.family === 'evm')).toBe(true);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PUBLIC_RPC_URLS)).toBe(true);
    expect(Object.isFrozen(PUBLIC_RPC_URLS['evm:1'])).toBe(true);
  });
});
