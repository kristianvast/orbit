// Feedback to the Orbit team and builds this farm shares for review, both relayed to Core.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { arch, release } from "node:os";
import { join } from "node:path";
import type { FeedbackKind, SharedBuild, SharedBuildKind } from "@orbit/protocol";
import { RepoError } from "../db/repo";
import type { AccountService } from "./account";

const KIND_DIR: Record<SharedBuildKind, string> = {
  page: "pages",
  connector: "connectors",
  skill: "skills",
};
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build"]);
const MAX_FILES = 60;
const MAX_BYTES = 512 * 1024;

// A quoted value assigned to a secret-looking name, or a token in a well-known key format.
const SECRET_PATTERNS = [
  /\b(pass(word|wd)?|secret|api[_-]?key|token|credential)\w*["']?\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/i,
  /\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,})\b/,
];

export interface SharedFile {
  path: string;
  content: string;
}

export interface CollectedBuild {
  files: SharedFile[];
  /** Files left out and why, so Orion can tell the farmer. */
  skipped: string[];
}

/** Reads the text files of one build; refuses when a file looks like it holds a password or key. */
export function collectBuild(
  workspaceDir: string,
  kind: SharedBuildKind,
  name: string,
): CollectedBuild {
  if (!NAME.test(name)) {
    throw new RepoError("bad_request", `"${name}" is not a valid name (a-z, 0-9 and dashes)`);
  }
  const root = join(workspaceDir, KIND_DIR[kind], name);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new RepoError("not_found", `there is no ${kind} called ${name} in ${KIND_DIR[kind]}/`);
  }
  const files: SharedFile[] = [];
  const skipped: string[] = [];
  const leaks: string[] = [];
  let bytes = 0;
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) {
        skipped.push(`${rel} (hidden or generated)`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const raw = readFileSync(join(dir, entry.name));
      if (raw.includes(0)) {
        skipped.push(`${rel} (not a text file)`);
        continue;
      }
      const content = raw.toString("utf8");
      content.split("\n").forEach((line, index) => {
        if (SECRET_PATTERNS.some((pattern) => pattern.test(line)))
          leaks.push(`${rel}:${index + 1}`);
      });
      bytes += raw.byteLength;
      files.push({ path: rel, content });
    }
  };
  walk(root, "");
  if (leaks.length > 0) {
    throw new RepoError(
      "rule_violation",
      `these lines look like a password or key and must be removed before sharing: ${leaks.join(", ")}`,
      { leaks },
    );
  }
  if (files.length === 0) throw new RepoError("bad_request", `${kind} ${name} has no text files`);
  if (files.length > MAX_FILES || bytes > MAX_BYTES) {
    throw new RepoError(
      "bad_request",
      `${kind} ${name} is too large to share (${files.length} files, ${Math.ceil(bytes / 1024)} KB; the limit is ${MAX_FILES} files and ${MAX_BYTES / 1024} KB)`,
    );
  }
  return { files, skipped };
}

export class FeedbackService {
  /** Set once the account service exists; it is created after the agent tools. */
  account: Pick<AccountService, "request"> | null = null;

  constructor(
    private readonly workspaceDir: string,
    private readonly appVersion: string,
  ) {}

  private cloud(): Pick<AccountService, "request"> {
    if (!this.account) throw new RepoError("not_ready", "Orbit is still starting");
    return this.account;
  }

  async send(params: {
    kind: FeedbackKind;
    message: string;
    contactEmail?: string | undefined;
    locale?: string | undefined;
  }): Promise<{ id: string }> {
    const contactEmail = params.contactEmail?.trim();
    const result = (await this.cloud().request(
      "POST",
      "/v1/feedback",
      {
        kind: params.kind,
        message: params.message.trim(),
        appVersion: this.appVersion,
        os: `${process.platform} ${arch()} ${release()}`,
        ...(contactEmail ? { contactEmail } : {}),
        ...(params.locale ? { locale: params.locale } : {}),
      },
      "optional",
    )) as { id: string };
    return { id: result.id };
  }

  async share(params: {
    kind: SharedBuildKind;
    name: string;
    title: string;
    description: string;
  }): Promise<{ id: string; files: string[]; skipped: string[] }> {
    const { files, skipped } = collectBuild(this.workspaceDir, params.kind, params.name);
    const result = (await this.cloud().request("POST", "/v1/submissions", {
      kind: params.kind,
      name: params.name,
      title: params.title.trim(),
      description: params.description.trim(),
      appVersion: this.appVersion,
      files,
    })) as { id: string };
    return { id: result.id, files: files.map((f) => f.path), skipped };
  }

  async shared(): Promise<{ submissions: SharedBuild[] }> {
    const result = (await this.cloud().request("GET", "/v1/submissions")) as {
      submissions: SharedBuild[];
    };
    return {
      submissions: result.submissions.map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.name,
        title: s.title,
        status: s.status,
        reviewNote: s.reviewNote ?? null,
        createdAt: s.createdAt,
      })),
    };
  }
}
