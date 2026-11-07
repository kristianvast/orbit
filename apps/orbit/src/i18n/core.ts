/**
 * Dependency-free i18n core for the Orbit UI.
 *
 * Catalogs live in `locales/<locale>/<namespace>.ts`. English is the source of
 * truth: every other locale is typed `Catalog<typeof en.<namespace>>`, so a
 * missing or extra key is a type error. Messages are plain strings with
 * `{name}` placeholders, or plural objects picked with `Intl.PluralRules`
 * from the `count` variable.
 */

export const LOCALES = ["en", "nb"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "orbit.locale";

/** Language names shown in the picker, always written in their own language. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  nb: "Norsk bokmål",
};

export interface PluralMessage {
  zero?: string;
  one: string;
  other: string;
}

export type Message = string | PluralMessage;
export type Messages = Record<string, Message>;

/** Same keys as the English namespace; strings stay strings, plurals stay plurals. */
export type Catalog<T> = { [K in keyof T]: T[K] extends string ? string : PluralMessage };

export type Vars = Record<string, string | number>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Maps BCP 47 tags to a supported locale. Norwegian (no, nb, nn) maps to Bokmål. */
export function matchLocale(tag: string): Locale | null {
  const primary = tag.toLowerCase().split(/[-_]/)[0] ?? "";
  if (primary === "nb" || primary === "nn" || primary === "no") return "nb";
  if (primary === "en") return "en";
  return null;
}

export function detectLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/**
 * The tag handed to Intl formatters: the user's own regional variant when it
 * matches the chosen language (en-GB keeps day-month order), else the locale.
 */
export function intlTag(locale: Locale, languages: readonly string[]): string {
  return languages.find((tag) => matchLocale(tag) === locale) ?? locale;
}

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

export function selectMessage(locale: Locale, message: Message, vars?: Vars): string {
  if (typeof message === "string") return message;
  const count = Number(vars?.count ?? 0);
  if (count === 0 && message.zero !== undefined) return message.zero;
  const category = new Intl.PluralRules(locale).select(count);
  return category === "one" ? message.one : message.other;
}
