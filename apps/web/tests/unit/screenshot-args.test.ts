import { describe, expect, it } from 'vitest';
import { fileName, parseArgs, routeSlug } from '../../scripts/screenshot-args.ts';

describe('screenshot args', () => {
  it('defaults to the home route and ./.screenshots', () => {
    expect(parseArgs([])).toEqual({ routes: ['/'], out: './.screenshots' });
  });
  it('collects routes and --out in either form', () => {
    expect(parseArgs(['/', '/trade', '--out', 'x'])).toEqual({ routes: ['/', '/trade'], out: 'x' });
    expect(parseArgs(['--out=y', '/buy'])).toEqual({ routes: ['/buy'], out: 'y' });
  });
  it('rejects bad input', () => {
    expect(() => parseArgs(['--out'])).toThrow('--out needs');
    expect(() => parseArgs(['--out='])).toThrow('--out needs');
    expect(() => parseArgs(['--nope'])).toThrow('unknown option');
    expect(() => parseArgs(['trade'])).toThrow('must start with');
  });
  it('names files by route and size', () => {
    expect(routeSlug('/')).toBe('home');
    expect(routeSlug('/trade/eth?x=1')).toBe('trade-eth');
    expect(fileName('/', { width: 390, height: 844 })).toBe('home-390x844.png');
  });
});
