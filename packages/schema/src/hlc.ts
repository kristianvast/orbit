// Hybrid logical clock. Timestamps are strings that sort lexicographically in causal order:
//   <wall ms, 15 digits>:<counter, 6 digits>:<node id>
// e.g. "001762171200000:000003:install-7f3a". Last-writer-wins compares rows with compare().

export type HlcTimestamp = string;

export interface ParsedHlc {
  wallMs: number;
  counter: number;
  node: string;
}

export interface HlcOptions {
  /** Wall-clock source (ms since epoch). Defaults to Date.now. */
  now?: () => number;
  /** Remote timestamps further than this ahead of the local wall clock are rejected. Default 60 000. */
  maxDriftMs?: number;
}

export interface Hlc {
  readonly node: string;
  /** Timestamp for a local event (a local write). */
  tick(): HlcTimestamp;
  /** Merge a timestamp observed from another node; returns the new local timestamp. */
  receive(remote: HlcTimestamp): HlcTimestamp;
  /** Last timestamp issued, without advancing. */
  peek(): HlcTimestamp;
}

export class HlcError extends Error {
  override name = "HlcError";
}

const MAX_COUNTER = 999_999;

export function formatHlc({ wallMs, counter, node }: ParsedHlc): HlcTimestamp {
  return `${String(wallMs).padStart(15, "0")}:${String(counter).padStart(6, "0")}:${node}`;
}

export function parseHlc(ts: HlcTimestamp): ParsedHlc {
  const match = /^(\d{15}):(\d{6}):(.+)$/.exec(ts);
  if (!match) throw new HlcError(`invalid HLC timestamp: ${ts}`);
  return { wallMs: Number(match[1]), counter: Number(match[2]), node: match[3] as string };
}

/** Total order over HLC timestamps: -1 if a < b, 0 if equal, 1 if a > b. */
export function compare(a: HlcTimestamp, b: HlcTimestamp): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createHlc(node: string, options: HlcOptions = {}): Hlc {
  if (!node || node.includes(":")) throw new HlcError("HLC node id must be non-empty without ':'");
  const now = options.now ?? Date.now;
  const maxDriftMs = options.maxDriftMs ?? 60_000;
  let wallMs = 0;
  let counter = 0;

  const issue = (nextWall: number, nextCounter: number): HlcTimestamp => {
    if (nextCounter > MAX_COUNTER) throw new HlcError("HLC counter overflow");
    wallMs = nextWall;
    counter = nextCounter;
    return formatHlc({ wallMs, counter, node });
  };

  return {
    node,
    tick() {
      const physical = now();
      return physical > wallMs ? issue(physical, 0) : issue(wallMs, counter + 1);
    },
    receive(remote) {
      const r = parseHlc(remote);
      const physical = now();
      if (r.wallMs - physical > maxDriftMs) {
        throw new HlcError(`remote clock drift ${r.wallMs - physical}ms exceeds ${maxDriftMs}ms`);
      }
      const nextWall = Math.max(wallMs, r.wallMs, physical);
      if (nextWall === wallMs && nextWall === r.wallMs) {
        return issue(nextWall, Math.max(counter, r.counter) + 1);
      }
      if (nextWall === wallMs) return issue(nextWall, counter + 1);
      if (nextWall === r.wallMs) return issue(nextWall, r.counter + 1);
      return issue(nextWall, 0);
    },
    peek() {
      return formatHlc({ wallMs, counter, node });
    },
  };
}

/** Functional aliases: tick(clock) / receive(clock, remote). */
export const tick = (clock: Hlc): HlcTimestamp => clock.tick();
export const receive = (clock: Hlc, remote: HlcTimestamp): HlcTimestamp => clock.receive(remote);
