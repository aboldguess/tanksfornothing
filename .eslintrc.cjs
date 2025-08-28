/**
 * Summary: ESLint configuration using eslint:recommended rules for Tanks for Nothing.
 * Structure: Defines environments for browser and Node.js, sets ECMAScript version 2021 modules,
 *            and ignores generated directories to keep linting focused on source.
 * Usage: Run `npm run lint` to analyze project JavaScript files and surface potential issues.
 */
module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2021: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  ignorePatterns: ['node_modules', 'public/libs'],
};
