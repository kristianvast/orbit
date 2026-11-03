import { defineFileExportConnector } from "../file-export";
import type { ColumnMapping } from "../tabular";

// TODO(unconfirmed): CowManager does not publish the layout of its data export. The ear tag
// measures rumination and activity; the column headers below are guesses, so override them via
// config.mapping after checking a real export.
export const cowmanagerDefaultMapping: ColumnMapping = {
  animalId: ["Cow", "Animal", "Animal number"],
  earTag: ["Ear tag", "Tag"],
  name: "Name",
  group: "Group",
  deviceId: ["Sensor", "Tag number", "Sensor ID"],
  timestamp: ["Date", "Timestamp"],
  observations: [
    { column: ["Rumination (min)", "Rumination"], kind: "rumination", unit: "min" },
    { column: "Activity", kind: "activity" },
  ],
};

export const cowmanagerConnector = defineFileExportConnector({
  id: "cowmanager",
  vendor: "cowmanager",
  kind: "wearable",
  label: "CowManager ear tag file export",
  defaultMapping: cowmanagerDefaultMapping,
  deviceKind: "ear_tag_sensor",
});
