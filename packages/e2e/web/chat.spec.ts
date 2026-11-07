import { expect, test } from "@playwright/test";
import { activeSession, assistantMessages, startChat, toolCard } from "./helpers";

test("list cows streams an answer with a completed herd_query tool card", async ({ page }) => {
  await startChat(page, "list cows");
  const card = toolCard(page, "herd_query");
  await expect(card).toHaveAttribute("data-tool-status", "done");
  await expect(assistantMessages(page).last()).toContainText("Here is what I found:");
  await expect(page.getByTestId("chat-send-button")).toBeVisible();
});

test("find cameras runs camera_discover without an approval prompt", async ({ page }) => {
  await startChat(page, "find cameras on my network");
  await expect(toolCard(page, "camera_discover")).toHaveAttribute("data-tool-status", "done");
  await expect(assistantMessages(page).last()).toContainText("No ONVIF cameras answered");
});

test("a new session appears in the sidebar and survives a reload", async ({ page }) => {
  await startChat(page, "hello from the e2e suite");
  await expect(assistantMessages(page).last()).toContainText(
    'You said: "hello from the e2e suite"',
  );
  const testId = await activeSession(page).getAttribute("data-testid");
  expect(testId).toMatch(/^session-item-/);
  await page.reload();
  await expect(page.getByTestId(testId as string)).toBeVisible();
});
