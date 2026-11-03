import { defineFileExportConnector } from "../file-export";
import type { ColumnMapping } from "../tabular";

// TODO(unconfirmed): smaXtec's public documentation does not specify the CSV export of its
// portal. Metric names (temperature, activity, rumination) are what the bolus measures, but the
// column headers below are guesses; override via config.mapping after checking a real export.
export const smaxtecDefaultMapping: ColumnMapping = {
  animalId: ["Animal ID", "Animal"],
  earTag: ["Ear tag", "Ear tag number"],
  name: "Name",
  deviceId: ["Sensor", "Bolus ID", "Sensor ID"],
  timestamp: ["Timestamp", "Date"],
  observations: [
    { column: ["Temperature (C)", "Temperature"], kind: "temperature", unit: "C" },
    { column: "Activity", kind: "activity" },
    { column: ["Rumination (min)", "Rumination"], kind: "rumination", unit: "min" },
  ],
};

export const smaxtecConnector = defineFileExportConnector({
  id: "smaxtec",
  vendor: "smaxtec",
  kind: "wearable",
  label: "smaXtec bolus file export",
  defaultMapping: smaxtecDefaultMapping,
  deviceKind: "bolus",
});
