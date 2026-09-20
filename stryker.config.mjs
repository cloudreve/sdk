import { readFileSync } from "node:fs";

const lines = readFileSync("src/session/index.ts", "utf8").split("\n");
const guard = lines.findIndex((line) => line.includes("this.generation !== undefined &&")) + 1;

if (!guard) {
  throw Error("Session generation guard moved; review mutation target");
}

export default {
  mutate: [`src/session/index.ts:${guard - 1}:0-${guard + 2}:100`],
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  coverageAnalysis: "perTest",
  concurrency: 2,
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: ".artifacts/mutation.json" },
  thresholds: { high: 100, low: 100, break: 100 },
  tempDirName: ".artifacts/stryker",
};
