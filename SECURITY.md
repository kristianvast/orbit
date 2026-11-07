# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in Orbit, Orion, or Core, please report it privately by emailing **[kristian@agrointel.no](mailto:kristian@agrointel.no)**.

Please do not open a public GitHub issue for undisclosed security vulnerabilities. Include the affected package or file path, steps to reproduce the issue, and its potential impact on a farm PC or cloud deployment. We will acknowledge receipt and work with you on a fix before public disclosure.

## Security architecture on the farm PC

Orbit runs on a computer the farmer owns, often the same PC that manages a milking robot or barn network. We design the boundary between the UI, the Orion sidecar, and the local machine around these safeguards:

### 1. Localhost-only authenticated protocol

When the Tauri shell starts the Orion sidecar (`@orion/agent`), it generates a random 32-byte token and passes it to Orion. Orion binds exclusively to `127.0.0.1` on an OS-assigned port. Every WebSocket connection must begin with a `hello` frame carrying that token; any invalid token receives an `unauthorized` error and immediate socket closure with code `4401`. Incoming frames are validated with TypeBox `Value.Check` (no `eval`, compatible with a strict Content Security Policy), and database access over the wire is restricted to named queries and mutations (no raw SQL).

### 2. Orion runs as a trusted agent

Orion is a Pi coding agent with no permission gate: farm tools, file tools and shell commands run as soon as the model calls them, with the rights of the user running Orbit. Its instructions ([`packages/orion/resources/AGENTS.md`](packages/orion/resources/AGENTS.md) and the system prompt in [`packages/orion/src/agent/hub.ts`](packages/orion/src/agent/hub.ts)) tell it to explain what it will do and to ask the farmer in the chat before anything risky or hard to undo: deleting files, installing software, changing system or network settings, working outside the farm workspace, or contacting devices on the network. This is model behavior, not an enforced boundary, so treat Orion like any other program you let act on your computer, and rely on the snapshots below to undo mistakes.

### Local UI builds and custom pages

Orion serves custom pages (`/pages/<token>/...`) and the farm's own UI build (`/app/<token>/...`) only on `127.0.0.1` and only under the session token; a wrong token gets `401`, and paths that resolve outside the page folder or `apps/orbit/dist` (including through symlinks) get `404`. A local UI build is switched on only after its typecheck and build pass, and the shipped UI falls back to itself when a build never reports that it started, or when opened with `?safe`. Note that the token appears in these URLs, so anything that can read the window's address (the page itself) can talk to Orion; pages and local builds are written by Orion for this farm and are trusted like Orion.

### 3. Undoable snapshots for database and workspace changes

Every mutation to the local SQLite database records the before and after row states in the `snapshots` table, and every file change Orion makes in `<data-dir>/workspace` is committed to an invisible local Git repository. Farmers can inspect recent changes via `snapshots.list` and revert either database edits or workspace file changes through `snapshots.undo`.

### 4. Secrets stay out of the database

Camera credentials (`username` and `password`), connector API secrets, and LLM provider keys are never written to SQLite, Postgres, or the sync outbox:

- Camera and connector secrets are stored in the OS keychain via `Bun.secrets` (falling back to an encrypted local store with mode `0600` when no keychain is available). Database rows hold only a pointer (`cameras.credential_ref` or `connectors.config.credentialRef`).
- Model API keys live in `<data-dir>/pi/auth.json` (`0600`). `settings.get` returns only `{ configured: boolean, hint: "...abcd" }`, never the raw key.
- In `@core/api`, farm API tokens are stored in Postgres solely as SHA-256 hashes (`api_tokens.token_hash`).
