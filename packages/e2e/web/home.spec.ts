import { expect, test } from "@playwright/test";
import { SEED } from "../src/index";

test("home loads with the seeded herd counts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("home-herd-counts")).toHaveText(
    `${SEED.cattle} cattle · ${SEED.horses} horses`,
  );
  await expect(page.getByTestId("home-sensors-online")).toBeVisible();
  await expect(page.getByTestId("home-cameras-live")).toBeVisible();
  await expect(page.getByTestId("home-alerts")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Orion" }).first()).toBeVisible();
});
