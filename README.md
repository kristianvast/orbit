# Orbit

Orbit is an open-source desktop app for cattle (dairy and beef) and horse farms. You install it on your own computer on the farm, talk to Orion, its built-in AI assistant, and Orbit grows the screens and connections your farm needs. Records live on your PC first, work offline, and every change Orion makes can be undone with one click.

**Status:** Early release (v0.1.0). Interfaces, database tables, and cloud endpoints may still change.

## Download

Installers for Orbit v0.1.0:

- **Windows (x64):** [Orbit-Windows.exe](https://github.com/kristianvast/orbit/releases/latest/download/Orbit-Windows.exe)
- **macOS (Apple Silicon):** [Orbit-macOS-Apple-Silicon.dmg](https://github.com/kristianvast/orbit/releases/latest/download/Orbit-macOS-Apple-Silicon.dmg)
- **macOS (Intel):** [Orbit-macOS-Intel.dmg](https://github.com/kristianvast/orbit/releases/latest/download/Orbit-macOS-Intel.dmg)
- **Linux (x64):** [Orbit-Linux-x64.AppImage](https://github.com/kristianvast/orbit/releases/latest/download/Orbit-Linux-x64.AppImage)
- **Linux (ARM64):** [Orbit-Linux-arm64.AppImage](https://github.com/kristianvast/orbit/releases/latest/download/Orbit-Linux-arm64.AppImage)

Additional formats (`.msi` for Windows and `.deb` for Debian/Ubuntu) are attached to the [latest GitHub release](https://github.com/kristianvast/orbit/releases/latest). Installed copies download newer releases in the background and offer a one-click restart to update.

## What happens when you open it

A fresh install starts almost empty. The sidebar shows only **Home**, **Ask Orion**, and **Settings**, with a **Send feedback** link at the bottom.

1. **Switch Orion on:** When you first open Orbit and no AI model is set up yet, Home shows a setup card. You can create a free Orbit account (which includes 30 days of Orion at no cost, no card needed), sign in to an existing account, or bring your own AI provider key or subscription in Settings.
2. **Tell Orion about your farm:** Type or speak to Orion from Home or **Ask Orion**. Tell it whether you keep dairy cattle, beef cattle, or horses, and what you want to see first.
3. **Add only the screens you use:** Built-in screens for **Cows & Horses** (`herd`), **Sensors & Robots** (`devices`), and **Cameras** (`cameras`) start turned off. They appear only when Orion switches them on, when data for that area first arrives, or when you toggle them in Settings. Disabling a module only hides the screen; your data stays intact.

## What Orion can do for a farm

- **Keep herd records and events:** Add or update cattle and horses, search by name, ear tag, or national ID, and record events such as inseminations, pregnancy checks, calvings or foalings, abortions, dry-offs, and treatments.
- **Enforce real barn rules:** An animal wears a collar OR a bolus OR an ear tag sensor, never several at once. Orbit enforces at most one active wearable sensor per animal across the UI, Orion's tools, the local SQLite database, and cloud sync.
- **Install skills on demand:** Instead of shipping every vendor integration built in, Orion searches and installs verified add-ons from the [`skills/`](skills) catalog only when your farm needs them. Today the catalog includes `delaval-delpro` (imports animals, milkings, and daily weights from a DeLaval DelPro SQL Server on the farm network) and `farm-views` (ready-made, tested screens and Home cards for a herd register, a reproduction and calving calendar, and a camera wall).
- **Import CSV files and scaffold custom connectors:** Import spreadsheets with the built-in generic CSV connector, or ask Orion to scaffold and configure a custom TypeScript connector in your farm workspace for equipment or file exports your farm uses.
- **Build custom pages and Home cards:** Ask Orion for a screen tailored to your routine, such as a morning check list or a dry-cow board. Orion writes a custom page in your workspace (`pages/<id>/index.html`) that can also show a live summary card on Home.
- **Customize your copy of Orbit:** When a custom page is not enough, Orion can edit a local checkout of Orbit's UI, run typechecks and a local build (`local_ui_build`), and switch your app over to it. If a local build ever fails to start, Orbit falls back to the shipped UI automatically, and you can switch back anytime in **Settings > Your Orbit**.
- **Find and stream barn cameras:** Discover ONVIF cameras on the barn network (`camera_discover`) and view snapshots and live streams on a barn map through the bundled `go2rtc` relay.
- **Work in other programs on your PC:** When a herd or robot program on the farm computer has no connector or export, Orion can use its `computer` tool to view the screen and use the mouse and keyboard to operate it for you.
- **Remember your farm:** Orion saves lasting facts about your farm (`memory/farm.md`) and your preferences (`memory/user.md`) so you don't have to repeat your barn layout, groups, or routines in every conversation.
- **Ask before risky steps, and undo anything:** There are no separate approval pop-ups. For routine reads and undoable farm updates, Orion acts and tells you what it did. Before anything risky or hard to undo (such as deleting files, installing software, changing system or network settings, working outside the workspace, or contacting devices on the network), Orion explains what it plans to do in the chat and waits for your yes. Every database change and workspace edit is saved as a local snapshot (using a bundled pure-JavaScript Git implementation, so Git does not need to be installed on the farm PC) and can be reverted from Settings.

## How your data is kept

Your farm data lives in a local SQLite database (`orbit.sqlite`) on your computer. Orbit works offline by default: if the internet goes down in the barn, your records, custom pages, and local cameras keep working.

Camera passwords, connector secrets, AI provider keys, and account sessions are stored in your operating system's keychain (or an encrypted local store), never in SQLite tables, Postgres tables, or chat transcripts.

If you sign in to an Orbit account, Orion syncs your farm tables (`farms`, `animals`, `devices`, `device_bindings`, `connectors`, `observations`, `cameras`, `camera_layouts`) with Core so you can invite farm owners, managers, workers, and viewers with role-based permissions. Orbit's data model maps to and from the [ICAR ADE v1.5.1](https://github.com/adewg/ICAR) livestock data exchange standard, so records are not locked into Orbit's own format.

## Feedback and sharing with other farms

You can send bug reports, ideas, or questions straight to the Orbit team from **Settings > Feedback** (or the **Send feedback** link in the sidebar), or by asking Orion in the chat (`feedback_send`). Orion shows you the exact message first and sends it only after you say yes. Your Orbit version and operating system are included; your animal records and passwords are never attached.

If you and Orion build a custom page, connector, or skill that could help other farms, you can ask Orion to share it (`share_build`). Before sending, Orion scans every file and refuses to upload anything that looks like a password, secret, or API key. Shared builds go to the Orbit team for review (`share_status` shows whether a submission is pending, approved, or rejected) and reach other farms only after approval through the [`skills/`](skills) catalog.

## Plans and using your own AI key

Orbit is free and open-source software. You can run it purely locally with your own API key or subscription from providers such as Anthropic, OpenAI, or Google. If you prefer not to manage API keys, creating a free Orbit account gives your farm a 30-day free trial of Orion in the cloud with no card required. After the trial, optional paid plans in EUR cover cloud AI usage, voice minutes, and multi-device sync: **Orion** (EUR 20/month or EUR 200/year), **2 cameras** (EUR 49/month or EUR 490/year), **4 cameras** (EUR 75/month or EUR 750/year), and **6 cameras** (EUR 95/month or EUR 950/year), alongside optional hardware (**Pecorva box** at EUR 920 and **Tested camera** at EUR 150).

---

## For developers and contributors

### The three names

| Name      | What it is                                                                                                             | Where it lives                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Orbit** | The desktop application (Tauri 2 shell + React + TypeScript + Vite)                                                    | [`apps/orbit`](apps/orbit)         |
| **Orion** | The AI agent and local data server (Pi SDK running as a Bun sidecar, single writer to local SQLite)                    | [`packages/orion`](packages/orion) |
| **Core**  | Optional cloud infrastructure (Hono API, Postgres, ElectricSQL read-path sync, metered LLM/voice gateway, and billing) | [`core/api`](core/api)             |

### Quick start

You need [Bun](https://bun.sh) (1.3+) and Node.js 22.19+ installed. You don't need Rust, Tauri, or Docker to work on the UI, agent, or packages in browser development mode.

1. Install dependencies from the repository root:

```bash
scripts/locked-install.sh
```

2. Start the Orion sidecar in development mode (listens on `ws://127.0.0.1:7717/ws` with token `dev`, seeds a demo farm with 16 dairy cattle, 8 beef cattle, and 4 horses, installs the `farm-views` example pages, and enables the mock model):

```bash
bun run --filter '@orion/agent' dev
```

3. In a second terminal, start the Orbit web UI:

```bash
bun run --filter '@orbit/app' dev
```

Open the local URL printed by Vite in your browser. The web UI connects straight to your running Orion process.

### Running checks

```bash
bun run lint          # Biome check across the monorepo
bun run typecheck     # TypeScript (--noEmit) across all workspaces
bun run test          # Unit and integration tests across workspaces and skills/
bun run skills:index  # Rebuild skills/index.json (pass --check to verify)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for native Tauri desktop builds (`scripts/build-desktop.sh`), code conventions, and how farm-shared builds are reviewed into [`skills/`](skills).

### Repository map

All workspace packages use `"type": "module"` and export TypeScript source directly (`./src/index.ts`), so no build step is needed between packages during development.

| Workspace / Folder  | Path                                         | Description                                                                                                                                    |
| ------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orbit/app`        | [`apps/orbit`](apps/orbit)                   | Tauri 2 desktop shell, React UI, design system ([DESIGN.md](apps/orbit/DESIGN.md)), and Orion WebSocket hooks                                  |
| `@orbit/protocol`   | [`packages/protocol`](packages/protocol)     | WebSocket JSON frame types, TypeBox validators, codec, and browser-safe `OrionClient`                                                          |
| `@orbit/schema`     | [`packages/schema`](packages/schema)         | Drizzle ORM tables for SQLite and Postgres, Hybrid Logical Clock (HLC), wearable rule checks, ICAR ADE 1.5.1 mapper, migrations, and demo seed |
| `@orion/agent`      | [`packages/orion`](packages/orion)           | Orion sidecar server, Pi SDK session hub, farm tools, feedback/sharing, undo snapshots (`isomorphic-git`), keychain store, and SQLite writer   |
| `@orbit/connectors` | [`packages/connectors`](packages/connectors) | Connector SDK (`defineConnector`), CSV/XML/tabular parser helpers, starter template, and the built-in generic CSV adapter                      |
| `@orbit/sync`       | [`packages/sync`](packages/sync)             | Offline-first sync engine: pushes local outbox changes and pulls ElectricSQL shapes with last-writer-wins HLC resolution                       |
| `@core/api`         | [`core/api`](core/api)                       | Hono cloud server for `/v1/changes`, `/v1/shape`, `/v1/llm/*`, `/v1/voice/*`, `/v1/auth/*`, `/v1/billing/*`, `/v1/feedback`, `/v1/submissions` |
| `@orbit/e2e`        | [`packages/e2e`](packages/e2e)               | Playwright end-to-end test suite against the web build and a live Orion sidecar                                                                |
| `skills`            | [`skills`](skills)                           | On-demand skill catalog (`index.json`, `delaval-delpro`, `farm-views`) fetched and verified by Orion                                           |

### Documentation

- [Architecture overview](docs/ARCHITECTURE.md)
- [UI design system](apps/orbit/DESIGN.md)
- [Core cloud setup](core/README.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing guide](CONTRIBUTING.md) and [Contributor License Agreement](CLA.md)
- [Security policy](SECURITY.md)
- [Open-source licensing](LICENSING.md) and [Commercial licensing](COMMERCIAL.md)

### License

Orbit is dual-licensed:

1. **Open source:** Licensed under the [GNU Affero General Public License v3.0 only (AGPL-3.0-only)](LICENSE).
2. **Commercial:** A paid commercial license is available from AgroIntel for companies that embed Orbit in closed-source products, ship proprietary modifications, or cannot comply with AGPL-3.0-only terms.

See [LICENSING.md](LICENSING.md) and [COMMERCIAL.md](COMMERCIAL.md) for details, or write to [kristian@agrointel.no](mailto:kristian@agrointel.no).
