import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * The money-path lint rule (eslint.config.mjs, MONEY_PATH_RULES) is only worth what it catches:
 * each way round it that is known is tried here against a file the rule covers, and the allowed
 * integer checks are shown to pass. A rule that stops matching fails here, not silently.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: `${ROOT}eslint.config.mjs` });

async function messages(code: string, file = 'apps/web/src/lib/format.ts') {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${file}` });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax');
}

describe('the money-path lint rule', () => {
  it.each([
    ["Number('1')", "export const v = Number('1');"],
    ['an optional call, Number?.()', "export const v = Number?.('1');"],
    ['globalThis.Number()', "export const v = globalThis.Number('1');"],
    ['window.Number()', "export const v = window.Number('1');"],
    ['new Number()', 'export const v = new Number(1);'],
    ['an alias of Number', "const n = Number; export const v = n('1');"],
    ['bracket access, Number["parseFloat"]()', "export const v = Number['parseFloat']('1');"],
    ['a bare parseInt()', "export const v = parseInt('1');"],
    ['a bare parseFloat()', "export const v = parseFloat('1');"],
    ['Number.parseInt()', "export const v = Number.parseInt('1');"],
    ['Number.parseFloat?.()', "export const v = Number.parseFloat?.('1');"],
    ['globalThis.parseInt()', "export const v = globalThis.parseInt('1');"],
    ['.toFixed()', 'export const v = (1n as unknown as number).toFixed(2);'],
    ['.toLocaleString()', 'export const v = (5n).toLocaleString();'],
    ['bracket .toFixed', "export const v = (1 as number)['toFixed'](2);"],
    ['Math.round()', 'export const v = Math.round(1);'],
    ['Math["floor"]()', "export const v = Math['floor'](1);"],
    ['an alias of Math', 'const m = Math; export const v = m.min(1, 2);'],
    ['Intl.NumberFormat', 'export const v = new Intl.NumberFormat();'],
    ['unary plus', "export const v = +'1';"],
    ['a decimal literal', 'export const v = 1.5;'],
    ['a decimal literal with separators', 'export const v = 1_0.5;'],
    ['an exponent literal', 'export const v = 1e3;'],
    ['a trailing-dot literal', 'export const v = 1.;'],
  ])('refuses %s', async (_name, code) => {
    expect((await messages(code)).length).toBeGreaterThan(0);
  });

  it('allows the integer checks, min, max and abs, and bigint maths', async () => {
    const ok = [
      'export const a = Number.isInteger(1);',
      'export const b = Number.isSafeInteger(1);',
      'export const c = Math.min(1, 2) + Math.max(1, 2) + Math.abs(-1);',
      'export const d = (10n ** 6n) / 3n;',
      "export const e = '1.5'.length;",
    ].join('\n');
    expect(await messages(ok)).toEqual([]);
  });

  it.each([
    'apps/web/src/lib/swap/amount.ts',
    'apps/web/src/lib/swap/rate.ts',
    'apps/web/src/lib/api/quote.ts',
    'apps/web/src/lib/format.ts',
    'apps/web/src/lib/fee-copy.ts',
    'apps/web/src/lib/api/schemas.ts',
    'apps/web/src/lib/swap/tokens.ts',
    'apps/web/src/lib/swap/model.ts',
    'apps/web/src/lib/swap/copy.ts',
    'apps/web/src/lib/swap/use-swap.ts',
    'apps/web/src/lib/picker/model.ts',
    'apps/web/src/components/quote-details.tsx',
    'apps/web/src/components/swap-panel.tsx',
    'apps/web/src/components/swap-screen.tsx',
    'apps/web/src/components/swap-cta.tsx',
    'apps/web/src/components/token-row.tsx',
  ])('covers %s', async (file) => {
    expect((await messages("export const v = Number?.('1');", file)).length).toBeGreaterThan(0);
  });

  it('still bans inline styles in the money files (the rule block replaces the general one)', async () => {
    const jsx = 'export const A = () => <div style={{ color: "red" }} />;';
    expect((await messages(jsx, 'apps/web/src/components/swap-panel.tsx')).length).toBeGreaterThan(
      0,
    );
  });
});
