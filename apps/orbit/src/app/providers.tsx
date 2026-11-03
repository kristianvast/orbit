import type { OrionClient } from "@orbit/protocol";
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
import { type OrionEndpoint, OrionProvider } from "../lib/orion";

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
    if (typeof document !== "undefined") {
      const attr = document.documentElement.getAttribute("data-theme");
      if (attr === "dark" || attr === "light") return attr;
    }
    if (typeof window !== "undefined" && window.localStorage) {
      const saved = window.localStorage.getItem("orbit.theme");
      if (saved === "dark" || saved === "light") return saved;
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
}

export function AppProviders({
  children,
  initialClient,
  initialEndpoint,
  defaultTheme = "light",
}: AppProvidersProps) {
  return (
    <ThemeProvider defaultTheme={defaultTheme}>
      <ToastProvider>
        <OrionProvider initialClient={initialClient} initialEndpoint={initialEndpoint}>
          {children}
        </OrionProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
