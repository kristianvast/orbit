// The page the website sends Google sign-in back to: http://127.0.0.1:<port>/account/google/<state>.
// The Google credential arrives in the URL fragment (never sent over the network by the browser);
// the page posts it to itself, Orion signs in with it at Core, and the app hears account.updated.
import { randomBytes } from "node:crypto";
import { AccountError, type AccountService } from "./account";

const STATE = /^\/account\/google\/([A-Za-z0-9_-]{32})$/;
const MAX_CREDENTIAL = 16_384;

type GoogleAccount = Pick<AccountService, "hasGoogleLogin" | "googleFinish">;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function page(nonce: string, live: boolean): string {
  const script = live
    ? `<script nonce="${nonce}">
const out = document.getElementById("msg");
const hash = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const credential = hash.get("credential");
if (!credential) {
  out.textContent = hash.get("error") || "Google did not send a sign-in back. Start again from Orbit.";
} else {
  fetch(location.pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  })
    .then((res) => res.json())
    .then((res) => {
      out.textContent = res.ok
        ? "Signed in to Orbit as " + res.email + ". You can close this tab and go back to Orbit."
        : res.message;
    })
    .catch(() => {
      out.textContent = "Orbit did not answer. Make sure Orbit is open, then start again.";
    });
}
</script>`
    : "";
  const text = live
    ? "Signing in to Orbit..."
    : "This sign-in has expired. Start again from Orbit.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Orbit sign-in</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f3ec;color:#2b2722;display:grid;place-items:center;min-height:100vh;margin:0}p{max-width:28rem;padding:1.5rem;font-size:1.1rem;line-height:1.5;text-align:center}</style>
</head><body><p id="msg" role="status">${text}</p>${script}</body></html>`;
}

export async function serveGoogleCallback(
  req: Request,
  url: URL,
  port: number,
  account: GoogleAccount,
): Promise<Response> {
  const state = STATE.exec(url.pathname)?.[1];
  if (!state) return new Response("not found", { status: 404 });

  if (req.method === "GET") {
    const nonce = randomBytes(16).toString("base64");
    const live = account.hasGoogleLogin(state);
    return new Response(page(nonce, live), {
      status: live ? 200 : 410,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // Only this page may post here: another site in the same browser cannot forge the origin.
  if (req.headers.get("origin") !== `http://127.0.0.1:${port}`) {
    return json({ ok: false, message: "Refused: this request did not come from Orbit." }, 403);
  }
  let credential: unknown;
  try {
    credential = ((await req.json()) as { credential?: unknown }).credential;
  } catch {
    credential = undefined;
  }
  if (typeof credential !== "string" || !credential || credential.length > MAX_CREDENTIAL) {
    return json({ ok: false, message: "Google did not send a valid sign-in." }, 400);
  }
  try {
    const status = await account.googleFinish(state, credential);
    return json({ ok: true, email: status.user?.email ?? "" });
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const status = error.code === "not_found" ? 410 : error.code === "not_ready" ? 502 : 400;
    return json({ ok: false, message: error.message }, status);
  }
}
