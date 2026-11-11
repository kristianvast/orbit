import { expect, test } from "bun:test";
import { waitFor } from "./helpers";
import { voiceFixture } from "./voice-helpers";

test("voice browser open and highlight emit JPEG views and close clears the image", async () => {
  const f = await voiceFixture();
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        "<!doctype html><title>Voice browser</title><h1>Local page</h1><button>Start here</button>",
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
  });
  try {
    const opened = waitFor(f.client, "browser.view", (event) => event.sessionId === f.sessionId);
    const answer = await f.client.request("voice.tool", {
      voiceId: f.voiceId,
      toolCallId: "open-browser",
      name: "browser",
      args: { action: "open", url: `http://127.0.0.1:${server.port}/` },
    });
    expect(answer.isError).toBe(false);
    expect(answer.result).toContain('[1] button "Start here"');
    const view = await opened;
    expect(view).toMatchObject({
      title: "Voice browser",
      width: 1280,
      height: 900,
      highlight: null,
    });
    expect(Buffer.from(view.image ?? "", "base64").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
    const highlighted = waitFor(f.client, "browser.view", (event) => event.highlight !== null);
    expect(
      (
        await f.client.request("voice.tool", {
          voiceId: f.voiceId,
          toolCallId: "highlight-browser",
          name: "browser",
          args: { action: "highlight", ref: 1, note: "Start here." },
        })
      ).isError,
    ).toBe(false);
    const highlight = (await highlighted).highlight;
    expect(highlight).toMatchObject({
      note: "Start here.",
      x: expect.any(Number),
      y: expect.any(Number),
    });
    expect(highlight?.width).toBeGreaterThan(0);
    expect(highlight?.height).toBeGreaterThan(0);
    const closed = waitFor(f.client, "browser.view", (event) => event.image === null);
    await f.client.request("voice.tool", {
      voiceId: f.voiceId,
      toolCallId: "close-browser",
      name: "browser",
      args: { action: "close" },
    });
    expect(await closed).toMatchObject({ image: null, highlight: null });
  } finally {
    server.stop(true);
  }
}, 60000);
