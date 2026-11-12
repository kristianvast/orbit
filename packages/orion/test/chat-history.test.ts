import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cloudEntries, mergeEntries } from "../src/agent/chat-history";
import { voiceMessage } from "../src/agent/voice-history";

test("cloud history omits credential reads and known secrets without altering local history", () => {
  const sm = SessionManager.inMemory("/farm");
  const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
  sm.appendMessage({ role: "user", content: `Use ${key}`, timestamp: 1 });
  const assistant = voiceMessage("assistant", "");
  if (assistant.role !== "assistant") throw new TypeError("assistant fixture required");
  sm.appendMessage({
    ...assistant,
    content: [
      {
        type: "toolCall",
        id: "read-auth",
        name: "read",
        arguments: { path: "/private/pi/auth.json" },
      },
    ],
    stopReason: "toolUse",
  });
  sm.appendMessage({
    role: "toolResult",
    toolCallId: "read-auth",
    toolName: "read",
    content: [{ type: "text", text: "opaque credential file contents" }],
    details: { raw: "opaque credential file contents" },
    isError: false,
    timestamp: 2,
  });
  sm.appendMessage({ role: "user", content: "Keep my farm question", timestamp: 3 });
  sm.appendCustomEntry("tool-details", { token: "opaque-token-value", tokens: 1234 });
  const local = sm.getEntries();
  const cloud = cloudEntries(local);
  expect(cloud.map((e) => e.id)).toEqual(local.map((e) => e.id));
  const uploaded = JSON.stringify(cloud);
  expect(uploaded).not.toContain(key);
  expect(uploaded).not.toContain("opaque credential file contents");
  expect(uploaded).not.toContain("opaque-token-value");
  expect(uploaded).toContain("Keep my farm question");
  expect(cloud.find((e) => e.type === "custom")?.data).toMatchObject({ tokens: 1234 });
  expect(JSON.stringify(sm.getEntries())).toContain(key);
  expect(JSON.stringify(sm.getEntries())).toContain("opaque credential file contents");
});

test("history merge retains concurrent branches exactly once with parents before children", () => {
  const root = { id: "root", parentId: null, type: "message", timestamp: "2026-11-12T12:00:00Z" };
  const a = { id: "a", parentId: "root", type: "message", timestamp: "2026-11-12T12:01:00Z" };
  const b = { id: "b", parentId: "root", type: "message", timestamp: "2026-11-12T12:02:00Z" };
  const child = { id: "child", parentId: "b", type: "message", timestamp: "2026-11-12T12:03:00Z" };
  expect(mergeEntries([root, a], [child, b, root])).toEqual([root, a, b, child]);
  expect(mergeEntries([child, b, root], [a, root])).toEqual([root, a, b, child]);
});
