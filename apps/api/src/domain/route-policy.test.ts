import { describe, expect, it } from 'vitest';
import { TRUSTED_ROUTERS, ZEROX_ALLOWANCE_HOLDER, ZEROX_SETTLERS } from '../trusted-routers.js';
import { buildRoutePolicy, trustedRouter } from './route-policy.js';

const AH = '0x0000000000001fF3684f28c67538d4D072C22734';

describe('route policy', () => {
  it('lowercases addresses and finds routers case-insensitively', () => {
    const policy = buildRoutePolicy({
      1: [{ kind: 'zerox-allowance-holder', address: AH, targets: [`0x${'AB'.repeat(20)}`] }],
    });
    expect(trustedRouter(policy, 1, AH.toLowerCase())).toEqual({
      kind: 'zerox-allowance-holder',
      address: AH.toLowerCase(),
      targets: [`0x${'ab'.repeat(20)}`],
    });
    expect(trustedRouter(policy, 1, `0x${'00'.repeat(20)}`)).toBeUndefined();
    expect(trustedRouter(policy, 10, AH)).toBeUndefined();
  });

  it('rejects malformed or empty entries', () => {
    const entry = { kind: 'zerox-allowance-holder' as const, address: AH, targets: [AH] };
    expect(() => buildRoutePolicy({ 1: [{ ...entry, address: '0x1234' }] })).toThrow('chain 1');
    expect(() => buildRoutePolicy({ 1: [{ ...entry, targets: [] }] })).toThrow('chain 1');
    expect(() => buildRoutePolicy({ 1: [{ ...entry, targets: ['nope'] }] })).toThrow('chain 1');
  });

  it('trusts the AllowanceHolder with exactly two Settlers on each configured chain', () => {
    expect([...TRUSTED_ROUTERS.keys()]).toEqual([1, 8453, 42161]);
    for (const [chainId, settlers] of Object.entries(ZEROX_SETTLERS)) {
      const router = trustedRouter(TRUSTED_ROUTERS, Number(chainId), ZEROX_ALLOWANCE_HOLDER);
      expect(router?.targets).toEqual(settlers);
      expect(new Set(settlers).size).toBe(2);
    }
  });
});
