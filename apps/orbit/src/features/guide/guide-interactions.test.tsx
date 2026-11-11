import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../design";
import { I18nProvider } from "../../i18n";
import { GuideOverlay, runAppAction } from "./index";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function PathBadge() {
  const loc = useLocation();
  return <span data-testid="current-path">{loc.pathname}</span>;
}

function ToggleScreen() {
  const [showBtn, setShowBtn] = useState(true);
  return (
    <main>
      <h1>Settings</h1>
      {showBtn && (
        <button type="button" onClick={() => setShowBtn(false)}>
          Add camera
        </button>
      )}
    </main>
  );
}

describe("highlight, clear, click, and go", () => {
  it("highlights a live ref, dismisses on Escape, farmer click, or clear, and rejects a stale ref", async () => {
    render(
      <I18nProvider initialLocale="nb">
        <MemoryRouter initialEntries={["/settings"]}>
          <GuideOverlay />
          <ToggleScreen />
        </MemoryRouter>
      </I18nProvider>,
    );

    await runAppAction({ action: "look" });
    let hl: Awaited<ReturnType<typeof runAppAction>> | undefined;
    await act(async () => {
      hl = await runAppAction({
        action: "highlight",
        ref: 1,
        note: "Trykk her.",
      });
    });

    expect(hl?.isError).toBe(false);
    expect(hl?.result.startsWith("Done:")).toBe(true);
    expect(screen.getByTestId("guide-highlight")).toBeInTheDocument();
    expect(screen.getByTestId("guide-pointer")).toBeInTheDocument();
    expect(screen.getByTestId("guide-note")).toHaveTextContent("Trykk her.");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("guide-highlight")).not.toBeInTheDocument();

    await act(async () => {
      await runAppAction({ action: "highlight", ref: 1 });
    });
    expect(screen.getByTestId("guide-highlight")).toBeInTheDocument();

    fireEvent.click(document.body);
    expect(screen.queryByTestId("guide-highlight")).not.toBeInTheDocument();

    await act(async () => {
      await runAppAction({ action: "highlight", ref: 1 });
    });
    await act(async () => {
      const cleared = await runAppAction({ action: "clear" });
      expect(cleared.isError).toBe(false);
      expect(cleared.result.startsWith("Done:")).toBe(true);
    });
    expect(screen.queryByTestId("guide-highlight")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add camera" }));
    const stale = await runAppAction({ action: "highlight", ref: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.result.startsWith("Not done:")).toBe(true);
  });

  it("glides pointer, presses, clicks buttons and router links, and refuses danger buttons and danger dialogs", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onDelete = vi.fn();
    const onDialogSecondary = vi.fn();

    render(
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/"]}>
          <GuideOverlay />
          <PathBadge />
          <nav>
            <Link to="/settings">Settings</Link>
          </nav>
          <Routes>
            <Route
              path="/"
              element={
                <main>
                  <h1>Home</h1>
                  <button type="button" onClick={onSave}>
                    Save note
                  </button>
                  <Button variant="danger" onClick={onDelete}>
                    Delete herd record
                  </Button>
                  <div role="dialog" aria-label="Confirm removal">
                    <button type="button" onClick={onDialogSecondary}>
                      Keep animal
                    </button>
                    <Button variant="danger" onClick={onDelete}>
                      Confirm delete
                    </Button>
                  </div>
                </main>
              }
            />
            <Route
              path="/settings"
              element={
                <main>
                  <h1>Settings</h1>
                </main>
              }
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    const initialLook = await runAppAction({ action: "look" });
    expect(initialLook.result).toContain('[2] button "Save note"');

    let clickSaveResult: Awaited<ReturnType<typeof runAppAction>> | undefined;
    await act(async () => {
      const pending = runAppAction({ action: "click", ref: 2 });
      await vi.advanceTimersByTimeAsync(100);
      expect(screen.getByTestId("guide-pointer")).toHaveAttribute("data-phase", "moving");
      await vi.advanceTimersByTimeAsync(150);
      expect(screen.getByTestId("guide-pointer")).toHaveAttribute("data-phase", "pressing");
      await vi.runAllTimersAsync();
      clickSaveResult = await pending;
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(clickSaveResult?.isError).toBe(false);
    expect(clickSaveResult?.result.startsWith("Done:")).toBe(true);

    await act(async () => {
      const dangerRes = await runAppAction({ action: "click", ref: 3 });
      expect(dangerRes.isError).toBe(true);
      expect(dangerRes.result.startsWith("Not done:")).toBe(true);
    });
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId("guide-highlight")).toBeInTheDocument();

    await act(async () => {
      const dialogBtnRes = await runAppAction({ action: "click", ref: 4 });
      expect(dialogBtnRes.isError).toBe(true);
      expect(dialogBtnRes.result.startsWith("Not done:")).toBe(true);
    });
    expect(onDialogSecondary).not.toHaveBeenCalled();

    const pendingNav = runAppAction({ action: "click", ref: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(310);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    const navClickResult = await pendingNav;

    expect(screen.getByTestId("current-path")).toHaveTextContent("/settings");
    expect(navClickResult.isError).toBe(false);
    expect(navClickResult.result).toContain("Screen: Settings (/settings)");
  });

  it("jumps without glide under prefers-reduced-motion, navigates on go, and serializes queued actions", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const order: string[] = [];
    render(
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/"]}>
          <GuideOverlay />
          <PathBadge />
          <Routes>
            <Route
              path="/"
              element={
                <main>
                  <h1>Home</h1>
                  <button type="button" onClick={() => order.push("clicked")}>
                    Quick action
                  </button>
                </main>
              }
            />
            <Route
              path="/cameras"
              element={
                <main>
                  <h1>Cameras</h1>
                </main>
              }
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    const refusedFull = await runAppAction({ action: "go", path: "https://pecorva.com/cameras" });
    expect(refusedFull.isError).toBe(true);
    expect(refusedFull.result.startsWith("Not done:")).toBe(true);

    const refusedRelative = await runAppAction({ action: "go", path: "cameras" });
    expect(refusedRelative.isError).toBe(true);

    await act(async () => {
      const p1 = runAppAction({ action: "look" }).then((r) => {
        order.push("looked");
        return r;
      });
      const p2 = runAppAction({ action: "click", ref: 1 }).then((r) => {
        order.push("click-done");
        return r;
      });
      const p3 = runAppAction({ action: "go", path: "/cameras" }).then((r) => {
        order.push("go-done");
        return r;
      });
      await vi.advanceTimersByTimeAsync(5);
      await Promise.all([p1, p2, p3]);
    });

    expect(order).toEqual(["looked", "clicked", "click-done", "go-done"]);
    expect(screen.getByTestId("current-path")).toHaveTextContent("/cameras");
  });
});
