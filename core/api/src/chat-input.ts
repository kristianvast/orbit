export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const date = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
export const title = (v: unknown): v is string => typeof v === "string" && v.length <= 200;
export const entry = (
  v: unknown,
): v is Record<string, unknown> & { id: string; parentId: string | null } =>
  record(v) &&
  typeof v.id === "string" &&
  v.id.length > 0 &&
  v.id.length <= 128 &&
  typeof v.type === "string" &&
  v.type !== "session" &&
  (v.parentId === null || typeof v.parentId === "string") &&
  date(v.timestamp) &&
  (v.type !== "message" || (record(v.message) && typeof v.message.role === "string")) &&
  Buffer.byteLength(JSON.stringify(v)) <= 512 * 1024;
