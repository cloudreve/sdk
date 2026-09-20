import { execFileSync, spawnSync } from "node:child_process";

const result = spawnSync("git", ["config", "--local", "--unset-all", "core.hooksPath"], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0 && result.status !== 5) {
  process.exit(result.status ?? 1);
}

execFileSync("lefthook", ["install"], { stdio: "inherit" });
