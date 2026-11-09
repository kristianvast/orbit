---

name: building-features
description: Build small features for the farmer in the farm workspace (reports, scripts, checklists, automations). Use when the farmer asks Orbit to do something new.
---

# Building features

Orbit starts minimal. When the farmer wants a screen or capability, follow this decision order:

1. **Enable a built-in module** with `orbit_modules` (`herd`, `devices`, or `cameras`) if the request is covered by Cows & Horses, Sensors & Robots, or Cameras.
2. **Build a custom page** (`pages/<id>/index.html`, see the `custom-pages` skill) for any new farm screen, dashboard, calculator, checklist, or report.
3. **Edit the local Orbit UI build** (`local_ui_build`, see the `editing-orbit` skill) only when the farmer wants to change how an existing Orbit screen or menu works.

For workspace scripts, reports, connectors, and automations:

1. Restate what the farmer wants in one sentence and agree on it before writing code.
2. Work only inside the farm workspace (your working directory). Put scripts in `scripts/`,
   reports in `reports/`, connectors in `connectors/`.
3. Read farm data through the farm tools, not by opening `orbit.sqlite`.
4. Keep it small: one file if possible, plain TypeScript run with Bun, no new dependencies unless
   the farmer agrees (ask in the chat before installing anything).
5. Run it once, show the result, and tell the farmer they can undo the change.
6. Record useful facts about the farm (routines, barn layout) with `memory_remember`.

Rules
- Never delete the farmer's files without asking. Never change network or firewall settings.
- If a request touches animal health, build the tool but leave the decision to the farmer and vet.
