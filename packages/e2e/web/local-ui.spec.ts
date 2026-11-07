import { expect, test } from "@playwright/test";
import { E2E_ORION_PORT, E2E_TOKEN, E2E_VITE_PORT, SEED } from "../src/index";
import { startChat, toolCard } from "./helpers";

const LOCAL_BASE = `http://127.0.0.1:${E2E_ORION_PORT}/app/${E2E_TOKEN}/`;
const SHIPPED_ORIGIN = `http://127.0.0.1:${E2E_VITE_PORT}`;
const herdCounts = `${SEED.cattle} cattle · ${SEED.horses} horses`;

test("Orion builds your own Orbit, the app opens it, safe mode skips it, and you can switch back", async ({
  page,
}) => {
  // local_ui_build runs the real typecheck and vite build of apps/orbit.
  test.setTimeout(300_000);
  await startChat(page, "build my orbit");
  await expect(toolCard(page, "local_ui_build")).toHaveAttribute("data-tool-status", "done", {
    timeout: 240_000,
  });

  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`^${LOCAL_BASE}`));
  await expect(page.getByTestId("home-herd-counts")).toHaveText(herdCounts);
  await page.screenshot({ path: test.info().outputPath("local-ui-home.png") });

  await page.goto(`${SHIPPED_ORIGIN}/?safe`);
  await expect(page.getByTestId("home-herd-counts")).toHaveText(herdCounts);
  await expect(page).toHaveURL(`${SHIPPED_ORIGIN}/?safe`);

  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`^${LOCAL_BASE}`));
  await page.goto(`${LOCAL_BASE}settings`);
  await expect(page.getByTestId("local-ui-badge")).toBeVisible();
  await page.getByTestId("local-ui-use-original").click();
  await expect(page).toHaveURL(`${SHIPPED_ORIGIN}/`);
  await expect(page.getByTestId("home-herd-counts")).toHaveText(herdCounts);

  await page.goto("/settings");
  await expect(page.getByTestId("local-ui-badge")).toHaveText("Original");
  await expect(page).toHaveURL(`${SHIPPED_ORIGIN}/settings`);
});
