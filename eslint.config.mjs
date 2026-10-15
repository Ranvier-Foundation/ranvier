import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Strict CSP: the web app must emit no inline styles (no `style-src 'unsafe-inline'`).
 * Dynamic values go through classes and CSS variables from tokens; a truly dynamic value uses
 * `ref.style.setProperty` inside an effect, with a comment (docs/ui-guidelines.md section 1).
 */
const INLINE_STYLE_RULES = [
  {
    selector: "JSXAttribute[name.name='style']",
    message:
      'No style prop: it emits an inline style, which the strict CSP forbids. Use a class or a token CSS variable (docs/ui-guidelines.md).',
  },
  {
    selector: "JSXOpeningElement[name.name='style']",
    message:
      'No <style> element: it is an inline style. Put the rule in globals.css or a CSS module.',
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message:
      'No dangerouslySetInnerHTML: it can inject <style> or style attributes and is an XSS sink.',
  },
  {
    selector: "CallExpression[callee.property.name='createElement'][arguments.0.value='style']",
    message: 'No createElement("style"): it is an inline style.',
  },
];

const FLOAT_FORMATTERS = 'toFixed|toPrecision|toExponential|toLocaleString';

/**
 * Money paths: amounts are bigint base units and decimal strings, USD is integer cents. No float
 * conversion, rounding or formatting in the files that turn text into base units, derive rates,
 * read quote amounts and format money for display (CLAUDE.md, Rules). The rules look at the names
 * wherever they appear, so `globalThis.Number(x)`, `Number?.(x)`, `new Number(x)`, `Number['parseFloat']`,
 * `const n = Number` and a bare `parseInt` are all caught; only the integer checks
 * `Number.isInteger` and `Number.isSafeInteger` are allowed. `no-restricted-syntax` replaces the
 * block for all web files, so the inline-style rules are repeated.
 */
const MONEY_PATH_RULES = [
  ...INLINE_STYLE_RULES,
  {
    selector:
      "Identifier[name='Number']:not(MemberExpression[property.name=/^(isInteger|isSafeInteger)$/] > Identifier.object)",
    message:
      'No Number (Number(), new Number(), globalThis.Number, an alias) in a money path: use bigint and exact string maths. Number.isInteger and Number.isSafeInteger are the only members allowed.',
  },
  {
    selector: 'Identifier[name=/^(parseFloat|parseInt)$/]',
    message:
      'No parseFloat() or parseInt() (bare, global or on Number) in a money path: use bigint and exact string maths.',
  },
  {
    selector: `MemberExpression[property.name=/^(${FLOAT_FORMATTERS})$/], MemberExpression[property.value=/^(${FLOAT_FORMATTERS})$/]`,
    message: 'No float formatting in a money path.',
  },
  {
    selector: "Identifier[name='Intl']",
    message: 'No Intl number formatting in a money path (it formats floats): format from bigint.',
  },
  {
    selector:
      "MemberExpression[object.name='Math'][property.name!=/^(min|max|abs|sign)$/], MemberExpression[object.name='Math'][computed=true]",
    message:
      'No Math rounding or powers in a money path: use bigint division and `10n ** n`. Only Math.min, max, abs and sign are allowed.',
  },
  {
    selector: "Identifier[name='Math']:not(MemberExpression > Identifier.object)",
    message: 'No aliasing Math in a money path.',
  },
  {
    selector: "UnaryExpression[operator='+']",
    message: 'No unary plus (a hidden Number conversion) in a money path.',
  },
  {
    selector:
      'Literal[raw=/^[0-9_]*\\.[0-9_]*([eE][+-]?[0-9]+)?$/], Literal[raw=/^[0-9_]+[eE][+-]?[0-9]+$/]',
    message: 'No decimal or exponent literal in a money path.',
  },
];

const MONEY_PATH_FILES = [
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
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/node_modules/**', 'contracts/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...INLINE_STYLE_RULES] },
  },
  {
    // The money paths (see MONEY_PATH_RULES): the files that turn text into base units, derive
    // rates, read quote amounts and format money, tokens, fees and the quote's countdown for display.
    files: MONEY_PATH_FILES,
    rules: { 'no-restricted-syntax': ['error', ...MONEY_PATH_RULES] },
  },
  {
    // In tests a wrong assumption fails loudly, so non-null assertions are allowed.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
