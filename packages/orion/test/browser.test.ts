import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { BrowserSession } from "../src/agent/browser";
import { tempDir } from "./helpers";

const FORM_PAGE = `<!doctype html><title>Order feed</title>
<h1>Order feed</h1>
<p id="status">Nothing ordered yet.</p>
<button id="more" onclick="document.getElementById('status').textContent='Details shown.'">Show details</button>
<form action="/done" method="get">
  <label for="tons">Tons</label>
  <input id="tons" name="tons" value="1">
  <input type="password" name="pin" value="secret-pin">
  <button type="submit">Send order</button>
</form>
<a href="/done?tons=0">Skip</a>`;

let server: ReturnType<typeof Bun.serve>;
let base: string;
let profile: string;
let session: BrowserSession;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const html =
        url.pathname === "/done"
          ? `<!doctype html><title>Done</title><p>Ordered ${Number(url.searchParams.get("tons"))} tons.</p>`
          : FORM_PAGE;
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  profile = tempDir();
  session = new BrowserSession(profile);
});
afterAll(() => {
  session.close();
  server.stop(true);
  // Edge and Chrome keep the profile folder locked until their process is gone, which on
  // Windows is a moment after it is killed.
  Bun.WebView.closeAll();
  rmSync(profile, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

function shown(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

/** The number the page listing gave an item, e.g. `[3] button "Send order"`. */
function refOf(listing: string, label: string): number {
  const line = listing.split("\n").find((l) => l.includes(`"${label}"`));
  const ref = /^\[(\d+)\]/.exec(line ?? "")?.[1];
  if (!ref) throw new Error(`no item labelled ${label} in:\n${listing}`);
  return Number(ref);
}

describe("browser tool", () => {
  test("opens a page, lists what can be used, and never reads a password back", async () => {
    const page = shown(await session.run({ action: "open", url: `${base}/` }));
    expect(page).toContain("Page: Order feed");
    expect(page).toContain("Nothing ordered yet.");
    expect(page).toContain(`link "Skip" -> ${base}/done?tons=0`);
    expect(page).toContain('text field "Tons" = "1"');
    expect(page).not.toContain("secret-pin");
  }, 30_000);

  test("a click changes the page and the next reading shows it", async () => {
    const before = shown(await session.run({ action: "read" }));
    const after = shown(await session.run({ action: "click", ref: refOf(before, "Show details") }));
    expect(after).toContain("Details shown.");
  }, 30_000);

  test("typing replaces the field's text and submitting follows the form to the next page", async () => {
    const before = shown(await session.run({ action: "read" }));
    const after = shown(
      await session.run({ action: "type", ref: refOf(before, "Tons"), text: "12", submit: true }),
    );
    expect(after).toContain("Page: Done");
    expect(after).toContain("Ordered 12 tons.");
  }, 30_000);

  test("back returns to the form and a screenshot is a real JPEG", async () => {
    expect(shown(await session.run({ action: "back" }))).toContain("Page: Order feed");
    const picture = (await session.run({ action: "screenshot" })).content[1];
    if (picture?.type !== "image") throw new Error("no image in the screenshot result");
    expect(picture.mimeType).toBe("image/jpeg");
    expect(Buffer.from(picture.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 30_000);

  test("refuses addresses that are not web pages", async () => {
    await expect(session.run({ action: "open", url: "file:///etc/passwd" })).rejects.toThrow(
      "Only http and https",
    );
  });
});
