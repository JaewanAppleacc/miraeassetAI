// Turn N2.3: regression coverage for the Codex-reported defect in
// tests/lib/headless-chrome-cdp.mjs's setup-failure cleanup path --
// `killAndCleanup` previously swallowed every rm() error unconditionally
// (`.catch(() => {})`), including genuine non-ENOENT failures, and the
// original setup error was never preserved alongside a cleanup failure.
//
// killAndCleanup() is exported specifically so its ENOENT/non-ENOENT
// behavior can be tested in isolation, in seconds, without needing to
// force every scenario through a real (slow, ~10s-timeout) Chrome CDP
// handshake failure. One genuine end-to-end test using real Chrome (this
// machine has it) still proves the full launchHeadlessChromePage() wiring
// works, not just the isolated helper.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createPendingRequests, killAndCleanup, launchHeadlessChromePage, readDevToolsActivePort, waitForDownloadCompletion,
} from "./lib/headless-chrome-cdp.mjs";

const execFileAsync = promisify(execFile);

// Mirrors real child_process ordering: kill() only schedules the exit
// (async, via queueMicrotask -- matching how a real 'exit' event always
// fires asynchronously, after any .once("exit", ...) below has already
// registered), never fires synchronously before `once("exit", ...)` has
// had a chance to attach its listener.
function fakeInstantlyExitedProc() {
  const proc = {
    exitCode: null,
    signalCode: null,
    kill() { queueMicrotask(() => { proc.exitCode = 0; proc._exitCb?.(); }); },
    once(event, cb) { if (event === "exit") proc._exitCb = cb; },
  };
  return proc;
}

test("killAndCleanup: a clean proc + a real, removable userDataDir leaves no cleanup errors and removes the directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n23-cdp-cleanup-"));
  await writeFile(path.join(dir, "inner.txt"), "x");
  const errors = await killAndCleanup(fakeInstantlyExitedProc(), dir);
  assert.deepEqual(errors, []);
  await assert.rejects(readdir(dir), { code: "ENOENT" });
});

test("killAndCleanup: a userDataDir that does not exist (ENOENT) is treated as already-clean, not an error", async () => {
  const dir = path.join(os.tmpdir(), "n23-cdp-cleanup-does-not-exist");
  const errors = await killAndCleanup(fakeInstantlyExitedProc(), dir);
  assert.deepEqual(errors, []);
});

test("killAndCleanup: a genuine non-ENOENT rm failure is observable in the returned errors, not silently discarded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n23-cdp-cleanup-perm-"));
  await writeFile(path.join(dir, "inner.txt"), "x");
  await chmod(dir, 0o000);
  try {
    const errors = await killAndCleanup(fakeInstantlyExitedProc(), dir);
    assert.equal(errors.length, 1, "a real EACCES failure must be reported, not swallowed");
    assert.notEqual(errors[0].code, "ENOENT");
  } finally {
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
});

test("killAndCleanup: a proc.kill() failure is also observable, alongside a successful directory removal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n23-cdp-cleanup-killfail-"));
  const throwingProc = {
    exitCode: null,
    signalCode: null,
    kill() { throw new Error("simulated kill failure"); },
    once() {},
  };
  const errors = await killAndCleanup(throwingProc, dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /simulated kill failure/);
  await assert.rejects(readdir(dir), { code: "ENOENT" }, "the directory must still be removed even if killing the process failed");
});

