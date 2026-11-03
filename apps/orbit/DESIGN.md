# Orbit Design System (`@orbit/app`)

## 0. Research Log & Design Read

- **Design Read:** Operational desktop farm command shell for non-technical cattle & horse farmers, with a warm, high-contrast "Barn Observatory" language: concentric orbit rings, satellite status indicators, big 44px+ hit targets, plain language ("Cows & Horses", "Sensors & Robots", "Cameras", "Ask Orion"), and dual daylight/night themes (`light` for bright barn offices, `dark` for night calving checks).
- **Domain Invariant:** A cow or horse wears **at most ONE active wearable sensor** at a time (a collar **OR** a bolus **OR** an ear tag sensor — never stacked or combined). UI copy and components always present wearables as mutually exclusive choices.
- **Anti-Slop Guard:** No Inter, Instrument Serif, Plus Jakarta Sans, or JetBrains Mono. No purple gradients, no glassmorphism (`backdrop-filter`), no emoji icons, no coloured left/top edge stripes on cards, no 2px accent outlines on rounded cards, no marketing fluff ("seamlessly", "effortlessly", "smart").

## 1. Typography (Self-Hosted SIL Open Font License 1.1)

All fonts are self-hosted in `apps/orbit/public/fonts/` as variable WOFF2 files under the **SIL Open Font License 1.1 (OFL-1.1)**:

1. **Display / Headings (`--font-display`):** **Bricolage Grotesque** (`bricolage-grotesque-latin-wght-normal.woff2`, OFL-1.1, by Mathieu Triay).
   - _Why:_ Warm, characterful, sturdy proportions with unmistakable personality that avoids generic tech-SaaS defaults while staying grounded and readable at display and section-heading sizes.
2. **Body / UI Controls (`--font-sans`):** **Atkinson Hyperlegible Next** (`atkinson-hyperlegible-next-latin-wght-normal.woff2`, OFL-1.1, by Braille Institute).
   - _Why:_ Engineered specifically for maximum character disambiguation (`0`/`O`, `1`/`I`/`l`, ear tag codes, animal names) under harsh glare in a bright barn office or tired eyes during a 3 AM calving check.
3. **Data / Serials / Timestamps (`--font-mono`):** **Azeret Mono** (`azeret-mono-latin-wght-normal.woff2`, OFL-1.1, by Martin Vácha & Daniel Quisek).
   - _Why:_ Crisp tabular numerals (`tabular-nums`) for ear tag numbers (`DK-1001`), temperatures (`40.4 °C`), battery percentages, and sync timestamps. Never used as a decorative "tech" costume on headings.

### Type Scale (1.25x+ floor between heading steps)

| Token            | Value             | Role                              |
| ---------------- | ----------------- | --------------------------------- |
| `--text-display` | `2.75rem` (44px)  | Hero / primary farm figure        |
| `--text-h1`      | `2.125rem` (34px) | Page title                        |
| `--text-h2`      | `1.625rem` (26px) | Section heading                   |
| `--text-h3`      | `1.25rem` (20px)  | Card / group heading              |
| `--text-lg`      | `1.125rem` (18px) | Prominent control / lead copy     |
| `--text-base`    | `1rem` (16px)     | Primary body text & controls      |
| `--text-sm`      | `0.875rem` (14px) | Secondary metadata & table cells  |
| `--text-xs`      | `0.75rem` (12px)  | Badges, ear tag chips, timestamps |

## 2. Color System (Light & Dark Themes)

Built for >7:1 primary text contrast and >4.5:1 secondary text contrast in both themes.

### Light Theme ("Daylight Barn Office" - default `:root` & `[data-theme="light"]`)

- **Canvas & Surfaces:**
  - `--bg-canvas`: `#f6f3ec` (Warm limestone paper)
  - `--bg-surface`: `#ffffff` (Crisp card surface)
  - `--bg-elevated`: `#efeae0` (Tonal secondary surface / rail)
  - `--bg-subtle`: `#e5dfd2` (Interactive well / hover wash)
  - `--bg-hover`: `#dbd3c3` (Pressed / active control wash)
  - `--bg-scrim`: `rgba(24, 22, 18, 0.55)` (Modal/drawer backdrop)
