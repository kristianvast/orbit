import { expect, type Locator, type Page } from "@playwright/test";

/** Starts a fresh conversation and sends one prompt through the composer. */
export async function startChat(page: Page, prompt: string): Promise<void> {
  await page.goto("/chat");
  await expect(page.getByTestId("sessions-sidebar")).toBeVisible();
  await page.getByTestId("session-new-button").click();
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
  const composer = page.getByTestId("chat-composer-input");
  await composer.fill(prompt);
  await page.getByTestId("chat-send-button").click();
}

/** Sets one of Orion's tool switches in Settings; specs share one Orion, so each sets what it needs. */
export async function setToolAccess(
  page: Page,
  tool: "shell" | "browser" | "computer",
  allowed: boolean,
): Promise<void> {
  await page.goto("/settings/orion");
  const toggle = page.getByTestId(`settings-access-${tool}`);
  await expect(toggle).toBeEnabled();
  // The box is controlled by Orion's answer, so it flips only after the update comes back.
  if ((await toggle.isChecked()) !== allowed) {
    await toggle.click();
    // The first time a tool is turned on, Settings asks the same question Orion would.
    const allow = page.getByTestId("access-allow");
    if (allowed) {
      await expect(
        allow.or(page.locator(`[data-testid="settings-access-${tool}"]:checked`)),
      ).toBeVisible();
      if (await allow.isVisible()) await allow.click();
    }
  }
  await expect(toggle).toBeChecked({ checked: allowed });
}

export function toolCard(page: Page, toolName: string): Locator {
  return page.locator(`[data-testid^="tool-card-"][data-tool-name="${toolName}"]`);
}

export function assistantMessages(page: Page): Locator {
  return page.locator('[data-testid^="message-assistant-"]');
}

export function activeSession(page: Page): Locator {
  return page.locator('[data-testid^="session-item-"][data-active="true"]');
}
