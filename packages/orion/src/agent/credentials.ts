// Pi CredentialStore backed by <data-dir>/pi/auth.json (same shape as Pi's auth.json), mode 0600.
// Model API keys never enter settings.json, the database or the protocol.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  private load(): Record<string, Credential> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Credential>;
  }

  private save(data: Record<string, Credential>) {
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.serial(async () => {
      const data = this.load();
      const next = await fn(data[providerId]);
      if (next === undefined) delete data[providerId];
      else data[providerId] = next;
      this.save(data);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serial(async () => {
      const data = this.load();
      delete data[providerId];
      this.save(data);
    });
  }
}