- **Ink (Text):**
  - `--text-primary`: `#181612` (Deep iron ink)
  - `--text-secondary`: `#4a453b` (Weathered slate)
  - `--text-muted`: `#686153` (Warm stone — passes AA 4.6:1 on `--bg-canvas`)
  - `--text-inverse`: `#fcfaf5`
- **Brand & Accent:**
  - `--accent-primary`: `#b84a14` (Warm terracotta / barn ochre — high visibility, >=4.6:1 with white text)
  - `--accent-primary-hover`: `#9c3d0e`
  - `--accent-primary-subtle`: `rgba(184, 74, 20, 0.10)`
  - `--accent-secondary`: `#1f5c3f` (Pasture pine)
  - `--accent-secondary-subtle`: `rgba(31, 92, 63, 0.10)`
- **Semantic Status:**
  - `--status-ok`: `#1b6e44`, `--status-ok-bg`: `rgba(27, 110, 68, 0.11)`, `--status-ok-border`: `rgba(27, 110, 68, 0.30)`
  - `--status-warn`: `#945305`, `--status-warn-bg`: `rgba(148, 83, 5, 0.12)`, `--status-warn-border`: `rgba(148, 83, 5, 0.32)`
  - `--status-danger`: `#b42318`, `--status-danger-bg`: `rgba(180, 35, 24, 0.11)`, `--status-danger-border`: `rgba(180, 35, 24, 0.32)`
  - `--status-info`: `#175cd3`, `--status-info-bg`: `rgba(23, 92, 211, 0.10)`, `--status-info-border`: `rgba(23, 92, 211, 0.28)`
- **Borders & Focus:**
  - `--border-subtle`: `#dcd5c7`
  - `--border-strong`: `#bdb3a0`
  - `--border-focus`: `#b84a14`
  - `--orbit-ring`: `rgba(184, 74, 20, 0.18)`
  - `--orbit-ring-strong`: `rgba(184, 74, 20, 0.34)`

### Dark Theme ("Night Watch" - `[data-theme="dark"]`)

- **Canvas & Surfaces:**
  - `--bg-canvas`: `#111310` (Night pasture charcoal)
  - `--bg-surface`: `#191c18` (Barn timber dark surface)
  - `--bg-elevated`: `#222620` (Elevated panel)
  - `--bg-subtle`: `#2b3028` (Subtle wash)
  - `--bg-hover`: `#363c32` (Hover wash)
  - `--bg-scrim`: `rgba(8, 9, 7, 0.74)`
- **Ink (Text):**
  - `--text-primary`: `#f3f0e6` (Warm cream)
  - `--text-secondary`: `#c6c0b2` (Soft limestone)
  - `--text-muted`: `#968f7e` (Muted straw — passes AA >5:1 on `--bg-surface`)
  - `--text-inverse`: `#111310`
- **Brand & Accent:**
  - `--accent-primary`: `#e88245` (Warm lantern amber)
  - `--accent-primary-hover`: `#f2955e`
  - `--accent-primary-subtle`: `rgba(232, 130, 69, 0.15)`
  - `--accent-secondary`: `#5ec28f` (Night meadow green)
  - `--accent-secondary-subtle`: `rgba(94, 194, 143, 0.14)`
- **Semantic Status:**
  - `--status-ok`: `#57cc8a`, `--status-ok-bg`: `rgba(87, 204, 138, 0.14)`, `--status-ok-border`: `rgba(87, 204, 138, 0.34)`
  - `--status-warn`: `#f5b14c`, `--status-warn-bg`: `rgba(245, 177, 76, 0.15)`, `--status-warn-border`: `rgba(245, 177, 76, 0.35)`
  - `--status-danger`: `#f97066`, `--status-danger-bg`: `rgba(249, 112, 102, 0.16)`, `--status-danger-border`: `rgba(249, 112, 102, 0.38)`
  - `--status-info`: `#68a8ff`, `--status-info-bg`: `rgba(104, 168, 255, 0.15)`, `--status-info-border`: `rgba(104, 168, 255, 0.34)`
- **Borders & Focus:**
  - `--border-subtle`: `#2c3129`
  - `--border-strong`: `#434a3e`
  - `--border-focus`: `#e88245`
  - `--orbit-ring`: `rgba(232, 130, 69, 0.20)`
  - `--orbit-ring-strong`: `rgba(232, 130, 69, 0.38)`

## 3. Spacing, Radius & Motion

