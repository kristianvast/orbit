import { expect, test } from "@playwright/test";

test("cameras page renders the barn map, filters by location, and adds a camera", async ({
  page,
}) => {
  await page.goto("/cameras");
  await expect(page.getByTestId("cameras-page")).toBeVisible();
  await expect(page.getByTestId("camera-barn-map")).toBeVisible();
  await expect(page.getByTestId("camera-barn-selector")).toBeVisible();

  await expect(page.getByTestId("camera-barn-option-Milking parlour")).toBeVisible();
  await expect(page.getByTestId("camera-barn-option-Calving pen")).toBeVisible();
  await expect(page.getByTestId("camera-barn-option-Horse stable")).toBeVisible();

  await page.getByTestId("camera-barn-option-Calving pen").click();
  await expect(page.getByTestId("camera-barn-map")).toContainText("Calving pen");

  await page.getByTestId("cameras-add-btn").click();
  await expect(page.getByTestId("camera-form-dialog")).toBeVisible();
  await page.getByTestId("camera-form-name").fill("Maternity stall 2");
  await page.getByTestId("camera-form-location").fill("Maternity barn");
  await page.getByTestId("camera-form-rtsp").fill("rtsp://192.168.1.40:554/stream1");
  await page.getByTestId("camera-form-submit").click();

  await expect(page.getByTestId("camera-barn-option-Maternity barn")).toBeVisible();
  await expect(page.getByTestId("camera-barn-map")).toContainText("Maternity stall 2");
});
