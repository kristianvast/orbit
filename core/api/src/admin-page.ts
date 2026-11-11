// Plain review inbox: authenticate, read feedback, then inspect and review shared builds.
// Layout: a bounded reading column with document scrolling; forms wrap on phones.
// Native controls, system fonts and inline styles keep this page independent of the app.
export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Feedback review</title>
<style>
:root { color-scheme:light dark; --bg:#faf9f5; --ink:#252522; --surface:#fff;
  --line:#78766e; --muted:#57554f; --focus:#9b4128; --action:#33332f; --on-action:#fff; }
@media(prefers-color-scheme:dark) { :root { --bg:#20201e; --ink:#f5f3eb; --surface:#2c2c29;
  --line:#aaa69a; --muted:#c6c2b6; --focus:#ffb599; --action:#e5e1d5; --on-action:#20201e; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 system-ui,sans-serif; }
main { max-width:76ch; margin:auto; padding:24px max(16px,env(safe-area-inset-left)) 64px; }
h1 { font-size:32px; margin:0 0 24px; } h2 { font-size:25px; margin:40px 0 16px; }
h3 { font-size:20px; margin:24px 0 12px; } p { margin:12px 0; }
form,.actions { display:flex; flex-wrap:wrap; gap:12px; align-items:end; }
label { display:grid; gap:4px; min-width:0; } #login label { flex:1 1 240px; }
input,select,textarea,button { font:inherit; color:var(--ink); background:var(--surface);
  border:1px solid var(--line); border-radius:4px; min-height:44px; padding:8px 12px; max-width:100%; }
input,textarea { width:100%; caret-color:var(--focus); }
textarea { min-height:100px; resize:vertical; }
button { cursor:pointer; } button:hover { text-decoration:underline; }
button:active { opacity:.8; } button:disabled { opacity:.6; cursor:wait; }
button.primary { background:var(--action); color:var(--on-action); border-color:var(--action); }
:focus-visible { outline:2px solid var(--focus); outline-offset:3px; }
article { padding:24px 0; border-bottom:1px solid var(--line); }
article:first-child { padding-top:0; } article h3 { margin-top:0; }
.meta { color:var(--muted); font-size:14px; font-variant-numeric:tabular-nums; }
.text,pre { white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
pre { font-size:14px; line-height:1.6; }
.note { flex:1 1 100%; } details { margin:16px 0; } summary { cursor:pointer; padding:8px 0; min-height:44px; }
[hidden] { display:none !important; } #notice { min-height:26px; overflow-wrap:anywhere; }
::selection { background:var(--ink); color:var(--bg); }
</style>
</head>
<body><main>
<h1>Feedback review</h1>
<form id="login">
<label>Admin token<input id="token" type="password" autocomplete="current-password" required></label>
<button class="primary" type="submit">Open inbox</button>
</form>
<p id="notice" role="status" aria-live="polite">Enter your admin token to review feedback and shared builds.</p>
<div id="inbox" hidden>
<div class="actions"><button id="refresh" type="button">Refresh</button><button id="logout" type="button">Forget token</button></div>
<section aria-labelledby="feedback-heading"><h2 id="feedback-heading">Feedback</h2><div id="feedback"></div></section>
<section aria-labelledby="submissions-heading"><h2 id="submissions-heading">Submissions</h2><div id="submissions"></div></section>
</div>
<noscript>JavaScript is required to load and review the inbox.</noscript>
</main>
<script>
"use strict";
const tokenInput = document.getElementById("token");
const login = document.getElementById("login");
const inbox = document.getElementById("inbox");
const notice = document.getElementById("notice");
let token = sessionStorage.getItem("core-admin-token") || "";
let generation = 0;
function element(tag, text, parent, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  if (parent) parent.append(node);
  return node;
}
async function api(path, method, body) {
  const response = await fetch("/v1/admin/" + path, {
    method:method || "GET", headers: {authorization:"Bearer " + token, "content-type":"application/json"},
    body:body === undefined ? undefined : JSON.stringify(body), cache:"no-store"
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ? data.error.message : "Request failed");
  return data;
}
function report(error) { notice.textContent = error.message || "Request failed"; }
function statusForm(parent, path, row, statuses, withNote) {
  const form = element("form", undefined, parent);
  const label = element("label", "Status", form);
  const select = element("select", undefined, label);
  statuses.forEach(status => { const option = element("option", status, select); option.value = status; });
  select.value = row.status;
  let note;
  if (withNote) {
    const label = element("label", "Review note", form, "note");
    note = element("textarea", undefined, label); note.value = row.reviewNote || "";
  }
  const save = element("button", "Save review", form); save.type = "submit";
  form.addEventListener("submit", async event => {
    event.preventDefault(); save.disabled = true; notice.textContent = "Saving review...";
    try {
      await api(path, "PATCH", {status:select.value, ...(note ? {reviewNote:note.value} : {})});
      notice.textContent = "Review saved."; await load(false);
    } catch (error) { report(error); } finally { save.disabled = false; }
  });
}
function meta(parent, row) {
  element("p", row.kind + " | " + row.status + " | " + new Date(row.createdAt).toLocaleString(), parent, "meta");
  element("p", "User: " + (row.userId || "anonymous") + " | Farm: " + (row.farmId || "-"), parent, "meta text");
}
function feedbackRows(rows) {
  const root = document.getElementById("feedback"); root.replaceChildren();
  if (!rows.length) element("p", "No feedback yet.", root);
  rows.forEach(row => {
    const article = element("article", undefined, root);
    meta(article, row);
    element("p", row.message, article, "text");
    element("p", "Contact: " + (row.contactEmail || "-") + " | Version: " + (row.appVersion || "-") +
      " | OS: " + (row.os || "-") + " | Locale: " + (row.locale || "-"), article, "meta text");
    if (row.diagnostics) {
      const details = element("details", undefined, article);
      element("summary", "Diagnostics", details); element("pre", row.diagnostics, details);
    }
    statusForm(article, "feedback/" + row.id, row, ["new","read","done"], false);
  });
}
function submissionRows(rows) {
  const root = document.getElementById("submissions"); root.replaceChildren();
  if (!rows.length) element("p", "No submissions yet.", root);
  rows.forEach(row => {
    const article = element("article", undefined, root);
    element("h3", row.title, article, "text"); meta(article, row);
    element("p", row.name + " | Version: " + (row.appVersion || "-"), article, "meta text");
    element("p", row.description, article, "text");
    const show = element("button", "Show files", article); show.type = "button";
    const files = element("div", undefined, article);
    show.addEventListener("click", async () => {
      show.disabled = true; notice.textContent = "Loading files...";
      const current = generation;
      try {
        const detail = await api("submissions/" + row.id);
        if (current !== generation) return;
        files.replaceChildren();
        detail.files.forEach(file => {
          const item = element("details", undefined, files);
          element("summary", file.path, item, "text"); element("pre", file.content, item);
        });
        show.hidden = true; notice.textContent = "Files loaded.";
      } catch (error) { report(error); } finally { show.disabled = false; }
    });
    statusForm(article, "submissions/" + row.id, row, ["pending","approved","rejected"], true);
  });
}
async function load(announce = true) {
  const current = ++generation;
  if (announce) notice.textContent = "Loading inbox...";
  try {
    const [feedback, submissions] = await Promise.all([api("feedback"), api("submissions")]);
    if (current !== generation) return;
    feedbackRows(feedback.feedback); submissionRows(submissions.submissions);
    login.hidden = true; inbox.hidden = false; tokenInput.value = "";
    sessionStorage.setItem("core-admin-token", token);
    if (announce) notice.textContent = "Inbox loaded.";
  } catch (error) { if (current === generation) report(error); }
}
login.addEventListener("submit", event => { event.preventDefault(); token = tokenInput.value.trim(); load(); });
document.getElementById("refresh").addEventListener("click", () => load());
document.getElementById("logout").addEventListener("click", () => {
  ++generation; token = ""; sessionStorage.removeItem("core-admin-token");
  document.getElementById("feedback").replaceChildren(); document.getElementById("submissions").replaceChildren();
  inbox.hidden = true; login.hidden = false; notice.textContent = "Token forgotten."; tokenInput.focus();
});
if (token) load();
</script>
</body></html>`;
