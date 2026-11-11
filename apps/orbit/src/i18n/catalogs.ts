import {
  type Catalog,
  interpolate,
  type Locale,
  type Message,
  selectMessage,
  type Vars,
} from "./core";
import { account as enAccount } from "./locales/en/account";
import { cameras as enCameras } from "./locales/en/cameras";
import { chat as enChat } from "./locales/en/chat";
import { connection as enConnection } from "./locales/en/connection";
import { design as enDesign } from "./locales/en/design";
import { devices as enDevices } from "./locales/en/devices";
import { feedback as enFeedback } from "./locales/en/feedback";
import { herd as enHerd } from "./locales/en/herd";
import { home as enHome } from "./locales/en/home";
import { localUi as enLocalUi } from "./locales/en/localUi";
import { pages as enPages } from "./locales/en/pages";
import { providers as enProviders } from "./locales/en/providers";
import { settings as enSettings } from "./locales/en/settings";
import { shell as enShell } from "./locales/en/shell";
import { account as nbAccount } from "./locales/nb/account";
import { cameras as nbCameras } from "./locales/nb/cameras";
import { chat as nbChat } from "./locales/nb/chat";
import { connection as nbConnection } from "./locales/nb/connection";
import { design as nbDesign } from "./locales/nb/design";
import { devices as nbDevices } from "./locales/nb/devices";
import { feedback as nbFeedback } from "./locales/nb/feedback";
import { herd as nbHerd } from "./locales/nb/herd";
import { home as nbHome } from "./locales/nb/home";
import { localUi as nbLocalUi } from "./locales/nb/localUi";
import { pages as nbPages } from "./locales/nb/pages";
import { providers as nbProviders } from "./locales/nb/providers";
import { settings as nbSettings } from "./locales/nb/settings";
import { shell as nbShell } from "./locales/nb/shell";

const en = {
  account: enAccount,
  cameras: enCameras,
  chat: enChat,
  connection: enConnection,
  design: enDesign,
  devices: enDevices,
  feedback: enFeedback,
  herd: enHerd,
  home: enHome,
  localUi: enLocalUi,
  pages: enPages,
  providers: enProviders,
  settings: enSettings,
  shell: enShell,
};

type En = typeof en;
type Tree = { [N in keyof En]: Catalog<En[N]> };

/** Every translatable key, e.g. `"shell.nav.home"`. */
export type MessageKey = { [N in keyof En]: `${N & string}.${keyof En[N] & string}` }[keyof En];

const nb: Tree = {
  account: nbAccount,
  cameras: nbCameras,
  chat: nbChat,
  connection: nbConnection,
  design: nbDesign,
  devices: nbDevices,
  feedback: nbFeedback,
  herd: nbHerd,
  home: nbHome,
  localUi: nbLocalUi,
  pages: nbPages,
  providers: nbProviders,
  settings: nbSettings,
  shell: nbShell,
};

const CATALOGS: Record<Locale, Tree> = { en, nb };

function lookup(locale: Locale, key: MessageKey): Message | undefined {
  const dot = key.indexOf(".");
  const ns = key.slice(0, dot) as keyof Tree;
  const name = key.slice(dot + 1);
  return (CATALOGS[locale][ns] as Record<string, Message | undefined>)[name];
}

/** Translate outside React (constants, reducers). Falls back to English, then the key. */
export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const message = lookup(locale, key) ?? lookup("en", key);
  if (message === undefined) return key;
  return interpolate(selectMessage(locale, message, vars), vars);
}
