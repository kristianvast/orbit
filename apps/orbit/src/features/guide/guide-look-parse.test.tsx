import { render } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../design";
import { I18nProvider } from "../../i18n";
import { GuideOverlay, parseAppAction, runAppAction } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseAppAction", () => {
  it("accepts the five valid action shapes and rejects malformed inputs", () => {
    expect(parseAppAction({ action: "look" })).toEqual({ action: "look" });
    expect(parseAppAction({ action: "clear" })).toEqual({ action: "clear" });
    expect(parseAppAction({ action: "highlight", ref: 3, note: "Settings are here." })).toEqual({
      action: "highlight",
      ref: 3,
      note: "Settings are here.",
    });
    expect(parseAppAction({ action: "click", ref: 1 })).toEqual({ action: "click", ref: 1 });
    expect(parseAppAction({ action: "go", path: "/settings", note: "Audio" })).toEqual({
      action: "go",
      path: "/settings",
      note: "Audio",
    });

    expect(parseAppAction(null)).toBeNull();
    expect(parseAppAction("look")).toBeNull();
    expect(parseAppAction({ action: "unknown" })).toBeNull();
    expect(parseAppAction({ action: "highlight" })).toBeNull();
    expect(parseAppAction({ action: "highlight", ref: 0 })).toBeNull();
    expect(parseAppAction({ action: "click", ref: 1.5 })).toBeNull();
    expect(parseAppAction({ action: "click", ref: "2" })).toBeNull();
    expect(parseAppAction({ action: "highlight", ref: 2, note: 99 })).toBeNull();
    expect(parseAppAction({ action: "go" })).toBeNull();
    expect(parseAppAction({ action: "go", path: "   " })).toBeNull();
  });
});

describe("runAppAction without a mounted GuideOverlay", () => {
  it("resolves with Not done when no overlay is mounted", async () => {
    const res = await runAppAction({ action: "look" });
    expect(res.isError).toBe(true);
    expect(res.result.startsWith("Not done:")).toBe(true);
  });
});

describe("screen listing (look)", () => {
  it("numbers visible enabled controls, excludes hidden/disabled/voice/guide nodes, marks danger buttons, and never leaks password values", async () => {
    render(
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/barn"]}>
          <GuideOverlay />
          <nav>
            <Link to="/">Home</Link>
            <Link to="/settings">Settings</Link>
          </nav>
          <main>
            <h1>Morning Barn Check</h1>
            <p>North pen water trough is full.</p>
            <label htmlFor="ear-tag">Ear tag</label>
            <input id="ear-tag" defaultValue="DK-1042" />
            <input placeholder="Search herd" />
            <button type="button" title="Refresh sensors" aria-label="Refresh sensors" />
            <label htmlFor="cam-secret">Camera password</label>
            <input id="cam-secret" type="password" defaultValue="super-secret-pw-99" />
            <Button variant="danger">Delete record</Button>
            <button type="button" disabled>
              Disabled action
            </button>
            <button type="button" style={{ display: "none" }}>
              Hidden style button
            </button>
            <button type="button" hidden>
              Hidden attr button
            </button>
          </main>
          <div data-testid="voice-stage">
            <button type="button">Mute mic</button>
          </div>
          <div data-testid="voice-dock">
            <button type="button">End voice</button>
          </div>
          <div data-testid="home-orion-widget">
            <button type="button">Start talking</button>
          </div>
        </MemoryRouter>
      </I18nProvider>,
    );

    const look = await runAppAction({ action: "look" });
    expect(look.isError).toBe(false);
    const lines = look.result.split("\n");
    expect(lines[0]).toBe("Screen: Morning Barn Check (/barn)");
    expect(look.result).toContain("North pen water trough is full.");
    expect(lines).toContain("Things on screen:");

    expect(look.result).toContain('[1] link "Home"');
    expect(look.result).toContain('[2] link "Settings"');
    expect(look.result).toContain('[3] input "Ear tag" = "DK-1042"');
    expect(look.result).toContain('[4] input "Search herd"');
    expect(look.result).toContain('[5] button "Refresh sensors"');
    expect(look.result).toContain('[6] input "Camera password"');
    expect(look.result).toContain('[7] button "Delete record" (ask the farmer to press this one)');

    const itemsSection = look.result.split("Things on screen:")[1] ?? "";
    expect(look.result).not.toContain("super-secret-pw-99");
    expect(itemsSection).not.toContain("Disabled action");
    expect(look.result).not.toContain("Hidden style button");
    expect(look.result).not.toContain("Hidden attr button");
    expect(look.result).not.toContain("Mute mic");
    expect(look.result).not.toContain("End voice");
    expect(look.result).not.toContain("Start talking");
  });

  it("falls back to document.title when no h1 is present and caps main text at 1500 chars", async () => {
    document.title = "Orbit Fallback Title";
    const longText = "A".repeat(1800);
    render(
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/notes"]}>
          <GuideOverlay />
          <main>
            <p>{longText}</p>
          </main>
        </MemoryRouter>
      </I18nProvider>,
    );

    const look = await runAppAction({ action: "look" });
    const lines = look.result.split("\n");
    expect(lines[0]).toBe("Screen: Orbit Fallback Title (/notes)");
    expect(lines[1]?.length).toBe(1500);
  });
});
