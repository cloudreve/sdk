import { sdkConfig, structuralSpacing } from "@cloudreve/quality/eslint";

export default [
  ...sdkConfig,
  {
    rules: {
      curly: ["error", "all"],
      "one-var": ["error", "never"],
    },
  },
  structuralSpacing,
];
