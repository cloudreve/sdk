# Compatibility

The SDK uses standard Web APIs through injected transports and works with Node.js, browser bundlers, and React Native source exports. Native applications supply byte I/O, secure credential storage, and background scheduling. Runtime dependencies are Valibot and semver.

The optional Docker contract suite runs against digest-pinned **4.17.0** and **4.18.0** containers. The suite covers authentication, file lifecycle and search, text conflicts, resumable uploads/downloads, shares, direct links, profiles, WebDAV credentials, and archives. Server version discovery accepts canonical SemVer from 4.0.0 onward; discovery alone does not guarantee every feature is supported. Provider-specific transports and optional services have deterministic tests; live cloud-provider compatibility is not implied.

## Sessions and requests

- Use `createClient` with a bound asynchronous `SessionStore` and `SessionExclusive` for durable credentials. Fresh logins create a generation; refresh preserves it; logout removes only its bound generation. Applications own atomic storage and cross-process exclusion.
- API origins use `/api/v4/`. Authenticated requests reject external or credential-bearing URLs. Storage transports do not receive backend bearer tokens automatically.
- Control requests have a 30-second total deadline, including credential waits and bounded safe retries. Streaming bodies are not inferred replayable. Transfer duration is unlimited by default; callers can set total deadlines and supply inactivity detection.
- Control response bodies and individual SSE frames are limited to 8 MiB. Custom transports without readable response bodies must enforce native buffer limits themselves.
- `Files.events` is a subscription without a default total deadline. Callers own reconnection and stable client identity.

## Files and transfers

- Copy operations preflight destinations and perform one server mutation. Different-name copies and combined cross-directory move-and-rename operations are rejected before writes.
- Text editing is limited to 5 MiB and preserves BOM/version-conflict behavior. Streaming downloads do not inherit that size limit.
- Category URIs are server presets and cannot be combined with other search filters. Paging and sorting remain independent.
- Transfer checkpoints belong to one server, account, and source. Filesystem replacement, native encryption, and OS permissions remain application responsibilities.
- Anonymous archive downloads support files and share roots containing only files. Directory archives require authenticated access because Community guest traversal can omit descendants.
- OAuth requires caller-provided credentials. No client secret is embedded in the package.

`ApiError` retains backend codes, operation data, partial failures, and structured error kinds. Applications own translated messages and secret-safe output.
