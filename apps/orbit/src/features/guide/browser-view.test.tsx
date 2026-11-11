import type {
  ConnectionState,
  EventFrame,
  EventType,
  OrionClient,
  ServerEvent,
} from "@orbit/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { OrionProvider } from "../../lib/orion";
import { BrowserView } from "./index";

function createEventClient(): {
  readonly client: OrionClient;
  readonly emit: (event: EventFrame<"browser.view">) => void;
} {
  const listeners = new Map<string, Set<(ev: ServerEvent) => void>>();
  const state: ConnectionState = "open";

  function on<E extends EventType>(type: E, handler: (event: EventFrame<E>) => void): () => void;
  function on(type: "*", handler: (event: ServerEvent) => void): () => void;
  function on(type: string, handler: (event: never) => void): () => void {
    const fn = handler as (ev: ServerEvent) => void;
    const set = listeners.get(type) ?? new Set();
    set.add(fn);
    listeners.set(type, set);
    return () => {
      set.delete(fn);
    };
  }

  const client: OrionClient = {
    state,
    server: null,
    request: () => Promise.reject(new Error("not used in BrowserView test")),
    query: () => Promise.reject(new Error("not used in BrowserView test")),
    mutate: () => Promise.reject(new Error("not used in BrowserView test")),
    on,
    onState: () => () => {},
    ready: () => Promise.resolve(),
    close: () => {},
  };

  const emit = (event: EventFrame<"browser.view">) => {
    for (const fn of listeners.get("browser.view") ?? []) fn(event);
    for (const fn of listeners.get("*") ?? []) fn(event);
  };

  return { client, emit };
}

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrowserView", () => {
  it("renders nothing before an event, scales the highlight box to the rendered frame and after resize, ignores other sessions, and clears on image: null", () => {
    const { client, emit } = createEventClient();

    render(
      <I18nProvider initialLocale="en">
        <OrionProvider initialClient={client}>
          <BrowserView sessionId="sess-1" />
        </OrionProvider>
      </I18nProvider>,
    );

    expect(screen.queryByTestId("browser-view")).not.toBeInTheDocument();

    act(() => {
      emit({
        type: "browser.view",
        sessionId: "sess-other",
        url: "https://supplier.example/feed",
        title: "Feed Portal",
        image: "/9j/4AAQSkZJRg==",
        width: 1280,
        height: 900,
        highlight: null,
      });
    });
    expect(screen.queryByTestId("browser-view")).not.toBeInTheDocument();

    act(() => {
      emit({
        type: "browser.view",
        sessionId: "sess-1",
        url: "https://registry.example/herd",
        title: "Herd Registry",
        image: "/9j/4AAQSkZJRg==",
        width: 1280,
        height: 900,
        highlight: {
          x: 320,
          y: 180,
          width: 256,
          height: 90,
          note: "Sign in here.",
        },
      });
    });

    const view = screen.getByTestId("browser-view");
    expect(view).toBeInTheDocument();
    expect(view).toHaveTextContent("Herd Registry");
    expect(view).toHaveTextContent("https://registry.example/herd");

    const frame = screen.getByTestId("browser-view-frame");
    expect(frame).toHaveAttribute("src", "data:image/jpeg;base64,/9j/4AAQSkZJRg==");

    let currentWidth = 640;
    let currentHeight = 450;
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() =>
      makeRect(0, 0, currentWidth, currentHeight),
    );
    if (frame.parentElement) {
      vi.spyOn(frame.parentElement, "getBoundingClientRect").mockImplementation(() =>
        makeRect(0, 0, currentWidth, currentHeight),
      );
    }

    act(() => {
      fireEvent.load(frame);
    });

    const highlight = screen.getByTestId("browser-highlight");
    expect(highlight).toHaveStyle({
      left: "160px",
      top: "90px",
      width: "128px",
      height: "45px",
    });
    expect(highlight).toHaveTextContent("Sign in here.");

    currentWidth = 320;
    currentHeight = 225;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(highlight).toHaveStyle({
      left: "80px",
      top: "45px",
      width: "64px",
      height: "22.5px",
    });

    act(() => {
      emit({
        type: "browser.view",
        sessionId: "sess-1",
        url: "https://registry.example/herd",
        title: "Herd Registry",
        image: null,
        width: 1280,
        height: 900,
        highlight: null,
      });
    });

    expect(screen.queryByTestId("browser-view")).not.toBeInTheDocument();
  });
});
