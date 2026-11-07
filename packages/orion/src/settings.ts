import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@orbit/protocol";

export interface StoredSettings {
  provider: string | null;
  model: string | null;
  thinkingLevel: ThinkingLevel;
  /** Masked hints only ("…abcd"); keys live in Pi's credential store (<data-dir>/pi/auth.json). */
  keyHints: Record<string, string>;
}

const DEFAULTS: StoredSettings = {
  provider: null,
  model: null,
  thinkingLevel: "off",
  keyHints: {},
};

export class SettingsStore {
  private file: string;
  private value: StoredSettings;

  constructor(dataDir: string) {
    this.file = join(dataDir, "settings.json");
    this.value = { ...DEFAULTS };
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredSettings> &
        Record<string, unknown>;
      // Drop keys from the removed approval flow so they are not written back.
      const { approvalMode: _mode, alwaysAllow: _allow, ...kept } = raw;
      this.value = { ...DEFAULTS, ...kept };
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
