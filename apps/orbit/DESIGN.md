# Orbit Design System (`@orbit/app`)

## 0. Research Log & Design Read

- **Design Read:** Operational desktop farm command shell for non-technical cattle or horse farmers, with a warm, high-contrast "Observatory Ledger" (`U1`) palette (limestone paper, iron ink, terracotta accent; charcoal and lantern amber at night), the **Kepler Monogram (`L2`)** brand mark, and the **Pecorva brand type system**: Tanker all-caps poster display over Switzer UI text. Layout stays quiet: flat panels, hairline rules instead of boxes, one prominent action per screen, and a silent sync indicator that appears only when offline or out of sync for >= 3 minutes. Big 44px hit targets, either-or species language ("Cattle" or "Horses" — never combined "Cows & Horses"), and two themes (`light` for bright barn offices, `dark` for night checks).
- **Redesign log (2026-11-05):** removed every region boxed as a bordered + shadowed card, stat tiles and bordered rows nested inside cards, a subtitle under every heading, pill badges on static labels, sparkle icons on suggestion chips, three equal stat cards, an explanatory "Data Safety" filler card, an icon-in-orange-tile logo, and a broken 390px shell. The owner kept the original warm palette and asked for the Pecorva website fonts (`pecorva-website/shared/tokens.css`).
- **Domain Invariant:** A cow or horse wears **at most ONE active wearable sensor** at a time (a collar **OR** a bolus **OR** an ear tag sensor, never stacked or combined). UI copy and components always present wearables as mutually exclusive choices.
- **Languages:** All UI copy goes through `t()` from `src/i18n` (English source catalogs in `src/i18n/locales/en/<namespace>.ts`, Norwegian Bokmål in `locales/nb/`; a missing translation is a type error). Never hard-code user-visible strings in components; data from Orion or the database (animal names, notes) is shown as-is. Users pick the language in Settings; the default follows the OS language.
- **Anti-Slop Guard:** No purple gradients, no glassmorphism (`backdrop-filter`), no emoji icons, no coloured edge stripes on cards, no 2px accent outlines on rounded cards, no cards inside cards, no marketing fluff ("seamlessly", "effortlessly", "smart").

## 1. Typography (Pecorva type system, self-hosted)

All fonts are self-hosted WOFF2 files in `apps/orbit/public/fonts/`; licences are listed in its `README.md`. `font-synthesis: none` is set globally so the single-weight display face is never faux-bolded.

1. **Display (`--font-display`):** **Tanker** 400 (`tanker-400-normal.woff2`, Fontshare, ITF Free Font License). All-caps poster face for `h1`/`h2` page titles, the Home status line, the wordmark, and large figures. Always `text-transform: uppercase`, weight 400, tracking `0.005em`.
2. **UI / Body (`--font-sans`):** **Switzer** 400/500/600/700 (`switzer-*-normal.woff2`, Fontshare, ITF Free Font License). Body, controls, and card / panel titles (600, sentence case).
3. **Data (`--font-mono`):** **Azeret Mono** (`azeret-mono-latin-wght-normal.woff2`, SIL OFL 1.1). Only identifiers compared character by character: ear tags (`DK-1001`), serials, endpoints. Counts use `tabular-nums`.

### Type Scale (1.25x floor between heading steps)

| Token            | Value              | Role                             |
| ---------------- | ------------------ | -------------------------------- |
| `--text-display` | `2.5rem` (40px)    | Home status line (Tanker)        |
| `--text-h1`      | `2rem` (32px)      | Page title (Tanker)              |
| `--text-h2`      | `1.5625rem` (25px) | Section heading (Tanker)         |
| `--text-h3`      | `1.25rem` (20px)   | Card / panel title (Switzer 600) |
| `--text-lg`      | `1.125rem` (18px)  | Prominent control / lead copy    |
| `--text-base`    | `1rem` (16px)      | Body text & controls             |
| `--text-sm`      | `0.875rem` (14px)  | Secondary metadata & table cells |
| `--text-xs`      | `0.75rem` (12px)   | Badges, timestamps, small labels |

