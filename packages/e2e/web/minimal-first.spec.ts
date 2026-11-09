import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { assistantMessages, startChat, toolCard } from "./helpers";

// Runs in the "fresh" project: an unseeded Orion with an empty data dir (see playwright.config.ts).
const PROOF_DIR = resolve(import.meta.dirname, "../../../.omo/proof/minimal-first");

async function proof(page: Page, name: string): Promise<void> {
  mkdirSync(PROOF_DIR, { recursive: true });
  await page.screenshot({ path: join(PROOF_DIR, name), fullPage: true });
}

function navLinks(page: Page) {
  return page.locator(".orbit-nav-list").getByRole("link");
}

test.use({ viewport: { width: 1280, height: 820 } });

test("Orbit starts minimal and Orion adds the herd module", async ({ page }) => {
  // (a) Fresh install: Home, Chat and Settings only, with the Orion-first Home.
  await page.goto("/");
  await expect(page.getByTestId("home-minimal")).toBeVisible();
  await expect(page.getByTestId("home-ask-input")).toBeVisible();
  await expect(navLinks(page)).toHaveCount(3);
  await expect(page.getByTestId("nav-home")).toBeVisible();
  await expect(page.getByTestId("nav-chat")).toBeVisible();
  await expect(page.getByTestId("nav-settings")).toBeVisible();
  await expect(page.locator('[data-testid^="nav-module-"]')).toHaveCount(0);
  await proof(page, "01-fresh-minimal.png");

  // (b) Herd is not added yet.
  await page.goto("/herd");
  const herdOff = page.getByTestId("module-disabled-herd");
  await expect(herdOff).toBeVisible();
  await expect(herdOff).toContainText("Cows & Horses is not added yet");
  await expect(page.getByTestId("herd-page")).toHaveCount(0);
  await proof(page, "02-herd-not-added.png");

  // (c) Ask Orion; the mock model calls orbit_modules { action: "enable", id: "herd" }.
  await startChat(page, "Track my herd please");
  await expect(toolCard(page, "orbit_modules")).toHaveAttribute("data-tool-status", "done");
  await expect(assistantMessages(page).last()).toContainText("Here is what I found:");
  await expect(page.getByTestId("chat-send-button")).toBeVisible();
  await proof(page, "03-orion-adds-herd.png");

  // (d) The nav grew a Herd entry from the modules.updated event, with no reload needed.
  const herdNav = page.getByTestId("nav-module-herd");
  await expect(herdNav).toBeVisible();
  await expect(navLinks(page)).toHaveCount(4);
  await herdNav.click();
  await expect(page.getByTestId("herd-page")).toBeVisible();
  await proof(page, "04-nav-grown.png");

  // (e) The module persists across a reload (Orion saved modules.json).
  await page.reload();
  await expect(page.getByTestId("nav-module-herd")).toBeVisible();
  await expect(page.getByTestId("herd-page")).toBeVisible();
  await expect(page.locator('[data-testid^="nav-module-"]')).toHaveCount(1);

  // (f) Settings shows Herd as added by Orion; Devices and Cameras stay off.
  await page.getByTestId("nav-settings").click();
  const card = page.getByTestId("settings-modules-card");
  await card.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("settings-module-status-herd")).toHaveText("Added by Orion");
  await expect(page.getByTestId("settings-module-status-devices")).toHaveText("Not added");
  await expect(page.getByTestId("settings-module-status-cameras")).toHaveText("Not added");
  await proof(page, "05-settings-modules.png");
});
