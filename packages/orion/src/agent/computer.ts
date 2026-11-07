// Computer use: screenshots plus mouse and keyboard input on this PC, so Orion can read and operate
// programs that have no connector (for example a vendor herd-management app). Driven through the
// operating system's own tools, no native dependency: macOS screencapture/sips/osascript, Windows
// PowerShell (user32 + System.Windows.Forms), Linux X11 xdotool + ImageMagick import.
// Each call is one atomic action; nothing stays held between calls, so chat.abort is the stop.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const COMPUTER_ACTIONS = [
  "screenshot",
  "cursor_position",
  "move",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type",
  "key",
] as const;

const Coord = (description: string) => Type.Optional(Type.Integer({ minimum: 0, description }));

export const ComputerParams = Type.Object({
  action: Type.Enum([...COMPUTER_ACTIONS]),
  x: Coord("Pointer x in screenshot pixels (move, click, drag start, scroll)"),
  y: Coord("Pointer y in screenshot pixels"),
  toX: Coord("Drag end x"),
  toY: Coord("Drag end y"),
  amount: Type.Optional(
    Type.Integer({ minimum: -50, maximum: 50, description: "Scroll lines; positive scrolls down" }),
  ),
  text: Type.Optional(Type.String({ description: "Text to type (type)" })),
  keys: Type.Optional(
    Type.String({ description: 'Key or combination (key), e.g. "enter", "ctrl+s", "cmd+shift+4"' }),
  ),
});
export type ComputerAction = Static<typeof ComputerParams>;

export type RefusalCode = "permission_denied" | "unavailable" | "bad_request" | "failed";

export class ComputerRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

type Mod = "cmd" | "ctrl" | "alt" | "shift";
const MODS: Record<string, Mod> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  win: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};
const NAMED = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "space",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
] as const;
type Named = (typeof NAMED)[number];
const ALIASES: Record<string, Named> = { return: "enter", esc: "escape", del: "delete" };

export interface KeyCombo {
  mods: Mod[];
  key: { named: Named } | { char: string };
}

export function parseKeys(combo: string): KeyCombo {
  const parts = combo
    .trim()
    .split(/\s*\+\s*/)
    .filter((p) => p !== "");
  // "ctrl++" means ctrl and the plus key.
  if (combo.trim().endsWith("++")) parts.push("+");
  const last = parts.pop();
  if (!last) throw new ComputerRefusal("bad_request", `No key in "${combo}".`);
  const mods: Mod[] = [];
  for (const p of parts) {
    const mod = MODS[p.toLowerCase()];
    if (!mod) throw new ComputerRefusal("bad_request", `Unknown modifier "${p}" in "${combo}".`);
    if (!mods.includes(mod)) mods.push(mod);
  }
  const lower = last.toLowerCase();
  const named = ALIASES[lower] ?? (NAMED as readonly string[]).find((n) => n === lower);
  if (named) return { mods, key: { named: named as Named } };
  if ([...last].length === 1) return { mods, key: { char: last } };
  throw new ComputerRefusal("bad_request", `Unknown key "${last}" in "${combo}".`);
}

const MAC_KEY_CODES: Record<Named, number> = {
  enter: 36,
  tab: 48,
  escape: 53,
  backspace: 51,
  delete: 117,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  space: 49,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};
const MAC_MODS: Record<Mod, string> = {
  cmd: "command down",
  ctrl: "control down",
  alt: "option down",
  shift: "shift down",
};

/** osascript argv for a key combination; the character travels as an argument, never as script. */
export function macKeyCommand(combo: KeyCombo): string[] {
  const using = combo.mods.length
    ? ` using {${combo.mods.map((m) => MAC_MODS[m]).join(", ")}}`
    : "";
  const stroke =
    "named" in combo.key
      ? `key code ${MAC_KEY_CODES[combo.key.named]}${using}`
      : `keystroke (item 1 of argv)${using}`;
  const arg = "char" in combo.key ? [combo.key.char] : [];
  return [
    "osascript",
    "-e",
    "on run argv",
    "-e",
    `tell application "System Events" to ${stroke}`,
    "-e",
    "end run",
    ...arg,
  ];
}