## 2. Color System (Light & Dark Themes)

The original Orbit palette: warm limestone neutrals, iron ink, one terracotta / lantern-amber accent, four semantic status hues. Primary buttons use the accent (`--action-*` tokens alias it).

### Light Theme ("Daylight Barn Office" - default `:root` & `[data-theme="light"]`)

| Role                | Token                                                      | Value                                         | Contrast                 |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------- | ------------------------ |
| Canvas              | `--bg-canvas`                                              | `#f6f3ec`                                     |                          |
| Surface             | `--bg-surface`                                             | `#ffffff`                                     |                          |
| Rail / tonal panel  | `--bg-elevated`                                            | `#efeae0`                                     |                          |
| Hover / pressed     | `--bg-subtle` / `--bg-hover`                               | `#e5dfd2` / `#dbd3c3`                         |                          |
| Ink                 | `--text-primary` / `--text-secondary` / `--text-muted`     | `#181612` / `#433e34` / `#645d4f`             | muted 5.4:1 on canvas    |
| Accent (terracotta) | `--accent-primary` / `-hover`                              | `#b84a14` / `#9c3d0e`                         | 4.9:1 on canvas          |
| Primary action      | `--action-bg` / `--action-fg`                              | `#b84a14` / `#fcfaf5`                         | 5.0:1                    |
| Pasture green       | `--accent-secondary`                                       | `#1f5c3f`                                     |                          |
| Status              | `--status-ok` / `warn` / `danger` / `info`                 | `#19673e` / `#8c4d04` / `#b42318` / `#175cd3` | all > 5:1                |
| Borders             | `--border-subtle` / `--border-strong` / `--border-control` | `#dcd5c7` / `#bab09d` / `#8a806e`             | control 3.9:1 on surface |
| Focus               | `--border-focus`                                           | `#b84a14`                                     |                          |

### Dark Theme ("Night Watch" - `[data-theme="dark"]`)

| Role                    | Token                                                      | Value                                         | Contrast                 |
| ----------------------- | ---------------------------------------------------------- | --------------------------------------------- | ------------------------ |
| Canvas / surface / rail | `--bg-canvas` / `--bg-surface` / `--bg-elevated`           | `#111310` / `#191c18` / `#21251f`             |                          |
| Hover / pressed         | `--bg-subtle` / `--bg-hover`                               | `#2a2f28` / `#353b32`                         |                          |
| Ink                     | `--text-primary` / `--text-secondary` / `--text-muted`     | `#f3f0e6` / `#c9c3b5` / `#9a9383`             | muted > 5:1 on surface   |
| Accent (lantern amber)  | `--accent-primary` / `-hover`                              | `#e88245` / `#f2955e`                         |                          |
| Primary action          | `--action-bg` / `--action-fg`                              | `#e88245` / `#111310`                         | 6.9:1                    |
| Night meadow green      | `--accent-secondary`                                       | `#5ec28f`                                     |                          |
| Status                  | `--status-ok` / `warn` / `danger` / `info`                 | `#57cc8a` / `#f5b14c` / `#f97066` / `#68a8ff` |                          |
| Borders                 | `--border-subtle` / `--border-strong` / `--border-control` | `#2c3129` / `#434a3e` / `#76705f`             | control 3.5:1 on surface |
| Focus                   | `--border-focus`                                           | `#e88245`                                     |                          |

## 3. Spacing, Radius, Elevation & Motion

