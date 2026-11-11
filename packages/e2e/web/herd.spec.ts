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

test("animal drawer shows read-only wearable details without sensor attach actions", async ({
  page,
}) => {
  await openHerdTable(page);
  await page.getByTestId(`herd-inspect-${SEED.firstDairyEarTag}`).click();
  await expect(page.getByTestId("animal-detail-drawer")).toBeVisible();
  await expect(page.getByTestId("animal-drawer-wearable-card")).toBeVisible();
  await expect(page.getByTestId("animal-drawer-attach-sensor-btn")).toHaveCount(0);
  await expect(page.getByTestId("animal-drawer-unbind-sensor-btn")).toHaveCount(0);
});
