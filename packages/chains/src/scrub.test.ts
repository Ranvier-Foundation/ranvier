import { describe, expect, it } from 'vitest';
import { errText, scrubUrls } from './scrub.js';
import { errText as verifyErrText, scrubUrls as verifyScrubUrls } from './verify.js';

describe('RPC URLs never reach output', () => {
  it('replaces URL-looking substrings with <rpc-url>', () => {
    expect(scrubUrls('Failed to parse URL from https://x.example/v2/KEY')).toBe(
      'Failed to parse URL from <rpc-url>',
    );
    // Commas are URL characters, so a following comma is scrubbed too (over-scrubbing is safe).
    expect(scrubUrls('a wss://node.example:8546/KEY b http://u:p@h/x,y')).toBe(
      'a <rpc-url> b <rpc-url>',
    );
    expect(scrubUrls('host eth-mainnet.g.alchemy.com/v2/KEY failed')).toBe('host <rpc-url> failed');
    expect(scrubUrls('RPC HTTP 429')).toBe('RPC HTTP 429');
    expect(scrubUrls('execution reverted (0x313ce567)')).toBe('execution reverted (0x313ce567)');
  });

  it('formats errors as one scrubbed line of at most 200 characters', () => {
    expect(errText(new Error('bad https://k.example/SECRET'))).toBe('bad <rpc-url>');
    expect(errText('plain https://k.example/SECRET')).toBe('plain <rpc-url>');
    expect(errText(new Error(`${'x'.repeat(300)}`))).toHaveLength(200);
    expect(errText(new Error(`${'x'.repeat(190)} https://k.example/SECRET`))).not.toMatch(
      /SECRET|k\.example/,
    );
  });
});

describe('verify.ts re-exports', () => {
  it('re-exports the shared helpers', () => {
    expect(verifyScrubUrls).toBe(scrubUrls);
    expect(verifyErrText).toBe(errText);
  });
});
