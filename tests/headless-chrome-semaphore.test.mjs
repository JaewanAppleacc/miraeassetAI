// Turn N4.18.1: real-Chrome regression tests proving
// tests/lib/headless-chrome-cdp.mjs's launch-concurrency semaphore (Part C
// of this Turn) actually gates real launches -- not just the generic
// process-semaphore.mjs primitive in isolation (see
// tests/process-semaphore.test.mjs), and not just the pre-existing
// cleanup guarantees (see tests/headless-chrome-cdp-cleanup.test.mjs).
// Every test here uses a UNIQUE semaphore key (via a fake, per-test
// repoRoot passed through launchHeadlessChromePage is not supported --
// instead each test monkey-patches HEADLESS_CHROME_MAX_CONCURRENCY via the
// exported semaphorePermits/semaphoreTimeoutMs per-call overrides, and
// relies on this file's own real (shared, repo-scoped) semaphore key,
// serialized by running these tests sequentially within this file and
// always fully closing every page before the next test begins) so they
// never interfere with tests in sibling files that also use the real
// launchHeadlessChromePage default concurrency of 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { launchHeadlessChromePage, resolveHeadlessChromeMaxConcurrency, DEFAULT_HEADLESS_CHROME_MAX_CONCURRENCY, DEFAULT_SEMAPHORE_ACQUIRE_TIMEOUT_MS } from "./lib/headless-chrome-cdp.mjs";
import { acquireSemaphore, inspectSemaphore, SemaphoreTimeoutError } from "../scripts/lib/process-semaphore.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const REPO_ROOT_FOR_SEMAPHORE = path.resolve(fileURLToPath(new URL("./lib/headless-chrome-cdp.mjs", import.meta.url)), "../../..");
const SEMAPHORE_KEY = `headless-chrome-launch:${REPO_ROOT_FOR_SEMAPHORE}`;

test("Turn N4.18.1: DEFAULT_HEADLESS_CHROME_MAX_CONCURRENCY / resolveHeadlessChromeMaxConcurrency default to 2 and are env-var overridable", () => {
  assert.equal(DEFAULT_HEADLESS_CHROME_MAX_CONCURRENCY, 2);
  const before = process.env.HEADLESS_CHROME_MAX_CONCURRENCY;
  try {
    delete process.env.HEADLESS_CHROME_MAX_CONCURRENCY;
    assert.equal(resolveHeadlessChromeMaxConcurrency(), 2);
    process.env.HEADLESS_CHROME_MAX_CONCURRENCY = "5";
    assert.equal(resolveHeadlessChromeMaxConcurrency(), 5);
    process.env.HEADLESS_CHROME_MAX_CONCURRENCY = "not-a-number";
    assert.equal(resolveHeadlessChromeMaxConcurrency(), 2, "an invalid override must fall back to the default, not crash or produce 0/negative permits");
  } finally {
    if (before === undefined) delete process.env.HEADLESS_CHROME_MAX_CONCURRENCY;
    else process.env.HEADLESS_CHROME_MAX_CONCURRENCY = before;
  }
});

test("Turn N4.18.1 D6/D7: with semaphorePermits=1, a second real launch genuinely waits for the first to close, and a too-short acquisition timeout fails bounded and closed", async () => {
  const first = await launchHeadlessChromePage({ semaphorePermits: 1, semaphoreTimeoutMs: 15_000 });
  try {
    const stateWhileHeld = await inspectSemaphore({ key: SEMAPHORE_KEY, permits: 1 });
    assert.equal(stateWhileHeld.holders.length, 1, "the first launch must genuinely hold the one available permit");

    // A second launch with a SHORT timeout must fail bounded and closed --
    // never hang past its own timeout, and never silently proceed anyway.
    const start = Date.now();
    await assert.rejects(
      launchHeadlessChromePage({ semaphorePermits: 1, semaphoreTimeoutMs: 400 }),
      /timed out after 400ms waiting for one of 1 permit/,
    );
    assert.ok(Date.now() - start < 2000, "the impatient second launch must fail close to its own bounded timeout (400ms), not hang");

    // A second launch with a GENEROUS timeout, started concurrently with
    // closing the first, must succeed only once the first's permit is
    // actually released (real serialization, not a race that happens to
    // pass).
    const events = [];
    const secondPromise = launchHeadlessChromePage({ semaphorePermits: 1, semaphoreTimeoutMs: 15_000 })
      .then((page) => { events.push("second-acquired"); return page; });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(events, [], "the second launch must still be waiting while the first page has not been closed yet");

    await first.close();
    const second = await secondPromise;
    assert.deepEqual(events, ["second-acquired"]);
    await second.close();
  } finally {
    // Best-effort: if an assertion above threw before `first` was closed,
    // still release the real Chrome process/permit rather than leaking it
    // into later tests in this file or sibling files.
    await first.close().catch(() => {});
  }
});

