import { expect, test } from "@playwright/test";
import { startChat, toolCard } from "./helpers";

test("a page Orion builds shows up in the menu and reads farm data", async ({ page }) => {
  await startChat(page, "make a page");
  await expect(toolCard(page, "write")).toHaveAttribute("data-tool-status", "done");

  const link = page.getByTestId("nav-custom-page-herd-count");
  await expect(link).toBeVisible();
  await link.click();

  const frame = page.frameLocator('[data-testid="custom-page-frame"]');
  await expect(frame.getByRole("heading", { name: "Herd count" })).toBeVisible();
  await expect(frame.locator("#count")).toHaveText("24 cattle");
});
