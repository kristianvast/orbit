# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in Orbit, Orion, or Core, please report it privately by emailing **[kristian@agrointel.no](mailto:kristian@agrointel.no)**.

Please do not open a public GitHub issue for undisclosed security vulnerabilities. Include the affected package or file path, steps to reproduce the issue, and its potential impact on a farm PC or cloud deployment. We will acknowledge receipt and work with you on a fix before public disclosure.

## Security architecture on the farm PC

Orbit runs on a computer the farmer owns, often the same PC that manages a milking robot or barn network. We design the boundary between the UI, the Orion sidecar, and the local machine around four safeguards:

### 1. Localhost-only authenticated protocol

When the Tauri shell starts the Orion sidecar (`@orion/agent`), it generates a random 32-byte token and passes it to Orion. Orion binds exclusively to `127.0.0.1` on an OS-assigned port. Every WebSocket connection must begin with a `hello` frame carrying that token; any invalid token receives an `unauthorized` error and immediate socket closure with code `4401`. Incoming frames are validated with TypeBox `Value.Check` (no `eval`, compatible with a strict Content Security Policy), and database access over the wire is restricted to named queries and mutations (no raw SQL).

### 2. The Orion approval gate

AI agents can make mistakes, and farm computers sit on sensitive local networks. Orion wraps every tool call in a permission gate ([`packages/orion/src/agent/gate.ts`](packages/orion/src/agent/gate.ts)) before execution:

| Tier             | What it covers                                                                                                                                                                                                                                                                                    | Behavior                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`safe`**       | Read-only herd, device, connector, and observation queries (`herd_query`, `devices_list`, `observations_query`, `connectors_list`), plus file reads inside `<data-dir>/workspace`                                                                                                                 | Runs automatically without prompting.                                                                                                                                                                                            |
| **`ask`**        | Adding or updating animals, binding devices, scaffolding or running connectors, ONVIF camera discovery, adding cameras, and file edits or shell commands inside `<data-dir>/workspace`                                                                                                            | Pauses and sends an `approval.request` card to the UI with a plain-language explanation (plus the exact command for shell calls). Runs only if the farmer approves (or if the farmer enabled `auto` mode / remembered the tool). |
| **`always_ask`** | Any file read, write, or edit outside the workspace; shell commands referencing paths outside the workspace (`..`, `~`, `$HOME`, absolute paths); file deletions (`rm`, `del`, `git reset --hard`); network or firewall changes (`iptables`, `ufw`, `netsh`, `pfctl`); package installs or `sudo` | **Always** prompts the farmer for explicit one-time confirmation, even when `approvalMode` is set to `auto` or the tool was previously marked `always_allow`.                                                                    |

Farmers can also set `approvalMode` to `read_only`, which denies every `ask` and `always_ask` call immediately without prompting. Every gate decision is logged to `<data-dir>/audit.log`, and the UI reminds the user on approval cards that AI can make mistakes.

### 3. Undoable snapshots for database and workspace changes

Every mutation to the local SQLite database records the before and after row states in the `snapshots` table, and every file change Orion makes in `<data-dir>/workspace` is committed to an invisible local Git repository. Farmers can inspect recent changes via `snapshots.list` and revert either database edits or workspace file changes through `snapshots.undo`.

### 4. Secrets stay out of the database

Camera credentials (`username` and `password`), connector API secrets, and LLM provider keys are never written to SQLite, Postgres, or the sync outbox:

- Camera and connector secrets are stored in the OS keychain via `Bun.secrets` (falling back to an encrypted local store with mode `0600` when no keychain is available). Database rows hold only a pointer (`cameras.credential_ref` or `connectors.config.credentialRef`).
- Model API keys live in `<data-dir>/pi/auth.json` (`0600`). `settings.get` returns only `{ configured: boolean, hint: "...abcd" }`, never the raw key.
- In `@core/api`, farm API tokens are stored in Postgres solely as SHA-256 hashes (`api_tokens.token_hash`).
