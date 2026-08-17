// Turn M9: a minimal, dependency-free Chrome DevTools Protocol driver
// used to prove the offline review UI actually renders and behaves
// correctly in a real browser, not just via static regex checks on the
// HTML text. Uses ONLY Node built-ins (child_process, global fetch,
// global WebSocket) plus the local Google Chrome.app already installed
// on this machine -- no puppeteer/playwright, no network access (Chrome
// itself is launched with no default browser check and no network
// service beyond the local CDP loopback port).
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export async function launchHeadlessChromePage({ url, port } = {}) {
  const chromePath = CHROME_CANDIDATES[0];
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "seed-headless-cdp-"));
  const resolvedPort = port ?? 9333 + Math.floor(Math.random() * 500);

  const proc = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    `--remote-debugging-port=${resolvedPort}`, `--user-data-dir=${userDataDir}`,
  ], { stdio: "ignore" });

  await waitForCdp(resolvedPort);

  const createRes = await fetch(`http://127.0.0.1:${resolvedPort}/json/new?about:blank`, { method: "PUT" });
  const target = await createRes.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`page evaluate threw: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  }

  await send("Page.enable", {});
  await send("Runtime.enable", {});
  // Auto-accept any confirm()/alert() dialog the page might open (the
  // review UI's reset button uses window.confirm) so evaluation never
  // hangs waiting for a dialog no human is present to answer.
  await send("Page.setBypassCSP", { enabled: true });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Page.javascriptDialogOpening") {
      send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    }
  });

  if (url) {
    await send("Page.navigate", { url });
    await waitForLoad(send);
  }

  async function close() {
    try { ws.close(); } catch { /* ignore */ }
    // SIGTERM is not reliable here: headless Chrome can be mid-way through
    // an internal download-manager operation (e.g. a real <a download>
    // click against a blob: URL, with no Page.setDownloadBehavior set) and
    // ignore/delay SIGTERM well past any reasonable fallback wait, which
    // leaves the CDP WebSocket's underlying socket open and the Node test
    // process hanging forever after all assertions already passed. SIGKILL
    // guarantees the OS tears down the process (and its socket) immediately.
    proc.kill("SIGKILL");
    await new Promise((resolve) => { proc.once("exit", resolve); setTimeout(resolve, 3000); });
    await rm(userDataDir, { recursive: true, force: true });
  }

  return { evaluate, send, close };
}

async function waitForCdp(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`headless Chrome CDP endpoint on port ${port} did not become ready in time`);
}

async function waitForLoad(send) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (result.result.value === "complete") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("page did not finish loading in time");
}