// Turn N4.1a (found while verifying this turn's own fix): a real, detached
// Chrome helper process (most likely crashpad, the crash-handler that is
// deliberately spawned to survive the browser process dying) was observed
// recreating an EMPTY userDataDir at the exact same path microseconds
// after rm() had already reported success -- a real residue silently
// reported as "cleaned up". This test simulates that exact race
// deterministically (no real Chrome needed) by recreating the directory
// shortly after killAndCleanup's own first rm() call, and asserts the
// recheck-and-retry pass in removeDirCompletely() (a) still leaves the
// directory gone by the time killAndCleanup returns, unless (b) the
// recreation happens too late for the bounded recheck window to catch --
// in which case it MUST be reported as a real cleanup error, never hidden.
test("killAndCleanup: a directory recreated 50ms after the first rm() (simulating the real detached-helper-process race this fix targets) is still caught and left gone, not silently declared clean while actually present", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n41a-cdp-cleanup-race-"));
  // Recreate the directory 50ms after killAndCleanup starts -- well inside
  // removeDirCompletely()'s own 200ms recheck window (this is the exact
  // shape of the real race: a helper process observed recreating an empty
  // userDataDir microseconds after the first rm() had already succeeded).
  setTimeout(() => { mkdir(dir, { recursive: true }).catch(() => {}); }, 50);
  const fakeProc = { exitCode: null, signalCode: null, kill() {}, once(event, cb) { if (event === "exit") cb(); } };
  const errors = await killAndCleanup(fakeProc, dir);
  assert.deepEqual(errors, []);
  await assert.rejects(readdir(dir), { code: "ENOENT" }, "the recheck-and-retry pass must catch and remove the recreated directory");
});

// Turn N4.2.1 (found while verifying the port-1 fix, via a real
// reproduced cross-contaminated download between two DIFFERENT test
// files' Chrome launches): launchHeadlessChromePage's default port picker
// used to be `9333 + random(500)` with no collision detection. Many
// concurrent callers (this is exactly what node --test's default file-
// level parallelism produces) picking from only 500 values can and did
// collide, silently attaching one caller to a SIBLING's already-running
// Chrome instance instead of its own.
//
// Turn N4.2.2 (Codex-reported defect): the N4.2.1 fix ("reserveEphemeralPort()":
// listen(0), read the assigned port, close the probe, hand the bare
// NUMBER to Chrome) was not actually atomic -- a real TOCTOU window
// existed between releasing the probe and Chrome's own later bind().
// reserveEphemeralPort() and its "50 concurrent calls" test (which only
// ever proved listen(0) itself doesn't collide with ANOTHER listen(0)
// call -- never that a released-then-reused port stays free until Chrome
// gets to it) are both removed. The real fix is `--remote-debugging-port=0`
// + reading Chrome's own DevToolsActivePort file, which has no such gap
// because nothing ever releases the port before Chrome binds it. These
// tests verify that replacement directly, via debugPort on real launches.

