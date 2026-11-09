// The farm workspace is a git repository the farmer never sees. Orion commits a snapshot after each
// agent run that changed files; undo reverts one snapshot commit.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class Workspace {
  available = false;

  constructor(readonly dir: string) {}

  async git(args: string[]): Promise<GitResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Orion",
        GIT_AUTHOR_EMAIL: "orion@orbit.local",
        GIT_COMMITTER_NAME: "Orion",
        GIT_COMMITTER_EMAIL: "orion@orbit.local",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  /** Creates the workspace and a starter AGENTS.md once, and initialises git if it is installed. */
  async init(): Promise<void> {
    mkdirSync(join(this.dir, "connectors"), { recursive: true });
    mkdirSync(join(this.dir, "pages"), { recursive: true });
    mkdirSync(join(this.dir, "skills"), { recursive: true });
    const agents = join(this.dir, "AGENTS.md");
    if (!existsSync(agents)) {
      writeFileSync(
        agents,
        "# This farm\n\nNotes Orion keeps about this farm: routines, barn layout, devices and preferences.\n",
      );
    }
    try {
      const version = await this.git(["--version"]);
      this.available = version.code === 0;
    } catch {
      this.available = false;
    }
    if (!this.available) return;
    if (!existsSync(join(this.dir, ".git"))) {
      await this.git(["init", "-q"]);
      writeFileSync(join(this.dir, ".gitignore"), "node_modules/\n*.log\n.env\n");
      await this.git(["add", "-A"]);
      await this.git(["commit", "-q", "-m", "Farm workspace created"]);
    }
  }

  /** Commits all changes; returns null when nothing changed or git is unavailable. */
  async snapshot(
    message: string,
  ): Promise<{ commit: string; parent: string; files: string[] } | null> {
    if (!this.available) return null;
    const status = await this.git(["status", "--porcelain", "-z"]);
    if (status.code !== 0 || status.stdout.length === 0) return null;
    const parent = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    await this.git(["add", "-A"]);
    const commit = await this.git(["commit", "-q", "-m", message]);
    if (commit.code !== 0) return null;
    const head = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    const files = (await this.git(["diff", "--name-only", parent, head])).stdout
      .split("\n")
      .filter(Boolean);
    return { commit: head, parent, files };
  }

  /** Reverts one snapshot commit with a new commit, so history is kept. */
  async revert(commit: string): Promise<string[]> {
    if (!this.available) throw new Error("snapshots are unavailable because git is not installed");
    const files = (await this.git(["diff", "--name-only", `${commit}^`, commit])).stdout
      .split("\n")
      .filter(Boolean);
    const result = await this.git(["revert", "--no-edit", commit]);
    if (result.code !== 0) {
      await this.git(["revert", "--abort"]);
      throw new Error(
        `could not undo: later changes touch the same files (${result.stderr.trim()})`,
      );
    }
    return files;
  }
}
