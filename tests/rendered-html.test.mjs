import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the DART corpus viewer shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>DART Corpus Viewer<\/title>/i);
  assert.match(html, /DART Corpus Viewer/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("viewer keeps corpus access local and read-only", async () => {
  const [viewer, api, packageJson] = await Promise.all([
    readFile(new URL("../app/viewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/viewer-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(viewer, /원본 읽기 전용/);
  assert.match(viewer, /http:\/\/127\.0\.0\.1:4318/);
  assert.match(api, /safeSourcePath/);
  assert.match(api, /resolved\.startsWith\(rootPrefix\)/);
  assert.doesNotMatch(api, /writeFile|unlink|rename|rmSync|rmdir/);
  assert.match(packageJson, /"viewer": "node scripts\/start-viewer\.mjs"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
