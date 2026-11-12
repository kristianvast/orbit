import type { OrionClient } from "@orbit/protocol";
import type { Species } from "@orbit/schema";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ToastProvider } from "../design";
import { VoiceProvider, type VoiceStartSessionFn } from "../features/voice";
import { I18nProvider, type Locale } from "../i18n";
import { AccountProvider } from "../lib/account";
import { type OrionEndpoint, OrionProvider } from "../lib/orion";
import { FarmSpeciesProvider } from "../lib/species";

export type ThemeMode = "light" | "dark";

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  setTheme: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({
  children,
  defaultTheme = "light",
}: {
  children: ReactNode;
  defaultTheme?: ThemeMode;
}) {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    // The saved choice wins over index.html's static data-theme default.
    try {
      const saved = window.localStorage?.getItem("orbit.theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch {
      // Ignore storage errors
    }
    if (typeof document !== "undefined") {
      const attr = document.documentElement.getAttribute("data-theme");
      if (attr === "dark" || attr === "light") return attr;
    }
    return defaultTheme;
  });

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
    }
    try {
      window.localStorage?.setItem("orbit.theme", theme);
    } catch {
      // Ignore storage errors
    }
  }, [theme]);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export interface AppProvidersProps {
  children: ReactNode;
  initialClient?: OrionClient;
  initialEndpoint?: OrionEndpoint;
  defaultTheme?: ThemeMode;
  /** Forces a UI language (tests, previews); otherwise stored choice or OS language. */
  initialLocale?: Locale;
  initialSpecies?: Species;
  voiceStartSession?: VoiceStartSessionFn;
}

export function AppProviders({
  children,
  initialClient,
  initialEndpoint,
  defaultTheme = "light",
  initialLocale,
  initialSpecies,
  voiceStartSession,
}: AppProvidersProps) {
  return (
    <I18nProvider initialLocale={initialLocale}>
      <ThemeProvider defaultTheme={defaultTheme}>
        <ToastProvider>
          <OrionProvider initialClient={initialClient} initialEndpoint={initialEndpoint}>
            <AccountProvider>
              <FarmSpeciesProvider initialSpecies={initialSpecies}>
                <VoiceProvider
                  {...(voiceStartSession !== undefined ? { startSession: voiceStartSession } : {})}
                >
                  {children}
                </VoiceProvider>
              </FarmSpeciesProvider>
            </AccountProvider>
          </OrionProvider>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
