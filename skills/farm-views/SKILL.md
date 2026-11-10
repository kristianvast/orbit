---

name: farm-views
description: Ready-made, tested screens to start from when the farmer wants to see their animals, a calendar or their cameras - a herd view (Home card, herd list with the farmer's own filters, a card and a detail panel per animal), a calendar (calvings and foalings due, dry-offs, pregnancy checks, recorded events) and a camera wall. Copy one in and tune it instead of building a page from scratch.
---

# Farm views

Three screens that were built and tested on a demo farm. Each is a folder you copy into the farm
workspace with `page_scaffold`. It then shows under "Your pages" and as a card on Home, and the card
opens the full screen.

| page       | card on Home                                          | full screen                                                     |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `herd`     | head count, a split of the herd, how many need a look | search, filter chips, one card per animal, a panel per animal   |
| `calendar` | today, this week, the next thing due                  | month grid, the day's events, what is coming up and overdue     |
| `cameras`  | one camera's picture, how many are online             | a wall of still pictures by location, a larger picture on click |

What the farmer sees is set in the folder's `config.json`. Each view ships with a small default on
purpose: the point is a screen that shows what THIS farmer uses, not everything Orbit can show.

## Add a view

1. Agree in one sentence what they want to see. Ask what they look at every day and what they act on
   (which groups, which dates, which numbers). Do not guess a long list.
2. `page_scaffold` with `{ "fromSkill": "farm-views", "page": "herd" }` (or `calendar`, `cameras`).
   For a second copy with other settings, add `"id"`, for example
   `{ "fromSkill": "farm-views", "page": "herd", "id": "heifers" }`, and give it its own `title` in
   `pages/heifers/page.json`.
3. Edit `pages/<id>/config.json` to match what they said, using the menus below. It is strict JSON.
   Ids the view does not know are ignored, so a typo shows as a missing chip, not an error.
4. Tell the farmer where it is (the card on Home, "Your pages" in the menu) and that it can be
   undone. Ask them to look and say what is missing and what is in the way, then adjust.
5. `memory_remember` what they chose, so the next change starts from it.

`page_scaffold` never replaces a page that already exists, so the farmer's settings are safe. To
take a newer version of a view: `skill_install` again, scaffold it under a new id, copy the old
`config.json` across, and remove the old folder once the farmer is happy.

## Herd: `pages/herd/config.json`

```json
{
  "species": "all",
  "card": { "breakdown": "group" },
  "filters": ["attention", "group"],
  "sorts": ["attention", "name", "tag"],
  "animalCard": {
    "facts": ["group", "age"],
    "badges": ["alert", "heat", "due-soon", "fresh", "dry"]
  },
  "animalPanel": {
    "facts": ["tag", "nationalId", "breed", "sex", "age", "group", "sensor"],
    "sections": ["attention", "reproduction", "milk", "readings", "events", "notes"]
  },
  "repro": {}
}
```

- `species`: `all`, `cattle` or `horse`. Limits the whole view.
- `card.breakdown`: what the Home card's bar splits the herd by: `group`, `species` or `lactation`.
- `filters`: the chips above the list, in this order ("All" is always first). `attention` (an alert
  in the last 7 days), `group` (one chip per group the farm has), `species` (one per species),
  `fresh`, `dry`, `in-calf`, `inseminated`, `open`, `due-soon`, `dry-off-due`, `check-due`, `heat`,
  `no-sensor`, `low-battery`.
- `sorts`: the choices in the sort box, first one is the default: `attention`, `name`, `tag`, `age`,
  `group`, `due`, `milk`.
- `animalCard.facts`: the line under each animal's name, at most three are shown: `group`, `age`,
  `breed`, `sex`, `species`, `lactation`, `reproduction`, `days-in-milk`, `due`, `milk`, `sensor`.
- `animalCard.badges`: in order of importance, at most two are shown: `alert`, `heat`, `due-soon`,
  `check-due`, `dry-off-due`, `fresh`, `dry`, `in-calf`.
- `animalPanel.facts`: the animal card facts plus `tag`, `nationalId`, `birthDate`.
- `animalPanel.sections`: `attention`, `reproduction`, `milk`, `readings`, `events`, `notes`.
- `repro`: the farm's own numbers, see "Dates" below.

Examples. A dairy farmer who walks the dry cows and close-up cows every morning:
`"filters": ["attention", "due-soon", "dry-off-due", "group"]`, `"animalCard": { "facts":
["group", "due", "milk"], ... }`. A beef farmer: `"species": "cattle"`, `"filters": ["attention",
"in-calf", "due-soon", "group"]`, and leave `dry-off-due` and `milk` out everywhere. A horse yard:
`"species": "horse"`, `"filters": ["attention", "group"]`, `"animalPanel": { "sections":
["attention", "reproduction", "readings", "events", "notes"] }`.

## Calendar: `pages/calendar/config.json`

```json
{
  "weekStart": 1,
  "show": [
    "expected-calving",
    "dry-off-due",
    "pregnancy-check-due",
    "calving",
    "insemination",
    "pregnancy-check",
    "dry-off",
    "treatment",
    "alert"
  ],
  "card": { "upcomingDays": 14 },
  "upcomingDays": 60,
  "repro": {}
}
```

- `weekStart`: 0 is Sunday, 1 is Monday, up to 6. Ask which day their week starts on.
- `show`: which kinds of event appear. Planned, worked out from the records: `expected-calving`
  (calving, or foaling for a mare), `dry-off-due`, `pregnancy-check-due`. Recorded: `calving`,
  `insemination`, `pregnancy-check`, `dry-off`, `treatment`, `alert`.
- `card.upcomingDays` and `upcomingDays`: how far ahead the Home card and the "Coming up" list look.

The calendar has nothing to show until events are on record. Record them with `herd_record_event`
when the farmer tells you ("Rosa was inseminated this morning"), or bring them in with a connector.

## Cameras: `pages/cameras/config.json`

```json
{
  "card": { "camera": null, "refreshSeconds": 15 },
  "panel": { "refreshSeconds": 5, "zoomRefreshSeconds": 2 },
  "locations": [],
  "order": "location",
  "hide": []
}
```

- `card.camera`: the name of the camera the Home card shows; `null` picks the first one online. Ask
  which one they check most (often the calving pen).
- `locations`: which locations get a filter chip, in order; empty means all of them.
- `order`: `location`, `name` or `online-first`.
- `hide`: names of cameras to leave out.
- The refresh values are seconds between pictures.

This view shows still pictures that refresh. For live video, switch on the built-in Cameras screen
with `orbit_modules`. Cameras are added with `camera_discover` and `camera_add` (see the `cameras`
skill); this view never asks for or shows a password.

## Dates the views work out

Herd and calendar use the same rules, in `repro.js` in each folder:

- Expected calving or foaling: the last insemination since the last calving, plus the gestation
  length, for an animal that is in calf (a positive pregnancy check, or the status from a herd
  system). An empty check or an abortion clears it.
- Dry-off due: a set number of days before the expected calving, for a cow in milk.
- Pregnancy check due: a set number of days after an insemination that has no check yet.

Defaults: gestation 280 days for cattle and 340 for horses, dry-off 60 days before calving, check
35 days after insemination, "fresh" for 30 days after calving, "due soon" within 14 days. Ask the
farmer for their own numbers and set only what differs, in BOTH views so they agree:

```json
"repro": { "gestationDays": { "cattle": 283 }, "dryOffDaysBeforeCalving": 56 }
```

## When the menu does not have it

Build on the view instead of starting over.

- Each folder has one file with the rules (`herd.js`, `calendar.js`, `cameras.js`): a list of
  options, each with an id, a label and the rule as a small function. Add the new option there, then
  list its id in `config.json`. Read the file first and follow its pattern.
- `index.html` is the full screen and `card.html` the Home card. Both load `../_orbit.css` (Orbit's
  look) and `../_orbit.js` (farm data), and read `config.json`. Keep everything in the folder; no
  outside requests, the farm PC may be offline.
- The Home card is small (about 208 pixels tall) and cannot be clicked into: it only shows. Put
  controls in the full screen.
- If the farmer does not use English, translate the labels in the files into their language.
- If you change `repro.js`, make the same change in the other view's copy.
- After a change, open the page yourself if you can, or ask the farmer to look, before saying it works.

## Rules

- An animal wears a collar OR a bolus OR an ear tag sensor, never two. The views show the one it
  has. Do not add anything that suggests a second.
- Alerts are signals, not diagnoses. Keep the line that says to check the animal and call the vet.
- The views read farm data and write only an animal's notes. If you add a way to change records,
  say so to the farmer first; every change can be undone.
- No vendor names in the screens.
