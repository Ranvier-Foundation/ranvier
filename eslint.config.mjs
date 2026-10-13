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
    // In tests a wrong assumption fails loudly, so non-null assertions are allowed.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
