import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Nothing in the application writes to the log except src/lib/log.ts, which
    // strips anything that could carry a person's details. A stray console call
    // anywhere else would bypass that, so the rule is mechanical rather than a
    // habit. It is scoped to application code only: the migration runner and the
    // tests are meant to print, and are not a path a visitor's data travels.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: { "no-console": "error" },
  },
  {
    files: ["src/lib/log.ts"],
    rules: { "no-console": "off" },
  },
]);

export default eslintConfig;
