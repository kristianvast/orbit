import { expect, test } from "bun:test";
import { startOrion } from "../src/app";
import { connect, removeDir, TOKEN, tempDir, waitFor } from "./helpers";

test.each([
  [402, "plan_required"],
  [429, "budget_exceeded"],
] as const)(
  "Core gateway HTTP %i emits a typed %s chat error",
  async (status, code) => {
    const gateway = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { code, message: code } }, { status }),
    });
    const dir = tempDir();
    const app = await startOrion({
      port: 0,
      token: TOKEN,
      dataDir: dir,
      mockModel: false,
      seed: true,
      gatewayUrl: `http://127.0.0.1:${gateway.port}/v1`,
      appSource: null,
    });
    const client = await connect(app);
    try {
      await client.request("settings.update", {
        provider: "orbit-gateway",
        model: "orbit-default",
        apiKey: { provider: "orbit-gateway", key: "test-session" },
      });
      const { session } = await client.request("sessions.create", {});
      const failure = waitFor(client, "error", (event) => event.sessionId === session.id);
      const settled = waitFor(client, "agent.settled", (event) => event.sessionId === session.id);
      await client.request("chat.prompt", { sessionId: session.id, text: "How is the herd?" });
      expect(await failure).toMatchObject({ sessionId: session.id, code });
      expect(await settled).toMatchObject({ reason: "error" });
    } finally {
      client.close();
      await app.stop();
      gateway.stop(true);
      removeDir(dir);
    }
  },
  15000,
);
