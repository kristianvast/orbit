// Command-line and environment configuration for the Orion sidecar.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OrionConfig {
  /** 0 = let the OS pick a free port. */
  port: number;
  token: string;
  dataDir: string;
  mockModel: boolean;
  seed: boolean;
  /** Core LLM gateway base URL (env ORBIT_GATEWAY_URL); enables the orbit-gateway provider. */
  gatewayUrl: string | null;
  /** Orbit cloud (Core) base URL (--core-url or ORBIT_CORE_URL): accounts, sync, cloud model. */
  coreUrl?: string | null;
  /** Website for Google sign-in (env ORBIT_SITE_URL); https://pecorva.com when unset. */
  siteUrl?: string | null;
  /** Orbit source checkout Orion may edit (--app-source or ORBIT_APP_SOURCE); null in installed builds. */
  appSource: string | null;
  /** Skill catalog: http(s) base URL or local folder (--skills-url or ORION_SKILLS_URL). */
  skillsUrl?: string | null;
  /** Exit when stdin closes (--parent-watch): the desktop shell holds the pipe, so a killed shell never leaves Orion orphaned. */
  parentWatch?: boolean;
  /** Shuts Orion down cleanly so its parent starts it again; set only when a parent will. */
  restart?: () => void;
  /** Starts Orion again on the same port (another farm folder); the shell's restart or in-process. */
  reopen?: () => void;
}

/** OS application-data directory for Orbit (Windows %APPDATA%, macOS Application Support, XDG on Linux). */
export function defaultDataDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Orbit");
  }
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Orbit");
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "Orbit");
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

/** Parses `--flag value`, `--flag=value` and bare boolean flags. */
export function parseConfig(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): OrionConfig {
  const values = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) throw new ConfigError(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq > 0) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (["port", "token", "data-dir", "app-source", "core-url", "skills-url"].includes(name)) {
      if (next === undefined) throw new ConfigError(`--${name} needs a value`);
      values.set(name, next);
      i++;
    } else {
      values.set(name, true);
    }
  }
  const known = new Set([
    "port",
    "token",
    "data-dir",
    "app-source",
    "core-url",
    "skills-url",
    "mock-model",
    "seed",
    "dev",
    "parent-watch",
  ]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new ConfigError(`unknown option: --${key}`);
  }
  const dev = values.get("dev") === true;
  const str = (name: string): string | undefined => {
    const v = values.get(name);
    return typeof v === "string" ? v : undefined;
  };

  const portRaw = str("port") ?? env.ORION_PORT ?? (dev ? "7717" : "0");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`invalid --port: ${portRaw}`);
  }
  const token = str("token") ?? env.ORION_TOKEN ?? (dev ? "dev" : undefined);
  if (!token) throw new ConfigError("--token (or ORION_TOKEN) is required");
  const appSourceRaw = str("app-source") ?? env.ORBIT_APP_SOURCE?.trim();
  const appSource = appSourceRaw ? resolve(appSourceRaw) : null;
  if (appSource && !existsSync(join(appSource, "apps", "orbit", "package.json"))) {
    throw new ConfigError(`--app-source ${appSource} is not an Orbit checkout (no apps/orbit)`);
  }

  return {
    port,
    token,
    dataDir: resolve(str("data-dir") ?? env.ORION_DATA_DIR ?? defaultDataDir()),
    mockModel: values.get("mock-model") === true || truthy(env.ORION_MOCK_MODEL),
    seed: values.get("seed") === true || truthy(env.ORION_SEED),
    gatewayUrl: env.ORBIT_GATEWAY_URL?.trim() || null,
    coreUrl: (str("core-url") ?? env.ORBIT_CORE_URL)?.trim().replace(/\/+$/, "") || null,
    siteUrl: env.ORBIT_SITE_URL?.trim().replace(/\/+$/, "") || null,
    appSource,
    skillsUrl: (str("skills-url") ?? env.ORION_SKILLS_URL)?.trim() || null,
    parentWatch: values.get("parent-watch") === true,
  };
}
