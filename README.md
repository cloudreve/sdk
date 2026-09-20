# Cloudreve SDK

A portable TypeScript client for Cloudreve. Typed file operations, resumable transfers, sharing, and durable sessions for **Node.js, browsers, and React Native**.

> [!IMPORTANT]
> Under active development. Features and interfaces may change. Stay tuned for updates.

[API reference](docs/api/sdk.api.md) · [Compatibility](docs/compatibility.md) · [Releases](https://github.com/cloudreve/sdk/releases) · [MIT](LICENSE)

## Install

```sh
npm install https://github.com/cloudreve/sdk/releases/download/v1.1.0/cloudreve-sdk-1.1.0.tgz
```

Published as a versioned release archive; an npm registry release is not yet available.

## Usage

```ts
import { createPublicClient } from "@cloudreve/sdk";

const client = createPublicClient({
  endpoint: "https://cloud.example.com",
  transport: fetch,
});

const { files } = await client.files.list("cloudreve://SHARE_ID@share/");

for (const file of files) {
  console.log(file.name);
}
```

This example lists a public share. Authenticated clients combine `Authentication` from `@cloudreve/sdk/session`, `createClient`, and an application credential store.

## Modules

| Area                 | Modules                                  |
| -------------------- | ---------------------------------------- |
| **Connect**          | `protocol` · `session`                   |
| **Store & transfer** | `files` · `transfers`                    |
| **Share & manage**   | `shares` · `jobs` · `profile` · `webdav` |

The root export provides the complete client. Individual entry points expose each module. The SDK handles token refresh and request cancellation; applications own credential persistence and platform integration.

## Development

Tools are pinned with [mise](https://mise.jdx.dev/); dependencies use Bun.

```sh
mise install
mise run setup
mise run check
mise run package:check
```

---

[Cloudreve](https://github.com/cloudreve/cloudreve) · [Foundation](https://github.com/cloudreve/foundation) · **SDK** · [CLI](https://github.com/cloudreve/cli)