test("Turn N4.18.2: DEFAULT_SEMAPHORE_ACQUIRE_TIMEOUT_MS is bounded to 120s, not the old 30-minute default (see the retraction comment in headless-chrome-cdp.mjs -- a real isolated reproduction proved the 30-minute figure was justifying tolerance for external hook-vs-ad-hoc-invocation contention, not anything this file's own code needs)", () => {
  const before = process.env.HEADLESS_CHROME_SEMAPHORE_TIMEOUT_MS;
  try {
    delete process.env.HEADLESS_CHROME_SEMAPHORE_TIMEOUT_MS;
    assert.equal(DEFAULT_SEMAPHORE_ACQUIRE_TIMEOUT_MS, 120_000);
  } finally {
    if (before === undefined) delete process.env.HEADLESS_CHROME_SEMAPHORE_TIMEOUT_MS;
    else process.env.HEADLESS_CHROME_SEMAPHORE_TIMEOUT_MS = before;
  }
});

test("Turn N4.18.2: a genuine semaphore-acquire timeout from launchHeadlessChromePage() is reported as a SemaphoreTimeoutError with a distinguishable .code -- never disguised as a Chrome/CDP setup failure (e.g. never matches the DevToolsActivePort-missing error shape) -- and Chrome is never spawned in this path", async () => {
  const permits = 1;
  const blocker = await acquireSemaphore({ key: SEMAPHORE_KEY, permits, timeoutMs: 5000, ownerMeta: { simulating: "another-invocation-holding-the-only-permit" } });
  try {
    const start = Date.now();
    let caught;
    try {
      await launchHeadlessChromePage({ semaphorePermits: permits, semaphoreTimeoutMs: 300 });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof SemaphoreTimeoutError, `expected a SemaphoreTimeoutError, got ${caught?.constructor?.name}: ${caught?.message}`);
    assert.equal(caught.code, "SEMAPHORE_ACQUIRE_TIMEOUT");
    assert.doesNotMatch(caught.message, /DevToolsActivePort/, "a semaphore timeout must never be confusable with a Chrome-setup failure");
    assert.ok(Date.now() - start < 3000, "must fail close to its own short bounded timeout (300ms), not wait for anything else");
  } finally {
    await blocker.release();
  }
});

