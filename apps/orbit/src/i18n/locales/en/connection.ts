import type { Messages } from "../../core";

export const connection = {
  "title.unauthorized": "Orion rejected the security token",
  "title.connecting": "Connecting to Orion on this farm PC…",
  "title.unreachable": "Orion assistant is not reachable right now",
  "detail.unauthorized":
    "Restart Orbit so a fresh local session token can be negotiated with Orion.",
  "detail.waiting":
    "Waiting for local Orion agent at {url}. Your farm data stays safe on this PC and will appear automatically once connected.",
  "state.connecting": "connecting",
  "state.reconnecting": "Reconnecting",
  "state.closed": "closed",
  "state.unauthorized": "unauthorized",
  retry: "Retry connection",
} as const satisfies Messages;