- **Spacing Scale (4px base):** `--space-1` (4px) through `--space-12` (48px), plus `--space-16` (64px) for page-level breaks.
- **Hit Targets:** `--control-height-sm` (36px), `--control-height-md` (44px default), `--control-height-lg` (52px).
- **Radius (tight, tooled):** `--radius-sm` 4px (badges, inner rows), `--radius-md` 6px (controls), `--radius-lg` 10px (panels), `--radius-xl` 14px (dialogs), `--radius-full`.
- **Elevation:** panels are flat (hairline only, no shadow). Shadow exists only on things that float: dialog, drawer, toast (`--shadow-lg`, tinted to the graphite hue).
- **Motion:** `--duration-fast` (120ms), `--duration-normal` (200ms), `--duration-slow` (360ms), `--ease-out` (`cubic-bezier(0.22, 1, 0.36, 1)`). All animations respect `prefers-reduced-motion`.

## 4. Spacing & Layout Contract

Layout: App Shell - persistent left rail (brand, nav, Orion status line) + top farm bar + scrollable workspace; below 820px the rail collapses to a single horizontally scrolling nav row under the top bar -> fixed-sidenav-shell (skipped: host unreachable); scroll owner: `.orbit-main-scroll`; anti-patterns: double vertical scrollbars, missing `min-block-size: 0` on grid scroll child, horizontal page overflow at 390 and 1024.

Layout: Home Screen - status line + Ask Orion composer on top, then a two-column split (alerts list leading, farm instruments trailing), then a row of page cards (one flat tile per custom page that ships a card, never above the alerts), then one footnote line -> page-grid + split (skipped: host unreachable); scroll owner: `.orbit-main-scroll`; anti-patterns: burying active calving/health alerts below decorative chrome, cards inside cards, stat tiles repeating the instrument list, stacking multiple wearables per animal.

Layout: Cameras Screen (Barn Map) - page header with Add camera primary action and Find cameras secondary action, network discovery privacy card, then the interactive BarnMapCanvas (toolbar with live count, optional BarnSelector when cameras span >1 location, Reset view and Tidy layout buttons, over a bounded pannable/zoomable world viewport holding aspect-locked CameraTile items) -> canvas-shell (skipped: host unreachable); scroll owner: `.orbit-main-scroll` for page, `.orbit-barn-map__viewport` (`touch-action: none`, `overflow: hidden`) for 2D pan/zoom; anti-patterns: infinite reconnect spinners when go2rtc relay or camera stream is offline, reflowing the spatial barn layout across breakpoints instead of panning/zooming.

Layout: Settings Screen (Account & Billing) - vertical stack of flat panel cards (`AccountCard` with `BillingSection`, `MembersCard`, `Modules` toggles for `herd` / `devices` / `cameras`, `Language`, `Model` + `ProvidersCard` split, `Undo`, `Data`, `About`) inside `.orbit-container` -> stacked-settings (skipped: host unreachable); scroll owner: `.orbit-main-scroll`; anti-patterns: 2px accent outlines on plan cards, nested cards with drop shadows, hiding BYO provider option on free plan.

Layout: Ask Orion Screen (Chat & Voice) - two-column bounded shell (`.orbit-threads` sidebar + `.orbit-thread-pane` with header, scrollable transcript/timeline + `PlanErrorCard`, and footer housing `VoicePanel` + `Composer`) -> split-thread-shell (skipped: host unreachable); scroll owner: `.orbit-thread-pane__scroll` (and `.orbit-voice-panel__body` inside active voice mode); anti-patterns: raw error stack traces for `plan_required` / `budget_exceeded`, blocking text fallback when mic permission is denied.

## 5. Screen Brief (Home & App Shell)

- **Primary Action:** **"Ask Orion"**, the submit button of the Home composer (ink style). Typing a question and pressing Enter opens `/chat?prompt=...`; an empty submit opens `/chat`.
- **Information Priorities (1-3):**
  1. **Status line + active alerts** (`farm.summary.recentAlerts`): a one-sentence verdict ("3 things need a look today." / "All quiet in the barn today.") and the alert list, each row naming the animal, the alert kind, the time, and what to check.
  2. **Farm instruments** (`farm.summary.counts`): animals (cattle, horses), cameras live, and connections (shown only when at least one connector exists), with the `OrbitRings` diagram as the panel's visual anchor.
  3. **Suggested questions** for Orion, as plain text buttons under the composer.
