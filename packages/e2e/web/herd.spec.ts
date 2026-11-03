import { expect, type Page, test } from "@playwright/test";
import { SEED } from "../src/index";

async function openHerdTable(page: Page) {
  await page.goto("/herd");
  await expect(page.getByTestId("herd-page")).toBeVisible();
  await page.getByTestId("herd-view-table-btn").click();
  await expect(page.getByTestId("herd-table")).toBeVisible();
}

test("herd table lists the seeded cows", async ({ page }) => {
  await openHerdTable(page);
  const rows = page.locator('[data-testid^="herd-row-"]');
  await expect(rows).toHaveCount(SEED.cattle + SEED.horses);
  await expect(page.getByTestId(`herd-row-${SEED.firstDairyEarTag}`)).toContainText(
    SEED.firstDairyName,
  );
});

test("attach sensor explains the one-wearable rule", async ({ page }) => {
  await openHerdTable(page);
  await page.getByTestId(`herd-inspect-${SEED.firstDairyEarTag}`).click();
  await expect(page.getByTestId("animal-detail-drawer")).toBeVisible();
  await page.getByTestId("animal-drawer-attach-sensor-btn").click();
  const dialog = page.getByTestId("herd-attach-sensor-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("a collar OR a bolus OR an ear tag sensor");
  await page.getByTestId("herd-attach-sensor-cancel").click();
  await expect(dialog).toBeHidden();
});
