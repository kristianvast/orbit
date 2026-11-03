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

export function toolCard(page: Page, toolName: string): Locator {
  return page.locator(`[data-testid^="tool-card-"][data-tool-name="${toolName}"]`);
}

export function assistantMessages(page: Page): Locator {
  return page.locator('[data-testid^="message-assistant-"]');
}

export function activeSession(page: Page): Locator {
  return page.locator('[data-testid^="session-item-"][data-active="true"]');
}
