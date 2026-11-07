import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type MessageKey, translate } from "./catalogs";
import {
  DEFAULT_LOCALE,
  detectLocale,
  intlTag,
  isLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
  type Vars,
} from "./core";

export type TranslateFn = (key: MessageKey, vars?: Vars) => string;

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslateFn;
  /** BCP 47 tag for Intl APIs (`toLocaleString`, `Intl.*Format`). */
  intlLocale: string;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

function readStoredLocale(): Locale | null {
  try {
    const saved = window.localStorage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** Stored choice first, then the OS/browser language list, then English. */
export function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  return readStoredLocale() ?? detectLocale(browserLanguages());
}

function makeValue(locale: Locale, setLocale: (locale: Locale) => void): I18nContextValue {
  const tag = intlTag(locale, browserLanguages());
  return {
    locale,
    setLocale,
    intlLocale: tag,
    t: (key, vars) => translate(locale, key, vars),
    formatDate: (value, options) => {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString(tag, options);
    },
    formatNumber: (value, options) => value.toLocaleString(tag, options),
  };
}

const I18nContext = createContext<I18nContextValue>(makeValue(DEFAULT_LOCALE, () => {}));

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? resolveInitialLocale());

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage?.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice still applies for this session.
    }
  }, []);

  const value = useMemo(() => makeValue(locale, setLocale), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** Shorthand when a component only needs `t`. */
export function useT(): TranslateFn {
  return useContext(I18nContext).t;
}
