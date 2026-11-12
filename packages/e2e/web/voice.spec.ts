import { expect, type Locator, type Page, test } from "@playwright/test";
import { E2E_ORION_PORT, E2E_TOKEN, SEED } from "../src/index";
import { setComputerAccess } from "./helpers";

const HERD_ANSWER = `There are ${SEED.cattle + SEED.horses} animals in your herd.`;
const HERD_PAGE = `http://127.0.0.1:${E2E_ORION_PORT}/pages/${E2E_TOKEN}/herd/index.html`;
const FAKE_MICROPHONE = {
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
};

async function startCallOnHome(page: Page): Promise<Locator> {
  await page.goto("/");
  const widget = page.getByTestId("home-orion-widget");
  await widget.getByTestId("home-voice-start").click();
  await expect(widget).toHaveAttribute("data-voice-state", "listening");
  return widget;
}

async function startCallInChat(page: Page): Promise<Locator> {
  await page.goto("/chat");
  await page.getByTestId("session-new-button").click();
  await page.getByTestId("chat-voice-button").click();
  const stage = page.getByTestId("voice-stage");
  await expect(stage).toHaveAttribute("data-voice-state", "listening");
  return stage;
}

async function say(surface: Locator, text: string): Promise<void> {
  const input = surface.getByTestId("voice-text-input");
  await input.fill(text);
  await input.press("Enter");
}

async function sayInChat(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId("chat-composer-input");
  await composer.fill(text);
  await composer.press("Enter");
}

test.use(FAKE_MICROPHONE);

test("a call starts from the Home widget and answers in plain words", async ({ page }) => {
  const widget = await startCallOnHome(page);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(widget.getByTestId("voice-orb")).toBeVisible();

  await say(widget, "Who is in my herd?");
  await expect(widget).toContainText(HERD_ANSWER);
  await expect(
    widget.locator('[data-testid="activity-row"][data-status="done"]').first(),
  ).toBeVisible();
  await expect(widget).not.toContainText("db_query");
  await expect(widget).not.toContainText("animals.list");

  await widget.getByTestId("voice-end").click();
  await expect(widget).toHaveAttribute("data-voice-state", /^(ended|idle)$/);
});

test("a spoken conversation is kept in chat and continues there", async ({ page }) => {
  const stage = await startCallInChat(page);
  await expect(page.locator('[data-voice="on"]')).toBeVisible();

  await sayInChat(page, "Who is in my herd?");
  const transcript = page.getByTestId("chat-transcript");
  await expect(transcript).toContainText("Who is in my herd?");
  await expect(transcript).toContainText(HERD_ANSWER);
  await expect(transcript.getByText(HERD_ANSWER)).toHaveCount(1);
  await stage.getByTestId("voice-end").click();
  await expect(page.locator('[data-voice="on"]')).toHaveCount(0);

  await page.getByTestId("chat-composer-input").fill("hello after the call");
  await page.getByTestId("chat-send-button").click();
  await expect(transcript).toContainText('You said: "hello after the call"');

  await page.reload();
  await expect(transcript).toContainText("Who is in my herd?");
  await expect(transcript).toContainText(HERD_ANSWER);
  await expect(transcript).toContainText('You said: "hello after the call"');
});

test("Orion points at Settings, opens it, and the call follows to that page", async ({ page }) => {
  const widget = await startCallOnHome(page);

  await say(widget, "where are the settings?");
  await expect(page.getByTestId("guide-highlight")).toBeVisible();
  await expect(page.getByTestId("guide-note")).toContainText("Settings are here.");

  await say(widget, "open settings");
  await expect(page).toHaveURL(/\/settings$/);
  const dock = page.getByTestId("voice-dock");
  await expect(dock).toBeVisible();
  await expect(dock).not.toHaveAttribute("data-voice-state", /^(ended|idle)$/);
  await dock.getByTestId("voice-end").click();
});

test("Orion shows the page it opened in its browser and marks where to start", async ({ page }) => {
  await setComputerAccess(page, false);
  const stage = await startCallInChat(page);

  await sayInChat(page, `open ${HERD_PAGE}`);
  await expect(page.getByTestId("access-dialog")).toHaveAttribute("data-tool", "browser");
  await page.getByTestId("access-allow").click();
  await expect(page.getByTestId("browser-view")).toBeVisible();
  await expect(page.getByTestId("browser-view-frame")).toBeVisible();
  await expect(page.getByTestId("browser-highlight")).toBeVisible();
  await expect(page.getByTestId("chat-transcript")).toContainText(
    "I opened the page and marked where to start.",
  );
  await stage.getByTestId("voice-end").click();
});

test("a bigger job is handed over and Orion reports back when it is ready", async ({ page }) => {
  const stage = await startCallInChat(page);

  await sayInChat(page, "build me a calving overview");
  const transcript = page.getByTestId("chat-transcript");
  await expect(transcript).toContainText("I have started on that.");
  await expect(transcript).toContainText("Good news.");
  await expect(stage.locator('[data-testid="activity-row"][data-status="running"]')).toHaveCount(0);
  await stage.getByTestId("voice-end").click();
});
