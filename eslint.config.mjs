import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
    // Strict CSP: the web app must emit no inline styles (no `style-src 'unsafe-inline'`).
    // Dynamic values go through classes and CSS variables from tokens; a truly dynamic value uses
    // `ref.style.setProperty` inside an effect, with a comment (docs/ui-guidelines.md section 1).
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
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
          selector:
            "CallExpression[callee.property.name='createElement'][arguments.0.value='style']",
          message: 'No createElement("style"): it is an inline style.',
        },
      ],
    },
  },
  {
    // Money paths: amounts are bigint base units and decimal strings, USD is integer cents. No
    // float conversion, rounding or formatting in the files that turn text into base units, derive
    // rates and read quote amounts (CLAUDE.md, Rules). `no-restricted-syntax` replaces the block
    // above for these files, so the inline-style rules are repeated.
    files: [
      'apps/web/src/lib/swap/amount.ts',
      'apps/web/src/lib/swap/rate.ts',
      'apps/web/src/lib/api/quote.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='style']",
          message: 'No style prop (strict CSP).',
        },
        {
          selector: "CallExpression[callee.name=/^(parseFloat|Number)$/]",
          message: 'No Number() or parseFloat() in a money path: use bigint and exact string maths.',
        },
        {
          selector: "CallExpression[callee.object.name='Number'][callee.property.name=/^(parseFloat|parseInt)$/]",
          message: 'No Number.parseFloat() or Number.parseInt() in a money path.',
        },
        {
          selector: "MemberExpression[property.name=/^(toFixed|toPrecision|toExponential|toLocaleString)$/]",
          message: 'No float formatting in a money path.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil|trunc|pow|sqrt|log|log10|exp)$/]",
          message: 'No Math rounding or powers in a money path: use bigint division and `10n ** n`.',
        },
        {
          selector: "UnaryExpression[operator='+']",
          message: 'No unary plus (a hidden Number conversion) in a money path.',
        },
        {
          selector: "Literal[raw=/^\\d*\\.\\d+$/]",
          message: 'No decimal literal in a money path.',
        },
      ],
    },
  },
  {
    // In tests a wrong assumption fails loudly, so non-null assertions are allowed.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
