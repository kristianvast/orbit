import { afterEach, expect, test } from "bun:test";
import { GATEWAY_PROVIDER } from "../src/agent/hub";
import { GATEWAY_TITLE_MODEL, pickTitleModel } from "../src/agent/title";
import { startOrion } from "../src/app";
import { connect, removeDir, TOKEN, tempDir } from "./helpers";

const model = (id: string, cost: number, input = ["text"]) => ({
  id,
  input,
  cost: { input: cost },
});

test("a title is asked of the provider's cheapest paid text model, never a dearer one", () => {
  const big = model("big", 2);
  const all = [big, model("free-tier", 0), model("small", 0.1), model("mid", 0.5)];
  expect(pickTitleModel(big, all).id).toBe("small");
  expect(pickTitleModel(model("small", 0.1), all).id).toBe("small");
  expect(pickTitleModel(big, [big, model("pictures-only", 0.01, ["image"])]).id).toBe("big");
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

test("the subscription's small model exists for titles but is not offered as a model to chat with", async () => {
  const dataDir = tempDir();
  const app = await startOrion({
    port: 0,
    token: TOKEN,
    dataDir,
    mockModel: true,
    seed: false,
    gatewayUrl: "http://127.0.0.1:9/v1",
    appSource: null,
  });
  const client = await connect(app);
  cleanups.push(() => removeDir(dataDir));
  cleanups.push(async () => {
    client.close();
    await app.stop();
  });
  expect(app.hub.runtime.getModel(GATEWAY_PROVIDER, GATEWAY_TITLE_MODEL)?.id).toBe(
    GATEWAY_TITLE_MODEL,
  );
  const { availableModels } = await client.request("settings.get", {});
  const offered = availableModels.filter((m) => m.provider === GATEWAY_PROVIDER).map((m) => m.id);
  expect(offered).toEqual(["orbit-default"]);
});
