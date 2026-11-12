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
/** What the person picked: follow the OS, or force one theme. */
export type ThemePreference = "system" | ThemeMode;

const PREFERENCE_KEY = "orbit.theme.mode";
/** Pre-preference key: it always stored the resolved theme, so only "dark" was a real choice. */
const LEGACY_THEME_KEY = "orbit.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const PREFERENCE_CYCLE: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

export function readThemePreference(): ThemePreference | null {
  try {
    const saved = window.localStorage?.getItem(PREFERENCE_KEY);
    if (saved === "system" || saved === "light" || saved === "dark") return saved;
    if (window.localStorage?.getItem(LEGACY_THEME_KEY) === "dark") return "dark";
  } catch {
    // Ignore storage errors
  }
  return null;
}

export function systemTheme(): ThemeMode | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

interface ThemeContextValue {
  /** The theme on screen. */
  theme: ThemeMode;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  setTheme: (theme: ThemeMode) => void;
  /** Steps System -> Light -> Dark -> System. */
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  preference: "system",
  setPreference: () => {},
  setTheme: () => {},
  cycleTheme: () => {},
});

export function ThemeProvider({
  children,
  defaultTheme = "light",
}: {
  children: ReactNode;
  /** Used only when the OS colour scheme cannot be read. */
  defaultTheme?: ThemeMode;
}) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => readThemePreference() ?? "system",
  );
  const [osTheme, setOsTheme] = useState<ThemeMode>(() => systemTheme() ?? defaultTheme);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => setOsTheme(mq.matches ? "dark" : "light");
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const theme: ThemeMode = preference === "system" ? osTheme : preference;

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage?.setItem(PREFERENCE_KEY, preference);
      window.localStorage?.removeItem(LEGACY_THEME_KEY);
    } catch {
      // Ignore storage errors
    }
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
  }, []);

  const setTheme = useCallback((next: ThemeMode) => {
    setPreferenceState(next);
  }, []);

  const cycleTheme = useCallback(() => {
    setPreferenceState((prev) => PREFERENCE_CYCLE[prev]);
  }, []);

  const value = useMemo(
    () => ({ theme, preference, setPreference, setTheme, cycleTheme }),
    [theme, preference, setPreference, setTheme, cycleTheme],
  );

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
