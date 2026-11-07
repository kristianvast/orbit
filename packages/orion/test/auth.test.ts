import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import type { OrionClient } from "@orbit/protocol/client";
import type { OrionApp } from "../src/app";
import { connect, record, removeDir, startApp, tempDir, waitFor } from "./helpers";

process.env.ORION_NO_BROWSER = "1";

const FAKE = "test-sub";

function storedCredentials(dataDir: string): Record<string, Record<string, unknown>> {
  const file = join(dataDir, "pi", "auth.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function registerFakeSubscription(app: OrionApp) {
  const mock = app.hub.runtime.getProvider("orion-mock");
  if (!mock) throw new Error("the mock provider is not registered");
  const base = app.hub.runtime.getModels("orion-mock")[0] as Model<never>;
  const model = { ...base, provider: FAKE, id: "test-model", name: "Test model" };
  const provider: Provider = {
    id: FAKE,
    name: "Test Subscription",
    auth: {
      oauth: {
        name: "Test (subscription)",
        isSubscription: true,
        async login(io) {
          io.notify({
            type: "auth_url",
            url: "https://example.test/authorize",
            instructions: "Sign in",
          });
          io.notify({
            type: "device_code",
            userCode: "ABCD-1234",
            verificationUri: "https://example.test/device",
          });
          const plan = await io.prompt({
            type: "select",
            message: "Pick a plan",
            options: [
              { id: "pro", label: "Pro" },
              { id: "max", label: "Max" },
            ],
          });
          const code = await io.prompt({ type: "secret", message: "Paste the code" });
          return {
            type: "oauth",
            access: `access-${plan}-${code}`,
            refresh: "refresh-token",
            expires: Date.now() + 3_600_000,
          };
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    getModels: () => [model],
    stream: (m, context, options) => mock.stream(m, context, options),
    streamSimple: (m, context, options) => mock.streamSimple(m, context, options),
  };
  app.hub.runtime.registerNativeProvider(provider);
}

describe("provider sign-in (Pi /login over the protocol)", () => {
  let dataDir: string;
  let app: OrionApp;
  let client: OrionClient;

  beforeEach(async () => {
    dataDir = tempDir();
    app = await startApp(dataDir, false);
    registerFakeSubscription(app);
    client = await connect(app);
  });

  afterEach(async () => {
    client.close();
    await app.stop();
    removeDir(dataDir);
  });

  it("lists subscriptions and API-key providers without the internal mock provider", async () => {
    const { providers } = await client.request("auth.providers");
    const ids = providers.map((p) => p.id);
    expect(ids).toContain(FAKE);
    expect(ids).toContain("anthropic");
    expect(ids).not.toContain("orion-mock");
    const fake = providers.find((p) => p.id === FAKE);
    expect(fake?.oauth).toEqual({ name: "Test (subscription)", subscription: true });
    expect(fake?.status).toEqual({ configured: false, method: null, source: null });
    expect(providers.find((p) => p.id === "anthropic")?.oauth?.subscription).toBe(true);
  });

  it("relays links, device codes and prompts, stores the credential, and logs out", async () => {
    const events = record(client);
    const selectPrompt = waitFor(client, "auth.prompt", (e) => e.prompt.type === "select");
    const { loginId } = await client.request("auth.login", { providerId: FAKE, method: "oauth" });

    const select = await selectPrompt;
    expect(select.loginId).toBe(loginId);
    expect(select.prompt.options?.map((o) => o.id)).toEqual(["pro", "max"]);
    const secretPrompt = waitFor(client, "auth.prompt", (e) => e.prompt.type === "secret");
    await client.request("auth.respond", { loginId, promptId: select.promptId, value: "max" });

    const secret = await secretPrompt;
    const finished = waitFor(client, "auth.finished", (e) => e.loginId === loginId);
    await client.request("auth.respond", { loginId, promptId: secret.promptId, value: "1234" });
    expect(await finished).toMatchObject({ loginId, providerId: FAKE, ok: true, cancelled: false });

    const notices = events.filter((e) => e.type === "auth.notice").map((e) => e.notice);
    expect(notices).toEqual([
      {
        type: "auth_url",
        url: "https://example.test/authorize",
        instructions: "Sign in",
        opened: false,
      },
      {
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://example.test/device",
      },
    ]);
    expect(storedCredentials(dataDir)[FAKE]).toMatchObject({
      type: "oauth",
      access: "access-max-1234",
    });
    expect(JSON.stringify(events)).not.toContain("access-max-1234");

    const { providers } = await client.request("auth.providers");
    expect(providers.find((p) => p.id === FAKE)?.status).toMatchObject({
      configured: true,
      method: "oauth",
    });
    const settings = await client.request("settings.get");
    expect(settings.availableModels.map((m) => `${m.provider}/${m.id}`)).toContain(
      `${FAKE}/test-model`,
    );

    const after = await client.request("auth.logout", { providerId: FAKE });
    expect(after.providers.find((p) => p.id === FAKE)?.status.configured).toBe(false);
    expect(storedCredentials(dataDir)[FAKE]).toBeUndefined();
  });

  it("cancelling a sign-in mid-prompt stores nothing and reports cancelled", async () => {
    const selectPrompt = waitFor(client, "auth.prompt", (e) => e.prompt.type === "select");
    const { loginId } = await client.request("auth.login", { providerId: FAKE, method: "oauth" });
    await selectPrompt;

    const finished = waitFor(client, "auth.finished", (e) => e.loginId === loginId);
    expect(await client.request("auth.cancel", { loginId })).toEqual({ accepted: true });
    expect(await finished).toMatchObject({ loginId, providerId: FAKE, ok: false, cancelled: true });
    expect(storedCredentials(dataDir)[FAKE]).toBeUndefined();
  });

  it("saves a built-in provider's API key through its own login prompt without echoing it", async () => {
    const events = record(client);
    const keyPrompt = waitFor(client, "auth.prompt");
    const { loginId } = await client.request("auth.login", {
      providerId: "groq",
      method: "api_key",
    });
    const prompt = await keyPrompt;
    expect(prompt.prompt.type).toBe("secret");

    const finished = waitFor(client, "auth.finished", (e) => e.loginId === loginId);
    await client.request("auth.respond", {
      loginId,
      promptId: prompt.promptId,
      value: "gsk_test_secret_value",
    });
    expect((await finished).ok).toBe(true);
    expect(storedCredentials(dataDir).groq).toEqual({
      type: "api_key",
      key: "gsk_test_secret_value",
    });
    expect(JSON.stringify(events)).not.toContain("gsk_test_secret_value");
    const { providers } = await client.request("auth.providers");
    expect(providers.find((p) => p.id === "groq")?.status).toMatchObject({
      configured: true,
      method: "api_key",
    });
  });

  it("rejects unknown providers and methods a provider does not offer", async () => {
    await expect(
      client.request("auth.login", { providerId: "nope", method: "oauth" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      client.request("auth.login", { providerId: "groq", method: "oauth" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      client.request("auth.login", { providerId: "orion-mock", method: "api_key" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
