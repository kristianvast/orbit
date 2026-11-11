import type { Messages } from "../../core";

export const design = {
  "dialog.close": "Close dialog",
  "drawer.close": "Close panel",
  "tabs.label": "Section tabs",
  "toast.region": "Notifications",
  "toast.dismiss": "Dismiss notification",
  "orbit.diagram": "Farm orbit diagram: {center} {sublabel}",
  "orbit.center": "BARN",
  "orbit.sublabel": "Calm orbit",
  "orbit.cattle": "Cattle",
  "orbit.horses": "Horses",
  "orbit.robot": "Milking robot",
  "orbit.cameras": "Cameras",
  "orbit.alerts": "Alerts",
} as const satisfies Messages;
