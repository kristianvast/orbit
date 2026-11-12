import * as fs from "node:fs";
import { join } from "node:path";
import type { FarmAppDelta, FarmCodeBlobs } from "@orbit/protocol";
import { farmCodePath, farmCodeSecret } from "@orbit/protocol";
import * as git from "isomorphic-git";
import { codeHash } from "./farm-code-files";
import type { LocalUiService } from "./local-ui";

const author = { name: "Orion", email: "orion@orbit.local", timestamp: 0, timezoneOffset: 0 };

/** Encodes only changed files, including their old bytes, without fetching the sender's release. */
export class AppCode {
  constructor(
    private readonly dataDir: string,
    private readonly ui: LocalUiService,
  ) {}

  async collect(): Promise<{ delta: FarmAppDelta | null; blobs: FarmCodeBlobs }> {
    const dir = this.ui.checkoutDir;
    if (!fs.existsSync(join(dir, ".git"))) return { delta: null, blobs: {} };
    const version = await this.ui.baseVersion();
    if (!version) return { delta: null, blobs: {} };
    const ref = `v${version}`;
    const baseCommit = await git.resolveRef({ fs, dir, ref });
    const files: FarmAppDelta["files"] = {};
    const blobs: FarmCodeBlobs = {};
    for (const [path, head, workdir] of await git.statusMatrix({ fs, dir, ref })) {
      if (head === workdir || !farmCodePath(path)) continue;
      const stat = fs.lstatSync(join(dir, path), { throwIfNoEntry: false });
      if (stat && !stat.isFile()) continue;
      const base =
        head === 0 ? null : (await git.readBlob({ fs, dir, oid: baseCommit, filepath: path })).blob;
      const content = workdir === 0 ? null : fs.readFileSync(join(dir, path));
      if ([base, content].some((raw) => raw && farmCodeSecret(Buffer.from(raw).toString("utf8"))))
        continue;
      const hashes = [base, content].map((raw) => {
        if (raw === null) return null;
        const hash = codeHash(raw);
        blobs[hash] = Buffer.from(raw).toString("base64");
        return hash;
      });
      files[path] = { base: hashes[0] ?? null, content: hashes[1] ?? null };
    }
    return { delta: Object.keys(files).length ? { baseCommit, files } : null, blobs };
  }

  /** Creates a commit object from the two partial trees; does not check out the sender's base. */
  private async deltaCommit(delta: FarmAppDelta, blobs: FarmCodeBlobs): Promise<string> {
    const dir = this.ui.checkoutDir;
    const tree = async (side: "base" | "content", prefix = ""): Promise<string> => {
      const entries: git.TreeEntry[] = [];
      const folders = new Set<string>();
      for (const [path, file] of Object.entries(delta.files).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (!path.startsWith(prefix) || file[side] === null) continue;
        const rel = path.slice(prefix.length);
        const slash = rel.indexOf("/");
        if (slash >= 0) {
          folders.add(rel.slice(0, slash));
          continue;
        }
        const hash = file[side];
        if (!hash || blobs[hash] === undefined)
          throw new Error(`Missing app delta blob for ${path}`);
        const oid = await git.writeBlob({
          fs,
          dir,
          blob: Buffer.from(blobs[hash] ?? "", "base64"),
        });
        entries.push({ mode: "100644", path: rel, oid, type: "blob" });
      }
      for (const folder of folders)
        entries.push({
          mode: "040000",
          path: folder,
          oid: await tree(side, `${prefix}${folder}/`),
          type: "tree",
        });
      return git.writeTree({ fs, dir, tree: entries });
    };
    const parent = await git.writeCommit({
      fs,
      dir,
      commit: {
        tree: await tree("base"),
        parent: [],
        author,
        committer: author,
        message: `Recovery base versions from ${delta.baseCommit}\n`,
      },
    });
    return git.writeCommit({
      fs,
      dir,
      commit: {
        tree: await tree("content"),
        parent: [parent],
        author,
        committer: author,
        message: "Farm app changes received from another Orbit\n",
      },
    });
  }

  async receive(received: FarmAppDelta | null, blobs: FarmCodeBlobs): Promise<void> {
    const delta = received ?? { baseCommit: "0".repeat(40), files: {} };
    const recovery = join(
      this.dataDir,
      "farm-code",
      "app",
      codeHash(Buffer.from(JSON.stringify(delta))),
    );
    fs.mkdirSync(recovery, { recursive: true });
    fs.writeFileSync(join(recovery, "delta.json"), JSON.stringify({ delta, blobs }, null, 2));
    this.ui.disable();
    const failed = (reason: string) => this.ui.syncRecovery(reason, recovery);
    const source = await this.ui.source();
    if (!source.ok) {
      failed(source.output);
      return;
    }
    const commit = await this.deltaCommit(delta, blobs);
    const moved = await this.ui.update({ receivedCommit: commit });
    if (!moved.ok) {
      failed(moved.output);
      return;
    }
    const built = await this.ui.build();
    if (!built.ok) {
      const restored = await this.ui.restore(moved.previous);
      failed(`${built.step}: ${built.output}${restored ? `\nRestore: ${restored}` : ""}`);
      return;
    }
    this.ui.syncRecovery(null, null);
  }
}
