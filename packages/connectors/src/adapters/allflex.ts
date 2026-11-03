import { defineFileExportConnector } from "../file-export";
import type { ColumnMapping } from "../tabular";

// TODO(unconfirmed): Allflex (SenseHub) does not publish its export layout publicly, and its
// monitoring comes as collars or ear tags depending on the product. The column headers below are
// guesses; override via config.mapping. The sensor kind defaults to "collar"; set
// config.deviceKind to "ear_tag_sensor" for ear tags. An animal still gets only ONE sensor.
export const allflexDefaultMapping: ColumnMapping = {
  animalId: ["Animal ID", "Animal", "Animal number"],
  earTag: ["Ear tag", "Visual ID"],
  name: "Name",
  group: "Group",
  deviceId: ["Collar", "Tag", "Sensor ID"],
  timestamp: ["Time", "Date", "Timestamp"],
  observations: [
    { column: ["Rumination (min)", "Rumination"], kind: "rumination", unit: "min" },
    { column: "Activity", kind: "activity" },
  ],
};

export const allflexConnector = defineFileExportConnector({
  id: "allflex",
  vendor: "allflex",
  kind: "wearable",
  label: "Allflex collar / ear tag file export",
  defaultMapping: allflexDefaultMapping,
  deviceKind: "collar",
  allowedDeviceKinds: ["collar", "ear_tag_sensor"],
});
