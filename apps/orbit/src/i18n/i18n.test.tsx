import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectLocale,
  I18nProvider,
  LOCALE_STORAGE_KEY,
  resolveInitialLocale,
  translate,
  useI18n,
} from ".";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("locale detection", () => {
  it("maps every Norwegian tag to Bokmål and falls back to English", () => {
    expect(detectLocale(["nb-NO"])).toBe("nb");
    expect(detectLocale(["nn"])).toBe("nb");
    expect(detectLocale(["no"])).toBe("nb");
    expect(detectLocale(["de-DE", "nb"])).toBe("nb");
    expect(detectLocale(["fr-FR", "de"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });

  it("prefers a valid stored choice and ignores a garbage one", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["nb-NO"]);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "xx");
    expect(resolveInitialLocale()).toBe("nb");
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    expect(resolveInitialLocale()).toBe("en");
  });
});

describe("translate", () => {
  it("interpolates variables and picks plural forms per locale", () => {
    expect(translate("en", "shell.sync.syncing", { count: 3 })).toBe("Syncing (3)");
    expect(translate("nb", "shell.sync.syncing", { count: 3 })).toBe("Synkroniserer (3)");
    expect(translate("en", "settings.undo.items", { count: 1 })).toBe("1 item");
    expect(translate("en", "settings.undo.items", { count: 4 })).toBe("4 items");
    expect(translate("nb", "settings.undo.items", { count: 1 })).toBe("1 element");
    expect(translate("nb", "settings.undo.items", { count: 4 })).toBe("4 elementer");
  });
});

function LocaleProbe() {
  const { t, setLocale } = useI18n();
  return (
    <button type="button" onClick={() => setLocale("nb")}>
      {t("shell.nav.home")}
    </button>
  );
}

describe("I18nProvider", () => {
  it("switches language live, persists the choice and sets <html lang>", () => {
    render(
      <I18nProvider initialLocale="en">
        <LocaleProbe />
      </I18nProvider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Home");
    act(() => screen.getByRole("button").click());
    expect(screen.getByRole("button")).toHaveTextContent("Hjem");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("nb");
    expect(document.documentElement.lang).toBe("nb");
  });
});
