# Contributing to Orbit

Thanks for helping build Orbit. Whether you are adding a device connector, fixing a UI bug, or tightening the sync engine, this guide covers how the repository is set up and what we check before merging.

## Prerequisites

- **Bun** 1.3+ (package manager, test runner, and runtime for Orion and Core)
- **Node.js** 22.19+
- **Git** (used by both developers and Orion's local workspace snapshot system)

You do **not** need Rust, Cargo, or Docker installed on your machine to develop and test changes locally.

## The compute rule (strict)

Local development machines run **only light checks**:

- Dependency installation ([`scripts/locked-install.sh`](scripts/locked-install.sh) or `bun install`)
- Biome formatting and linting (`bun run lint`)
- TypeScript typechecking (`bun run typecheck`)
- Fast unit and integration tests (`bun run test`, using `bun test`, `vitest`, and in-process PGlite)
- Vite web builds (`bun run --filter '@orbit/app' build`)
- Playwright end-to-end tests against the web build and a short-lived local Orion dev server

**Never run heavy builds locally.** Do not run `cargo`, `rustc`, `tauri dev`, `tauri build`, `bun build --compile`, `docker`, or any video/image rendering on your local machine. Rust compilation, native desktop installers (`.dmg`, `.msi`, `.deb`, `.AppImage`), compiled sidecar binaries, and Docker images are built exclusively in GitHub Actions CI. When editing Rust files under [`apps/orbit/src-tauri`](apps/orbit/src-tauri), read the types carefully and let CI compile them.

## Local development setup

1. Clone the repository and install dependencies:

```bash
scripts/locked-install.sh
```

Always prefer `scripts/locked-install.sh` when adding packages or working alongside coding agents; it takes a lockfile lock so parallel installs never corrupt `node_modules`.

To add a dependency to a specific workspace package:

```bash
scripts/locked-install.sh packages/orion some-package
```

For internal workspace dependencies, add `"@orbit/schema": "workspace:*"` to the package's `package.json` and run `scripts/locked-install.sh` with no arguments.

2. Run the Orion sidecar and the Orbit UI in two terminals:

```bash
# Terminal 1: Orion sidecar on ws://127.0.0.1:7717/ws (token "dev", seeded demo farm, mock LLM)
bun run --filter '@orion/agent' dev

# Terminal 2: Vite dev server for @orbit/app
bun run --filter '@orbit/app' dev
```

## Code conventions

- **Formatting & Linting:** Enforced by [Biome](biome.json) (2 spaces, double quotes, line width 100, organized imports). Run `bun run lint` to check and `bun run lint:fix` to format.
- **TypeScript:** All packages extend [`tsconfig.base.json`](tsconfig.base.json) with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noImplicitOverride`. Every package must pass `bun run typecheck` (`tsc -p . --noEmit`) with zero errors.
- **Source-first exports:** Workspace packages export `./src/index.ts` directly and use `"type": "module"`. Do not add intermediate TypeScript build steps between libraries.
- **Shared contracts:** Wire frames live in [`packages/protocol`](packages/protocol) and database schemas live in [`packages/schema`](packages/schema). Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing either contract.
- **Domain invariant (one wearable per animal):** A cow or horse wears a collar OR a bolus OR an ear tag sensor, never several at once. Code and copy must always treat them as alternatives and enforce at most one active wearable sensor binding per animal.
- **Product copy:** Keep all UI copy, error messages, and documentation globally neutral (no single-country assumptions). Orbit supports cattle (dairy and beef) and horses.
- **Deterministic tests:** Tests run via `bun test` (for backend/shared packages) and `vitest` (for `@orbit/app`). Subscribe to events or promises rather than using fixed sleeps.
- **Secrets:** Never commit API keys, tokens, or camera passwords. Even in runtime code, secrets belong in the OS keychain, never in SQLite or Postgres tables.

## Submitting a pull request

1. Run the verification suite from the repo root and make sure every command exits 0:

```bash
bun run lint
bun run typecheck
bun run test
```

2. Sign the [Contributor License Agreement](CLA.md). Because Orbit is dual-licensed under [AGPL-3.0-only](LICENSE) and a commercial license ([LICENSING.md](LICENSING.md)), every contributor must agree to the CLA before their first pull request can be merged.
