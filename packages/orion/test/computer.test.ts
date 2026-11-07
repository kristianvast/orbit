import { describe, expect, test } from "bun:test";
import {
  ComputerRefusal,
  createComputerTool,
  macKeyCommand,
  macPointerScript,
  parseKeys,
  sendKeysCombo,
  sendKeysText,
  xdotoolArgs,
  xdotoolCombo,
} from "../src/agent/computer";

describe("computer tool key mapping", () => {
  test("parses modifiers, named keys, aliases and the plus key", () => {
    expect(parseKeys("Cmd+Shift+4")).toEqual({ mods: ["cmd", "shift"], key: { char: "4" } });
    expect(parseKeys("return")).toEqual({ mods: [], key: { named: "enter" } });
    expect(parseKeys("ctrl++")).toEqual({ mods: ["ctrl"], key: { char: "+" } });
    expect(() => parseKeys("hyper+x")).toThrow(ComputerRefusal);
    expect(() => parseKeys("ctrl+enterr")).toThrow(ComputerRefusal);
  });

  test("macOS passes characters as an argument, never inside the script", () => {
    expect(macKeyCommand(parseKeys("cmd+s"))).toEqual([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      'tell application "System Events" to keystroke (item 1 of argv) using {command down}',
      "-e",
      "end run",
      "s",
    ]);
    expect(macKeyCommand(parseKeys('"')).at(-1)).toBe('"');
    expect(macKeyCommand(parseKeys("enter"))[4]).toBe(
      'tell application "System Events" to key code 36',
    );
  });

  test("Windows escapes SendKeys syntax and refuses the Windows key", () => {
    expect(sendKeysText("a+b {x} 50%")).toBe("a{+}b {{}x{}} 50{%}");
    expect(sendKeysCombo(parseKeys("ctrl+shift+s"))).toBe("^+s");
    expect(sendKeysCombo(parseKeys("alt+f4"))).toBe("%{F4}");
    expect(() => sendKeysCombo(parseKeys("win+r"))).toThrow(ComputerRefusal);
  });

  test("Linux maps to xdotool key names and arguments", () => {
    expect(xdotoolCombo(parseKeys("cmd+pageup"))).toBe("super+Prior");
    expect(xdotoolArgs({ action: "scroll", x: 5, y: 6, amount: -2 })).toEqual([
      "mousemove",
      "5",
      "6",
      "click",
      "--repeat",
      "2",
      "4",
    ]);
    expect(xdotoolArgs({ action: "type", text: "--help" })).toEqual([
      "type",
      "--delay",
      "12",
      "--",
      "--help",
    ]);
  });

  test("macOS pointer scripts post a press and release at the target", () => {
    const script = macPointerScript({ action: "click", x: 10, y: 20 });
    expect(script).toContain("ev(1,10,20,0,1);ev(2,10,20,0,1);");
  });
});

describe("computer tool refusals", () => {
  test("missing coordinates come back as a refusal result, not a thrown error", async () => {
    const tool = createComputerTool();
    const result = await tool.execute(
      "call-1",
      { action: "click" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Refused (bad_request): click needs x, y.",
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
