import { expect, test } from "@playwright/test";

test("approval mode toggles and persists", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  const ask = page.getByTestId("settings-approval-mode-ask");
  const auto = page.getByTestId("settings-approval-mode-auto");
  await expect(ask).toHaveText("Selected");

  await auto.click();
  await expect(auto).toHaveText("Selected");
  await expect(ask).not.toHaveText("Selected");
  await page.reload();
  await expect(auto).toHaveText("Selected");

  // Restore the default so later specs still see approval prompts.
  await ask.click();
  await expect(ask).toHaveText("Selected");
});