- **Left Out on Purpose:** greeting-plus-headline formula in a hero card, the three equal stat cards (they repeated the instrument numbers), the stat tiles under the orbit diagram, the "Needs attention" mini-list (it repeated the alert list), the "Data Safety & Undo" card (now one footnote line), sparkle icons, static "Active" badge, subtitles under every heading, fake weather, random sparklines.
- **Required Content:**
  - Left rail navigation (minimal-first order): `Home`, `Ask Orion` (Chat), enabled built-in modules in `MODULE_IDS` order (`Cattle` or `Horses` for `herd` depending on farm species, `Connections` for `devices`, `Cameras` for `cameras`), `Your pages` (custom workspace pages under `pages/<id>/index.html`), and `Settings`. A fresh install shows only `Home`, `Ask Orion`, and `Settings` until modules or custom pages are added; alert count on Home, primary animal count on `Cattle` / `Horses` when enabled.
  - Top bar: farm name (`farm.summary.farm.name`, fallback), quiet sync notice (hidden when healthy or during routine background sync; shown only on error, local disconnect, or >= 3 min offline), light/dark theme toggle. Orion connection state + local-save note in the rail footer.
  - Connection banner when Orion is reconnecting, offline, or unauthorized.
  - Home (`U1 · Observatory Ledger`): ruled masthead with status badge (`home-alerts`), primary species count (`home-herd-counts`, never zero-padded secondary species), poster Tanker verdict (`home-hero-headline`), and right-aligned tabular telemetry ribbon; recessed Ask Orion + Talk to Orion command bar; two-column split with Priority Triage (showing animal, ear tag, single active wearable chip when present, alert kind, time, and per-alert "Ask Orion") and Barn Observatory (`OrbitRings` astrolabe dial, group composition bar, and instrument gauges `home-animals-gauge`, `home-cameras-live`, and `home-connectors-gauge` when >= 1 connector exists); custom page cards (`home-cards`, `home-card-<id>`); and the undo + saved-on-this-PC note.
- **Reusable Primitives (`src/design/`):**
  - `Button` (`primary` ink, `secondary` hairline, `subtle` text, `danger`; `sm`/`md`/`lg`; loading state with fixed box geometry)
  - `Card` (flat surface panel with a hairline, header, title, optional subtitle, actions, body, footer)
  - `Badge` (4px-radius tonal label: `neutral`, `ok`, `warn`, `danger`, `info`, `accent`; only for values that change)
  - `Input`, `Select` (44px, control-edge border, labelled, hint/error)
  - `Dialog`, `Drawer` (the only shadowed surfaces), `Tabs` (segmented), `Toast`, `EmptyState`, `Skeleton`
  - `OrbitRings` (SVG concentric rings with satellite nodes; hairline rings, accent only on the core and alert nodes)

### Cameras Screen (Barn Map)

- **Primary Action:** **"Add camera"** (`cameras-add-btn`), primary button in the page header.
- **Information Priorities (1-3):**
  1. **Barn Map Canvas** (`camera-barn-map`): pannable/zoomable 2D map of aspect-locked (`896 / 512`) camera tiles (`camera-tile-<id>`) showing live MSE video (`connectMSE`), a still JPEG poster (`frame.jpeg`), or the offline `CameraSnapshotPlaceholder` (`camera-snapshot-<id>`).
  2. **Barn Selector** (`camera-barn-selector`): shown when cameras span more than one location, filtering the map to one barn with optional per-farm favourite pinning.
  3. **Network Discovery & Keychain Privacy Card**: explains local network camera scanning with Orion and OS keychain password storage.