test("readDevToolsActivePort: a file that never appears fails closed within the given timeout, not hanging past it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n422-devtoolsport-missing-"));
  try {
    const start = Date.now();
    await assert.rejects(readDevToolsActivePort(dir, 300), /did not appear with a valid port within 300ms/);
    assert.ok(Date.now() - start < 2000, "must fail close to its own timeout, not hang indefinitely");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readDevToolsActivePort: an empty file (created but not yet flushed) is treated as transient and still fails closed at the deadline, never hangs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n422-devtoolsport-empty-"));
  try {
    await writeFile(path.join(dir, "DevToolsActivePort"), "");
    const start = Date.now();
    await assert.rejects(readDevToolsActivePort(dir, 300), /did not appear with a valid port within 300ms/);
    assert.ok(Date.now() - start < 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readDevToolsActivePort: a genuinely invalid first line (not an integer) fails immediately, not after waiting out the full timeout", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n422-devtoolsport-invalid-"));
  try {
    await writeFile(path.join(dir, "DevToolsActivePort"), "not-a-port\n/devtools/browser/abc\n");
    const start = Date.now();
    await assert.rejects(readDevToolsActivePort(dir, 10_000), /is not a valid port number/);
    assert.ok(Date.now() - start < 2000, "an invalid (non-empty) value must fail fast, never wait out the full 10s timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readDevToolsActivePort: an out-of-range port number (e.g. 0 or 70000) is rejected just like a non-numeric value", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n422-devtoolsport-range-"));
  try {
    await writeFile(path.join(dir, "DevToolsActivePort"), "70000\n/devtools/browser/abc\n");
    await assert.rejects(readDevToolsActivePort(dir, 10_000), /is not a valid port number/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readDevToolsActivePort: a valid file resolves to the exact integer on its first line, ignoring the rest of the file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n422-devtoolsport-valid-"));
  try {
    await writeFile(path.join(dir, "DevToolsActivePort"), "54321\n/devtools/browser/some-uuid\n");
    const port = await readDevToolsActivePort(dir, 5000);
    assert.equal(port, 54321);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readDevToolsActivePort: a file that appears shortly after polling begins is still picked up before the deadline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n422-devtoolsport-delayed-"));
  try {
    setTimeout(() => { writeFile(path.join(dir, "DevToolsActivePort"), "12345\n/devtools/browser/x\n").catch(() => {}); }, 150);
    const port = await readDevToolsActivePort(dir, 5000);
    assert.equal(port, 12345);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("launchHeadlessChromePage: two concurrently-launched default (no explicit port) instances get two different real debugPorts", async () => {
  let pageA = null; let pageB = null;
  try {
    [pageA, pageB] = await Promise.all([launchHeadlessChromePage({}), launchHeadlessChromePage({})]);
    assert.ok(Number.isInteger(pageA.debugPort) && pageA.debugPort > 0 && pageA.debugPort < 65536);
    assert.ok(Number.isInteger(pageB.debugPort) && pageB.debugPort > 0 && pageB.debugPort < 65536);
    assert.notEqual(pageA.debugPort, pageB.debugPort, "two concurrent default launches must never end up on the same real CDP port");
  } finally {
    if (pageA) await pageA.close();
    if (pageB) await pageB.close();
  }
});

test("launchHeadlessChromePage: a missing DevToolsActivePort file (Chrome fails to start entirely) fails closed within the setup timeout, not hanging", async () => {
  // A deliberately invalid Chrome binary path is out of reach here (the
  // path is a module-level constant), so this exercises the same failure
  // shape via readDevToolsActivePort's own bounded-timeout contract
  // directly: an explicit, already-occupied port (Chrome's bind fails,
  // so it never starts a debug server and never writes the file) still
  // fails with a clear, bounded error -- the explicit-port path
  // intentionally bypasses DevToolsActivePort reading entirely, and this
  // confirms that bypass doesn't silently hang either.
  const reservation = net.createServer();
  const reservationSockets = new Set();
  reservation.on("connection", (socket) => {
    reservationSockets.add(socket);
    socket.on("close", () => reservationSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  let page = null;
  try {
    await assert.rejects(launchHeadlessChromePage({ port }), /did not become ready in time/i);
  } finally {
    if (page) await page.close();
    for (const socket of reservationSockets) socket.destroy();
    await new Promise((resolve) => reservation.close(resolve));
  }
});

// -- End-to-end: a genuine Chrome CDP handshake failure (unreachable
// debugging port) forces launchHeadlessChromePage's own catch block to
// run killAndCleanup for real. Verifies (1) the ORIGINAL setup error
// (waitForCdp's own timeout message) survives, and (2) no Chrome process
// referencing this test's unique port is left running afterward. -------

test("launchHeadlessChromePage: a real CDP handshake failure preserves the original setup error and leaves no Chrome process behind", async () => {
  // Turn N4.2.1 (user-reported defect, actually observed): this test used
  // to hardcode port 1 (a privileged port an unprivileged process cannot
  // bind) to force a reliable CDP handshake failure. But port 1 is a
  // SHARED, GUESSABLE constant -- when two copies of this test file ran
  // concurrently (a real verify:contracts collided with the Stop hook's
  // own automatic re-verification), the ps-aux check below could match
  // the OTHER run's still-alive --remote-debugging-port=1 Chrome process
  // and mistake it for this run's own leftover, failing a genuinely clean
  // run. Fixed by reserving a real, OS-assigned, per-run-unique loopback
  // port via a temporary TCP server BEFORE launching Chrome on that same
  // port number -- the OS guarantees no two concurrently-bound listeners
  // can share a port, so this test's own port can never collide with a
  // sibling run's port, and the process check below only ever looks for
  // THIS run's own unique port, never a shared/guessable one.
  const reservation = net.createServer();
  // net.Server.close() waits for every ACCEPTED connection to end before
  // its callback fires -- it does not forcibly drop them. waitForCdp()'s
  // own polling fetch() calls will genuinely complete a TCP handshake
  // against this bare listener (Chrome's real bind() failure gives an
  // instant ECONNREFUSED with nothing listening; a held port gives a
  // real, silently-never-answered connection instead), and neither side
  // ever closes that socket on its own -- so reservation.close() in the
  // finally block below would hang forever without this. Track and force-
  // destroy every accepted socket before closing.
  const reservationSockets = new Set();
  reservation.on("connection", (socket) => {
    reservationSockets.add(socket);
    socket.on("close", () => reservationSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;

  let page = null;
  let thrown = null;
  try {
    // The reservation server still holds `port`, so Chrome's own bind()
    // on the identical port number genuinely fails -- the same real
    // handshake-failure path as the old privileged-port trick, but now
    // exercised on a port no other concurrent process can also be using.
    //
    // Turn N2.4 (Codex-reported defect): the previous version used
    // `await assert.rejects(promise.then(page => { unexpectedPage = page; ... }))`
    // -- if the promise unexpectedly RESOLVED, assert.rejects itself threw
    // "Missing expected rejection" from INSIDE that awaited call, which
    // skipped the `if (unexpectedPage) await unexpectedPage.close()` line
    // entirely (it never ran), leaking a real Chrome process/userDataDir.
    // Fixed with an explicit try/finally so page.close() is unconditionally
    // attempted whenever `page` was ever assigned, regardless of what the
    // assertion logic below does with the outcome.
    try {
      page = await launchHeadlessChromePage({ port });
    } catch (error) {
      thrown = error;
    } finally {
      if (page) await page.close();
    }

    if (thrown) {
      assert.match(thrown.message, /did not become ready in time/i, `unexpected error shape: ${thrown.message}`);
    } else {
      // The reserved port unexpectedly became bindable (e.g. the
      // reservation server somehow released it, or a sandbox permits
      // SO_REUSEPORT-style sharing) -- the real page was still safely
      // closed above. Fail explicitly rather than silently passing, so
      // this environment difference stays visible.
      assert.fail(
        "the reserved port unexpectedly became bindable by Chrome in this environment -- the bind-failure this test relies on did not occur here "
        + "(the real Chrome page/process/userDataDir were still closed safely above via the try/finally)",
      );
    }

    const { stdout } = await execFileAsync("ps", ["aux"]).catch(() => ({ stdout: "" }));
    assert.doesNotMatch(stdout, new RegExp(`remote-debugging-port=${port}\\b`), "no Chrome process for this test's own unique port must remain running");
  } finally {
    for (const socket of reservationSockets) socket.destroy();
    await new Promise((resolve) => reservation.close(resolve));
  }
});

// -- Turn N4.1a: two real, independently-confirmed hung process trees (one
// ~11h old, one ~3h old) were both stuck inside the same UI test with a
// live headless Chrome process open the whole time. Root cause: CDP
// send()'s Promise had no timeout, and no download destination was ever
// configured, so a download-adjacent renderer state change could leave a
// command's response never arriving. These tests pin the fix at three
// layers: the pending-request registry in isolation (fast, deterministic),
// the download-completion poller in isolation, and two real-Chrome
// end-to-end reproductions of the exact failure mode. -----------------

test("createPendingRequests: an unresolved request rejects after its own timeout, names the CDP method, and leaves 0 pending afterward", async () => {
  const registry = createPendingRequests(50);
  let caught = null;
  const promise = new Promise((resolve, reject) => registry.register(1, resolve, reject, "Runtime.evaluate"));
  assert.equal(registry.size(), 1);
  await promise.catch((error) => { caught = error; });
  assert.ok(caught, "an unresolved request must reject, never hang");
  assert.match(caught.message, /Runtime\.evaluate/);
  assert.match(caught.message, /timed out after 50ms/);
  assert.equal(registry.size(), 0, "a timed-out request must not remain in the pending map");
});

test("createPendingRequests: settle() before the timeout resolves normally and cancels the timer (no late rejection ever fires)", async () => {
  const registry = createPendingRequests(50);
  let result = null;
  const promise = new Promise((resolve, reject) => registry.register(7, resolve, reject, "Page.enable"));
  const settled = registry.settle(7, { id: 7, result: { ok: true } });
  assert.equal(settled, true);
  result = await promise;
  assert.deepEqual(result, { ok: true });
  assert.equal(registry.size(), 0);
  // If the timer had NOT been cancelled, waiting past the timeout window
  // would still be harmless here since the promise already settled -- but
  // size() staying 0 proves clearTimeout actually ran, not just that the
  // already-resolved promise silently ignored a second settle attempt.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(registry.size(), 0);
});

test("createPendingRequests: settle() after a request already timed out is a harmless no-op, not a crash or a double-resolve", async () => {
  const registry = createPendingRequests(30);
  let caught = null;
  const promise = new Promise((resolve, reject) => registry.register(2, resolve, reject, "Runtime.evaluate"));
  await promise.catch((error) => { caught = error; });
  assert.ok(caught);
  const settledLate = registry.settle(2, { id: 2, result: {} });
  assert.equal(settledLate, false, "settle() must report false for an id it no longer tracks");
});

test("createPendingRequests: rejectAll() rejects every still-pending request (models a CDP WebSocket close/error) and clears the map", async () => {
  const registry = createPendingRequests(60_000); // long enough that only rejectAll() -- not the timeout -- can be what settles these
  const promises = [1, 2, 3].map((id) => new Promise((resolve, reject) => registry.register(id, resolve, reject, `method-${id}`)));
  assert.equal(registry.size(), 3);
  registry.rejectAll(new Error("CDP WebSocket closed before this command received a response"));
  const results = await Promise.allSettled(promises);
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.ok(results.every((r) => /WebSocket closed/.test(r.reason.message)));
  assert.equal(registry.size(), 0);
});

test("waitForDownloadCompletion: a lone .crdownload fragment fails explicitly once the timeout elapses, and does not hang past it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n41a-download-poll-"));
  try {
    await writeFile(path.join(dir, "export.jsonl.crdownload"), "partial");
    const start = Date.now();
    await assert.rejects(
      waitForDownloadCompletion({ downloadDir: dir, timeoutMs: 300, pollIntervalMs: 50 }),
      /\.crdownload fragment is still present/,
    );
    assert.ok(Date.now() - start < 2000, "must fail close to its own timeout, not hang indefinitely");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForDownloadCompletion: an empty directory (no download ever started) fails explicitly once the timeout elapses", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n41a-download-poll-empty-"));
  try {
    await assert.rejects(
      waitForDownloadCompletion({ downloadDir: dir, timeoutMs: 200, pollIntervalMs: 50 }),
      /no completed download appeared/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForDownloadCompletion: a stable, complete file (no .crdownload suffix) is detected and its size reported correctly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "n41a-download-poll-complete-"));
  try {
    await writeFile(path.join(dir, "export.jsonl"), "hello world");
    const result = await waitForDownloadCompletion({ downloadDir: dir, timeoutMs: 2000, pollIntervalMs: 50 });
    assert.equal(result.filename, "export.jsonl");
    assert.equal(result.bytes, Buffer.byteLength("hello world"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- Real-Chrome end-to-end reproductions of the two failure modes. ------

test("launchHeadlessChromePage: an unresponsive CDP command (a Promise that never resolves in the page) times out instead of hanging forever", async () => {
  let page = null;
  try {
    page = await launchHeadlessChromePage({ cdpTimeoutMs: 500 });
    const start = Date.now();
    await assert.rejects(
      page.evaluate("new Promise(function(){})"), // genuinely never resolves -- Chrome itself will never reply
      /Runtime\.evaluate.*timed out/,
    );
    assert.ok(Date.now() - start < 3000, "the client-side timeout, not some other mechanism, must be what ends this");
  } finally {
    if (page) await page.close();
  }
});

test("page.close(): rejects any command still pending at close time instead of leaving its caller hanging", async () => {
  let page = null;
  try {
    page = await launchHeadlessChromePage({ cdpTimeoutMs: 20_000 }); // long enough that only close()'s rejectAll -- not the timeout -- can be what settles this
    const stillPending = page.evaluate("new Promise(function(){})");
    // Attach the rejection assertion BEFORE awaiting close() -- assert.rejects()
    // attaches its .then/.catch handler synchronously when called, even though
    // its own returned promise isn't awaited until later. Awaiting close()
    // first would leave `stillPending` briefly unobserved once rejectAll()
    // settles it, which Node's test runner treats as an unhandled rejection
    // and fails the CURRENTLY RUNNING test with it -- not a bug in close()
    // itself, just an ordering hazard in how this test observes it.
    const rejectionCheck = assert.rejects(stillPending, /closed while this command was still pending/);
    await page.close();
    await rejectionCheck;
    page = null; // already closed; the outer finally must not double-close
  } finally {
    if (page) await page.close();
  }
});

test("launchHeadlessChromePage: a real FINAL-export-style download completes in the page's own dedicated downloadDir, never the OS Downloads folder", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "n41a-download-fixture-"));
  const fixtureHtmlPath = path.join(fixtureDir, "download-fixture.html");
  await writeFile(fixtureHtmlPath, [
    "<!doctype html><html><body>",
    "<script>",
    "function triggerDownload() {",
    "  var blob = new Blob(['{\"ok\":true}'], { type: 'application/json' });",
    "  var url = URL.createObjectURL(blob);",
    "  var a = document.createElement('a');",
    "  a.href = url; a.download = 'n41a-fixture-export.jsonl';",
    "  document.body.appendChild(a); a.click();",
    "  URL.revokeObjectURL(url);",
    "}",
    "</script>",
    "</body></html>",
  ].join("\n"));

  let page = null;
  try {
    page = await launchHeadlessChromePage({ url: `file://${fixtureHtmlPath}` });
    const osDownloads = path.join(os.homedir(), "Downloads");
    assert.notEqual(page.downloadDir, osDownloads);
    assert.equal(page.downloadDir.startsWith(osDownloads), false, "downloadDir must never live inside the OS default Downloads folder");
    assert.equal(path.dirname(page.downloadDir), os.tmpdir(), "downloadDir must be its own dedicated temp directory");

    await page.evaluate("triggerDownload()");
    const result = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 5000 });
    assert.equal(result.filename, "n41a-fixture-export.jsonl");
    assert.ok(result.bytes > 0);

    const osDownloadsEntries = await readdir(osDownloads).catch(() => []);
    assert.equal(osDownloadsEntries.includes("n41a-fixture-export.jsonl"), false, "this fixture's download must never land in the OS Downloads folder");

    const { userDataDir, downloadDir } = page;
    await page.close();
    page = null;
    await assert.rejects(readdir(userDataDir), { code: "ENOENT" }, "userDataDir must be removed on close");
    await assert.rejects(readdir(downloadDir), { code: "ENOENT" }, "downloadDir must be removed on close");
  } finally {
    if (page) await page.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("launchHeadlessChromePage: two concurrent pages never touch each other's userDataDir/downloadDir", async () => {
  let pageA = null; let pageB = null;
  try {
    [pageA, pageB] = await Promise.all([launchHeadlessChromePage({}), launchHeadlessChromePage({})]);
    assert.notEqual(pageA.userDataDir, pageB.userDataDir);
    assert.notEqual(pageA.downloadDir, pageB.downloadDir);

    await pageA.close();
    const pageAClosed = pageA;
    pageA = null;

    // Page B's own directories must be completely untouched by A's close().
    assert.ok((await readdir(pageB.userDataDir)).length >= 0, "pageB.userDataDir must still exist");
    assert.ok((await readdir(pageB.downloadDir)).length >= 0, "pageB.downloadDir must still exist");
    await assert.rejects(readdir(pageAClosed.userDataDir), { code: "ENOENT" });
    await assert.rejects(readdir(pageAClosed.downloadDir), { code: "ENOENT" });

    const { userDataDir: bUserDataDir, downloadDir: bDownloadDir } = pageB;
    await pageB.close();
    pageB = null;
    await assert.rejects(readdir(bUserDataDir), { code: "ENOENT" });
    await assert.rejects(readdir(bDownloadDir), { code: "ENOENT" });
  } finally {
    if (pageA) await pageA.close();
    if (pageB) await pageB.close();
  }
});

// Turn N4.2.2: the exact shape of the real cross-contamination bug found
// while verifying N4.2.1 -- two SEPARATE launches, each triggering a real
// download AT THE SAME TIME -- reproduced deterministically in a single
// test rather than relying on running two whole test files concurrently.
// Distinct debugPorts alone would not have caught the original bug (the
// old picker COULD occasionally land on different ports and still pass);
// this test additionally proves each instance's download only ever
// appears in its OWN downloadDir, with its OWN distinct filename/content.
test("launchHeadlessChromePage: two concurrent instances downloading AT THE SAME TIME never cross-contaminate each other's downloadDir", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "n422-concurrent-download-fixture-"));
  async function writeFixture(name, filename) {
    const fixtureHtmlPath = path.join(fixtureDir, `${name}.html`);
    await writeFile(fixtureHtmlPath, [
      "<!doctype html><html><body>",
      "<script>",
      "function triggerDownload() {",
      `  var blob = new Blob(['${name}-payload'], { type: 'application/json' });`,
      "  var url = URL.createObjectURL(blob);",
      "  var a = document.createElement('a');",
      `  a.href = url; a.download = '${filename}';`,
      "  document.body.appendChild(a); a.click();",
      "  URL.revokeObjectURL(url);",
      "}",
      "</script>",
      "</body></html>",
    ].join("\n"));
    return fixtureHtmlPath;
  }

  let pageA = null; let pageB = null;
  try {
    const [htmlA, htmlB] = await Promise.all([
      writeFixture("instance-a", "n422-instance-a-export.jsonl"),
      writeFixture("instance-b", "n422-instance-b-export.jsonl"),
    ]);
    [pageA, pageB] = await Promise.all([
      launchHeadlessChromePage({ url: `file://${htmlA}` }),
      launchHeadlessChromePage({ url: `file://${htmlB}` }),
    ]);
    assert.notEqual(pageA.debugPort, pageB.debugPort);

    await Promise.all([pageA.evaluate("triggerDownload()"), pageB.evaluate("triggerDownload()")]);
    const [resultA, resultB] = await Promise.all([
      waitForDownloadCompletion({ downloadDir: pageA.downloadDir, timeoutMs: 5000 }),
      waitForDownloadCompletion({ downloadDir: pageB.downloadDir, timeoutMs: 5000 }),
    ]);
    assert.equal(resultA.filename, "n422-instance-a-export.jsonl");
    assert.equal(resultB.filename, "n422-instance-b-export.jsonl");

    // Each downloadDir must contain ONLY its own file -- never the sibling's.
    const entriesA = await readdir(pageA.downloadDir);
    const entriesB = await readdir(pageB.downloadDir);
    assert.deepEqual(entriesA, ["n422-instance-a-export.jsonl"]);
    assert.deepEqual(entriesB, ["n422-instance-b-export.jsonl"]);
  } finally {
    if (pageA) await pageA.close();
    if (pageB) await pageB.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
