import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWebTools, htmlToText, parseSearchResults } from "../src/agent/web";

const SEARCH_PAGE = `<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fhoof%2Dcare&amp;rut=abc">Hoof care &amp; trimming</a>
  <a class="result__snippet" href="#">Trim <b>twice</b> a year.</a>
</div>
<div class="result result--ad">
  <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.test">Buy trimmers</a>
</div>
<div class="result">
  <a class="result__a" href="https://vet.test/lameness">Lameness scoring</a>
  <a class="result__snippet" href="#">A five-point scale.</a>
</div>`;

const LONG_PAGE = `<html><head><title>Barn notes</title><style>p{color:red}</style></head>
<body><script>steal()</script><h1>Barn notes</h1><p>${"Feed twice daily. ".repeat(80)}</p>
<p>See <a href="/silage">silage guide</a>.</p></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let base: string;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname, searchParams } = new URL(request.url);
      if (pathname === "/search") {
        if (searchParams.get("q") === "blocked") return new Response("slow down", { status: 202 });
        return new Response(SEARCH_PAGE, { headers: { "content-type": "text/html" } });
      }
      if (pathname === "/page") {
        return new Response(LONG_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (pathname === "/manual.pdf") {
        return new Response(new Uint8Array([37, 80, 68, 70]), {
          headers: { "content-type": "application/pdf" },
        });
      }
      return new Response("gone", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function call(tool: ToolDefinition | undefined, params: unknown) {
  if (!tool) throw new Error("tool missing");
  const result = (await tool.execute(
    "call",
    params as never,
    undefined,
    undefined,
    {} as never,
  )) as AgentToolResult<unknown> & { isError?: boolean };
  const first = result.content[0];
  return {
    text: first?.type === "text" ? first.text : "",
    details: result.details,
    isError: result.isError === true,
  };
}

describe("htmlToText", () => {
  test("keeps what a person reads, marks headings, and writes links out in full", async () => {
    const page = await htmlToText(
      '<html><head><title>A &amp; B</title><script>x()</script></head><body><h2>Dry cows</h2><p>Move at&nbsp;60 days &#8211; see <a href="/dry">the plan</a> or <a href="#top">top</a>.</p><style>.a{}</style></body></html>',
      "https://farm.test/guide/",
    );
    expect(page.title).toBe("A & B");
    expect(page.text).toBe(
      "# Dry cows\n\nMove at 60 days \u2013 see the plan [https://farm.test/dry] or top.",
    );
  });
});

describe("parseSearchResults", () => {
  test("unwraps the redirect address, decodes text and drops advertising", async () => {
    expect(await parseSearchResults(SEARCH_PAGE)).toEqual([
      {
        title: "Hoof care & trimming",
        url: "https://example.test/hoof-care",
        snippet: "Trim twice a year.",
      },
      {
        title: "Lameness scoring",
        url: "https://vet.test/lameness",
        snippet: "A five-point scale.",
      },
    ]);
  });
});

describe("web tools", () => {
  test("web_search lists results and tells Orion when the service turns it away", async () => {
    const [search] = createWebTools({ searchUrl: `${base}/search` });
    const found = await call(search, { query: "hoof care", maxResults: 1 });
    expect(found.isError).toBe(false);
    expect(found.details).toEqual({
      results: [
        {
          title: "Hoof care & trimming",
          url: "https://example.test/hoof-care",
          snippet: "Trim twice a year.",
        },
      ],
    });
    const blocked = await call(search, { query: "blocked" });
    expect(blocked.isError).toBe(true);
    expect(blocked.details).toEqual({ status: 202 });
  });

  test("web_fetch returns a long page in parts and never the page's scripts", async () => {
    const [, read] = createWebTools();
    const first = await call(read, { url: `${base}/page`, maxChars: 500 });
    const info = first.details as { title: string; start: number; end: number; total: number };
    expect(info).toMatchObject({ title: "Barn notes", start: 0, end: 500 });
    expect(info.total).toBeGreaterThan(1000);
    expect(first.text).not.toContain("steal()");
    expect(first.text).toContain(`call web_fetch again with start 500`);

    const last = await call(read, { url: `${base}/page`, start: info.total - 60, maxChars: 500 });
    expect(last.text).toContain(`silage guide [${base}/silage]`);
    expect(last.details).toMatchObject({ end: info.total });
  });

  test("web_fetch refuses files that are not text, missing pages and non-web addresses", async () => {
    const [, read] = createWebTools();
    expect(await call(read, { url: `${base}/manual.pdf` })).toMatchObject({
      isError: true,
      details: { type: "application/pdf" },
    });
    expect(await call(read, { url: `${base}/nowhere` })).toMatchObject({
      isError: true,
      details: { status: 404 },
    });
    expect((await call(read, { url: "file:///etc/passwd" })).isError).toBe(true);
  });
});
