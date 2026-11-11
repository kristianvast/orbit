# Orbit Roadmap

Orbit v0.1.0 ships the local-first desktop app and cloud foundation:

- **Minimal-first desktop app (`@orbit/app`):** Starts with Home, Ask Orion, and Settings; built-in Herd, Devices, and Cameras modules turn on when needed. Built and signed for Windows, macOS, and Linux with background auto-updates.
- **Orion sidecar (`@orion/agent`):** Local SQLite single writer (`@orbit/schema` with ICAR ADE v1.5.1 mapping), undo snapshots for database rows and workspace files (via bundled `isomorphic-git`), custom pages and Home cards, local UI builds (`local_ui_build`), persistent farm/user memory, and OS-native `computer` use.
- **Skills and connectors (`skills/`, `@orbit/connectors`):** On-demand skill catalog (`delaval-delpro` and `farm-views`), generic CSV import, and workspace connector scaffolding.
- **Core cloud, sync, billing, and feedback (`@orbit/sync`, `@core/api`):** Accounts, farm roles and invites, ElectricSQL + HLC outbox sync, metered LLM and Gemini Live voice gateway, Stripe subscriptions and hardware checkout, in-app feedback (`POST /v1/feedback`), and reviewed farm-shared builds (`POST /v1/submissions`).

Here is what we are building next.

## 1. Connector hot reload and background scheduling

Today, Orion scaffolds connectors in `<data-dir>/workspace/connectors/<name>` and runs them on demand via `connector_run`. Next:

- Live hot reload when Orion edits a connector or workspace skill so the running sidecar picks up changes without restarting a session.
- Background scheduled sync loops inside Orion for enabled local connectors, with automatic deduplication on `(animal, device, kind, timestamp)`.

## 2. More vendor skills in the catalog

[`packages/connectors`](../packages/connectors) provides the connector SDK, CSV/XML/tabular parsers, and generic CSV adapter, while vendor-specific integrations live in the on-demand [`skills/`](../skills) catalog (starting with `delaval-delpro`). Next:

- Publish catalog skills verified against real farm exports and local LAN APIs for additional milking robots, collars, boluses, ear tag sensors, and scales.
- Automated conversion from approved farm-shared submissions (`/v1/admin/submissions`) into branch pull requests for `skills/`.

## 3. Pecorva vision models on a Jetson edge box

Orbit discovers ONVIF cameras on the barn LAN (`camera_discover`) and streams them through the bundled `go2rtc` relay onto the barn map. Next, we are connecting barn cameras to Pecorva computer-vision models:

- Local inference on an NVIDIA Jetson edge box on the farm LAN (or via Core for farms without an edge box).
- Continuous posture, gait, calving, and health observations for cattle and horses written into `observations` and surfaced in Orion and on Home.
