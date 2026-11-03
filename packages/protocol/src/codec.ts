// Pure encode/decode with runtime validation (typebox Value.Check: no eval, CSP-safe in webviews).

import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  type ClientMessage,
  EVENT_TYPES,
  type EventBody,
  type EventFrame,
  Events,
  type EventType,
  REQUEST_TYPES,
  type RequestFrame,
  type RequestParams,
  type RequestResult,
  Requests,
  type RequestType,
  ResponseFrame,
  type ServerMessage,
} from "./messages";
import type { ProtocolError } from "./model";

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function errorsOf(schema: TSchema, value: unknown): string {
  return Value.Errors(schema, value)
    .slice(0, 3)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
}

function parse(raw: string | Uint8Array | ArrayBuffer): DecodeResult<Record<string, unknown>> {
  let text: string;
  if (typeof raw === "string") text = raw;
  else text = new TextDecoder().decode(raw);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "frame is not valid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "frame must be a JSON object" };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return { ok: false, error: "frame.type must be a string" };
  return { ok: true, value: value as Record<string, unknown> };
}

export function isRequestType(type: string): type is RequestType {
  return (REQUEST_TYPES as string[]).includes(type);
}
export function isEventType(type: string): type is EventType {
  return (EVENT_TYPES as string[]).includes(type);
}

/** Validates request params (without id/type). */
export function validateParams<T extends RequestType>(
  type: T,
  params: unknown,
): DecodeResult<RequestParams<T>> {
  const schema = Requests[type].params;
  if (Value.Check(schema, params)) return { ok: true, value: params as RequestParams<T> };
  return { ok: false, error: `invalid ${type} params: ${errorsOf(schema, params)}` };
}

/** Validates a response result against the request type it answers. */
export function validateResult<T extends RequestType>(
  type: T,
  result: unknown,
): DecodeResult<RequestResult<T>> {
  const schema = Requests[type].result;
  if (Value.Check(schema, result)) return { ok: true, value: result as RequestResult<T> };
  return { ok: false, error: `invalid ${type} result: ${errorsOf(schema, result)}` };
}

export function validateEvent<E extends EventType>(
  type: E,
  body: unknown,
): DecodeResult<EventBody<E>> {
  const schema = Events[type];
  if (Value.Check(schema, body)) return { ok: true, value: body as EventBody<E> };
  return { ok: false, error: `invalid ${type} event: ${errorsOf(schema, body)}` };
}

/** Server side: decode and validate a frame sent by the UI. */
export function decodeClientMessage(
  raw: string | Uint8Array | ArrayBuffer,
): DecodeResult<ClientMessage> {
  const parsed = parse(raw);
  if (!parsed.ok) return parsed;
  const frame = parsed.value;
  const type = frame.type as string;
  if (!isRequestType(type)) return { ok: false, error: `unknown request type: ${type}` };
  if (typeof frame.id !== "string" || frame.id.length === 0) {
    return { ok: false, error: "request id must be a non-empty string" };
  }
  const { id: _id, type: _type, ...params } = frame;
  const checked = validateParams(type, params);
  if (!checked.ok) return checked;
  return { ok: true, value: frame as ClientMessage };
}

/** Client side: decode and validate a frame sent by Orion. Response results are not checked here. */
export function decodeServerMessage(
  raw: string | Uint8Array | ArrayBuffer,
): DecodeResult<ServerMessage> {
  const parsed = parse(raw);
  if (!parsed.ok) return parsed;
  const frame = parsed.value;
  const type = frame.type as string;
  if (type === "response") {
    if (Value.Check(ResponseFrame, frame)) return { ok: true, value: frame as ResponseFrame };
    return { ok: false, error: `invalid response: ${errorsOf(ResponseFrame, frame)}` };
  }
  if (!isEventType(type)) return { ok: false, error: `unknown event type: ${type}` };
  const { type: _type, ...body } = frame;
  const checked = validateEvent(type, body);
  if (!checked.ok) return checked;
  return { ok: true, value: frame as EventFrame };
}

export function encodeRequest<T extends RequestType>(
  id: string,
  type: T,
  params: RequestParams<T>,
): string {
  return JSON.stringify({ ...(params as object), id, type } as RequestFrame<T>);
}

export function encodeEvent<E extends EventType>(type: E, body: EventBody<E>): string {
  return JSON.stringify({ ...(body as object), type });
}

export function encodeResult(id: string, result: unknown): string {
  return JSON.stringify({ type: "response", id, ok: true, result } satisfies ResponseFrame);
}

export function encodeError(id: string, error: ProtocolError): string {
  return JSON.stringify({ type: "response", id, ok: false, error } satisfies ResponseFrame);
}

/** Parses the sidecar stdout line `ORION_READY {"port":N}`; returns null for any other line. */
export function parseReadyLine(line: string): { port: number } | null {
  const match = /^ORION_READY (\{.*\})\s*$/.exec(line);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1] as string) as { port?: unknown };
    return typeof value.port === "number" && Number.isInteger(value.port)
      ? { port: value.port }
      : null;
  } catch {
    return null;
  }
}
