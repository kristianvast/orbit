import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalMode, ThinkingLevel } from "@orbit/protocol";

export interface StoredSettings {
  provider: string | null;
  model: string | null;
  thinkingLevel: ThinkingLevel;
  approvalMode: ApprovalMode;
  alwaysAllow: string[];
  /** Masked hints only ("…abcd"); keys live in Pi's credential store (<data-dir>/pi/auth.json). */
  keyHints: Record<string, string>;
}

const DEFAULTS: StoredSettings = {
  provider: null,
  model: null,
  thinkingLevel: "off",
  approvalMode: "ask",
  alwaysAllow: [],
  keyHints: {},
};

/** Task-spec names accepted on disk for the protocol's approval modes. */
const MODE_ALIASES: Record<string, ApprovalMode> = {
  ask_every_time: "ask",
  auto_approve_ask_tier: "auto",
};

export class SettingsStore {
  private file: string;
  private value: StoredSettings;

  constructor(dataDir: string) {
    this.file = join(dataDir, "settings.json");
    this.value = { ...DEFAULTS };
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredSettings>;
      const mode = raw.approvalMode as string | undefined;
      this.value = {
        ...DEFAULTS,
        ...raw,
        approvalMode: (mode && MODE_ALIASES[mode]) || (raw.approvalMode ?? DEFAULTS.approvalMode),
      };
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

  allowAlways(toolName: string) {
    if (!this.value.alwaysAllow.includes(toolName)) {
      this.update({ alwaysAllow: [...this.value.alwaysAllow, toolName] });
    }
  }
}

export function maskKey(key: string): string {
  return key.length <= 4 ? "…" : `…${key.slice(-4)}`;
}
