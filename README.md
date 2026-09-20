# Cloudreve SDK

> [!IMPORTANT]
> Under active development. Features and interfaces may change. Stay tuned for updates.

A portable TypeScript client for Cloudreve. Typed file operations, resumable transfers, sharing, and durable sessions for Node.js, browsers, and React Native.

## Install

```sh
npm install https://github.com/cloudreve/sdk/releases/download/v1.1.0/cloudreve-sdk-1.1.0.tgz
```

## Usage

```ts
import { createPublicClient } from "@cloudreve/sdk";

const client = createPublicClient({
  endpoint: "https://cloud.example.com",
  transport: fetch,
});

const entries = await client.files.list("cloudreve://SHARE_ID@share/");

console.log(entries);
```

Authenticated clients combine `Authentication` from `@cloudreve/sdk/session` with `createClient` and an application credential store. The SDK handles refresh and cancellation; applications own persistence and platform integration.

The package exposes the complete client and individual modules: `protocol`, `session`, `files`, `transfers`, `shares`, `jobs`, `profile`, and `webdav`. [API reference](docs/api/sdk.api.md) and [compatibility notes](docs/compatibility.md).

## Development

[mise](https://mise.jdx.dev) manages pinned tools; Bun installs dependencies.

```sh
mise trust
mise install
mise run setup
mise run check
mise run package:check
mise run test:e2e
```

Checks cover formatting, lint, types, module boundaries, public API changes, and at least 95% statements, branches, functions, and lines across all production source. Package checks install the tarball into an isolated consumer and verify Node execution, browser bundling, and TypeScript declarations.

GitHub Actions runs build, unit, and package checks on Linux, macOS, and Windows on every push and pull request. Optional Docker E2E runs on Linux against pinned Community 4.17.0 and 4.18.0 images; select a version with `CR_CI_VERSION` and run `mise run test:e2e`.
