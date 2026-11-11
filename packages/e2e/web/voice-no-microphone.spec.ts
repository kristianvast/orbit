import { expect, test } from "@playwright/test";
import { SEED } from "../src/index";

test("without a microphone, typed questions still get an answer", async ({ page }) => {
  await page.goto("/");
  const widget = page.getByTestId("home-orion-widget");
  await widget.getByTestId("home-voice-start").click();
  await expect(widget).toHaveAttribute("data-voice-state", /^(listening|speaking|working)$/);

  const input = widget.getByTestId("voice-text-input");
  await input.fill("Who is in my herd?");
  await input.press("Enter");
  await expect(widget).toContainText(
    `There are ${SEED.cattle + SEED.horses} animals in your herd.`,
  );
  await widget.getByTestId("voice-end").click();
});