- **Spacing Scale (4px base):** `--space-1` (4px), `--space-2` (8px), `--space-3` (12px), `--space-4` (16px), `--space-5` (20px), `--space-6` (24px), `--space-8` (32px), `--space-10` (40px), `--space-12` (48px).
- **Hit Targets:** `--control-height-sm` (36px), `--control-height-md` (44px — default for farmer touch/pointer ease), `--control-height-lg` (52px).
- **Border Radius:** `--radius-sm` (6px), `--radius-md` (10px), `--radius-lg` (14px), `--radius-xl` (20px), `--radius-full` (9999px).
- **Motion:** `--duration-fast` (120ms), `--duration-normal` (200ms), `--duration-slow` (360ms), `--ease-out` (`cubic-bezier(0.22, 1, 0.36, 1)`). All animations respect `@media (prefers-reduced-motion: reduce)`.

## 4. Spacing & Layout Contract

Layout: App Shell - persistent left navigation rail + top farm status bar + scrollable main workspace -> fixed-sidenav-shell (skipped: host unreachable); scroll owner: `.orbit-main-scroll`; anti-patterns: double vertical scrollbars on window and main, missing `min-block-size: 0` on grid scroll child, horizontal overflow at 1024x700.

Layout: Home Screen - farm orbit overview + priority alerts + herd/device/camera satellite summary -> page-grid + intrinsic grid (skipped: host unreachable); scroll owner: `.orbit-main-scroll`; anti-patterns: burying active calving/health alerts below decorative chrome, stacking multiple wearables per animal.

## 5. Screen Brief (Home & App Shell)

- **Primary Action:** **"Ask Orion"** button (prominent terracotta/amber CTA in the Home hero & command bar that opens `/chat` with Orion, or triggers an immediate question).
- **Information Priorities (1-3):**
  1. **Active Alerts & Farm Pulse** (Calving alerts, high temperature health events, heat alerts from `farm.summary.recentAlerts`, and Orion connection banner if Orion is offline).
  2. **The Farm Orbit & Herd/Equipment Status** (`farm.summary.counts`: Cattle, Horses, Sensors online/offline, Cameras online, Connectors synced, visualised cleanly alongside the `OrbitRings` farm diagram).
  3. **Quick Ask Orion Prompts** (Plain-language one-click questions a farmer asks: e.g., _"Which cows need attention today?"_, _"Check calving pen camera and recent alerts"_, _"Show sensors with low battery"_).
- **Left Out on Purpose:** No fake weather widgets, no decorative sparklines with random data, no stacked multi-wearable badges per animal, no marketing slogans.
- **Required Content:**
  - Left rail navigation: `Home`, `Ask Orion`, `Cows & Horses`, `Sensors & Robots`, `Cameras`, `Settings`.
  - Top bar: Farm name (from `farm.summary.farm.name` or `"Demo Farm"` fallback), Orion connection state, Sync status (`sync.status`), and Light/Dark theme toggle.
  - Friendly connection banner when Orion is reconnecting, offline, or unauthorized.
  - Home summary driven by `useOrionQuery("farm.summary")`: cows count, horses count, alerts list, sensors online/offline count, cameras online/total count, and prominent "Ask Orion" entry.
- **Reusable Primitives (`src/design/`):**
  - `Button` (variants: `primary`, `secondary`, `subtle`, `danger`; sizes: `sm`, `md`, `lg`; loading state with fixed box geometry)
  - `Card` (tonal/bordered container with header, title, subtitle, actions, body)
  - `Badge` (semantic variants: `neutral`, `ok`, `warn`, `danger`, `info`, `accent`)
  - `Input` (labelled text input with hint/error states, 44px height)
  - `Select` (labelled native select with custom chevron, 44px height)
  - `Dialog` (accessible modal dialog with Escape close, focus management, scrim)
  - `Drawer` (slide-over side sheet for detail inspection)
  - `Tabs` (ARIA tablist + tab + tabpanel with keyboard arrow navigation)
  - `Toast` (`ToastProvider` + `useToast()` for transient feedback)
  - `EmptyState` (calm orbit-themed empty state with title, description, and optional action)
  - `Skeleton` (loading placeholder block)
  - `OrbitRings` (SVG concentric rings, orbit paths, central barn node, and satellite nodes representing cows, horses, sensors, and cameras)