const SENDKEYS_NAMED: Record<Named, string> = {
  enter: "{ENTER}",
  tab: "{TAB}",
  escape: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  space: " ",
  ...(Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `{F${i + 1}}`]),
  ) as Record<`f${number}`, string>),
};

/** Escapes text for System.Windows.Forms.SendKeys, where + ^ % ~ ( ) { } [ ] are syntax. */
export function sendKeysText(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

export function sendKeysCombo(combo: KeyCombo): string {
  if (combo.mods.includes("cmd")) {
    throw new ComputerRefusal(
      "unavailable",
      "The Windows key cannot be sent on Windows; use ctrl or alt combinations, or click instead.",
    );
  }
  const prefix = combo.mods.map((m) => ({ ctrl: "^", alt: "%", shift: "+" })[m as "ctrl"]).join("");
  const key = "named" in combo.key ? SENDKEYS_NAMED[combo.key.named] : sendKeysText(combo.key.char);
  return prefix + key;
}

const XDOTOOL_NAMED: Record<Named, string> = {
  enter: "Return",
  tab: "Tab",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  space: "space",
  ...(Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]),
  ) as Record<`f${number}`, string>),
};

export function xdotoolCombo(combo: KeyCombo): string {
  const mods = combo.mods.map((m) => (m === "cmd" ? "super" : m));
  const key = "named" in combo.key ? XDOTOOL_NAMED[combo.key.named] : combo.key.char;
  return [...mods, key].join("+");
}

async function exec(
  argv: string[],
  signal: AbortSignal | undefined,
  env: Record<string, string> = {},
): Promise<string> {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    // Orion runs without a console under Tauri, so each powershell.exe would open its own window.
    windowsHide: true,
    ...(signal ? { signal } : {}),
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (signal?.aborted) throw new ComputerRefusal("failed", "Stopped by the farmer.");
  if (code !== 0) {
    const detail = (err || out).trim();
    if (/-1719|-25211|-1743|not allowed|assistive access/i.test(detail)) {
      throw new ComputerRefusal(
        "permission_denied",
        "macOS refused keyboard or mouse control. In System Settings > Privacy & Security, turn on Orbit under Accessibility, then quit and reopen Orbit.",
      );
    }
    throw new ComputerRefusal("failed", `${argv[0]} exited with ${code}: ${detail.slice(0, 500)}`);
  }
  return out.trim();
}

function need(a: ComputerAction, ...keys: Array<"x" | "y" | "toX" | "toY" | "text" | "keys">) {
  const missing = keys.filter((k) => a[k] === undefined);
  if (missing.length) {
    throw new ComputerRefusal("bad_request", `${a.action} needs ${missing.join(", ")}.`);
  }
}

export interface Screenshot {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

interface Backend {
  screenshot(signal?: AbortSignal): Promise<Screenshot>;
  act(a: ComputerAction, signal?: AbortSignal): Promise<string>;
}

function withTempFile<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "orion-screen-"));
  return fn(join(dir, "screen.jpg")).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function described(a: ComputerAction): string {
  switch (a.action) {
    case "move":
      return `Moved the pointer to (${a.x}, ${a.y}).`;
    case "click":
    case "double_click":
    case "right_click":
      return `${a.action.replace("_", " ")} at (${a.x}, ${a.y}).`;
    case "drag":
      return `Dragged from (${a.x}, ${a.y}) to (${a.toX}, ${a.toY}).`;
    case "scroll":
      return `Scrolled ${a.amount ?? 3} lines at (${a.x}, ${a.y}).`;
    case "type":
      return `Typed ${[...(a.text ?? "")].length} characters.`;
    case "key":
      return `Pressed ${a.keys}.`;
    default:
      return "Done.";
  }
}

const JXA_MOUSE =
  "ObjC.import('CoreGraphics');function ev(t,x,y,b,n){var e=$.CGEventCreateMouseEvent(null,t,{x:x,y:y},b);if(n)$.CGEventSetIntegerValueField(e,1,n);$.CGEventPost(0,e);}";

