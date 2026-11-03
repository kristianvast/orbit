import { describe, expect, test } from "bun:test";
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeError,
  encodeEvent,
  encodeRequest,
  encodeResult,
  parseReadyLine,
  validateResult,
} from "../src/codec";

describe("decodeClientMessage", () => {
  test("accepts valid requests and round-trips encodeRequest", () => {
    const raw = encodeRequest("1", "chat.prompt", { sessionId: "s1", text: "How is Bella?" });
    const decoded = decodeClientMessage(raw);
    expect(decoded).toEqual({
      ok: true,
      value: { id: "1", type: "chat.prompt", sessionId: "s1", text: "How is Bella?" },
    });
  });

  test("validates named db queries and mutations", () => {
    expect(
      decodeClientMessage(
        encodeRequest("2", "db.query", { query: "animals.list", params: { species: "horse" } }),
      ).ok,
    ).toBe(true);
    expect(
      decodeClientMessage(JSON.stringify({ id: "3", type: "db.query", query: "drop.everything" }))
        .ok,
    ).toBe(false);
    expect(
      decodeClientMessage(
        JSON.stringify({
          id: "4",
          type: "db.query",
          query: "animals.list",
          params: { species: "sheep" },
        }),
      ).ok,
    ).toBe(false);
    expect(
      decodeClientMessage(
        encodeRequest("5", "db.mutate", {
          mutation: "bindings.set",
          params: { deviceId: "d", animalId: "a" },
        }),
      ).ok,
    ).toBe(true);
    expect(
      decodeClientMessage(
        JSON.stringify({
          id: "6",
          type: "db.mutate",
          mutation: "animals.upsert",
          params: { animal: { species: "goat" } },
        }),
      ).ok,
    ).toBe(false);
  });

  test("rejects malformed frames with readable errors", () => {
    const cases: [string, RegExp][] = [
      ["not json", /JSON/],
      ["[1]", /object/],
      [JSON.stringify({ id: "1" }), /type/],
      [JSON.stringify({ id: "1", type: "nope" }), /unknown request type/],
      [JSON.stringify({ type: "sessions.list" }), /id/],
      [
        JSON.stringify({ id: "1", type: "approval.respond", approvalId: "a", decision: "maybe" }),
        /approval.respond/,
      ],
      [JSON.stringify({ id: "1", type: "chat.prompt", sessionId: "s", text: "" }), /chat.prompt/],
    ];
    for (const [raw, pattern] of cases) {
      const decoded = decodeClientMessage(raw);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.error).toMatch(pattern);
    }
  });
});

describe("decodeServerMessage", () => {
  test("responses and events", () => {
    expect(decodeServerMessage(encodeResult("1", { sessions: [] })).ok).toBe(true);
    expect(
      decodeServerMessage(encodeError("1", { code: "not_found", message: "no session" })).ok,
    ).toBe(true);
    expect(
      decodeServerMessage(
        JSON.stringify({
          type: "response",
          id: "1",
          ok: false,
          error: { code: "weird", message: "" },
        }),
      ).ok,
    ).toBe(false);
    const ev = encodeEvent("approval.request", {
      sessionId: "s",
      approvalId: "a1",
      toolName: "bash",
      title: "Run a command",
      plainLanguage: "List files in your farm folder",
      command: "ls",
      risk: "ask",
    });
    expect(decodeServerMessage(ev)).toMatchObject({
      ok: true,
      value: { type: "approval.request", risk: "ask" },
    });
    expect(
      decodeServerMessage(encodeEvent("db.changed", { table: "animals", ids: ["a"] })).ok,
    ).toBe(true);
    expect(
      decodeServerMessage(JSON.stringify({ type: "tool.end", sessionId: "s", toolCallId: "t" })).ok,
    ).toBe(false);
    expect(
      decodeServerMessage(JSON.stringify({ type: "message.delta", messageId: "m", text: "hi" })).ok,
    ).toBe(false);
    expect(decodeServerMessage(JSON.stringify({ type: "mystery" })).ok).toBe(false);
  });

  test("validateResult checks per-request result shape", () => {
    expect(validateResult("sessions.list", { sessions: [] }).ok).toBe(true);
    expect(validateResult("sessions.list", { sessions: [{ id: 1 }] }).ok).toBe(false);
    expect(validateResult("db.mutate", { ids: ["x"], snapshotId: null }).ok).toBe(true);
  });
});

test("parseReadyLine", () => {
  expect(parseReadyLine('ORION_READY {"port":53121}')).toEqual({ port: 53121 });
  expect(parseReadyLine("ORION_READY nope")).toBeNull();
  expect(parseReadyLine('ready {"port":1}')).toBeNull();
  expect(parseReadyLine('ORION_READY {"port":"1"}')).toBeNull();
});
