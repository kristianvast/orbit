import type { Messages } from "../../core";

export const devices = {
  "mode.cloud_api": "cloud api",
  "mode.local_api": "local api",
  "mode.local_db": "local db",
  "mode.file_import": "file import",
  "mode.custom": "custom",

  "vendor.generic_csv": "CSV Import",
  "vendor.custom": "custom",

  "time.never": "Never",
  "time.justNow": "Just now",
  "time.minutesAgo": { one: "{count}m ago", other: "{count}m ago" },
  "time.hoursAgo": { one: "{count}h ago", other: "{count}h ago" },
  "time.daysAgo": { one: "{count}d ago", other: "{count}d ago" },

  "common.cancel": "Cancel",
  "common.retry": "Retry",

  "page.title": "Connections",
  "empty.title": "No connections yet",

  "connector.toast.on": "Connection switched on",
  "connector.toast.off": "Connection switched off",
  "connector.toast.enabled": "{name} is now enabled.",
  "connector.toast.paused": "{name} is now paused.",
  "connector.toast.error": "Could not update connection",
  "sync.toast.done": "Sync finished",
  "sync.toast.description": "Imported latest readings from {name}.",
  "sync.toast.notice": "Sync notice",

  "connectors.error.title": "Could not load connections",
  "connectors.loading": "Loading connections…",
  "connector.status.error": "Sync error",
  "connector.status.enabled": "Enabled",
  "connector.status.paused": "Paused",
  "connector.lastSync": "Last sync: {time}",
  "connector.turnOff": "Turn off",
  "connector.turnOn": "Turn on",
  "connector.syncNow": "Sync now",
  "connector.password": "Password",
  "password.title": "Password for {name}",
  "password.description":
    "Stored in this computer's secure keychain and used only by this connection. Orion never sees it.",
  "password.label": "Password",
  "password.save": "Save password",
  "password.toast.saved": "Password saved",
  "password.toast.error": "Could not save the password",

  "connectNew.button": "Connect with Orion",
  "connectNew.prompt": "Help me connect my farm equipment or software",
} as const satisfies Messages;
