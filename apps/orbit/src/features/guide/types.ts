export type AppAction =
  | { action: "look" }
  | { action: "highlight"; ref: number; note?: string }
  | { action: "click"; ref: number; note?: string }
  | { action: "go"; path: string; note?: string }
  | { action: "clear" };

export interface AppActionResult {
  result: string;
  isError: boolean;
}

export type GuideItemKind =
  | "link"
  | "button"
  | "input"
  | "select"
  | "tab"
  | "checkbox"
  | "radio"
  | "switch";

export interface ScreenItem {
  readonly ref: number;
  readonly kind: GuideItemKind;
  readonly label: string;
  readonly value?: string;
  readonly danger: boolean;
  readonly element: Element;
}

export interface ScreenSnapshot {
  readonly heading: string;
  readonly path: string;
  readonly text: string;
  readonly items: readonly ScreenItem[];
  readonly formatted: string;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface BoxRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type PointerPhase = "idle" | "moving" | "pressing";

export interface GuideVisualState {
  readonly mode: "idle" | "active";
  readonly targetElement: Element | null;
  readonly targetLabel: string;
  readonly note: string | undefined;
  readonly pointerPhase: PointerPhase;
  readonly pointerFrom: Point | null;
  readonly pointerTo: Point | null;
  readonly routePath: string;
  readonly sequence: number;
}
