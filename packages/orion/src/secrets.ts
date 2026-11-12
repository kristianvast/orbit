// Secret storage: OS keychain via Bun.secrets when available, otherwise an AES-256-GCM encrypted
// JSON file in the data dir (key in a 0600 file next to it). Callers only ever see a ref string.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = "no.agrointel.orbit";

export interface SecretStore {
  readonly backend: "keychain" | "encrypted-file";
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

interface BunSecrets {
  get(o: { service: string; name: string }): Promise<string | null>;
  set(o: { service: string; name: string; value: string }): Promise<void>;
  delete(o: { service: string; name: string }): Promise<boolean>;
}

class KeychainStore implements SecretStore {
  readonly backend = "keychain" as const;
  constructor(
    private readonly secrets: BunSecrets,
    private readonly namespace: string,
  ) {}
  private name(ref: string) {
    return `${this.namespace}:${ref}`;
  }
  async set(ref: string, value: string) {
    await this.secrets.set({ service: SERVICE, name: this.name(ref), value });
  }
  async get(ref: string) {
    return this.secrets.get({ service: SERVICE, name: this.name(ref) });
  }
  async delete(ref: string) {
    await this.secrets.delete({ service: SERVICE, name: this.name(ref) });
  }
}

export class EncryptedFileStore implements SecretStore {
  readonly backend = "encrypted-file" as const;
  private readonly file: string;
  private readonly key: Buffer;

  constructor(dataDir: string, fileName = "secrets.enc.json") {
    this.file = join(dataDir, fileName);
    const keyFile = join(dataDir, "secrets.key");
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    chmodSync(keyFile, 0o600);
    this.key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
  }

  private load(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const { iv, tag, data } = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv as string, "base64"));
    decipher.setAuthTag(Buffer.from(tag as string, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(data as string, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8")) as Record<string, string>;
  }

  private save(values: Record<string, string>) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
    const payload = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    writeFileSync(this.file, JSON.stringify(payload), { mode: 0o600 });
  }

  async set(ref: string, value: string) {
    const values = this.load();
    values[ref] = value;
    this.save(values);
  }
  async get(ref: string) {
    return this.load()[ref] ?? null;
  }
  async delete(ref: string) {
    const values = this.load();
    delete values[ref];
    this.save(values);
  }
}

/**
 * Picks the keychain when Bun.secrets works on this machine (probed with a round trip), else the
 * encrypted file. ORION_SECRETS=file forces the file backend (tests, headless Linux).
 */
export async function openSecretStore(dataDir: string, namespace: string): Promise<SecretStore> {
  const secrets = (Bun as unknown as { secrets?: BunSecrets }).secrets;
  if (secrets && process.env.ORION_SECRETS !== "file") {
    const store = new KeychainStore(secrets, namespace);
    try {
      await store.set("__probe", "ok");
      const ok = (await store.get("__probe")) === "ok";
      await store.delete("__probe");
      if (ok) return store;
    } catch {
      // No keychain service available (e.g. headless Linux without libsecret): use the file.
    }
  }
  return new EncryptedFileStore(dataDir);
}
