const EXCLUDED_SURFACE_SELECTOR = [
  '[data-guide-overlay="true"]',
  '[data-testid="guide-highlight"]',
  '[data-testid="guide-pointer"]',
  '[data-testid="guide-note"]',
  '[data-testid="voice-stage"]',
  '[data-testid="voice-dock"]',
  '[data-testid="home-orion-widget"]',
].join(", ");

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TR",
  "UL",
]);

const SKIP_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);

export function isInsideExcludedSurface(el: Element): boolean {
  return el.closest(EXCLUDED_SURFACE_SELECTOR) !== null;
}

function hasLayoutEngine(doc: Document): boolean {
  if ((doc.documentElement?.clientWidth ?? 0) > 0) return true;
  const bodyRect = doc.body?.getBoundingClientRect();
  return (bodyRect?.width ?? 0) > 0 || (bodyRect?.height ?? 0) > 0;
}

export function isElementVisible(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === "hidden") return false;
  const view = el.ownerDocument.defaultView;
  let current: Element | null = el;
  while (current !== null) {
    if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true") {
      return false;
    }
    if (current instanceof HTMLElement && current.inert) return false;
    if (view) {
      const style = view.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      ) {
        return false;
      }
    }
    current = current.parentElement;
  }
  if (hasLayoutEngine(el.ownerDocument)) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
  }
  return true;
}

export function isElementDisabled(el: Element): boolean {
  if (
    (el instanceof HTMLButtonElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement) &&
    el.disabled
  ) {
    return true;
  }
  if (el.getAttribute("aria-disabled") === "true") return true;
  return el.closest("fieldset:disabled, [inert]") !== null;
}

export function isPasswordField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  return (
    el.type.toLowerCase() === "password" ||
    (el.getAttribute("type") ?? "").toLowerCase() === "password"
  );
}

function isDirectDangerControl(el: Element): boolean {
  if (
    el.classList.contains("orbit-btn--danger") ||
    Array.from(el.classList).some((cls) => cls.endsWith("--danger"))
  ) {
    return true;
  }
  if (el.getAttribute("data-danger") === "true" || el.getAttribute("data-variant") === "danger") {
    return true;
  }
  const testId = el.getAttribute("data-testid") ?? "";
  if (
    testId === "account-logout" ||
    testId === "invite-revoke" ||
    testId.startsWith("provider-disconnect-") ||
    testId.startsWith("session-delete-")
  ) {
    return true;
  }
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  if (tag === "button" || role === "button") {
    const rawText = (el.textContent ?? "").trim();
    if (/\b(sign\s*out|log\s*out|logg\s*ut)\b/i.test(rawText)) return true;
  }
  return false;
}

export function isDangerTarget(el: Element): boolean {
  if (isDirectDangerControl(el)) return true;
  const dialog = el.closest('[role="dialog"], [role="alertdialog"], dialog');
  if (!dialog) return false;
  const buttons = dialog.querySelectorAll('button, [role="button"]');
  for (const btn of buttons) {
    if (!isElementDisabled(btn) && isElementVisible(btn) && isDirectDangerControl(btn)) {
      return true;
    }
  }
  return false;
}

export function cleanText(raw: string, maxChars: number): string {
  return raw.replace(/\s+/g, " ").trim().replaceAll('"', "'").slice(0, maxChars);
}

export function collectVisibleNodeText(node: Node, includeVisuallyHidden: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (!(node instanceof Element)) return "";
  if (SKIP_TEXT_TAGS.has(node.tagName)) return "";
  if (isInsideExcludedSurface(node) || isPasswordField(node)) return "";
  if (!includeVisuallyHidden && node.classList.contains("orbit-visually-hidden")) return "";
  if (!isElementVisible(node)) return "";
  if (node.tagName === "BR") return "\n";

  const chunks: string[] = [];
  for (const child of node.childNodes) {
    const part = collectVisibleNodeText(child, includeVisuallyHidden);
    if (part) chunks.push(part);
  }
  const joined = chunks.join(" ");
  return BLOCK_TAGS.has(node.tagName) ? `\n${joined}\n` : joined;
}
