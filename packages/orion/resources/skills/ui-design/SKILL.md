---

name: ui-design
description: Design clear, useful screens for this farmer using Orbit's page kit and design tokens. Read before building or changing any page, Home card or Orbit screen.
---

# UI design

## Decide the job

Before writing a screen, name its one job and the action the farmer needs most.
Choose the few facts needed for that job, in the order the farmer uses them.
Keep that decision in your work notes, not as explanatory copy on the screen.

## Make the job visible

- Use position, spacing, size and familiar symbols to show what matters. Give the main action
  one clear place; keep secondary actions quieter.
- Use short titles, field labels, units and action names. No description paragraphs, welcome
  copy or instructions on screen. Explain setup in the chat.
- Use Orbit's existing icons, with accessible names for icon buttons. Never use emoji as icons.
  Keep a short visible label when a symbol alone would be unclear.
- Choose a list for items, a table for comparison, and a detail view for one thing. Do not wrap
  every fact in a card or add summary tiles that serve no decision.

## Show what works

- Use real farm data. No invented readings, sample animals, placeholder values or demo charts
  in the delivered screen. Omit sections whose data does not exist.
- Every visible action must do its named job. Hide unavailable features and controls for
  equipment that is not connected. Never draw a button now and promise to wire it later.
- Orbit ships no ready sensor connection. Build unvalidated connections with the farmer,
  test against the real device, and only then show their working data and controls.
  Validated catalog connectors found with `skill_search` can follow their own setup flow.
- Connections lists existing connectors; it is not a catalog of sensors or robots.

## Use Orbit's parts

For a custom page, follow `custom-pages` and load `../_orbit.css`. That stylesheet includes
Orbit's tokens and `resources/pages/kit.css`; use `kit-page`, `kit-list`, `kit-row`,
`kit-facts`, `orbit-btn`, `orbit-input` and the other supplied parts before adding CSS.
For Orbit's own screens, read its `DESIGN.md` and reuse the nearest existing component.

Use only Orbit's colour, spacing, type and motion tokens. Tanker is the display face,
Switzer the UI face, and Azeret Mono the mono face. Keep both light and dark themes.
Do not import another font, palette, component theme or remote asset to make a page look nicer.

## Fit the farmer's hands and screen

- Make touch targets at least 44 by 44 CSS pixels, including icon buttons. Add hit-area padding
  rather than enlarging the icon. Leave room between neighbouring actions.
- At phone width, stack content in reading order. Wrap toolbars and long names; keep essential
  actions reachable without sideways scrolling. Name which region scrolls; avoid nested scrollbars.
- Use native buttons and inputs, visible keyboard focus, proper labels and readable contrast.
  Never rely on colour alone for a warning or status.
- Design empty, loading, error and offline states. An empty view has a short status and, only
  when it works, the next action; it has no empty panels. A loading indicator is temporary,
  never pretend data. Put a concise error by the failed item and offer retry only if wired.
- A control keeps its size while saving or loading. Show success in the changed item.
  Keep motion brief, respect reduced motion, and never delay an action for animation.

## Look before finishing

Open the result and inspect it at phone and desktop widths, in light and dark.
Try the main action, keyboard navigation and the empty, loading and error states.
Check long names, clipping, overlap, focus and touch targets. Remove anything without a job.
Fix what you see before saying it works. If you cannot render or inspect it, say what remains
unverified; a successful build alone does not prove a screen is usable.
