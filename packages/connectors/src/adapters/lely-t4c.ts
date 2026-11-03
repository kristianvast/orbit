import { defineFileExportConnector } from "../file-export";
import type { ColumnMapping } from "../tabular";

// TODO(unconfirmed): Lely's public documentation does not publish the column layout of T4C
// (Time for Cows) management-software exports, and the export is configurable per farm. These
// header names are best guesses; the farmer's agent must compare them with the real saved file
// and override them through config.mapping.
export const lelyT4cDefaultMapping: ColumnMapping = {
  animalId: ["Animal number", "Animal", "Cow number"],
  name: "Name",
  earTag: ["Ear tag", "Ear tag number"],
  group: "Group",
  birthDate: ["Birth date", "Date of birth"],
  deviceId: ["Robot", "Robot number"],
  timestamp: ["Milking start", "Date"],
  observations: [{ column: ["Milk yield", "Yield (kg)"], kind: "milking", unit: "kg" }],
};

export const lelyT4cConnector = defineFileExportConnector({
  id: "lely_t4c",
  vendor: "lely",
  kind: "milking_robot",
  label: "Lely T4C (Astronaut) file export",
  defaultMapping: lelyT4cDefaultMapping,
  deviceKind: "milking_robot",
});
