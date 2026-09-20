import { expect, it } from "vitest";
import { compareSemver, validateServerVersion } from "../../src/session/index.ts";

it("orders the complete SemVer prerelease precedence sequence in both directions", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];

  for (const [i, a] of ordered.entries()) {
    for (const [j, b] of ordered.entries()) {
      expect(compareSemver(a, b), `${a} versus ${b}`).toBe(Math.sign(i - j));
    }
  }
});

it("handles numeric and lexical identifiers, complete labels and ignored build metadata", () => {
  for (const [a, b] of [
    ["4.19.0-alpha.2", "4.19.0-alpha.10"],
    ["4.19.0-2", "4.19.0-10"],
    ["4.19.0-999", "4.19.0-1a"],
    ["4.19.0-999", "4.19.0--"],
    ["4.19.0-alpha-a", "4.19.0-alpha-b"],
    ["4.19.0-alpha-1", "4.19.0-alpha-2"],
    ["4.19.0-ALPHA", "4.19.0-alpha"],
    ["4.19.0-alpha.9007199254740992", "4.19.0-alpha.9007199254740993"],
    ["4.19.0-9007199254740993", "4.19.0-10000000000000000000"],
    ["4.19.0-2.9007199254740993", "4.19.0-10.9007199254740992"],
    ["4.19.0-alpha.9007199254740993", "4.19.0-beta.9007199254740992"],
    ["4.10.0-alpha", "4.17.0"],
    ["4.19.1-9007199254740993", "4.20.0-1"],
    ["5.0.0-alpha", "5.0.0"],
  ]) {
    expect(compareSemver(a!, b!)).toBe(-1);
    expect(compareSemver(b!, a!)).toBe(1);
  }

  for (const version of ["4.19.0", "4.19.0-alpha.1", "4.19.0-9007199254740993"]) {
    expect(compareSemver(version, `${version}+build.001`)).toBe(0);
    expect(compareSemver(`${version}+a-b.1`, `${version}+other.42`)).toBe(0);
  }
});

const invalid = [
  "",
  "4",
  "4.1",
  "4.1.0.0",
  "v4.19.0",
  "=4.19.0",
  " 4.19.0",
  "4.19.0\n",
  "04.19.0",
  "4.019.0",
  "4.19.00",
  "4.19.0-01",
  "4.19.0-alpha.01",
  "4.19.0-",
  "4.19.0-alpha..1",
  "4.19.0-alpha_beta",
  "4.19.0-α",
  "4.19.0+",
  "4.19.0+build..1",
  "4.19.0+build+extra",
  "4.19.0+build_1",
  "9007199254740992.0.0",
];

it.each(invalid)("rejects noncanonical or malformed version %j on either side", (version) => {
  expect(() => compareSemver(version, "4.19.0")).toThrow("Invalid version");
  expect(() => compareSemver("4.19.0", version)).toThrow("Invalid version");
});

it("discovers Community and Pro prereleases and build metadata without comparing the edition marker", async () => {
  for (const version of [
    "4.19.0",
    "4.19.0-alpha.1",
    "4.19.0-alpha-dev.2",
    "4.19.0+build.001",
    "4.19.0-alpha.1+build.001",
  ]) {
    for (const isPro of [false, true]) {
      expect(
        await validateServerVersion("https://cloud.example", async () =>
          Response.json({ code: 0, data: version + (isPro ? "-pro" : "") }),
        ),
      ).toEqual({ version, isPro });
    }
  }

  await expect(
    validateServerVersion("https://cloud.example", async () =>
      Response.json({ code: 0, data: "4.0.0-alpha.1-pro" }),
    ),
  ).rejects.toMatchObject({
    type: "versionTooLow",
    params: { version: "4.0.0-alpha.1", minVersion: "4.0.0" },
  });
});

it("classifies malformed discovered versions as API errors for either edition", async () => {
  for (const version of invalid) {
    for (const suffix of ["", "-pro"]) {
      await expect(
        validateServerVersion("https://cloud.example", async () =>
          Response.json({ code: 0, data: version + suffix }),
        ),
      ).rejects.toMatchObject({
        type: "apiError",
        params: { message: "Invalid server version" },
      });
    }
  }

  for (const data of [null, false, 419, {}, []]) {
    await expect(
      validateServerVersion("https://cloud.example", async () => Response.json({ code: 0, data })),
    ).rejects.toMatchObject({
      type: "apiError",
      params: { message: "Invalid server version" },
    });
  }
});
