import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync("docs/api", { recursive: true });

const localBuild = process.argv.includes("--local");

const config = ExtractorConfig.prepare({
  configObject: {
    projectFolder: resolve("."),
    newlineKind: "lf",
    mainEntryPointFilePath: resolve("dist/index.d.ts"),
    compiler: { tsconfigFilePath: resolve("tsconfig.json") },
    apiReport: {
      enabled: true,
      reportFileName: "sdk.api.md",
      reportFolder: resolve("docs/api"),
      reportTempFolder: resolve(".artifacts/api"),
    },
    docModel: { enabled: false },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    messages: {
      extractorMessageReporting: {
        default: { logLevel: "warning" },
        "ae-undocumented": { logLevel: "none" },
        "ae-missing-release-tag": { logLevel: "error" },
      },
    },
  },
  configObjectFullPath: resolve("api-extractor.json"),
  packageJsonFullPath: resolve("package.json"),
});

const result = Extractor.invoke(config, {
  localBuild,
  showVerboseMessages: false,
});

if (result.errorCount || (!localBuild && result.apiReportChanged)) {
  process.exitCode = 1;
}
