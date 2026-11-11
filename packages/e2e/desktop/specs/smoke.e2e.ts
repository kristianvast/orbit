import { $, browser } from "@wdio/globals";

// Fresh install = minimal Orbit: Home, Chat, Settings. Herd, Devices and Cameras are
// modules that stay hidden until Orion, the farmer or their first data enables them.
const MINIMAL_NAV = ["/", "/chat", "/settings"];
const MODULE_ROUTES = ["/herd", "/devices", "/cameras"];

/** Built-in nav routes in rail order; custom pages ("Your pages") are excluded. */
async function builtInNavRoutes(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'nav a.orbit-nav-link:not([data-testid^="nav-custom-page-"])',
      ),
    ).map((a) => a.getAttribute("href") ?? ""),
  );
}

/** The connection banner's text: on a dead sidecar it carries the shell's reason and Orion's stderr. */
async function connectionBanner(): Promise<string> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[role="status"]'))
      .map((el) => el.textContent ?? "")
      .join(" | "),
  );
}

async function waitWithBanner(condition: () => Promise<boolean>, timeout: number, what: string) {
  try {
    await browser.waitUntil(condition, { timeout });
  } catch {
    throw new Error(`${what}; connection banner: ${(await connectionBanner()) || "(none)"}`);
  }
}

async function expectMinimalNav(timeout: number) {
  let seen: string[] = [];
  await browser.waitUntil(
    async () => {
      seen = await builtInNavRoutes();
      return seen.join(" ") === MINIMAL_NAV.join(" ");
    },
    { timeout, timeoutMsg: `expected nav ${MINIMAL_NAV.join(", ")}, saw ${seen.join(", ")}` },
  );
  for (const route of MODULE_ROUTES) {
    if (seen.includes(route)) throw new Error(`module route ${route} shown on a fresh install`);
  }
}

describe("Orbit desktop smoke", () => {
  it("opens minimal on a fresh data dir: Home, Chat, Settings only", async () => {
    // First launch spawns the sidecar and migrates an empty SQLite database. The minimal nav also
    // shows while modules are loading, so first require a live Orion connection.
    await waitWithBanner(
      async () => (await $(".orbit-status-dot--ok").isExisting()) === true,
      60_000,
      "Orion never connected",
    );
    await expectMinimalNav(10_000);
  });

  it("opens Chat and gets a mock reply", async () => {
    await $('nav a.orbit-nav-link[href="/chat"]').click();
    await $('[data-testid="sessions-sidebar"]').waitForDisplayed();
    await $('[data-testid="session-new-button"]').click();
    await $('[data-testid="chat-empty-state"]').waitForDisplayed();
    await $('[data-testid="chat-composer-input"]').setValue("hello from the desktop smoke");
    await $('[data-testid="chat-send-button"]').click();

    const expected = 'You said: "hello from the desktop smoke"';
    await waitWithBanner(
      async () => {
        const replies = await $$('[data-testid^="message-assistant-"]').getElements();
        const last = replies.at(-1);
        return last ? (await last.getText()).includes(expected) : false;
      },
      60_000,
      `no assistant reply containing ${expected}`,
    );
  });

  it("stays minimal after talking to Orion (no module enabled without data)", async () => {
    await expectMinimalNav(5_000);
  });
});
