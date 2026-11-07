import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./providers";

function ThemeProbe() {
  const { theme } = useTheme();
  return <span data-testid="theme">{theme}</span>;
}

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
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
});
