import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "build/**",
      "dogfood-output/**",
      "node_modules/**",
      ".worktrees/**",
      "src-tauri/target/**",
    ],
  },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["client/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/text-\\[[0-9]/]",
          message:
            "Use the named font-size tokens (text-label/text-body/text-title/text-display) instead of arbitrary text-[…] sizes.",
        },
        {
          selector: "TemplateElement[value.raw=/text-\\[[0-9]/]",
          message:
            "Use the named font-size tokens (text-label/text-body/text-title/text-display) instead of arbitrary text-[…] sizes.",
        },
      ],
    },
  },
  {
    files: ["server/**/*.ts", "script/**/*.ts", "*.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