/** JXA source for a pointer action. Every value interpolated here is a validated integer. */
export function macPointerScript(a: ComputerAction): string {
  const { x = 0, y = 0, toX = 0, toY = 0 } = a;
  const at = `${x},${y}`;
  switch (a.action) {
    case "move":
      return `${JXA_MOUSE}ev(5,${at},0);`;
    case "click":
      return `${JXA_MOUSE}ev(5,${at},0);ev(1,${at},0,1);ev(2,${at},0,1);`;
    case "double_click":
      return `${JXA_MOUSE}ev(5,${at},0);ev(1,${at},0,1);ev(2,${at},0,1);ev(1,${at},0,2);ev(2,${at},0,2);`;
    case "right_click":
      return `${JXA_MOUSE}ev(5,${at},0);ev(3,${at},1,1);ev(4,${at},1,1);`;
    case "drag": {
      const steps = Array.from({ length: 10 }, (_, i) => {
        const t = (i + 1) / 10;
        return `ev(6,${Math.round(x + (toX - x) * t)},${Math.round(y + (toY - y) * t)},0);`;
      }).join("");
      return `${JXA_MOUSE}ev(5,${at},0);ev(1,${at},0,1);${steps}ev(2,${toX},${toY},0,1);`;
    }
    case "scroll":
      return `${JXA_MOUSE}ev(5,${at},0);$.CGEventPost(0,$.CGEventCreateScrollWheelEvent2(null,1,1,${-(a.amount ?? 3)},0,0));`;
    default:
      throw new ComputerRefusal("bad_request", `${a.action} is not a pointer action.`);
  }
}

const JXA_PERMISSIONS =
  "ObjC.import('CoreGraphics');ObjC.import('ApplicationServices');JSON.stringify({screen:typeof $.CGPreflightScreenCaptureAccess==='function'?$.CGPreflightScreenCaptureAccess():null,input:typeof $.AXIsProcessTrusted==='function'?$.AXIsProcessTrusted():null})";

const macBackend: Backend = {
  async screenshot(signal) {
    const perms = JSON.parse(
      await exec(["osascript", "-l", "JavaScript", "-e", JXA_PERMISSIONS], signal),
    );
    if (perms.screen === false) {
      throw new ComputerRefusal(
        "permission_denied",
        "macOS blocks screenshots. In System Settings > Privacy & Security > Screen & System Audio Recording, turn on Orbit, then quit and reopen Orbit.",
      );
    }
    const size = JSON.parse(
      await exec(
        [
          "osascript",
          "-l",
          "JavaScript",
          "-e",
          "ObjC.import('AppKit');var f=$.NSScreen.mainScreen.frame;JSON.stringify({w:f.size.width,h:f.size.height})",
        ],
        signal,
      ),
    ) as { w: number; h: number };
    return withTempFile(async (file) => {
      await exec(["screencapture", "-x", "-m", "-t", "jpg", file], signal);
      // Resample to logical points so screenshot pixels are the coordinates CGEvent uses.
      await exec(
        ["sips", "--resampleWidth", String(Math.round(size.w)), "-s", "formatOptions", "70", file],
        signal,
      );
      return {
        data: readFileSync(file),
        mimeType: "image/jpeg",
        width: Math.round(size.w),
        height: Math.round(size.h),
      };
    });
  },
  async act(a, signal) {
    if (a.action === "cursor_position") {
      const p = JSON.parse(
        await exec(
          [
            "osascript",
            "-l",
            "JavaScript",
            "-e",
            "ObjC.import('CoreGraphics');var p=$.CGEventGetLocation($.CGEventCreate(null));JSON.stringify({x:Math.round(p.x),y:Math.round(p.y)})",
          ],
          signal,
        ),
      );
      return `Pointer is at (${p.x}, ${p.y}).`;
    }
    const perms = JSON.parse(
      await exec(["osascript", "-l", "JavaScript", "-e", JXA_PERMISSIONS], signal),
    );
    if (perms.input === false) {
      // CGEventPost drops events silently without this grant, so refuse instead of pretending.
      throw new ComputerRefusal(
        "permission_denied",
        "macOS blocks mouse and keyboard control. In System Settings > Privacy & Security > Accessibility, turn on Orbit, then quit and reopen Orbit.",
      );
    }
    if (a.action === "type") {
      await exec(
        [
          "osascript",
          "-e",
          "on run argv",
          "-e",
          'tell application "System Events" to keystroke (item 1 of argv)',
          "-e",
          "end run",
          a.text ?? "",
        ],
        signal,
      );
    } else if (a.action === "key") {
      await exec(macKeyCommand(parseKeys(a.keys ?? "")), signal);
    } else {
      await exec(["osascript", "-l", "JavaScript", "-e", macPointerScript(a)], signal);
    }
    return described(a);
  },
};

