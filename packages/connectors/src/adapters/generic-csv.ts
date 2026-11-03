import { DEVICE_KINDS } from "@orbit/schema/enums";
import { defineFileExportConnector } from "../file-export";

export const genericCsvConnector = defineFileExportConnector({
  id: "generic_csv",
  vendor: "generic_csv",
  kind: "file_import",
  label: "Generic CSV import",
  allowedDeviceKinds: DEVICE_KINDS,
});
