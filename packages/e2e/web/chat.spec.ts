import { expect, test } from "@playwright/test";
import {
  activeSession,
  assistantMessages,
  setComputerAccess,
  startChat,
  toolCard,
} from "./helpers";

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

test("the first shell command asks once, and Allow lets it run from then on", async ({ page }) => {
  await setComputerAccess(page, false);
  await startChat(page, "check git");
  const dialog = page.getByTestId("access-dialog");
  await expect(dialog).toHaveAttribute("data-tool", "shell");
  await page.getByTestId("access-allow").click();
  await expect(dialog).toHaveCount(0);
  await expect(toolCard(page, "bash")).toHaveAttribute("data-tool-status", "done");

  await startChat(page, "check git again");
  await expect(toolCard(page, "bash")).toHaveAttribute("data-tool-status", "done");
  await expect(dialog).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByTestId("settings-computer-access")).toBeChecked();
});

test("Not now keeps the shell closed for that request", async ({ page }) => {
  await setComputerAccess(page, false);
  await startChat(page, "check git");
  await page.getByTestId("access-decline").click();
  await expect(page.getByTestId("access-dialog")).toHaveCount(0);
  await expect(toolCard(page, "bash")).toHaveAttribute("data-tool-status", "error");
  await page.goto("/settings");
  await expect(page.getByTestId("settings-computer-access")).not.toBeChecked();
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
