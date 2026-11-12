import type { LocalUiStatus } from "@orbit/protocol";
import { describe, expect, it } from "vitest";
import { updateAction } from "./updater";

const build = (state: LocalUiStatus["state"], baseVersion?: string | null): LocalUiStatus => ({
  state,
  path: state === "none" ? null : "/app/t/",
  builtAt: null,
  commit: null,
  baseVersion,
});

describe("updateAction", () => {
  it("sends a farm with its own build on an older version to chat first", () => {
    expect(updateAction("0.1.7", build("ready", "0.1.6"))).toBe("chat");
    expect(updateAction("0.1.7", build("broken", "0.1.6"))).toBe("chat");
    // An Orion from before updates does not say which version its build sits on.
    expect(updateAction("0.1.7", build("ready"))).toBe("chat");
  });

  it("just installs when there is no farm build or it already sits on the new version", () => {
    expect(updateAction("0.1.7", build("none"))).toBe("restart");
    expect(updateAction("0.1.7", null)).toBe("restart");
    expect(updateAction("0.1.7", build("ready", "0.1.7"))).toBe("restart");
  });
});