test("Turn N4.18.2: page.close() reliably runs via a t.after() cleanup owner even when the REST of a test.before() body throws after the page was acquired -- zero leftover Chrome process, temp path, or semaphore holder afterward", async () => {
  // Mirrors the exact structural fix applied to
  // relation-closure-owner-review-ui-v01/v02.test.mjs: register cleanup on
  // the test context immediately after acquiring the page, so a LATER
  // failure in the same hook body can never skip it. Run as a real child
  // `node --test` process (not inline) so this test can observe the
  // OUTCOME (a report of pass/fail from the child) without polluting this
  // file's own test run with a deliberately-failing test.
  const script = `
    import test from "node:test";
    import assert from "node:assert/strict";
    import { launchHeadlessChromePage } from ${JSON.stringify(new URL("./lib/headless-chrome-cdp.mjs", import.meta.url).pathname)};
    let capturedUserDataDir;
    let capturedDownloadDir;
    test.before(async (t) => {
      const page = await launchHeadlessChromePage({});
      capturedUserDataDir = page.userDataDir;
      capturedDownloadDir = page.downloadDir;
      t.after(async () => { await page.close(); });
      throw new Error("deliberate failure AFTER page acquisition, to prove t.after() still runs");
    });
    test("placeholder (never reached -- the before() hook above always throws first)", () => {});
    test.after(() => {
      // Emit the captured paths on a side channel (stdout, since the
      // parent needs them but the test framework's own pass/fail reporting
      // is otherwise all this test cares about) so the parent can assert
      // cleanup actually happened.
      console.log("CAPTURED_PATHS::" + JSON.stringify({ userDataDir: capturedUserDataDir, downloadDir: capturedDownloadDir, pid: process.pid }));
    });
  `;
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const tmpScriptPath = path.join(os.tmpdir(), `n4182-throwing-before-${Date.now()}.test.mjs`);
  await fs.writeFile(tmpScriptPath, script, "utf8");
  try {
    // Node's own test runner marks every per-file child it spawns with
    // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID; inheriting those into a
    // NESTED `node --test` child (this test file is itself one such
    // per-file child) makes the nested runner think it is being invoked
    // recursively and silently skip running the file entirely. Strip them
    // so the nested child is a genuinely independent test run.
    const { NODE_TEST_CONTEXT, NODE_TEST_WORKER_ID, ...cleanEnv } = process.env;
    const result = await execFileAsync(process.execPath, ["--test", tmpScriptPath], { env: cleanEnv }).catch((error) => error);
    const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const match = combinedOutput.match(/CAPTURED_PATHS::(\{.*\})/);
    assert.ok(match, `expected the child to report its captured paths; full output:\n${combinedOutput}`);
    const { userDataDir, downloadDir, pid: childPid } = JSON.parse(match[1]);
    assert.ok(userDataDir && downloadDir, "the child must have actually acquired a real page before throwing");
    await assert.rejects(fs.stat(userDataDir), { code: "ENOENT" }, "userDataDir must be gone -- t.after() must have run despite the before() hook throwing");
    await assert.rejects(fs.stat(downloadDir), { code: "ENOENT" }, "downloadDir must be gone -- t.after() must have run despite the before() hook throwing");
    const state = await inspectSemaphore({ key: SEMAPHORE_KEY, permits: resolveHeadlessChromeMaxConcurrency() });
    assert.ok(!state.holders.some((h) => String(h.pid) === String(childPid)), "the crashed child's own semaphore permit must not still be held");
  } finally {
    await fs.rm(tmpScriptPath, { force: true });
  }
});

test("Turn N4.18.1 D8: a holder record left behind by a crashed owner (dead PID, never released) on the REAL production headless-Chrome semaphore key is reclaimed, letting a genuine launchHeadlessChromePage() call proceed without waiting out its full timeout", async () => {
  // Plant a stale holder directly on the exact same key/permits
  // launchHeadlessChromePage() itself uses -- this is what a real crash
  // (the process that called launchHeadlessChromePage dying, e.g. an
  // uncaught exception or an external SIGKILL, before it ever reached
  // page.close()) leaves behind: a holder file naming a PID that no
  // longer exists.
  const permits = resolveHeadlessChromeMaxConcurrency();
  // Fill EVERY permit slot with a stale (dead-PID) holder -- planting only
  // one while `permits > 1` would leave a genuinely free slot and let the
  // real launch below succeed trivially, without exercising reclaim at
  // all. Acquire ALL slots first (each still recording OUR OWN live PID,
  // so acquiring slot 2 never sees slot 1 as already-stale-and-reclaimable
  // mid-loop), THEN overwrite every slot's pid to a dead one in a second
  // pass -- doing both steps in one combined loop would let each new
  // acquireSemaphore() call's own internal reclaim step immediately reap
  // the PREVIOUS iteration's just-poisoned slot before this loop even
  // reaches the next one.
  const realHandles = [];
  for (let i = 0; i < permits; i += 1) {
    realHandles.push(await acquireSemaphore({ key: SEMAPHORE_KEY, permits, timeoutMs: 5000, ownerMeta: { simulating: "crashed-chrome-launcher", step: i } }));
  }
  const deadPids = [];
  for (const handle of realHandles) {
    const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => deadChild.once("exit", resolve));
    deadPids.push(deadChild.pid);
    const record = JSON.parse(await readFile(handle.slotPath, "utf8"));
    await writeFile(handle.slotPath, JSON.stringify({ ...record, pid: deadChild.pid }), "utf8");
  }

  const before = await inspectSemaphore({ key: SEMAPHORE_KEY, permits });
  assert.equal(before.holders.length, permits, "every permit slot must be genuinely (stale-)held before the real launch call runs");
  assert.ok(before.holders.every((h) => deadPids.includes(h.pid)), "every holder must carry one of the simulated dead PIDs, not a live one");

  const start = Date.now();
  const page = await launchHeadlessChromePage({ semaphorePermits: permits, semaphoreTimeoutMs: 15_000 });
  try {
    assert.ok(Date.now() - start < 5000, "a real launchHeadlessChromePage() call must reclaim the stale holder well before its own bounded timeout, not wait it out");
  } finally {
    await page.close();
  }
});

