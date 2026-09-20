import { it, expect } from "vitest";
import { mkdtempSync, cpSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

for (const [name, source, violation] of [
  ["platform", 'import fs from "node:fs"; export const x = fs;', "sdk-is-portable"],
  [
    "private",
    'import { CrUri } from "../files/uri.ts"; export const x = CrUri;',
    "session-public-dependencies",
  ],
  ["unresolved", 'import x from "missing-platform"; export { x };', "no-unresolved"],
] as const) {
  it(`rejects ${name} dependency through the real graph checker`, () => {
    const directory = mkdtempSync(join(tmpdir(), "cloudreve-sdk-arch-"));

    try {
      symlinkSync(
        resolve(root, "node_modules"),
        join(directory, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );

      cpSync("src", join(directory, "src"), { recursive: true });
      cpSync("tsconfig.json", join(directory, "tsconfig.json"));
      cpSync(".dependency-cruiser.mjs", join(directory, ".dependency-cruiser.mjs"));
      writeFileSync(join(directory, "src/session/forbidden.ts"), source);

      const result = spawnSync(
        process.execPath,
        [
          resolve(root, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs"),
          "src",
          "--config",
          ".dependency-cruiser.mjs",
        ],
        { cwd: directory, encoding: "utf8" },
      );

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout + result.stderr).toContain(violation);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

it("rejects hidden platform globals while permitting explicitly injected values", async () => {
  const { Linter } = await import("eslint");
  const { sdkConfig } = await import("@cloudreve/quality/eslint");

  const lint = (text: string) =>
    new Linter().verify(text, sdkConfig, { filename: "src/files/probe.ts" });

  for (const text of [
    "export const x=document.cookie;",
    "export const x=globalThis.fetch;",
    'export const x=localStorage.getItem("token");',
    "export const x=process.env;",
    "declare const document:any; export const x=document;",
    "export const x = ;",
  ]) {
    expect(lint(text).length).toBeGreaterThan(0);
  }

  expect(lint("export function use(document:{id:string}) { return document.id; }")).toEqual([]);
});
