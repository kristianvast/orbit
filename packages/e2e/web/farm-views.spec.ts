import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { SEED } from "../src/index";

// The seeded demo farm gets the catalog's ready-made views (skills/farm-views): a Home card and a
// page each. Other specs share this farm and may add cameras, so camera checks name seeded ones.

function panel(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="custom-page-frame"]');
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("Home shows a card for each ready-made view and a card opens its page", async ({ page }) => {
  await page.goto("/");
  for (const id of ["herd", "calendar", "cameras"]) {
    await expect(page.getByTestId(`home-card-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId("home-card-frame-herd")).toHaveAttribute(
    "src",
    /\/pages\/[^/]+\/herd\/card\.html\?theme=(light|dark)&lang=/,
  );

  const herdCard = page.frameLocator('[data-testid="home-card-frame-herd"]');
  await expect(herdCard.getByTestId("herd-card-total")).toContainText(
    String(SEED.cattle + SEED.horses),
  );
  await expect(herdCard.getByTestId("herd-card-attention")).toContainText("3");
  const calendarCard = page.frameLocator('[data-testid="home-card-frame-calendar"]');
  await expect(calendarCard.getByTestId("calendar-card-next")).toContainText("Ruby");

  await page.getByTestId("home-card-link-herd").click();
  await expect(page).toHaveURL(/\/pages\/herd$/);
  await expect(panel(page).getByTestId("herd-title")).toBeVisible();
});

test("the herd view narrows to what needs a look, finds an animal and opens its panel", async ({
  page,
}) => {
  await page.goto("/pages/herd");
  const herd = panel(page);
  await expect(herd.getByTestId("herd-count")).toContainText(String(SEED.cattle + SEED.horses));

  await herd.getByTestId("herd-filter-attention").click();
  const cards = herd.getByTestId("animal-card");
  await expect(cards).toHaveCount(3);
  const names = await cards.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).dataset.animalName).sort(),
  );
  expect(names).toEqual(["Poppy", "Rosa", "Ruby"]);

  await herd.getByTestId("herd-filter-all").click();
  await herd.getByTestId("herd-search").fill(SEED.firstDairyName.toLowerCase());
  await expect(cards).toHaveCount(1);
  await cards.click();

  await expect(herd.getByTestId("animal-panel-name")).toContainText(SEED.firstDairyName);
  await expect(herd.getByTestId("animal-panel-tag")).toContainText(SEED.firstDairyEarTag);
  await expect(herd.getByTestId("animal-panel-milk")).toContainText(/\d+(\.\d+)?\s*kg/);
  await herd.getByTestId("animal-panel-close").click();
  await expect(herd.getByTestId("animal-panel")).toBeHidden();
});

test("the calendar view works out what is due from the recorded inseminations", async ({
  page,
}) => {
  await page.goto("/pages/calendar");
  const calendar = panel(page);
  const upcoming = calendar.getByTestId("calendar-upcoming");
  const event = (type: string, animal: string) =>
    upcoming.locator(
      `[data-testid="calendar-event"][data-type="${type}"][data-animal-name="${animal}"]`,
    );
  await expect(event("expected-calving", "Ruby")).toBeVisible();
  await expect(event("dry-off-due", "Ivy")).toBeVisible();
  await expect(event("pregnancy-check-due", "Luna")).toBeVisible();
  await expect(event("expected-calving", "Saga")).toContainText(/foaling/i);

  const label = calendar.getByTestId("calendar-month-label");
  const thisMonth = (await label.textContent()) ?? "";
  expect(thisMonth).not.toBe("");
  await calendar.getByTestId("calendar-next").click();
  await expect(label).not.toHaveText(thisMonth);
  await calendar.getByTestId("calendar-today").click();
  await expect(label).toHaveText(thisMonth);
});

test("the camera wall shows a picture for cameras that are online and a status for the rest", async ({
  page,
}) => {
  // The demo cameras have no video behind them; stand in for the relay's still pictures.
  await page.route(/\/camera\/[^/]+\/[^/]+\/frame\.jpeg/, (route) =>
    route.fulfill({ contentType: "image/png", body: ONE_PIXEL_PNG }),
  );
  await page.goto("/pages/cameras");
  const wall = panel(page);
  await expect(wall.getByTestId("cameras-summary")).toContainText(/\d+ of \d+ online/);
  const tile = (name: string) =>
    wall.locator(`[data-testid="camera-view-tile"][data-camera-name="${name}"]`);

  await expect(tile("Calving pen")).toHaveAttribute("data-status", "online");
  await expect(tile("Calving pen")).toHaveAttribute("data-frame", "showing");
  await expect(tile("Stable aisle")).toHaveAttribute("data-status", "offline");
  await expect(tile("Stable aisle")).not.toHaveAttribute("data-frame", "showing");

  await tile("Calving pen").click();
  await expect(wall.getByTestId("camera-view-dialog")).toBeVisible();
  await expect(wall.getByTestId("camera-view-dialog-frame")).toBeVisible();
  await wall.getByTestId("camera-view-dialog-close").click();
  await expect(wall.getByTestId("camera-view-dialog")).toBeHidden();
});
