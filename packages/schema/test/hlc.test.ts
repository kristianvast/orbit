import { describe, expect, test } from "bun:test";
import { compare, createHlc, HlcError, parseHlc, receive, tick } from "../src/hlc";

describe("hlc", () => {
  test("ticks are strictly increasing even when the wall clock stalls or goes back", () => {
    let wall = 1_000;
    const clock = createHlc("a", { now: () => wall });
    const t1 = clock.tick();
    const t2 = clock.tick();
    wall = 500;
    const t3 = tick(clock);
    wall = 2_000;
    const t4 = clock.tick();
    expect([t1, t2, t3, t4]).toEqual([...[t1, t2, t3, t4]].sort());
    expect(compare(t1, t2)).toBe(-1);
    expect(compare(t3, t2)).toBe(1);
    expect(compare(t4, t4)).toBe(0);
    expect(parseHlc(t3)).toEqual({ wallMs: 1_000, counter: 2, node: "a" });
    expect(parseHlc(t4)).toEqual({ wallMs: 2_000, counter: 0, node: "a" });
  });

  test("receive moves past a remote timestamp from the future", () => {
    const a = createHlc("a", { now: () => 1_000 });
    const b = createHlc("b", { now: () => 5_000 });
    const remote = b.tick();
    const merged = receive(a, remote);
    expect(compare(merged, remote)).toBe(1);
    expect(compare(a.tick(), merged)).toBe(1);
    expect(parseHlc(merged).wallMs).toBe(5_000);
  });

  test("receive with equal wall time takes max counter + 1", () => {
    const a = createHlc("a", { now: () => 1_000 });
    a.tick();
    const merged = a.receive("000000000001000:000007:b");
    expect(parseHlc(merged)).toEqual({ wallMs: 1_000, counter: 8, node: "a" });
  });

  test("concurrent writes from two nodes have a deterministic total order", () => {
    const x = createHlc("node-x", { now: () => 1_000 }).tick();
    const y = createHlc("node-y", { now: () => 1_000 }).tick();
    expect(compare(x, y)).toBe(-1);
    expect(compare(y, x)).toBe(1);
  });

  test("rejects excessive drift and malformed input", () => {
    const a = createHlc("a", { now: () => 0, maxDriftMs: 10 });
    expect(() => a.receive("000000000000100:000000:b")).toThrow(HlcError);
    expect(() => parseHlc("nope")).toThrow(HlcError);
    expect(() => createHlc("bad:id")).toThrow(HlcError);
  });
});
