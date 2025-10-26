/**
 * Summary: Flat ESLint configuration aligning Tanks for Nothing's JavaScript and TypeScript sources with modern linting best practices.
 * Structure: Imports recommended presets from @eslint/js and typescript-eslint, declares global environments, and centralizes ignore patterns.
 * Usage: Run `npm run lint` to validate source files across server, client, admin, and tooling packages.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sharedIgnores = ['dist/**', 'node_modules/**', 'public/libs/**'];

export default tseslint.config(
  {
    name: 'tanksfornothing/ignores',
    ignores: sharedIgnores,
  },
  {
    name: 'tanksfornothing/language-options',
    files: ['**/*.{js,ts,tsx,cjs,mjs}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: 'tanksfornothing/custom-rules',
    rules: {
      'no-undef': 'off',
      'prefer-const': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  }
);
