// Runinback — ESLint flat config. Correctness rules only; formatting is left to
// .editorconfig so legacy files don't churn.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "supabase/functions/**/*.ts"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "supabase/functions/_shared/game-rules/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, __RUNINBACK_CONFIG__: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["tests/**/*.js", "*.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
];
