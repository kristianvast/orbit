---

name: editing-orbit
description: Change Orbit itself (an existing screen, the menu, the words on screen, or Orion's own instructions, tools and skills) by building the farm's own copy from source. Use when a custom page is not enough because the farmer wants to change what Orbit already shows or how you work.
---

# Editing Orbit

Read and follow `ui-design` before changing anything with a screen.

Orbit's installed app is a fixed build. To change it you edit a copy of its source and build it.
Two tools do all the heavy work, so the whole job is three steps:

1. `orbit_source` makes the source ready (downloads the installed version the first time).
2. You edit the files.
3. `local_ui_build` records the edits, checks them, builds, and switches the result on.

Orbit falls back to the original by itself if a build ever fails to start, and the farmer can
switch back in Settings > Your Orbit.

Prefer a custom page (custom-pages skill) when the farmer only needs a new screen.

## Before the first time

Tell the farmer that Orbit will switch to a copy you build on this computer, that the first build
takes a few minutes and needs the internet once, and that they can switch back in Settings > Your
Orbit. Wait for a yes. After that first time you do not need to ask again for each change.

## Every change

1. Run `orbit_source`. It returns the folder and where things are. Do not look for the source
   anywhere else, and do not clone or install by hand.
2. Find the place: `grep -rn "<text the farmer sees>" "<source>/apps/orbit/src"`. The words on
   screen live in `apps/orbit/src/i18n/locales/<language>/`; change every language that has the
   text. Read a file before you change it, and follow `<source>/AGENTS.md`.
3. Edit. What you may change:
   - `apps/orbit/src`: the app's screens (React + TypeScript).
   - `packages/orion/src` and `packages/orion/resources`: Orion itself. Your instructions are in
     `packages/orion/src/agent/hub.ts`, your tools in `packages/orion/src/agent/`, your skills in
     `packages/orion/resources/skills/`.
   - `packages/protocol` only together with both sides that use it (the app and Orion), in the
     same build.
   - Never `packages/schema` or `packages/sync`: a changed database would stop this farm syncing
     with its other devices.
4. Run `local_ui_build` with a `summary` of the change in the farmer's words. If it fails, read the
   output, fix the code, and run it again. Never tell the farmer it worked until the tool says
   "Built and checked".
5. Tell the farmer what changed and how to see it, exactly as the result says: Orbit reloaded by
   itself, or they press "Open new version" at the top of Orbit (closing and reopening Orbit works
   too). When you changed Orion, the result says Orion restarts by itself after your reply: finish
   the reply and start nothing else.

## After an Orbit update

The installed app changes version, so move the farm's changes onto the new one:
`git -C "<source>" fetch --tags && git -C "<source>" rebase v<new version>` (the version is under
"This computer" in your instructions). Resolve conflicts keeping the farmer's intent, then run
`local_ui_build`. Until it passes, Orbit runs the original.

## Undo

- One change: `git -C "<source>" revert <commit>`, then `local_ui_build`.
- Everything: `local_ui_disable` (the source stays, so a build turns it back on).
