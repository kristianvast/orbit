import type { Messages } from "../../core";

export const connection = {
  "title.unauthorized": "Orion rejected the security token",
  "title.connecting": "Connecting to Orion on this farm PC…",
  "title.unreachable": "Orion assistant is not reachable right now",
  "title.stopped": "Orion has stopped",
  "detail.stopped":
    "Orbit tried to restart Orion and it kept stopping. Your farm data is safe on this PC. Details: {reason}",
  "detail.unauthorized":
    "Restart Orbit so a fresh local session token can be negotiated with Orion.",
  "detail.waiting":
    "Waiting for local Orion agent at {url}. Your farm data stays safe on this PC and will appear automatically once connected.",
  "state.connecting": "connecting",
  "state.reconnecting": "Reconnecting",
  "state.closed": "closed",
  "state.unauthorized": "unauthorized",
  "state.stopped": "Stopped",
  retry: "Retry connection",
  restart: "Restart Orion",
} as const satisfies Messages;
