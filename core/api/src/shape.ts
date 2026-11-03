// GET /v1/shape: authenticated proxy in front of Electric. The client chooses only the table and
// its stream position; Core forces the row filter to the token's farm so a farm can never read
// another farm's rows (https://electric-sql.com/docs/guides/auth).
import { SYNCED_TABLES } from "@orbit/schema";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const PASSTHROUGH_PARAMS = ["offset", "handle", "live", "cursor"] as const;

export interface ShapeProxyOptions {
  electricUrl: string;
  electricSecret?: string;
  fetch: FetchLike;
}

export async function proxyShape(
  request: Request,
  farmId: string,
  options: ShapeProxyOptions,
): Promise<Response> {
  const incoming = new URL(request.url).searchParams;
  const table = incoming.get("table") ?? "";
  if (!(SYNCED_TABLES as readonly string[]).includes(table)) {
    return Response.json(
      { error: `table must be one of ${SYNCED_TABLES.join(", ")}` },
      { status: 400 },
    );
  }
  if (!incoming.get("offset"))
    return Response.json({ error: "offset is required" }, { status: 400 });

  const upstream = new URL("/v1/shape", options.electricUrl);
  upstream.searchParams.set("table", table);
  for (const key of PASSTHROUGH_PARAMS) {
    const v = incoming.get(key);
    if (v !== null) upstream.searchParams.set(key, v);
  }
  upstream.searchParams.set("where", "farm_id = $1");
  upstream.searchParams.set("params[1]", farmId);
  upstream.searchParams.set("replica", "full");
  if (options.electricSecret) upstream.searchParams.set("secret", options.electricSecret);

  let res: Response;
  try {
    res = await options.fetch(upstream, { signal: request.signal });
  } catch (err) {
    return Response.json(
      { error: `electric unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }
  const headers = new Headers(res.headers);
  // fetch already decoded the body, so the upstream encoding/length no longer apply.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("vary", "authorization");
  return new Response(res.body, { status: res.status, headers });
}
