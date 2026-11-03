---

name: herd-data
description: Look up and update animals, sensors and observations with the farm tools. Use for questions about the herd, a specific animal, alerts, or putting a sensor on an animal.
---

# Herd data

1. Find animals with `herd_query` (filters: species, groupName, search; `id` accepts an id, ear
   tag or name). Default lists active animals only.
2. Look at readings and alerts with `observations_query` (`alertsOnly: true`, `sinceHours: 24`).
3. Change records with `herd_upsert_animal`. Pass `id` to update; omit it to add.
4. Sensors: `devices_list` shows each device and the animal it is on. `device_bind` puts a device
   on an animal or takes it off (`action: "unbind"`).

Rules
- One wearable per animal: collar OR bolus OR ear tag sensor. If `device_bind` reports a conflict,
  explain it and offer to unbind the old sensor first.
- Summaries: give counts first, then the few animals that need attention. Use names and ear tags,
  not ids, when talking to the farmer.
- Health alerts are signals, not diagnoses. Suggest checking the animal and calling the vet.
