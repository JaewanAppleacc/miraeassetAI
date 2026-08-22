// Turn M9: a minimal, dependency-free Chrome DevTools Protocol driver
// used to prove the offline review UI actually renders and behaves
// correctly in a real browser, not just via static regex checks on the
// HTML text. Uses ONLY Node built-ins (child_process, global fetch,
// global WebSocket) plus the local Google Chrome.app already installed
// on this machine -- no puppeteer/playwright, no network access (Chrome
// itself is launched with no default browser check and no network
// service beyond the local CDP loopback port).
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

// Turn N4.1a (user-reported defect, confirmed via two real hung process
// trees -- one 11 hours old, one 3+ hours old, both stuck inside the same
// UI test): every CDP `send()` call used to return a Promise with NO
// timeout at all. If Chrome never replied to a command (plausible after a
// download-related renderer state change, since downloads previously had
// no configured destination -- see downloadDir below), the `await` hung
// forever. `node --test` is run with --test-timeout=0 project-wide, so
// nothing on the test-runner side rescued it either. DEFAULT_CDP_TIMEOUT_MS
// bounds every individual command; DEFAULT_SETUP_TIMEOUT_MS bounds the
// one-time WebSocket-open/initial-fetch handshake steps.
export const DEFAULT_CDP_TIMEOUT_MS = 15_000;
const DEFAULT_SETUP_TIMEOUT_MS = 10_000;

