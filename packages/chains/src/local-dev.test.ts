/**
 * The local test chain (ADR 0013, section 2) is well formed and stays outside everything the
 * package serves: the registry, the token list, the public RPC defaults and the package index
 * (its TypeScript surface and the index the build emits).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as index from './index.js';
import * as localDev from './local-dev.js';
import {
  LOCAL_DEV_CHAIN,
  LOCAL_DEV_CHAIN_ID,
  LOCAL_DEV_CHAIN_KEY,
  LOCAL_DEV_CONTRACTS,
  localDevAddresses,
  localDevToken,
} from './local-dev.js';
import { CHAINS, getChain, isValidTokenAddress } from './registry.js';
import { PUBLIC_RPC_URLS } from './rpc-defaults.js';
import { listTokens, TOKEN_LIST } from './tokens.js';

const PKG = fileURLToPath(new URL('../', import.meta.url));
const LOCAL_NAME = 'Local test chain';

function everyObjectFrozen(value: unknown, path = 'root'): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const own = Object.isFrozen(value) ? [] : [path];
  return [
    ...own,
    ...Object.entries(value).flatMap(([k, v]) => everyObjectFrozen(v, `${path}.${k}`)),
  ];
}

/** Every string in a value, recursively (keys included). */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
}

describe('LOCAL_DEV_CHAIN', () => {
  it('is chain 31337 under the agreed name and the registry shape', () => {
    expect(LOCAL_DEV_CHAIN_ID).toBe(31337);
    expect(LOCAL_DEV_CHAIN.key).toBe('evm:31337');
    expect(LOCAL_DEV_CHAIN.key).toBe(LOCAL_DEV_CHAIN_KEY);
    expect(LOCAL_DEV_CHAIN.chainId).toBe(LOCAL_DEV_CHAIN_ID);
    expect(LOCAL_DEV_CHAIN.name).toBe('Local test chain (not a real network)');
    expect(LOCAL_DEV_CHAIN.family).toBe('evm');
    expect(LOCAL_DEV_CHAIN.nativeSymbol).toBe('ETH');
    expect(LOCAL_DEV_CHAIN.nativeDecimals).toBe(18);
  });

  it('lists the native coin, hWETH (18, wrapped native) and hUSDC (6)', () => {
    expect(LOCAL_DEV_CHAIN.tokens.map((t) => [t.symbol, t.address, t.decimals])).toEqual([
      ['ETH', 'native', 18],
      ['hWETH', '0x47fa559be608137ea4d28588b6c57d0d1ac6552d', 18],
      ['hUSDC', '0x5784f90419222088ac18ae5b62ef381f4cb2deb1', 6],
    ]);
    expect(LOCAL_DEV_CHAIN.wrappedNative).toBe(localDevToken('hWETH').address);
    expect(localDevToken('hWETH').tags).toEqual(['wrapped-native']);
    expect(LOCAL_DEV_CHAIN.knownDecimals).toEqual({
      [localDevToken('hWETH').address]: 18,
      [localDevToken('hUSDC').address]: 6,
    });
    expect(() => localDevToken('hDAI' as 'hUSDC')).toThrow('local-dev lists no hDAI');
  });

  it('never selects a fee rate: no stablecoins, no stablecoin tag', () => {
    expect(LOCAL_DEV_CHAIN.stablecoins).toEqual({});
    expect(LOCAL_DEV_CHAIN.tokens.some((t) => t.tags?.includes('stablecoin'))).toBe(false);
  });

  it('every token is on the local chain with a valid lowercase address', () => {
    for (const t of LOCAL_DEV_CHAIN.tokens) {
      expect(t.chain).toBe(LOCAL_DEV_CHAIN_KEY);
      expect(isValidTokenAddress('evm', t.address), t.address).toBe(true);
      expect(t.address).toBe(t.address.toLowerCase());
    }
  });

  it('pins distinct, valid, lowercase contract addresses', () => {
    const all = [...localDevAddresses(), LOCAL_DEV_CONTRACTS.create2Factory];
    expect(new Set(all).size).toBe(all.length);
    expect(localDevAddresses()).toHaveLength(2 + 3 + 11);
    for (const a of all) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('is deep-frozen, like the registry', () => {
    expect(everyObjectFrozen(LOCAL_DEV_CHAIN)).toEqual([]);
    expect(everyObjectFrozen(LOCAL_DEV_CONTRACTS)).toEqual([]);
    expect(() => {
      (LOCAL_DEV_CHAIN.stablecoins as Record<string, string>).hUSDC = '0x';
    }).toThrow(TypeError);
  });
});

describe('the local chain stays out of the registry and the served lists', () => {
  const locals = localDevAddresses();

  it('CHAINS has no 31337 and no harness address', () => {
    expect(CHAINS.map((c) => c.key)).not.toContain(LOCAL_DEV_CHAIN_KEY);
    expect(getChain(LOCAL_DEV_CHAIN_KEY)).toBeUndefined();
    const text = strings(CHAINS).map((s) => s.toLowerCase());
    for (const a of locals) expect(text).not.toContain(a);
    expect(text.some((s) => s.includes(LOCAL_NAME.toLowerCase()))).toBe(false);
  });

  it('TOKEN_LIST has no 31337 token and no harness address', () => {
    expect(TOKEN_LIST.filter((t) => t.chain === LOCAL_DEV_CHAIN_KEY)).toEqual([]);
    expect(listTokens(LOCAL_DEV_CHAIN_KEY)).toEqual([]);
    const listed = new Set(TOKEN_LIST.map((t) => t.address.toLowerCase()));
    for (const a of locals) expect(listed.has(a), a).toBe(false);
  });

  it('PUBLIC_RPC_URLS has no 31337 entry and no loopback URL', () => {
    expect(Object.keys(PUBLIC_RPC_URLS)).not.toContain(LOCAL_DEV_CHAIN_KEY);
    for (const url of Object.values(PUBLIC_RPC_URLS).flat()) {
      expect(url).not.toMatch(/127\.0\.0\.1|localhost|\[::1\]/);
    }
  });
});

describe('the package index does not export local-dev', () => {
  const localNames = Object.keys(localDev);

  it('the runtime index shares no export (name or value) with local-dev', () => {
    expect(localNames.length).toBeGreaterThan(0);
    expect(Object.keys(index).filter((k) => localNames.includes(k))).toEqual([]);
    const values = new Set<unknown>(Object.values(localDev));
    expect(Object.entries(index).filter(([, v]) => values.has(v))).toEqual([]);
  });

  it('the TypeScript surface of index.ts (types included) has no local-dev export', () => {
    const file = join(PKG, 'src/index.ts');
    const program = ts.createProgram([file, join(PKG, 'src/local-dev.ts')], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const exportsOf = (path: string): ts.Symbol[] => {
      const source = program.getSourceFile(path);
      const symbol = source && checker.getSymbolAtLocation(source);
      if (!symbol) throw new Error(`no module symbol for ${path}`);
      return checker.getExportsOfModule(symbol);
    };
    const localDevFile = join(PKG, 'src/local-dev.ts');
    const localTypes = exportsOf(localDevFile).map((s) => s.getName());
    expect(localTypes).toEqual(expect.arrayContaining(['LocalDevChain', 'LocalDevContracts']));
    const indexExports = exportsOf(file);
    expect(indexExports.length).toBeGreaterThan(10);
    expect(indexExports.map((s) => s.getName()).filter((n) => localTypes.includes(n))).toEqual([]);
    // No index export is declared in local-dev.ts, under any name.
    const declaredIn = (s: ts.Symbol): string[] => {
      const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
      return (target.declarations ?? []).map((d) => d.getSourceFile().fileName);
    };
    expect(indexExports.filter((s) => declaredIn(s).includes(localDevFile))).toEqual([]);
  });

  describe('the built dist index', () => {
    let out = '';

    beforeAll(() => {
      // A real build of this package (its own tsconfig.build.json) into a scratch directory.
      out = mkdtempSync(join(tmpdir(), 'ranvier-chains-dist-'));
      const tsc = join(fileURLToPath(import.meta.resolve('typescript')), '../../bin/tsc');
      execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', out], {
        cwd: PKG,
        stdio: 'pipe',
      });
    }, 120_000);

    afterAll(() => {
      if (out) rmSync(out, { recursive: true, force: true });
    });

    it('emits local-dev as its own file, which index.js and index.d.ts never name', async () => {
      expect(readFileSync(join(out, 'local-dev.js'), 'utf8')).toContain(LOCAL_NAME);
      for (const f of ['index.js', 'index.d.ts']) {
        expect(readFileSync(join(out, f), 'utf8')).not.toMatch(/local-dev/);
      }
      const built = (await import(pathToFileURL(join(out, 'index.js')).href)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(built).sort()).toEqual(Object.keys(index).sort());
      expect(Object.keys(built).filter((k) => localNames.includes(k))).toEqual([]);
    });

    it('no module the built index reaches holds the local chain', () => {
      const seen = new Set<string>();
      const visit = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        const text = readFileSync(join(out, file), 'utf8');
        expect(text, file).not.toContain(LOCAL_NAME);
        for (const a of localDevAddresses()) expect(text.toLowerCase(), file).not.toContain(a);
        const info = ts.preProcessFile(text, true, true);
        for (const ref of info.importedFiles) {
          if (ref.fileName.startsWith('./')) visit(ref.fileName.slice(2));
        }
      };
      visit('index.js');
      expect(seen.size).toBeGreaterThan(3);
      expect(seen.has('local-dev.js')).toBe(false);
    });
  });

  it('package.json exports local-dev only as its own subpath', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', default: './dist/index.js' });
    expect(pkg.exports['./local-dev']).toEqual({
      types: './dist/local-dev.d.ts',
      default: './dist/local-dev.js',
    });
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './local-dev']);
  });
});
