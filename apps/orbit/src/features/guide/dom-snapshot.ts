import {
  cleanText,
  collectVisibleNodeText,
  isDangerTarget,
  isElementDisabled,
  isElementVisible,
  isInsideExcludedSurface,
  isPasswordField,
} from "./dom-predicates";
import type { GuideItemKind, ScreenItem, ScreenSnapshot } from "./types";

const MAX_ITEMS = 150;
const MAX_MAIN_TEXT_CHARS = 1500;
const MAX_LABEL_CHARS = 90;
const MAX_VALUE_CHARS = 60;
const DANGER_SUFFIX = " (ask the farmer to press this one)" as const;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="checkbox"]',
].join(", ");

function resolveAccessibleName(el: Element): string {
  const doc = el.ownerDocument;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .filter(Boolean);
    const joined = cleanText(parts.join(" "), MAX_LABEL_CHARS);
    if (joined) return joined;
  }
  const ariaLabel = cleanText(el.getAttribute("aria-label") ?? "", MAX_LABEL_CHARS);
  if (ariaLabel) return ariaLabel;

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    const firstLabel = el.labels?.[0];
    if (firstLabel) {
      const clone = firstLabel.cloneNode(true);
      if (clone instanceof Element) {
        for (const nested of clone.querySelectorAll("input, select, textarea")) nested.remove();
        const txt = cleanText(clone.textContent ?? "", MAX_LABEL_CHARS);
        if (txt) return txt;
      }
    }
  }
  return cleanText(collectVisibleNodeText(el, true), MAX_LABEL_CHARS);
}

function resolveElementLabel(el: Element): string {
  const isFormField =
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement;

  if (!isFormField) {
    const visible = cleanText(collectVisibleNodeText(el, false), MAX_LABEL_CHARS);
    if (visible) return visible;
  }
  const accessible = resolveAccessibleName(el);
  if (accessible) return accessible;

  const placeholder = cleanText(el.getAttribute("placeholder") ?? "", MAX_LABEL_CHARS);
  if (placeholder) return placeholder;

  const title = cleanText(el.getAttribute("title") ?? "", MAX_LABEL_CHARS);
  if (title) return title;

  if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button")) {
    const val = cleanText(el.value, MAX_LABEL_CHARS);
    if (val) return val;
  }
  return cleanText(el.getAttribute("name") ?? "", MAX_LABEL_CHARS);
}

function resolveItemKind(el: Element): GuideItemKind {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  if (tag === "a" || role === "link") return "link";
  if (role === "tab") return "tab";
  if (role === "switch") return "switch";
  if (role === "checkbox") return "checkbox";
  if (tag === "select") return "select";
  if (el instanceof HTMLInputElement) {
    const t = el.type.toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "button" || t === "submit" || t === "reset") return "button";
    return "input";
  }
  if (tag === "textarea") return "input";
  return "button";
}

function resolveItemValue(el: Element): string | undefined {
  if (isPasswordField(el)) return undefined;
  if (el instanceof HTMLInputElement) {
    const t = el.type.toLowerCase();
    if (t === "checkbox" || t === "radio") return el.checked ? "checked" : undefined;
    if (t === "button" || t === "submit" || t === "reset") return undefined;
    const cleaned = cleanText(el.value, MAX_VALUE_CHARS);
    return cleaned || undefined;
  }
  if (el instanceof HTMLTextAreaElement) {
    const cleaned = cleanText(el.value, MAX_VALUE_CHARS);
    return cleaned || undefined;
  }
  if (el instanceof HTMLSelectElement) {
    const selected = el.selectedOptions[0]?.textContent ?? el.value;
    const cleaned = cleanText(selected, MAX_VALUE_CHARS);
    return cleaned || undefined;
  }
  return undefined;
}

function extractMainExcerpt(doc: Document): string {
  const mainRoot = doc.querySelector("main") ?? doc.body;
  if (!mainRoot) return "";
  return collectVisibleNodeText(mainRoot, false)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_MAIN_TEXT_CHARS);
}

function resolveHeading(doc: Document): string {
  const scope = doc.querySelector("main") ?? doc.body;
  if (scope) {
    const headings = scope.querySelectorAll('h1, [role="heading"][aria-level="1"]');
    for (const h of headings) {
      if (isInsideExcludedSurface(h) || !isElementVisible(h)) continue;
      const txt = cleanText(collectVisibleNodeText(h, false), 120);
      if (txt) return txt;
    }
  }
  const title = cleanText(doc.title ?? "", 120);
  return title || "Orbit";
}

export function captureScreenSnapshot(doc: Document, path: string): ScreenSnapshot {
  const heading = resolveHeading(doc);
  const text = extractMainExcerpt(doc);
  const candidates = doc.querySelectorAll(INTERACTIVE_SELECTOR);
  const items: ScreenItem[] = [];

  for (const el of candidates) {
    if (items.length >= MAX_ITEMS) break;
    if (isInsideExcludedSurface(el) || isElementDisabled(el) || !isElementVisible(el)) continue;
    const ref = items.length + 1;
    const kind = resolveItemKind(el);
    const label = resolveElementLabel(el);
    const value = resolveItemValue(el);
    const danger = isDangerTarget(el);
    items.push({
      ref,
      kind,
      label,
      ...(value !== undefined ? { value } : {}),
      danger,
      element: el,
    });
  }

  const itemLines = items.map((item) => {
    const valueSegment = item.value !== undefined ? ` = "${item.value}"` : "";
    const suffix = item.danger ? DANGER_SUFFIX : "";
    return `[${item.ref}] ${item.kind} "${item.label}"${valueSegment}${suffix}`;
  });

  const lines = [
    `Screen: ${heading} (${path})`,
    ...(text ? [text] : []),
    "Things on screen:",
    ...itemLines,
  ];

  return {
    heading,
    path,
    text,
    items,
    formatted: lines.join("\n"),
  };
}