// A tiny, dependency-free "pending CDP requests" registry, exported so its
// timeout/reject-all behavior can be regression-tested in isolation, in
// milliseconds, without needing a real hung Chrome command (see
// tests/headless-chrome-cdp-cleanup.test.mjs).
export function createPendingRequests(timeoutMs = DEFAULT_CDP_TIMEOUT_MS) {
  const pending = new Map();

  function register(id, resolve, reject, label) {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command "${label}" timed out after ${timeoutMs}ms with no response`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    pending.set(id, { resolve, reject, timer });
  }

  // Returns true if a pending request for `id` was found and settled,
  // false otherwise (already timed out, or no such id -- both are no-ops).
  function settle(id, msg) {
    const entry = pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(id);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
    return true;
  }

  function rejectAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  return { register, settle, rejectAll, size: () => pending.size };
}

function withDeadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// Turn N2.2: everything from the Chrome spawn onward used to run with no
// enclosing try/catch. If ANY step after userDataDir/proc were created
// threw (waitForCdp timeout, the initial fetch/WebSocket handshake
// failing, an early send() rejecting), the function's own await chain
// rejected before ever reaching `return { evaluate, send, close }` -- so
// the caller's `page = await launchHeadlessChromePage(...)` assignment
// never completed, `page` stayed unset, and `test.after(() => { if
// (page) await page.close(); })`'s guard silently skipped cleanup even
// though a real Chrome process and a real userDataDir already existed.
// killAndCleanup() is the single place both are torn down.
//
// Turn N2.3 (Codex-reported defect): the original version of this
// function swallowed EVERY rm() error unconditionally
// (`.catch(() => {})`), including genuine, non-ENOENT failures (e.g. a
// permission problem) that a caller debugging a flaky setup failure would
// have wanted to see. `force: true` on rm() already makes ENOENT a no-op
// (it never throws for "already gone"), so anything that DOES reach the
// catch below is a real, unexpected cleanup problem -- collected here and
// returned rather than discarded, so the caller (launchHeadlessChromePage's
// own catch block) can report it ALONGSIDE the original setup error
// instead of one silently replacing the other.
//
// Turn N4.1a: `dirs` now accepts either a single path (backward
// compatible with every existing caller/test) or an array of paths, so a
// setup failure can clean up BOTH the userDataDir and the new dedicated
// downloadDir in one call.
// Exported (this file lives under tests/lib/ -- it is itself test-only
// infrastructure, not production code) so the setup-failure cleanup path
// can be regression-tested directly, without needing to force a real
// Chrome CDP handshake failure for every scenario -- see
// tests/headless-chrome-cdp-cleanup.test.mjs.
// Turn N4.1a (found while verifying THIS turn's own new tests): Chrome's
// crashpad crash-handler process is deliberately NOT a normal child that
// dies with the browser -- its entire purpose is to survive the browser
// process dying, so it can report the crash. It is spawned detached from
// our tracked `proc`, so SIGKILL to `proc` alone never reaches it. It (or
// a similar untracked helper) was observed recreating an EMPTY userDataDir
// at the exact same path microseconds after rm() had already completed
// successfully -- meaning the original single-shot rm() could report
// "cleaned up" while a residual directory reappeared right after, exactly
// the "cleanup errors hidden as success" failure mode this file's own
// contract forbids. Fixed at two layers: (1) `proc.pid` is now killed as a
// process GROUP (negative pid), reaching any ordinary, non-detached helper
// (GPU/renderer) that shares its pgid; (2) removeDirCompletely() below
// does a bounded recheck-after-delete and reports any directory that
// reappears as a real cleanup error instead of silently accepting it.
async function killProcessGroup(proc) {
  if (!(proc && proc.exitCode === null && proc.signalCode === null)) return;
  // proc.kill() first, exactly as before -- a genuine failure here is a
  // real cleanup error and must propagate (preserves the pre-existing
  // fake-proc test contract exactly, including error messages/codes).
  proc.kill("SIGKILL");
  // Supplementary, best-effort only: also SIGKILL the whole process GROUP
  // (proc's pid, if spawned with detached: true, is also its pgid), so a
  // non-detached helper process (GPU/renderer) sharing that pgid is
  // reached too. Never itself a source of a reported cleanup error --
  // proc.kill() above already carries that responsibility, and group-kill
  // semantics/permissions can legitimately vary by platform/sandbox.
  if (typeof proc.pid === "number" && proc.pid > 0) {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* best-effort */ }
  }
  await new Promise((resolve) => { proc.once("exit", resolve); setTimeout(resolve, 3000); });
}

async function removeDirCompletely(dir) {
  await rm(dir, { recursive: true, force: true });
  // One bounded recheck-and-retry pass: give a detached helper process
  // that raced with the line above a moment to finish, then remove
  // whatever it left and verify the path is genuinely gone.
  await new Promise((r) => setTimeout(r, 200));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await stat(dir);
    throw new Error(`residual directory reappeared after cleanup (likely a detached Chrome helper process, e.g. crashpad): ${dir}`);
  } catch (error) {
    if (error.code === "ENOENT") return; // genuinely gone
    throw error;
  }
}

export async function killAndCleanup(proc, dirs) {
  const cleanupErrors = [];
  try {
    await killProcessGroup(proc);
  } catch (error) {
    cleanupErrors.push(error);
  }
  const dirList = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
  for (const dir of dirList) {
    try {
      await removeDirCompletely(dir);
    } catch (error) {
      if (error.code !== "ENOENT") cleanupErrors.push(error);
    }
  }
  return cleanupErrors;
}

// Turn N4.1a: polls a dedicated downloadDir for a completed (non-
// `.crdownload`) file. Explicitly fails if only an in-progress
// `.crdownload` fragment exists once `timeoutMs` elapses, rather than
// hanging or silently reporting success on a partial file -- this is what
// actually proves the FINAL-export button produced a real, complete file,
// not just a UI success message.
export async function waitForDownloadCompletion({ downloadDir, timeoutMs = DEFAULT_CDP_TIMEOUT_MS, pollIntervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs;
  let lastSeenPartial = false;
  while (Date.now() < deadline) {
    const entries = await readdir(downloadDir).catch(() => []);
    const partial = entries.filter((name) => name.endsWith(".crdownload"));
    const complete = entries.filter((name) => !name.endsWith(".crdownload") && !name.startsWith("."));
    lastSeenPartial = partial.length > 0;
    if (complete.length > 0) {
      // Confirm size is stable across two checks spaced pollIntervalMs
      // apart, so a file still being written is never reported complete.
      const target = path.join(downloadDir, complete[0]);
      const sizeA = (await stat(target)).size;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const sizeB = (await stat(target).catch(() => ({ size: -1 }))).size;
      if (sizeA === sizeB && sizeA >= 0) return { filename: complete[0], path: target, bytes: sizeB };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    lastSeenPartial
      ? `download did not complete within ${timeoutMs}ms -- a .crdownload fragment is still present in ${downloadDir}`
      : `no completed download appeared within ${timeoutMs}ms in ${downloadDir}`,
  );
}

// Turn N4.2.1 (found while verifying this turn's own port-1 fix, via a
// real, reproduced cross-contaminated download): the OLD default port
// picker (`9333 + random(500)`) had no collision detection across only
// 500 possible values. When multiple test FILES launch Chrome
// concurrently (as node --test's default file-level parallelism does),
// two independently-picked random ports could coincide. waitForCdp() only
// checks that SOMETHING answers CDP on a port -- not that it's the
// process THIS call itself spawned -- so a collision silently attaches
// this call to a SIBLING run's already-listening Chrome instance instead
// of its own (which fails to bind and is invisible). Because
// Browser.setDownloadBehavior is BROWSER-WIDE (not per-tab), the two
// callers then fight over one shared download destination -- reproduced
// directly: seed-final-remediation-owner-review-ui.test.mjs's own
// downloadDir received a file named after
// seed-final-integration-owner-review-ui-v02.test.mjs's export. Fixed by
// reserving a real, OS-assigned, genuinely free port via a temporary
// listen(0) probe for every launch that doesn't explicitly request one --
// the OS never hands the same port to two concurrent listen(0) calls, so
// two of THIS function's own concurrent callers can never collide.
export async function reserveEphemeralPort() {
  const probe = net.createServer();
  const reservedPort = await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
  });
  await new Promise((resolve) => probe.close(resolve));
  return reservedPort;
}

export async function launchHeadlessChromePage({ url, port, cdpTimeoutMs = DEFAULT_CDP_TIMEOUT_MS } = {}) {
  const chromePath = CHROME_CANDIDATES[0];
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "seed-headless-cdp-"));
  const downloadDir = await mkdtemp(path.join(os.tmpdir(), "seed-headless-download-"));
  const resolvedPort = port ?? await reserveEphemeralPort();

  let proc;
  try {
    proc = spawn(chromePath, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
      // Turn N4.1a: crashpad (Chrome's crash-handler helper process) is
      // deliberately spawned to survive the main browser process dying --
      // it doesn't share this process's lifecycle and was observed
      // recreating an empty userDataDir after cleanup. Disabling it
      // removes the need for it to exist at all in test automation.
      "--disable-crash-reporter",
      `--remote-debugging-port=${resolvedPort}`, `--user-data-dir=${userDataDir}`,
    ], {
      stdio: "ignore",
      // Turn N4.1a: makes this process its own process-GROUP leader (its
      // pid becomes its own pgid), so killAndCleanup can SIGKILL the whole
      // group (`-proc.pid`) and reach any ordinary, non-detached helper
      // process (GPU/renderer) Chrome spawns, not just this one pid.
      detached: true,
    });

    await waitForCdp(resolvedPort);

    const createRes = await withDeadline(
      fetch(`http://127.0.0.1:${resolvedPort}/json/new?about:blank`, { method: "PUT" }),
      DEFAULT_SETUP_TIMEOUT_MS,
      "initial /json/new request",
    );
    const target = await withDeadline(createRes.json(), DEFAULT_SETUP_TIMEOUT_MS, "initial /json/new response body");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let nextId = 0;
    const pendingRequests = createPendingRequests(cdpTimeoutMs);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) pendingRequests.settle(msg.id, msg);
    });
    // Turn N4.1a: if the socket ever closes/errors with commands still in
    // flight, reject them immediately instead of leaving their timeout
    // timers as the only thing standing between them and a permanent hang.
    ws.addEventListener("close", () => pendingRequests.rejectAll(new Error("CDP WebSocket closed before this command received a response")));
    ws.addEventListener("error", () => pendingRequests.rejectAll(new Error("CDP WebSocket errored before this command received a response")));

    await withDeadline(
      new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", reject);
      }),
      DEFAULT_SETUP_TIMEOUT_MS,
      "CDP WebSocket open",
    );

    function send(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pendingRequests.register(id, resolve, reject, method);
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
    // Turn N4.1a: constrain every download this page ever triggers to its
    // own dedicated downloadDir -- never the OS default Downloads folder.
    // `Browser.setDownloadBehavior` (the modern, non-deprecated command)
    // works over a page-target CDP connection in current Chrome because
    // targets created via /json/new are flattened-session-capable by
    // default; this is exercised for real by
    // tests/headless-chrome-cdp-cleanup.test.mjs's download-completion test.
    await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
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

    return buildPage({ ws, proc, userDataDir, downloadDir, send, evaluate, pendingRequests });
  } catch (error) {
    const cleanupErrors = await killAndCleanup(proc, [userDataDir, downloadDir]);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Chrome setup failed (${error.message}); cleanup afterward also failed (${cleanupErrors.map((e) => e.message).join("; ")})`,
      );
    }
    throw error;
  }
}

function buildPage({ ws, proc, userDataDir, downloadDir, send, evaluate, pendingRequests }) {
  async function close() {
    pendingRequests.rejectAll(new Error("CDP page closed while this command was still pending"));
    try { ws.close(); } catch { /* ignore */ }
    // SIGTERM is not reliable here: headless Chrome can be mid-way through
    // an internal download-manager operation (e.g. a real <a download>
    // click against a blob: URL) and ignore/delay SIGTERM well past any
    // reasonable fallback wait, which leaves the CDP WebSocket's
    // underlying socket open and the Node test process hanging forever
    // after all assertions already passed. SIGKILL guarantees the OS
    // tears down the process (and its socket) immediately.
    const cleanupErrors = await killAndCleanup(proc, [userDataDir, downloadDir]);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `page.close() cleanup failed: ${cleanupErrors.map((e) => e.message).join("; ")}`);
    }
  }

  return { evaluate, send, close, userDataDir, downloadDir };
}

async function waitForCdp(port) {
  const deadline = Date.now() + DEFAULT_SETUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`headless Chrome CDP endpoint on port ${port} did not become ready in time`);
}

async function waitForLoad(send) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const deadline = Date.now() + DEFAULT_SETUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (result.result.value === "complete") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("page did not finish loading in time");
}
