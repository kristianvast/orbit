---

name: custom-pages
description: Add a new screen to the Orbit app (a dashboard, checklist, report, calculator or form) as a custom page in the farm workspace. Use when the farmer wants to see or do something the app has no screen for.
---

# Custom pages

A custom page is a folder `pages/<id>/` in the farm workspace (your working directory). Orbit lists
every folder with an `index.html` in its menu under "Your pages" and shows it inside the app.

1. Agree on what the page shows or does in one sentence.
2. Pick an id: lowercase letters, digits, `-` or `_` (for example `milk-board`).
3. Write `pages/<id>/page.json`: `{ "title": "Milk board", "description": "Yield per cow this week" }`.
4. Write `pages/<id>/index.html`. Keep it one self-contained file (inline CSS and JS); extra files
   in the folder are served too, by relative path. No CDNs or external requests: the farm PC may be
   offline.
5. For farm data, load the Orbit helper and call it:

   ```html
   <script src="../_orbit.js"></script>
   <script>
     const summary = await orbit.query("farm.summary");          // any db.query name
     const cows = await orbit.query("animals.list", { species: "cattle", limit: 200 });
     await orbit.mutate("animals.upsert", { animal: { id, species: "cattle", groupName: "Dry" } });
     orbit.on((event) => { if (event.type === "db.changed") refresh(); });
   </script>
   ```

   Wrap top-level `await` in an `async` function or use `<script type="module">`. Use the same
   named queries and mutations as the farm tools; never open `orbit.sqlite`.
6. Match Orbit's look: warm off-white background, dark ink text, terracotta accents, system fonts,
   generous spacing, large touch targets. Support a dark scheme with `prefers-color-scheme`.
7. Tell the farmer where to find it ("Your pages" in the menu) and that they can undo it.

Rules
- The one-wearable rule applies in pages too: never let a page attach a second wearable.
- Pages run sandboxed: no pop-ups, no access to the app window. Do not try to work around it.
