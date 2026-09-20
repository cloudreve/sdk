import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@cloudreve/sdk/client": resolve("src/client.ts"),
      ...Object.fromEntries(
        ["protocol", "session", "files", "transfers", "shares", "jobs", "profile", "webdav"].map(
          (name) => [`@cloudreve/sdk/${name}`, resolve(`src/${name}/index.ts`)],
        ),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json", "json-summary"],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
