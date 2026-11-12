// The farm workspace is a git repository the farmer never sees. Orion commits a snapshot after each
// agent run that changed files; undo reverts one snapshot commit.
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import * as git from "isomorphic-git";

const author = { name: "Orion", email: "orion@orbit.local" } as const;
export const WORKSPACE_AGENTS =
  "# This farm\n\nNotes Orion keeps about this farm: routines, barn layout, devices and preferences.\n";

class UndoConflict extends Error {
  constructor(files: string[]) {
    super(`could not undo: later changes touch the same files (${files.join(", ")})`);
  }
}

export class Workspace {
  onCommitted: (() => void) | null = null;
  constructor(readonly dir: string) {}

  /** Creates the workspace, starter files and initial git commit once. */
  async init(): Promise<void> {
    for (const folder of ["connectors", "pages", "skills"]) {
      fs.mkdirSync(join(this.dir, folder), { recursive: true });
    }
    const agents = join(this.dir, "AGENTS.md");
    if (!fs.existsSync(agents)) {
      fs.writeFileSync(agents, WORKSPACE_AGENTS);
    }
    if (!fs.existsSync(join(this.dir, ".git"))) {
      await git.init({ fs, dir: this.dir });
      const ignore = join(this.dir, ".gitignore");
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "node_modules/\n*.log\n.env\n");
      await this.stage();
      await git.commit({ fs, dir: this.dir, author, message: "Farm workspace created" });
    }
  }

  /** Stages changes, including deletions, without descending into ignored directories. */
  private async stage(): Promise<string[]> {
    const status = await git.statusMatrix({ fs, dir: this.dir });
    const files: string[] = [];
    for (const [filepath, head, workdir, stage] of status) {
      if (head !== workdir) files.push(filepath);
      if (workdir === stage) continue;
      if (workdir === 0) await git.remove({ fs, dir: this.dir, filepath });
      else await git.add({ fs, dir: this.dir, filepath, force: head !== 0 || stage !== 0 });
    }
    return files;
  }

  /** Commits all changes; returns null when nothing changed. */
  async snapshot(
    message: string,
  ): Promise<{ commit: string; parent: string; files: string[] } | null> {
    const files = await this.stage();
    if (files.length === 0) return null;
    const parent = await git.resolveRef({ fs, dir: this.dir, ref: "HEAD" });
    const commit = await git.commit({ fs, dir: this.dir, author, message });
    this.onCommitted?.();
    return { commit, parent, files };
  }

  /** Reverts only this snapshot's files with a new commit, so history is kept. */
  async revert(commit: string): Promise<string[]> {
    const [snapshot] = await git.log({ fs, dir: this.dir, ref: commit, depth: 1 });
    const parent = snapshot?.commit.parent[0];
    if (!parent) throw new Error("could not undo: snapshot has no parent commit");
    const changes: Array<{
      filepath: string;
      before: Uint8Array | null;
      after: Uint8Array | null;
      mode: number;
    }> = [];
    await git.walk({
      fs,
      dir: this.dir,
      trees: [git.TREE({ ref: parent }), git.TREE({ ref: commit })],
      map: async (filepath, [before, after]) => {
        if (
          (await before?.oid()) === (await after?.oid()) &&
          (await before?.mode()) === (await after?.mode())
        )
          return null;
        if ((await before?.type()) === "tree" || (await after?.type()) === "tree") return;
        changes.push({
          filepath,
          before: (await before?.content()) ?? null,
          after: (await after?.content()) ?? null,
          mode: (await before?.mode()) ?? 0,
        });
      },
    });
    changes.sort((a, b) => a.filepath.localeCompare(b.filepath));

    // Check every affected file before writing any of them. Reading bytes also catches dirty
    // working files and binary changes, rather than relying on HEAD or cached index timestamps.
    const conflicts: string[] = [];
    for (const { filepath, after } of changes) {
      const file = join(this.dir, filepath);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) {
        if (after !== null) conflicts.push(filepath);
      } else if (after === null || (!stat.isFile() && !stat.isSymbolicLink())) {
        conflicts.push(filepath);
      } else {
        const current = stat.isSymbolicLink()
          ? Buffer.from(fs.readlinkSync(file))
          : fs.readFileSync(file);
        if (!current.equals(after)) conflicts.push(filepath);
      }
    }
    if (conflicts.length) throw new UndoConflict(conflicts);

    for (const { filepath, before, mode } of changes) {
      const file = join(this.dir, filepath);
      if (before === null) {
        fs.unlinkSync(file);
        await git.remove({ fs, dir: this.dir, filepath });
      } else {
        fs.mkdirSync(dirname(file), { recursive: true });
        // Replace symlinks rather than writing through them.
        if (fs.lstatSync(file, { throwIfNoEntry: false })) fs.unlinkSync(file);
        if (mode === 0o120000) fs.symlinkSync(Buffer.from(before).toString(), file);
        else {
          fs.writeFileSync(file, before);
          fs.chmodSync(file, mode & 0o777);
        }
        await git.add({ fs, dir: this.dir, filepath, force: true });
      }
    }
    await git.commit({
      fs,
      dir: this.dir,
      author,
      message: `Revert "${snapshot.commit.message.trim()}"\n\nThis reverts commit ${commit}.`,
    });
    this.onCommitted?.();
    return changes.map(({ filepath }) => filepath);
  }
}
