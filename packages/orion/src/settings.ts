import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel, ToolAccess } from "@orbit/protocol";
import type { Species } from "@orbit/schema/enums";

export interface StoredSettings {
  provider: string | null;
  model: string | null;
  thinkingLevel: ThinkingLevel;
  /** Anonymised footage and outcomes may be shared to improve the models; on unless turned off. */
  shareAnonymousData: boolean;
  /** The farmer's yes per tool (shell, browser, computer), each given on that tool's first use. */
  toolAccess: ToolAccess;
  /** Tools whose question the farmer has allowed at least once (stays true when a switch is turned off). */
  toolAccessAccepted: ToolAccess;
  species?: Species;
  /** Masked hints only ("…abcd"); keys live in Pi's credential store (<data-dir>/pi/auth.json). */
  keyHints: Record<string, string>;
  /** 2 once the thinking default moved from off to medium; absent in older files. */
  version?: number;
}

const VERSION = 2;

const DEFAULTS: StoredSettings = {
  provider: null,
  model: null,
  thinkingLevel: "medium",
  shareAnonymousData: true,
  toolAccess: { shell: false, browser: false, computer: false },
  toolAccessAccepted: { shell: false, browser: false, computer: false },
  keyHints: {},
  version: VERSION,
};

export class SettingsStore {
  /** settings.json; file tools refuse it so Orion cannot change the farmer's choices. */
  readonly file: string;
  private value: StoredSettings;

  constructor(dataDir: string) {
    this.file = join(dataDir, "settings.json");
    this.value = { ...DEFAULTS };
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredSettings> &
        Record<string, unknown>;
      // Drop keys from the removed approval flow and the one-switch access so they are not written back.
      const { approvalMode: _mode, alwaysAllow: _allow, computerAccess: _access, ...kept } = raw;
      this.value = {
        ...DEFAULTS,
        ...kept,
        toolAccess: { ...DEFAULTS.toolAccess, ...kept.toolAccess },
        toolAccessAccepted: { ...DEFAULTS.toolAccessAccepted, ...kept.toolAccessAccepted },
      };
      // Older files stored the old "off" default on any save, so it is not a farmer's choice.
      if ((kept.version ?? 1) < VERSION) {
        if (this.value.thinkingLevel === "off") this.value.thinkingLevel = "medium";
        this.value.version = VERSION;
      }
    }
  }

  get(): StoredSettings {
    return structuredClone(this.value);
  }

  update(patch: Partial<StoredSettings>): StoredSettings {
    this.value = { ...this.value, ...patch };
    writeFileSync(this.file, `${JSON.stringify(this.value, null, 2)}\n`);
    return this.get();
  }
}

export function maskKey(key: string): string {
  return key.length <= 4 ? "…" : `…${key.slice(-4)}`;
}
