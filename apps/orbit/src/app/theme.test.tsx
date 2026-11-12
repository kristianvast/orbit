import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./providers";

function ThemeProbe() {
  const { theme, preference, cycleTheme } = useTheme();
  return (
    <button type="button" data-testid="theme" data-preference={preference} onClick={cycleTheme}>
      {theme}
    </button>
  );
}

function fakeSystemScheme(initialDark: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    matches: initialDark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) =>
      query === "(prefers-color-scheme: dark)" ? mq : { ...mq, matches: false },
  });
  return {
    set(dark: boolean) {
      mq.matches = dark;
      for (const fn of listeners) fn();
    },
  };
}

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("ThemeProvider", () => {
  it("restores a saved night mode over index.html's static light default", () => {
    document.documentElement.setAttribute("data-theme", "light");
    window.localStorage.setItem("orbit.theme", "dark");

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("follows the system scheme, including live changes, until a theme is picked", () => {
    const system = fakeSystemScheme(true);
    // The old key always held the resolved theme, so a stored "light" is not a real choice.
    window.localStorage.setItem("orbit.theme", "light");

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    const probe = screen.getByTestId("theme");
    expect(probe.dataset.preference).toBe("system");
    expect(probe.textContent).toBe("dark");

    act(() => system.set(false));
    expect(probe.textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fireEvent.click(probe);
    fireEvent.click(probe);
    expect(probe.dataset.preference).toBe("dark");
    act(() => system.set(false));
    expect(probe.textContent).toBe("dark");
    expect(window.localStorage.getItem("orbit.theme.mode")).toBe("dark");
    fireEvent.click(probe);
    expect(probe.dataset.preference).toBe("system");
    expect(probe.textContent).toBe("light");
  });
});
