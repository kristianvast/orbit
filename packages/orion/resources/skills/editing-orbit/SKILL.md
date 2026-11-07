---

name: editing-orbit
description: Change the Orbit app itself (an existing screen, the menu, how something looks or works) by building the farm's own copy from source. Use when a custom page is not enough because the farmer wants to change what Orbit already shows.
---

# Editing Orbit

Orbit's installed app is a fixed build. To change it, you edit a copy of the source and build it
with `local_ui_build`; Orbit opens that build at startup, and falls back to the original app if a
build fails or does not start.

Prefer a custom page (custom-pages skill) when the farmer only needs a new screen.

## First time: get the source

1. Explain that Orbit will switch to a copy you build on this computer, that the first build takes
   a few minutes and needs internet once, and that they can switch back in Settings > Your Orbit.
   Wait for a yes.
2. The checkout lives at the path named in the `local_ui_build` tool description (normally
   `<data-dir>/app`). If it does not exist, clone the exact version that is installed, so the app
   and Orion speak the same protocol:
   `git clone --branch v<version> --depth 50 https://github.com/kristianvast/orbit.git <checkout>`
   The installed version is the `version` field of Orion's `/health` endpoint on this computer. Then `git -C <checkout> switch -c farm` so the farm's changes live on their own branch.

## Every change

1. Edit only `apps/orbit/src` (React + TypeScript). Follow `<checkout>/AGENTS.md`.
2. Never change `packages/schema`, `packages/protocol`, `packages/sync`, or `packages/orion`: the
   installed Orion was built from the release and will not pick those up, and schema changes would
   break sync with other devices.
3. Commit on the `farm` branch with a short message saying what the farmer asked for.
4. Run `local_ui_build`. If it fails, read the output, fix the code, and run it again. Never tell the
   farmer it worked until the tool says "Built and checked".
5. Tell the farmer what changed. A running Orbit reloads by itself.

## After an Orbit update

The installed app changes version, so rebase the farm branch onto the new tag:
`git -C <checkout> fetch --tags && git -C <checkout> rebase v<new-version>`. Resolve conflicts in
`apps/orbit/src` keeping the farmer's intent, then `local_ui_build`. Until it passes, Orbit runs the
original app.

## Undo

- One change: `git revert` the commit, then `local_ui_build`.
- Everything: `local_ui_disable` (the checkout stays, so it can be turned back on with a build).
