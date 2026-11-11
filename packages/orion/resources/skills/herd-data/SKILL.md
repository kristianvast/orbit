---

name: herd-data
description: Look up and update animals, sensors and observations with the farm tools. Use for questions about the herd, a specific animal, alerts, or putting a sensor on an animal.
---

# Herd data

1. Find animals with `herd_query` (filters: species, groupName, search; `id` accepts an id, ear
   tag or name). Default lists active animals only.
2. Look at readings and alerts with `observations_query` (`alertsOnly: true`, `sinceHours: 24`).
3. Change records with `herd_upsert_animal`. Pass `id` to update; omit it to add.
4. Device records: `devices_list` shows each recorded device and the animal it is on.
   `device_bind` records a binding or takes it off (`action: "unbind"`); it does not connect
   hardware. Orbit has no ready sensor connection or sensor setup screen. Follow `connectors`
   to build and test a connection with the farmer before showing its data in the app.
5. When the farmer tells you something happened to an animal (inseminated, pregnancy check, calved
   or foaled, dried off, treated), record it with `herd_record_event`. Herd and calendar pages work
   out what is due from these records.

Rules
- One wearable per animal: collar OR bolus OR ear tag sensor. If `device_bind` reports a conflict,
  explain it and offer to unbind the old sensor first.
- Summaries: give counts first, then the few animals that need attention. Use names and ear tags,
  not ids, when talking to the farmer.
- Health alerts are signals, not diagnoses. Suggest checking the animal and calling the vet.
