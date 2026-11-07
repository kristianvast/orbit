# Orbit

**Status:** Early development. Interfaces, database tables, and sync endpoints may change before the first release.

Orbit is an open-source desktop application for livestock farms raising cattle (dairy and beef) and horses. A farmer installs it on a Windows, macOS, or Linux PC on the farm, such as the management computer next to a milking robot.

Inside the app lives **Orion**, an AI agent that knows your herd, reads your sensors, finds cameras on your local network, and writes new connectors or features right on your machine. Every change Orion makes is saved in an invisible local snapshot so you can undo it with one click, and Orion explains risky steps and asks you in the chat before taking them.

## The three names

| Name      | What it is                                                                                               | Where it lives                     |
| --------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Orbit** | The desktop application (Tauri 2 shell + React + TypeScript + Vite)                                      | [`apps/orbit`](apps/orbit)         |
| **Orion** | The AI agent and local data server (Pi SDK running as a Bun sidecar, single writer to local SQLite)      | [`packages/orion`](packages/orion) |
| **Core**  | Optional cloud infrastructure (Postgres, ElectricSQL read-path sync, write API, and metered LLM gateway) | [`core/api`](core/api)             |

## What you can do today

- **Track cattle and horses:** Manage dairy cattle, beef cattle, and horses in a local SQLite database that works offline by default.
- **Connect sensors and robots:** Pull data from milking robots (Lely, DeLaval), wearables (Allflex collars, smaXtec boluses, CowManager ear tag sensors), scales, or custom CSV and XML exports.
- **Enforce real barn rules:** An animal wears a collar OR a bolus OR an ear tag sensor, never several at once. Orbit enforces at most one active wearable sensor binding per animal across the UI, the database schema, and cloud sync.
- **Discover local cameras:** Probe your barn LAN for ONVIF cameras without sending credentials over the wire or storing passwords in the database.
- **Build custom tools with Orion:** Ask Orion to scaffold a connector for a local file export or write a script in your farm workspace. Every workspace edit is backed by a local snapshot you can revert.

## Quick start for developers

You need [Bun](https://bun.sh) (1.3+) and Node.js 22.19+ installed. You don't need Rust or Tauri to work on the UI, agent, or packages in browser development mode.

1. Install dependencies from the repository root:

```bash
bun install
```

_(If you are running multiple coding agents in this repository at the same time, run [`scripts/locked-install.sh`](scripts/locked-install.sh) instead so installs don't collide.)_

2. Start the Orion sidecar in development mode (listens on `ws://127.0.0.1:7717/ws` with token `dev`, seeds a demo farm with 16 dairy cattle, 8 beef cattle, and 4 horses, and enables the mock model):

```bash
bun run --filter '@orion/agent' dev
```

3. In a second terminal, start the Orbit web UI:

```bash
bun run --filter '@orbit/app' dev
```

Open the local URL printed by Vite in your browser. The web UI connects straight to your running Orion process.

### Running checks locally

```bash
bun run lint        # Biome check across the monorepo
bun run typecheck   # TypeScript (--noEmit) across all workspaces
bun run test        # Unit and integration tests (bun test + vitest)
```

Local development machines run only light checks. Rust compilation, Tauri desktop installers, Docker images, and compiled sidecar binaries run in GitHub Actions CI. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Repository map

All workspace packages use `"type": "module"` and export TypeScript source directly (`./src/index.ts`), so you don't need a build step between packages during development.

| Workspace           | Path                                         | Description                                                                                                                                    |
| ------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orbit/app`        | [`apps/orbit`](apps/orbit)                   | Tauri 2 desktop shell, React UI, design system ([DESIGN.md](apps/orbit/DESIGN.md)), and Orion WebSocket hooks                                  |
| `@orbit/protocol`   | [`packages/protocol`](packages/protocol)     | WebSocket JSON frame types, TypeBox validators, codec, and browser-safe `OrionClient`                                                          |
| `@orbit/schema`     | [`packages/schema`](packages/schema)         | Drizzle ORM tables for SQLite and Postgres, Hybrid Logical Clock (HLC), wearable rule checks, embedded migrations, and deterministic demo seed |
| `@orion/agent`      | [`packages/orion`](packages/orion)           | Orion sidecar server, Pi SDK session hub, farm tools, undo snapshots, keychain integration, and single-writer SQLite repository                |
| `@orbit/connectors` | [`packages/connectors`](packages/connectors) | Connector SDK, CSV/XML parser helpers, starter template, and adapters for Lely, DeLaval, smaXtec, CowManager, Allflex, and generic CSV         |
| `@orbit/sync`       | [`packages/sync`](packages/sync)             | Offline-first sync engine: pushes local outbox changes and pulls ElectricSQL shapes with last-writer-wins HLC resolution                       |
| `@core/api`         | [`core/api`](core/api)                       | Hono cloud server providing the `/v1/changes` write endpoint, `/v1/shape` Electric proxy, and `/v1/llm/*` metered LLM gateway                  |
| `@orbit/e2e`        | `packages/e2e`                               | Playwright end-to-end test suite against the web build and a live Orion sidecar                                                                |

## Documentation

- [Architecture overview](docs/ARCHITECTURE.md)
- [UI design system](apps/orbit/DESIGN.md)
- [Core cloud setup](core/README.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing guide](CONTRIBUTING.md) and [Contributor License Agreement](CLA.md)
- [Security policy](SECURITY.md)
- [Open-source licensing](LICENSING.md) and [Commercial licensing](COMMERCIAL.md)

## License

Orbit is dual-licensed:

1. **Open source:** Licensed under the [GNU Affero General Public License v3.0 only (AGPL-3.0-only)](LICENSE).
2. **Commercial:** A paid commercial license is available from AgroIntel for companies that embed Orbit in closed-source products, ship proprietary modifications, or cannot comply with AGPL-3.0-only terms.

See [LICENSING.md](LICENSING.md) and [COMMERCIAL.md](COMMERCIAL.md) for details, or write to [kristian@agrointel.no](mailto:kristian@agrointel.no).
