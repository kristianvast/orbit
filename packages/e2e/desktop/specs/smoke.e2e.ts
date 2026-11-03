import { $, browser, expect } from "@wdio/globals";

const SEEDED_COUNTS = "24 cattle · 4 horses";

describe("Orbit desktop smoke", () => {
  it("shows seeded data from the real Orion sidecar on Home", async () => {
    const counts = await $('[data-testid="home-herd-counts"]');
    // First launch spawns the sidecar, migrates SQLite and seeds the demo farm.
    await counts.waitForDisplayed({ timeout: 60_000 });
    await expect(counts).toHaveText(SEEDED_COUNTS);
  });

  it("opens Ask Orion and gets a mock reply", async () => {
    await $("a*=Ask Orion").click();
    await $('[data-testid="sessions-sidebar"]').waitForDisplayed();
    await $('[data-testid="session-new-button"]').click();
    await $('[data-testid="chat-empty-state"]').waitForDisplayed();
    await $('[data-testid="chat-composer-input"]').setValue("hello from the desktop smoke");
    await $('[data-testid="chat-send-button"]').click();

    const expected = 'You said: "hello from the desktop smoke"';
    await browser.waitUntil(
      async () => {
        const replies = await $$('[data-testid^="message-assistant-"]').getElements();
        const last = replies.at(-1);
        return last ? (await last.getText()).includes(expected) : false;
      },
      { timeout: 60_000, timeoutMsg: `no assistant reply containing ${expected}` },
    );
  });
});
