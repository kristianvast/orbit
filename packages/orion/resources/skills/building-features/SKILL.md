---

name: building-features
description: Build what this farmer needs in the farm workspace, including pages, tools, reports, automations and software for hardware. Use when the farmer asks Orbit to do something new.
---

# Building features

Build for this farmer's actual routine. Read and follow `ui-design` before anything with a screen.
Orbit starts minimal. When the farmer wants a screen or capability, follow this decision order:

1. **Enable a built-in module** with `orbit_modules` (`herd`, `devices`, or `cameras`) if the request is covered by Cattle / Horses (`herd`), Connections (existing connectors only), or Cameras. There is no ready sensor connection or sensor setup screen; follow `connectors` to build and test a new connection with the farmer.
2. **Build a custom page** (`pages/<id>/index.html`, see the `custom-pages` skill) for any new farm screen, dashboard, calculator, checklist, or report. For a herd list, a calendar or a camera wall, first `skill_search` the catalog: the `farm-views` skill has tested pages (each with a Home card) to copy with `page_scaffold` and tune to this farmer.
3. **Edit the local Orbit UI build** (`local_ui_build`, see the `editing-orbit` skill) only when the farmer wants to change how an existing Orbit screen or menu works.

Also build other software the farmer needs: scripts, small tools, reports and automations.
For hardware they are working on, build companion software such as serial or network readers,
firmware helpers and data loggers. Agree on the real device and a safe test before contacting it.

For workspace builds:

1. Restate what the farmer wants in one sentence and agree on it before writing code.
2. Work only inside the farm workspace (your working directory). Put scripts in `scripts/`,
   reports in `reports/`, connectors in `connectors/`, and small tools or hardware companion
   projects in `builds/<name>/`. Keep source, setup notes and tests together.
3. Read farm data through the farm tools, not by opening `orbit.sqlite`.
4. Keep it small: one file if possible, plain TypeScript run with Bun, no new dependencies unless
   the farmer agrees (ask in the chat before installing anything).
5. Run it once, show the result, and tell the farmer they can undo the change.
6. Record useful facts about the farm (routines, barn layout) with `memory_remember`.
7. Once it works for the farmer, offer to publish it to the Orbit marketplace with `share_build`.
   Get their yes before sending; a signed-in Orbit account is needed and the Orbit team reviews
   it before other farms can install it. Pages and connectors use their own sharing kinds.
   For other software, prepare a self-contained `skills/<name>/` folder with `SKILL.md`, setup
   and run instructions, and the source it needs; test that copy before sharing as kind `skill`.
   Use a name with lowercase letters, digits and dashes (at most 48 characters).
   Remove farm names, animal data, addresses and secrets. Sharing includes only text files in
   that folder, up to 60 files and 512 KB; hidden, generated and binary files are skipped.
   Do not promise to upload arbitrary workspace folders, binaries or Orbit's source checkout.

Rules
- Never delete the farmer's files without asking. Never change network or firewall settings.
- If a request touches animal health, build the tool but leave the decision to the farmer and vet.
