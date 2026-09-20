# Contributing

Use `mise run setup` to install locked dependencies and commit hooks. Run `mise run check` and `mise run package:check` before submitting a pull request. Linux contributors with Docker can run `mise run test:e2e`.

## Architecture

The SDK owns portable protocol and backend behavior. Keep filesystem, UI, native persistence, and platform scheduling in consuming applications. Modules import other modules through their public `index.ts` entry points; dependency checks enforce these boundaries.

Prefer focused changes to the existing `session`, `files`, `transfers`, `shares`, `jobs`, `profile`, and `webdav` modules. Document public behavior and constraints with concise TSDoc. Run `mise run api:update` for intentional API changes and review the generated report.

## Formatting

[Foundation](https://github.com/cloudreve/foundation) supplies shared ESLint and Prettier policies through the release-pinned `@cloudreve/quality` development dependency. Runtime code remains independent of Foundation.

Formatting uses two-space indentation, 100-column wrapping, and one blank line between imports and code, declarations and execution, control-flow blocks, functions, types, class methods, and section comments. Keep related short declarations together; use braces for every control-flow body and one variable per declaration. `mise run format` applies ESLint fixes and Prettier, then checks spacing after wrapping; `mise run check` enforces both.

## Validation

Dependency lifecycle scripts are disabled during installation. Project builds run explicitly through mise; optional native dependency optimizations are not required for these checks.

Add deterministic tests for new behavior and regression tests for fixes. All production source is included in the 95% coverage floor for statements, branches, functions, and lines. Do not hide untested paths with exclusions.

Real contracts live in `tests/contract`; `tooling/ci` provisions disposable digest-pinned Community containers and removes only resources owned by that run. Never point mutation tests at a production server. Optional-service contracts describe their additional fixture requirements.

Dependencies use Bun and a committed lockfile. Development packages are pinned to Foundation release assets and verified by the lockfile; runtime code must not import them. Keep local credentials, agent notes, and test receipts out of commits.