const PS_PRELUDE = [
  "$ErrorActionPreference='Stop'",
  `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OrionInput{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,int dx,int dy,int d,UIntPtr e);}'`,
  "[void][OrionInput]::SetProcessDPIAware()",
  "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
  "function Btn($f){[OrionInput]::mouse_event($f,0,0,0,[UIntPtr]::Zero)}",
].join("\n");

/** PowerShell body for an action; text and key strings arrive through $env:ORION_COMPUTER_TEXT. */
export function windowsScript(a: ComputerAction): string {
  const { x = 0, y = 0, toX = 0, toY = 0 } = a;
  const to = (px: number, py: number) => `[void][OrionInput]::SetCursorPos(${px},${py})`;
  switch (a.action) {
    case "screenshot":
      return [
        "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height",
        "$g=[System.Drawing.Graphics]::FromImage($bmp)",
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)",
        "$bmp.Save($env:ORION_COMPUTER_FILE,[System.Drawing.Imaging.ImageFormat]::Jpeg)",
        '"$($b.Width)x$($b.Height)"',
      ].join("\n");
    case "cursor_position":
      return '$p=[System.Windows.Forms.Cursor]::Position;"$($p.X),$($p.Y)"';
    case "move":
      return to(x, y);
    case "click":
      return `${to(x, y)};Btn 2;Btn 4`;
    case "double_click":
      return `${to(x, y)};Btn 2;Btn 4;Btn 2;Btn 4`;
    case "right_click":
      return `${to(x, y)};Btn 8;Btn 16`;
    case "drag":
      return `${to(x, y)};Btn 2;${to(Math.round((x + toX) / 2), Math.round((y + toY) / 2))};${to(toX, toY)};Btn 4`;
    case "scroll":
      return `${to(x, y)};[OrionInput]::mouse_event(2048,0,0,${-120 * (a.amount ?? 3)},[UIntPtr]::Zero)`;
    case "type":
    case "key":
      return "[System.Windows.Forms.SendKeys]::SendWait($env:ORION_COMPUTER_TEXT)";
  }
}

function powershell(body: string): string[] {
  const encoded = Buffer.from(`${PS_PRELUDE}\n${body}`, "utf16le").toString("base64");
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ];
}

const windowsBackend: Backend = {
  screenshot(signal) {
    return withTempFile(async (file) => {
      const out = await exec(powershell(windowsScript({ action: "screenshot" })), signal, {
        ORION_COMPUTER_FILE: file,
      });
      const [width = 0, height = 0] = out.split("x").map(Number);
      return { data: readFileSync(file), mimeType: "image/jpeg", width, height };
    });
  },
  async act(a, signal) {
    const text =
      a.action === "type"
        ? sendKeysText(a.text ?? "")
        : a.action === "key"
          ? sendKeysCombo(parseKeys(a.keys ?? ""))
          : "";
    const out = await exec(powershell(windowsScript(a)), signal, { ORION_COMPUTER_TEXT: text });
    if (a.action === "cursor_position") {
      const [px, py] = out.split(",");
      return `Pointer is at (${px}, ${py}).`;
    }
    return described(a);
  },
};

export function xdotoolArgs(a: ComputerAction): string[] {
  const at = ["mousemove", String(a.x ?? 0), String(a.y ?? 0)];
  switch (a.action) {
    case "cursor_position":
      return ["getmouselocation", "--shell"];
    case "move":
      return at;
    case "click":
      return [...at, "click", "1"];
    case "double_click":
      return [...at, "click", "--repeat", "2", "1"];
    case "right_click":
      return [...at, "click", "3"];
    case "drag":
      return [...at, "mousedown", "1", "mousemove", String(a.toX), String(a.toY), "mouseup", "1"];
    case "scroll": {
      const n = a.amount ?? 3;
      return [...at, "click", "--repeat", String(Math.abs(n)), n >= 0 ? "5" : "4"];
    }
    case "type":
      return ["type", "--delay", "12", "--", a.text ?? ""];
    case "key":
      return ["key", "--", xdotoolCombo(parseKeys(a.keys ?? ""))];
    case "screenshot":
      throw new ComputerRefusal("bad_request", "screenshot is not an xdotool action.");
  }
}

