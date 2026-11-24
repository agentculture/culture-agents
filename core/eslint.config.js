import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Scope: core/ only. The repo-level spikes/ directory is throwaway probe code
// outside this package and is never linted; dist/ and node_modules/ are
// generated or installed.
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
