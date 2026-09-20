import { sdkRules } from "@cloudreve/quality/dependencies";
const modules = {
  protocol: [],
  session: ["protocol"],
  files: ["session", "protocol"],
  jobs: ["session", "protocol"],
  webdav: ["session", "protocol"],
  transfers: ["session", "protocol", "files"],
  shares: ["session", "protocol", "files"],
  profile: ["session", "protocol", "transfers"],
};
export default {
  forbidden: [
    ...sdkRules(modules, ["valibot", "semver"]),
    {
      name: "semver-only-in-server-version-boundary",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/session/server\\.ts$" },
      to: { path: "(?:^|/)node_modules/semver/" },
    },
    {
      name: "facade-public-entries",
      severity: "error",
      from: { path: "^src/client\\.ts$" },
      to: { path: "^src/", pathNot: "/index\\.ts$" },
    },
  ],
  options: { tsConfig: { fileName: "tsconfig.json" } },
};
