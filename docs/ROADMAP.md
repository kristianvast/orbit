# Orbit Roadmap

Orbit is in early development. The foundations are in place: the local-first SQLite and Postgres schema ([`packages/schema`](../packages/schema)), the WebSocket protocol ([`packages/protocol`](../packages/protocol)), the Orion Pi sidecar with its approval gate and undo snapshots ([`packages/orion`](../packages/orion)), file-export connector adapters ([`packages/connectors`](../packages/connectors)), the ElectricSQL + outbox sync engine ([`packages/sync`](../packages/sync)), the Core cloud API ([`core/api`](../core/api)), and the Tauri 2 + React desktop shell ([`apps/orbit`](../apps/orbit)).

Here is what we are building next.

## 1. "Share with Pecorva" upstream pull requests

When Orion builds a new connector or farm workflow inside `<data-dir>/workspace`, it commits the change to an invisible local Git repository so the farmer never has to touch Git commands. Next, we are adding an opt-in **"Share with Pecorva"** button:

- A farmer can choose to share a working connector or feature back with the community in two clicks.
- Orion packages the workspace snapshot, strips all farm-specific identifiers, animal records, and credential references, and submits it through a **GitHub App** as a clean upstream pull request to this repository.

## 2. Plugin and connector hot reload

Today, Orion scaffolds custom connectors in `<data-dir>/workspace/connectors/<name>` and runs them on demand via `connector_run`. Next, we are adding:

- Live hot reload when Orion edits a connector or workspace skill so the running sidecar picks up changes immediately without restarting a session.
- Background scheduled sync loops inside Orion for enabled local connectors, with automatic deduplication on `(animal, device, kind, timestamp)`.

## 3. Real vendor APIs and verified export mappings

[`packages/connectors`](../packages/connectors) currently ships a working generic CSV/XML engine, a connector template, and initial file-export adapters for Lely T4C, DeLaval DelPro, smaXtec, CowManager, and Allflex. Next steps:

- Verify and lock in default column mappings against real farm exports from Lely, DeLaval, GEA, BouMatic, smaXtec, CowManager, and Allflex.
- Implement authenticated cloud and local LAN API modes (`mode: "api"`), replacing the current `NotImplementedError` placeholders with live vendor integrations.

## 4. Stripe billing for Core subscriptions

[`core/api`](../core/api) already records per-request token consumption in `llm_usage` and enforces monthly per-farm budgets via `farm_budgets`. Next, we are wiring **Stripe billing**:

- Monthly and yearly subscription plans per barn/farm.
- Automatic provisioning of `farm_budgets` and API tokens from Stripe webhook events.
- Usage reporting so farmers can monitor their subscription and LLM allowance from the Orbit Settings screen.

## 5. Pecorva vision models on a Jetson edge box

Orbit already discovers ONVIF cameras on the barn LAN (`camera_discover`) and stores camera streams in the local database. Next, we are connecting barn cameras to **Pecorva computer-vision models**:

- Local inference on an NVIDIA Jetson edge box sitting on the farm LAN (or via the cloud API for farms without an edge box).
- Continuous posture, gait, calving, and health observations for cattle and horses written straight into the `observations` table and surfaced in Orion and the Home dashboard.