function linuxTool(name: string): string {
  if (process.env.WAYLAND_DISPLAY) {
    throw new ComputerRefusal(
      "unavailable",
      "Computer use on Linux needs an X11 session; this desktop runs Wayland.",
    );
  }
  if (!process.env.DISPLAY) {
    throw new ComputerRefusal("unavailable", "No graphical desktop session (DISPLAY is not set).");
  }
  const path = Bun.which(name);
  if (!path) {
    throw new ComputerRefusal(
      "unavailable",
      `${name} is not installed. Ask the farmer to install ${name === "import" ? "ImageMagick" : name}.`,
    );
  }
  return path;
}

const linuxBackend: Backend = {
  async screenshot(signal) {
    const xdotool = linuxTool("xdotool");
    const importBin = linuxTool("import");
    const [width = 0, height = 0] = (await exec([xdotool, "getdisplaygeometry"], signal))
      .split(/\s+/)
      .map(Number);
    return withTempFile(async (file) => {
      await exec([importBin, "-window", "root", "-quality", "70", file], signal);
      return { data: readFileSync(file), mimeType: "image/jpeg", width, height };
    });
  },
  async act(a, signal) {
    const out = await exec([linuxTool("xdotool"), ...xdotoolArgs(a)], signal);
    if (a.action === "cursor_position") {
      const x = /X=(\d+)/.exec(out)?.[1];
      const y = /Y=(\d+)/.exec(out)?.[1];
      return `Pointer is at (${x}, ${y}).`;
    }
    return described(a);
  },
};

function backendFor(platform: NodeJS.Platform): Backend {
  switch (platform) {
    case "darwin":
      return macBackend;
    case "win32":
      return windowsBackend;
    case "linux":
      return linuxBackend;
    default:
      throw new ComputerRefusal("unavailable", `Computer use is not supported on ${platform}.`);
  }
}

/** Runs one computer action; exported so tests and QA can drive the real backend directly. */
export async function runComputerAction(
  a: ComputerAction,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<AgentToolResult<unknown>> {
  switch (a.action) {
    case "move":
    case "click":
    case "double_click":
    case "right_click":
    case "scroll":
      need(a, "x", "y");
      break;
    case "drag":
      need(a, "x", "y", "toX", "toY");
      break;
    case "type":
      need(a, "text");
      break;
    case "key":
      need(a, "keys");
      break;
    case "screenshot":
    case "cursor_position":
      break;
  }
  const backend = backendFor(platform);
  if (a.action === "screenshot") {
    const shot = await backend.screenshot(signal);
    return {
      content: [
        {
          type: "text",
          text: `Screenshot of the main screen, ${shot.width}x${shot.height}. Pointer coordinates use this image's pixels.`,
        },
        { type: "image", data: shot.data.toString("base64"), mimeType: shot.mimeType },
      ],
      details: { width: shot.width, height: shot.height },
    };
  }
  const done = await backend.act(a, signal);
  return { content: [{ type: "text", text: done }], details: { action: a.action } };
}

export function createComputerTool(): ToolDefinition {
  return {
    name: "computer",
    label: "Use the computer",
    description: [
      "See and operate other programs on this computer: take a screenshot of the main screen, move and click the mouse, drag, scroll, type text and press keys.",
      "Use it when no farm tool or connector covers the job, for example reading figures from a vendor herd-management or milking-robot program.",
      "Start with a screenshot and use its pixel coordinates; take another screenshot after acting to check the result.",
      "Before anything that changes data in another program or cannot be undone (saving, sending, deleting, paying, closing unsaved work), say what you will click or type and wait for the farmer's yes. Screenshots and pointer moves need no permission.",
      "If the result says Refused, stop, tell the farmer what is needed, and do not retry until they confirm.",
    ].join(" "),
    parameters: ComputerParams,
    async execute(_toolCallId, params, signal) {
      try {
        return await runComputerAction(params as ComputerAction, signal);
      } catch (error) {
        if (error instanceof ComputerRefusal) {
          return {
            content: [{ type: "text", text: `Refused (${error.code}): ${error.message}` }],
            details: { code: error.code },
            isError: true,
          };
        }
        throw error;
      }
    },
  } as ToolDefinition;
}
