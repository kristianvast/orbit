import { defineFileExportConnector } from "../file-export";
import type { ColumnMapping } from "../tabular";

// TODO(unconfirmed): DeLaval does not publicly document the DelPro export layout (CSV or XML) and
// exports are configurable per farm. These header and attribute names are best guesses covering
// both formats; compare them with the farmer's real file and override via config.mapping. For
// XML set config.format "xml" and, if the record element is not <Milking>, config.recordTag.
export const delproDefaultMapping: ColumnMapping = {
  animalId: ["Animal", "Animal number", "AnimalNumber"],
  name: "Name",
  group: "Group",
  deviceId: ["Station", "Robot", "Stall"],
  timestamp: "Date",
  time: "Time",
  observations: [{ column: ["Milk yield", "MilkYield", "Yield"], kind: "milking", unit: "kg" }],
};

export const delproConnector = defineFileExportConnector({
  id: "delpro",
  vendor: "delaval",
  kind: "milking_robot",
  label: "DeLaval DelPro file export",
  defaultMapping: delproDefaultMapping,
  deviceKind: "milking_robot",
  defaultRecordTag: "Milking",
});
