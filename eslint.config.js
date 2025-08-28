/**
 * Summary: ESLint flat configuration applying recommended rules for Tanks for Nothing project.
 * Structure: Exports an array defining ignored paths and JS lint settings using @eslint/js recommended set.
 * Usage: Run `npm run lint` to evaluate source files against these rules.
 */
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules", "public/lib"],
  },
  {
    ...js.configs.recommended,
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
];