- **Left Out on Purpose:** detection bounding-box overlays, heatmaps, polygon zone editors, calving-zone toggles, weight-capture flows, glassmorphism/blur overlays on camera tiles.
- **Required Content:**
  - Page header (`cameras-page`) with title, online count badge, `cameras-find-network-btn`, and `cameras-add-btn`.
  - Privacy card with `cameras-ask-orion-discovery-btn`.
  - Empty state (`cameras-empty-state`), loading state (`cameras-loading-state`), and error state (`cameras-error-state`).
  - `BarnMapCanvas` (`camera-barn-map`) with `BarnSelector` (`camera-barn-selector`), relay status notice when unavailable (`cameras-relay-notice`), `cameras-tidy-btn`, `cameras-reset-view-btn`, and `CameraTile` (`camera-tile-<id>`) with `camera-edit-<id>`, `camera-ask-orion-<id>`, Move to location menu, corner `[data-resize-handle]`, and tap-to-fullscreen.
  - `CameraFormDialog` (`camera-form-dialog`, `camera-form-name`, `camera-form-location`, `camera-form-rtsp`, `camera-form-onvif`, `camera-form-status`, `camera-form-username`, `camera-form-password`, `camera-form-cancel`, `camera-form-submit`).

### Settings Screen (Account & Billing) & Ask Orion (Chat & Voice)

- **Primary Action:** **"Choose a plan"** (`billing-checkout-button`) inside `BillingSection` on the Account card; **"Send"** (`chat-send-button`) in the Ask Orion composer.
- **Information Priorities (1-3):**
  1. **Current plan, status, renewal date, and usage meters** (`billing-plan-name`, `billing-status-badge`, `billing-period-end`, `billing-meter-tokens`, `billing-meter-voice`), plus open-source BYO key explanation on free plan (`billing-free-copy`).
  2. **Plan & interval picker** (`billing-plan-pen`, `billing-plan-barn`, `billing-interval-month`, `billing-interval-year`) with checkout and billing portal actions (`billing-checkout-button`, `billing-portal-button`).
  3. **Chat plan-limit card & Talk to Orion voice panel** (`chat-plan-error-card` with `chat-plan-error-use-key` and `chat-plan-error-see-plans`; `voice-panel` with `voice-state-badge`, `voice-transcript`, `voice-tools` reusing `ToolCard`, `voice-stop-button`, and `voice-mic-error` fallback).
- **Left Out on Purpose:** multi-tier comparison tables with checkmarks, decorative discount badges, animated waveform gimmicks, 2px coloured selection borders on plan cards.
- **Required Content:**
  - `AccountCard`: plan name (`free`/`pen`/`barn`), status badge, renewal/period end, token and voice minute usage meters, Free BYO explanation, signed-out sign-in prompt, Pen/Barn x Monthly/Yearly picker, `Choose a plan` (`billing.checkout`), `Manage billing` (`billing.portal`).
  - `ChatPage`: `PlanErrorCard` for `plan_required` and `budget_exceeded` with `"Use your own key"` (navigates to Providers) and `"See plans"` (navigates to Account card); `Composer` `"Talk to Orion"` button (`chat-voice-button`) opening `VoicePanel` with AudioWorklet 16 kHz PCM16 capture, 24 kHz AudioContext playback queue, live transcript, `ToolCard` tool executions, state badge, stop button, and mic-denied notice.

## 6. Components (source)

All primitives are project-kit components in `src/design/primitives.tsx` following shadcn/ui anatomy (button, card, badge, input, select, dialog, sheet, tabs, toast), restyled with the tokens above.

## 7. Surfaces

Flat panels on a canvas: `--bg-surface` with a 1px `--border-subtle` hairline and `--radius-lg`. Tonal grouping uses `--bg-elevated`. Inside a panel, rows are separated by hairline dividers, never by bordered boxes. No glass, no gradients, no grain, no glow.

## 8. Accepted Debt

- Feature screens (herd, devices, cameras, settings, chat) still carry many inline styles; they inherit the new tokens and primitives but were not restructured in the 2026-11-05 redesign.