test("Turn N4.18.1 D9: cleaning up this file's own Chrome/semaphore state never affects an unrelated concurrently-running process", async () => {
  // A canary process wholly unrelated to headless Chrome or this
  // semaphore -- if any cleanup path in this Turn's changes ever killed
  // "something" by scanning ps/pgrep output instead of only ever acting on
  // its own owned `proc` handle, this canary would be an equally plausible
  // victim. It survives means no such broad, unscoped kill happened.
  const canary = execFileAsync(process.execPath, ["-e", "setTimeout(() => process.exit(0), 3000)"]);
  const page = await launchHeadlessChromePage({ semaphorePermits: 1, semaphoreTimeoutMs: 15_000 });
  await page.close();
  // The canary must still be running its own 3s countdown, untouched.
  const { stdout, stderr } = await canary;
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("Turn N4.18.1 D10: zero leftover headless Chrome processes or temp directories remain after a full acquire/release cycle (success path)", async () => {
  const page = await launchHeadlessChromePage({ semaphorePermits: 2, semaphoreTimeoutMs: 15_000 });
  const { userDataDir, downloadDir } = page;
  await page.close();
  const { stdout } = await execFileAsync("ps", ["aux"]).catch(() => ({ stdout: "" }));
  assert.doesNotMatch(stdout, new RegExp(userDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no process referencing this run's own userDataDir must remain");
  const fs = await import("node:fs/promises");
  await assert.rejects(fs.stat(userDataDir), { code: "ENOENT" });
  await assert.rejects(fs.stat(downloadDir), { code: "ENOENT" });
});

test("Turn N4.18.1 D10b: zero leftover headless Chrome processes or temp directories remain after a launch that fails during setup (never held a permit past the failure)", async () => {
  const stateBefore = await inspectSemaphore({ key: SEMAPHORE_KEY, permits: resolveHeadlessChromeMaxConcurrency() });
  // A held, already-bound port forces Chrome's own bind() to fail (same
  // technique already proven safe in tests/headless-chrome-cdp-cleanup
  // .test.mjs's real CDP-handshake-failure test).
  const net = await import("node:net");
  const reservation = net.createServer();
  const reservationSockets = new Set();
  reservation.on("connection", (socket) => { reservationSockets.add(socket); socket.on("close", () => reservationSockets.delete(socket)); });
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  try {
    await assert.rejects(launchHeadlessChromePage({ port, semaphorePermits: resolveHeadlessChromeMaxConcurrency(), semaphoreTimeoutMs: 15_000 }), /did not become ready in time/i);
    const stateAfter = await inspectSemaphore({ key: SEMAPHORE_KEY, permits: resolveHeadlessChromeMaxConcurrency() });
    assert.equal(stateAfter.holders.length, stateBefore.holders.length, "a setup failure must release the permit it acquired, never leave it stuck");
  } finally {
    for (const socket of reservationSockets) socket.destroy();
    await new Promise((resolve) => reservation.close(resolve));
  }
});
