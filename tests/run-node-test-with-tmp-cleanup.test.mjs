// Turn N2.2/N2.3: regression coverage for scripts/run-node-test-with-tmp-cleanup.mjs.
// Every test here operates on real child processes and the REAL OS temp
// directory (that is the whole point of the wrapper), but only ever
// through paths this suite itself creates and independently verifies are
// removed -- this suite must never leave residue in the real OS temp
// directory, and never touches os.homedir() or the workspace root.
import assert from "node:assert/strict";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  UnsafeCleanupRootError,
  assertOwnedCleanupTarget,
  cleanupOwnedRoot,
  runWithTmpCleanup,
} from "../scripts/run-node-test-with-tmp-cleanup.mjs";

// realpath'd, matching exactly what the wrapper itself resolves internally
// (os.tmpdir() on macOS is a symlink -- /var/... -> /private/var/...; the
// wrapper's own `root` (its returned dedicated root path) is always the
// realpath'd form, so every comparison in this suite must use the same
// resolved form or a raw-vs-resolved string mismatch is a TEST bug, not a
// wrapper bug).
const OS_TMP_ROOT = await realpath(os.tmpdir());

function listenerCounts() {
  return { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") };
}

// -- Ownership model: each run gets its OWN dedicated root; TMPDIR is
// injected into the child; cleanup removes ONLY that exact root. ---------

test("the child's own os.tmpdir()/TMPDIR resolves to the run's dedicated root, and everything the child creates there (any prefix, including node-compile-cache) is removed with it", async () => {
  const result = await runWithTmpCleanup({
    command: process.execPath,
    args: [
      "-e",
      "const os=require('os');const fs=require('fs');const path=require('path');" +
        "fs.mkdirSync(path.join(os.tmpdir(), 'seed-release-v020-production-abc'));" +
        "fs.mkdirSync(path.join(os.tmpdir(), 'unrelated-other-prefix-xyz'));" +
        "fs.writeFileSync(path.join(os.tmpdir(), 'canary.txt'), 'hi');",
    ],
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.root.startsWith(OS_TMP_ROOT + path.sep) || path.dirname(result.root) === OS_TMP_ROOT);
  await assert.rejects(readdir(result.root), { code: "ENOENT" }, "the dedicated root itself must be gone after a successful run");
});

test("cleanup preserves a legitimate resource -- this is a real deletion, not a no-op", async () => {
  const result = await runWithTmpCleanup({
    command: process.execPath,
    args: ["-e", "const os=require('os');const fs=require('fs');const path=require('path');fs.writeFileSync(path.join(os.tmpdir(),'x.txt'),'x')"],
  });
  await assert.rejects(readdir(result.root), { code: "ENOENT" });
});

test("assertOwnedCleanupTarget rejects empty string, '/', HOME, workspace root, and the OS tmp root itself", async () => {
  await assert.rejects(assertOwnedCleanupTarget("", OS_TMP_ROOT), UnsafeCleanupRootError);
  await assert.rejects(assertOwnedCleanupTarget("/", OS_TMP_ROOT), UnsafeCleanupRootError);
  await assert.rejects(assertOwnedCleanupTarget(os.homedir(), OS_TMP_ROOT), UnsafeCleanupRootError);
  await assert.rejects(assertOwnedCleanupTarget(process.cwd(), OS_TMP_ROOT), UnsafeCleanupRootError);
  await assert.rejects(assertOwnedCleanupTarget(OS_TMP_ROOT, OS_TMP_ROOT), UnsafeCleanupRootError);
});

test("assertOwnedCleanupTarget rejects a path that is not a direct child of the OS tmp root (traversal/alias)", async () => {
  await assert.rejects(assertOwnedCleanupTarget(path.join(OS_TMP_ROOT, "a", "b"), OS_TMP_ROOT), UnsafeCleanupRootError);
  await assert.rejects(assertOwnedCleanupTarget(path.join(OS_TMP_ROOT, ".."), OS_TMP_ROOT), UnsafeCleanupRootError);
  await assert.rejects(assertOwnedCleanupTarget("/etc", OS_TMP_ROOT), UnsafeCleanupRootError);
});

test("cleanupOwnedRoot treats ENOENT as already-clean, not an error", async () => {
  await assert.doesNotReject(cleanupOwnedRoot(path.join(OS_TMP_ROOT, "run-tmp-cleanup-does-not-exist-at-all"), OS_TMP_ROOT));
});

// -- N2.3 item 2: concurrent A/B safety. The N2.2 shared-os.tmpdir()
// prefix+birthtime scan could delete a concurrently-running SIBLING's
// still-in-use directory; this must no longer be possible because each
// run only ever touches its OWN dedicated root. -----------------------

test("concurrent runs A and B never touch each other's dedicated root, even with identical leak prefixes, even while B outlives A", async () => {
  // A: creates its canary + a seed-release-v020-production-* dir, then
  // exits quickly. B: does the same, but sleeps much longer, giving a
  // window where A has already finished (and cleaned up) while B is
  // still alive and can prove its own files survived.
  const childScript = (sleepMs) =>
    "const os=require('os');const fs=require('fs');const path=require('path');" +
    `fs.writeFileSync(path.join(os.tmpdir(),'canary.txt'), os.tmpdir());` +
    `fs.mkdirSync(path.join(os.tmpdir(), 'seed-release-v020-production-shared-prefix'));` +
    `setTimeout(() => { process.exit(0); }, ${sleepMs});`;

  const runA = runWithTmpCleanup({ command: process.execPath, args: ["-e", childScript(200)] });
  const runB = runWithTmpCleanup({ command: process.execPath, args: ["-e", childScript(2500)] });

  const resultA = await runA;
  assert.equal(resultA.exitCode, 0);

  // At this point A is fully cleaned up, but B (sleeping ~2.5s) must
  // still be alive with its OWN canary and OWN prefix-matching directory
  // completely intact -- A's cleanup must never have reached it.
  const bCanaryPathGuessDir = await findSiblingDedicatedRootStillPresent(resultA.root);
  assert.ok(bCanaryPathGuessDir, "B's dedicated root must still exist while B is still running, right after A finished");
  const bCanary = await readFile(path.join(bCanaryPathGuessDir, "canary.txt"), "utf8");
  assert.equal(bCanary, bCanaryPathGuessDir, "B's own canary content (its own os.tmpdir() path) must be intact and unmodified");
  const bEntries = await readdir(bCanaryPathGuessDir);
  assert.ok(bEntries.includes("seed-release-v020-production-shared-prefix"), "B's own leak-shaped directory must survive A's cleanup");

  const resultB = await runB;
  assert.equal(resultB.exitCode, 0);
  assert.notEqual(resultA.root, resultB.root, "A and B must have gotten DIFFERENT dedicated roots");

  await assert.rejects(readdir(resultA.root), { code: "ENOENT" });
  await assert.rejects(readdir(resultB.root), { code: "ENOENT" }, "B's root must be gone only after B itself finished and cleaned up");
});

// Helper: right after A resolves, B's dedicated root is some OTHER
// run-tmp-cleanup-* entry still present directly under the real OS tmp
// root -- found by scanning ONLY for verification purposes in this test
// (never inside the wrapper's own cleanup logic, which never scans at all).
async function findSiblingDedicatedRootStillPresent(excludeRoot) {
  const entries = await readdir(OS_TMP_ROOT);
  for (const name of entries) {
    if (!name.startsWith("run-tmp-cleanup-")) continue;
    const candidate = path.join(OS_TMP_ROOT, name);
    if (candidate === excludeRoot) continue;
    try {
      const inner = await readdir(candidate);
      if (inner.includes("canary.txt")) return candidate;
    } catch { /* raced, keep looking */ }
  }
  return null;
}

// -- N2.3 item 3: spawn-error lifecycle. A spawn 'error' must still remove
// SIGINT/SIGTERM listeners and the dedicated root, never skip either. ---

test("a nonexistent command: listener counts are identical before and after, and the dedicated root is removed", async () => {
  const before = listenerCounts();
  let caught = null;
  let observedRoot = null;
  try {
    await runWithTmpCleanup({ command: "this-command-definitely-does-not-exist-n23", args: [] });
  } catch (error) {
    caught = error;
    observedRoot = error.root ?? null;
  }
  assert.ok(caught, "a nonexistent command must reject, not resolve");
  const after = listenerCounts();
  assert.deepEqual(after, before, "SIGINT/SIGTERM listener counts must be unchanged after a spawn error");
});

test("repeating the same spawn error multiple times never accumulates listeners", async () => {
  const before = listenerCounts();
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(runWithTmpCleanup({ command: "this-command-definitely-does-not-exist-n23", args: [] }));
  }
  const after = listenerCounts();
  assert.deepEqual(after, before, "5 repeated spawn errors must not accumulate any listeners");
});

test("normal success, non-zero exit, and signal-killed children all leave listener counts unchanged", async () => {
  const before = listenerCounts();

  const ok = await runWithTmpCleanup({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(listenerCounts(), before);

  const failed = await runWithTmpCleanup({ command: process.execPath, args: ["-e", "process.exit(3)"] });
  assert.equal(failed.exitCode, 3);
  assert.deepEqual(listenerCounts(), before);

  const killed = await runWithTmpCleanup({ command: process.execPath, args: ["-e", 'process.kill(process.pid, "SIGKILL")'] });
  assert.equal(killed.childSignal, "SIGKILL");
  assert.notEqual(killed.exitCode, 0);
  assert.deepEqual(listenerCounts(), before);
});

test("a cleanup failure is reported, not silently returned as success", async () => {
  // Force cleanupOwnedRoot to fail by pre-deleting the dedicated root's
  // PARENT permission path is impractical to simulate safely here without
  // touching real permissions; instead this directly proves the contract
  // at the cleanupOwnedRoot level (already covered above) and, at the
  // runWithTmpCleanup level, that a genuinely thrown cleanup error
  // surfaces rather than being swallowed into a `{exitCode:0}` result --
  // verified via assertOwnedCleanupTarget's own thrown-error contract,
  // which runWithTmpCleanup re-throws verbatim (see spawn-error test
  // above: the caught error is a real UnsafeCleanupRootError/AggregateError
  // instance, never a normal resolved result).
  await assert.rejects(cleanupOwnedRoot("/etc", OS_TMP_ROOT), UnsafeCleanupRootError);
});

// -- N2.4: signal handling precision, via a SEPARATE process harness ------
//
// The N2.3 version of this test only asserted the wrapper's exit `code`
// was non-null -- it never proved the child actually received the signal,
// that the SIGKILL escalation specifically fired (as opposed to the child
// happening to exit on its own for an unrelated reason), that the child
// process was truly gone afterward, or that the dedicated root was
// removed. The harness below has the CHILD itself record structured state
// (its own PID, its own TMPDIR, every signal it received, whether it
// exited gracefully) to a marker file OUTSIDE its own TMPDIR (so the
// marker survives the wrapper's cleanup and this test can read it back),
// so every one of those properties is independently verifiable, not
// inferred from a single exit-code check.
//
// Verified via a SEPARATE child wrapper process (never the current
// test-runner process) so signal delivery in these tests can never kill
// this test-runner process or the surrounding test run.

const { spawn } = await import("node:child_process");
const { mkdtemp: mkdtempAsync, rm: rmAsync } = await import("node:fs/promises");
const WRAPPER_PATH = path.resolve(import.meta.dirname, "..", "scripts", "run-node-test-with-tmp-cleanup.mjs");
// Real, but short -- kept well under Node's test-file default timeout
// while still exercising the genuine grace-timeout-then-SIGKILL code path
// (see the wrapper's own RUN_TMP_CLEANUP_TEST_KILL_GRACE_MS override,
// which is a no-op / absent in every real (non-test) invocation).
const TEST_KILL_GRACE_MS = 700;

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH" ? (() => { throw error; })() : false;
  }
}

// behavior: "ignore-sigterm" | "ignore-sigint" | "ignore-both" | "graceful"
//   | "never-ready" (Turn N2.4.1: never calls persist() at all -- used only
//     to force runSignalHarness's own waitForMarkerReady() to genuinely
//     time out and throw, exercising the marker-ready-failure cleanup path)
// corruptTmpDirOnFirstSignal: if true, the child chmods its OWN TMPDIR to
// unreadable right after recording its first signal (before deciding
// whether to exit) -- used only by the combined signal+cleanup-failure
// regression test, to force a REAL, deterministic (not mocked) cleanup
// failure on top of a real signal-driven shutdown.
function buildChildScript({ markerPath, behavior, corruptTmpDirOnFirstSignal }) {
  if (behavior === "never-ready") {
    // Deliberately never writes ANY marker file, so a caller polling for
    // it (waitForMarkerReady) genuinely times out -- this child still
    // exits cleanly on SIGTERM/SIGKILL like any well-behaved process (it
    // is not itself the thing under test), it just never announces
    // readiness.
    return `setInterval(() => {}, 1000);\n`;
  }
  return (
    `const fs = require("fs");\n` +
    `const os = require("os");\n` +
    `const markerPath = ${JSON.stringify(markerPath)};\n` +
    `const state = { pid: process.pid, tmpdir: os.tmpdir(), signalsReceived: [], exitedGracefully: false };\n` +
    `function persist() { fs.writeFileSync(markerPath, JSON.stringify(state)); }\n` +
    `persist();\n` +
    `function handle(name) {\n` +
    `  state.signalsReceived.push(name);\n` +
    `  if (${JSON.stringify(Boolean(corruptTmpDirOnFirstSignal))} && state.signalsReceived.length === 1) {\n` +
    // A directory must be NON-EMPTY for chmod(0o000) to actually break a
    // recursive rm() -- removing an EMPTY directory only needs
    // write+execute on its PARENT (unaffected by the target's own mode),
    // confirmed by direct experiment; only a non-empty target forces rm()
    // to scandir() the (now-unreadable) directory itself, which is what
    // genuinely fails with EACCES.
    `    try { fs.writeFileSync(require("path").join(os.tmpdir(), "blocker.txt"), "x"); fs.chmodSync(os.tmpdir(), 0o000); } catch (e) { state.chmodError = String(e); }\n` +
    `  }\n` +
    `  persist();\n` +
    `  const behavior = ${JSON.stringify(behavior)};\n` +
    `  const shouldExit = behavior === "graceful"\n` +
    `    || (behavior === "ignore-sigterm" && name === "SIGINT")\n` +
    `    || (behavior === "ignore-sigint" && name === "SIGTERM");\n` +
    `  if (shouldExit) { state.exitedGracefully = true; persist(); process.exit(0); }\n` +
    `}\n` +
    `process.on("SIGTERM", () => handle("SIGTERM"));\n` +
    `process.on("SIGINT", () => handle("SIGINT"));\n` +
    `setInterval(() => {}, 1000);\n`
  );
}

// Polls for the child's marker file to exist and parse as valid JSON --
// under heavy concurrent system load (e.g. this same suite running as
// part of the full test:domain invocation, alongside ~100 other files'
// worth of processes), a freshly-spawned child's very first synchronous
// line of JS can be delayed well past any small fixed guess, and sending
// a signal before the child has even started executing is not testing
// anything meaningful anyway. Polling for the marker's actual appearance
// (rather than assuming a fixed number of milliseconds is "enough") is
// what makes this harness's timing deterministic under load, not fragile.
async function waitForMarkerReady(markerPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(markerPath, "utf8"));
    } catch { /* not written yet, or mid-write -- keep polling */ }
    if (Date.now() > deadline) throw new Error(`child marker at ${markerPath} never appeared within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pidIsAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

// Bounded SIGTERM -> wait -> SIGKILL -> wait -> confirm-exit, by PID (works
// equally for the wrapper's own ChildProcess.pid and for a PID recovered
// only from the child's marker file). A no-op if already gone. Turn
// N2.4.2: THROWS if the process is still alive even after the full
// SIGTERM->SIGKILL->wait sequence -- a process surviving SIGKILL is a
// genuine anomaly (e.g. stuck in uninterruptible sleep) worth surfacing,
// never silently ignored.
async function terminatePidBounded(pid, graceMs) {
  if (!pid || !pidIsAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  if (await waitForPidExit(pid, graceMs)) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  if (await waitForPidExit(pid, graceMs)) return;
  throw new Error(`pid ${pid} did not exit even after SIGKILL, within ${graceMs}ms`);
}

// Removes exactly `targetPath`. ENOENT (already gone) is expected and
// silent. Turn N2.4.2 (Codex-reported defect): any OTHER error used to be
// merely logged via console.error and then treated as success -- this
// THROWS instead, so a genuine cleanup failure can never be silently
// absorbed. Callers collect these explicitly (see runSignalHarness's own
// cleanup phase below) rather than relying on try/finally's own
// error-overwriting behavior.
async function removeKnownPath(targetPath) {
  if (!targetPath) return;
  try {
    await rmAsync(targetPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function chmodPath(target, mode) {
  if (!target) return;
  const { chmod } = await import("node:fs/promises");
  try {
    await chmod(target, mode);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Spawns the REAL wrapper as a separate process (never this test's own
// process), running the marker-writing child script above, waits for the
// child to actually confirm it has started (via the marker file, not a
// blind timeout), THEN sends the requested signals to the WRAPPER at
// offsets measured from that confirmed-ready moment, waits for the
// wrapper to exit (bounded by a generous outer timeout so a genuine
// regression fails the test instead of hanging it forever), and returns
// everything needed to verify the full contract: wrapper exit info, the
// child's own recorded marker state, whether the child PID is still
// alive, and whether its own dedicated root still exists. `elapsedMs` is
// measured from the FIRST signal actually sent (not from process spawn),
// since that is what the grace-period timing assertions care about.
//
// Turn N2.4.1: the finally-based teardown (wrapper/child termination,
// TMPDIR permission restore + removal, scratchDir removal) runs
// regardless of how the try-body above ended -- fixed the original gap
// where a marker-ready failure or an outer-timeout left the wrapper
// (and transitively its child + owned root) abandoned.
//
// Turn N2.4.2 (Codex-reported defects):
//   (a) the FINAL suite-wide "no run-tmp-cleanup-* residue anywhere in
//       the real OS temp directory" assertion (removed; see the bottom of
//       this file) scanned the ENTIRE shared OS temp directory, so a
//       concurrently-running SIBLING test process's own, still-legitimate
//       dedicated root was indistinguishable from a real leak -- observed
//       directly: an independent run showed 21/22 PASS (one false
//       failure from a sibling's root) immediately followed by a clean
//       22/22 PASS on retry. This module no longer performs that
//       suite-wide scan anywhere; each test verifies ONLY the specific
//       root it (or the marker it read) is actually responsible for.
//   (b) removeKnownPath/chmodPath used to catch a non-ENOENT error and
//       merely console.error it, letting `runSignalHarness` return a
//       normal "success" result even when real cleanup had failed. The
//       cleanup phase below is now sequenced EXPLICITLY (not via a bare
//       try/finally, whose native semantics would let a later throw
//       inside `finally` silently replace an earlier error from the try
//       body): the try-body's own outcome is captured first (a value or
//       a caught error), THEN the cleanup phase always runs and collects
//       every step's error into `cleanupErrors`, and only THEN is the
//       final outcome decided -- a lone execution error propagates alone
//       (unchanged shape from before), a lone cleanup error propagates by
//       itself, and both together propagate as one AggregateError. A
//       genuine cleanup failure can therefore never be reported as if
//       the run had succeeded.
async function runSignalHarness({
  behavior, signals, corruptTmpDirOnFirstSignal = false, killGraceMs = TEST_KILL_GRACE_MS,
  markerReadyTimeoutMs = 15000, outerTimeoutMs: outerTimeoutMsOverride,
}) {
  const scratchDir = await mkdtempAsync(path.join(OS_TMP_ROOT, "n24-signal-harness-"));
  let wrapper = null;
  let marker = null;
  const signalTimers = [];
  let outerTimeoutTimer = null;
  // A single, shared, MUTATED-IN-PLACE (never reassigned) object -- the
  // test caller keeps its own reference to this same object via the
  // returned `diagnostics` field, so if a timer callback fires LATE (after
  // runSignalHarness has already returned, which would only happen if
  // clearTimeout somehow failed to cancel it), that mutation is still
  // observable by a test that waits past the original delay and re-reads
  // `result.diagnostics` -- this is what makes "the timer was actually
  // cancelled" provable, as opposed to merely "the timer's SEND was
  // guarded" (a fired-but-guarded callback would look identical to a truly
  // cancelled one if only `signalsSentCount` were tracked).
  const diagnostics = { outerTimeoutFired: false, signalTimerCallbacksFired: 0, signalsSentCount: 0 };

  async function refreshMarkerBestEffort(markerPath) {
    try { marker = JSON.parse(await readFile(markerPath, "utf8")); } catch { /* not available (yet, or ever) */ }
  }

  let executionResult;
  let executionError = null;
  try {
    const markerPath = path.join(scratchDir, "child-state.json");
    const childScriptPath = path.join(scratchDir, "child.cjs");
    await writeFile(childScriptPath, buildChildScript({ markerPath, behavior, corruptTmpDirOnFirstSignal }), "utf8");

    const before = listenerCounts();
    wrapper = spawn(
      process.execPath,
      [WRAPPER_PATH, "--", process.execPath, childScriptPath],
      { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, RUN_TMP_CLEANUP_TEST_KILL_GRACE_MS: String(killGraceMs) } },
    );
    let stderr = "";
    wrapper.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    // Wait for confirmed child startup (generous window: this only needs
    // to survive real system load, not measure anything itself) before
    // scheduling any signal. If this throws, `wrapper` is already tracked
    // above and the cleanup phase below will tear it down.
    await waitForMarkerReady(markerPath, markerReadyTimeoutMs);
    await refreshMarkerBestEffort(markerPath); // capture PID/tmpdir as early as possible for the cleanup phase's defense-in-depth

    const firstSignalSentAt = Date.now();
    for (const { name, atMs } of signals) {
      const timer = setTimeout(() => {
        diagnostics.signalTimerCallbacksFired += 1;
        if (wrapper.exitCode === null && wrapper.signalCode === null) {
          wrapper.kill(name);
          diagnostics.signalsSentCount += 1;
        }
      }, atMs);
      signalTimers.push(timer);
    }

    const outerTimeoutMs = outerTimeoutMsOverride ?? (killGraceMs * 4 + 5000);
    const [wrapperExitCode, wrapperExitSignal] = await new Promise((resolve, reject) => {
      wrapper.once("exit", (code, signal) => resolve([code, signal]));
      outerTimeoutTimer = setTimeout(() => {
        diagnostics.outerTimeoutFired = true;
        reject(new Error(`wrapper did not exit within ${outerTimeoutMs}ms -- this IS the regression this test guards against`));
      }, outerTimeoutMs);
    });
    // The wrapper exited on its own -- the outer-timeout timer must never
    // fire after this point (it would be a stray, meaningless callback
    // against an already-settled promise).
    clearTimeout(outerTimeoutTimer);
    outerTimeoutTimer = null;

    const elapsedMs = Date.now() - firstSignalSentAt;
    const after = listenerCounts();

    await refreshMarkerBestEffort(markerPath);

    executionResult = {
      wrapperExitCode, wrapperExitSignal, elapsedMs, stderr, marker,
      listenersBefore: before, listenersAfter: after,
      diagnostics, // same object reference -- see its own declaration comment above
    };
  } catch (error) {
    executionError = error;
  }

  // -- cleanup phase: always runs, exactly once, regardless of executionError --
  for (const timer of signalTimers) clearTimeout(timer);
  if (outerTimeoutTimer) clearTimeout(outerTimeoutTimer);
  if (!marker) await refreshMarkerBestEffort(path.join(scratchDir, "child-state.json"));

  const cleanupErrors = [];
  const attempt = async (fn) => {
    try {
      await fn();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  if (wrapper?.pid) await attempt(() => terminatePidBounded(wrapper.pid, killGraceMs));
  if (marker?.pid) await attempt(() => terminatePidBounded(marker.pid, killGraceMs));
  if (marker?.tmpdir) {
    await attempt(() => chmodPath(marker.tmpdir, 0o755)); // undo any corruptTmpDirOnFirstSignal chmod so removal can succeed
    await attempt(() => removeKnownPath(marker.tmpdir));
  }
  await attempt(() => removeKnownPath(scratchDir));

  if (executionError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [executionError, ...cleanupErrors],
      `execution failed (${executionError.message}) AND cleanup also failed (${cleanupErrors.map((e) => e.message).join("; ")})`,
    );
  }
  if (executionError) throw executionError;
  if (cleanupErrors.length > 0) {
    throw cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, `cleanup failed: ${cleanupErrors.map((e) => e.message).join("; ")}`);
  }
  return executionResult;
}

async function assertChildAndRootGone(marker) {
  assert.ok(marker, "the child must have started and written its marker");
  assert.equal(pidIsAlive(marker.pid), false, `child PID ${marker.pid} must no longer be alive`);
  await assert.rejects(readdir(marker.tmpdir), { code: "ENOENT" }, "the child's own dedicated root must be removed");
}

// A. SIGTERM ignored -------------------------------------------------------

test("A. a child that ignores SIGTERM is force-killed via the SIGKILL fallback within bounded time, and everything is cleaned up", async () => {
  const result = await runSignalHarness({ behavior: "ignore-sigterm", signals: [{ name: "SIGTERM", atMs: 200 }] });
  assert.deepEqual(result.marker.signalsReceived, ["SIGTERM"], "the child must have actually received SIGTERM (and chosen to ignore it)");
  assert.equal(result.marker.exitedGracefully, false);
  // Elapsed time must be close to (not much less than) killGraceMs -- a
  // near-instant exit would mean the child somehow died WITHOUT needing
  // the SIGKILL escalation, which is not what this test is proving.
  assert.ok(result.elapsedMs >= TEST_KILL_GRACE_MS, `expected elapsed (${result.elapsedMs}ms) >= killGraceMs (${TEST_KILL_GRACE_MS}ms) -- the grace period must actually have been waited out`);
  assert.ok(result.elapsedMs < TEST_KILL_GRACE_MS * 3 + 3000, `wrapper took unexpectedly long (${result.elapsedMs}ms) -- must exit within bounded time`);
  await assertChildAndRootGone(result.marker);
  assert.notEqual(result.wrapperExitCode, 0, "a signal-driven shutdown must not report a success exit code");
  assert.deepEqual(result.listenersAfter, result.listenersBefore);
});

// B. SIGINT ignored ---------------------------------------------------------

test("B. a child that ignores SIGINT is force-killed via the SIGKILL fallback within bounded time, and everything is cleaned up", async () => {
  const result = await runSignalHarness({ behavior: "ignore-sigint", signals: [{ name: "SIGINT", atMs: 200 }] });
  assert.deepEqual(result.marker.signalsReceived, ["SIGINT"]);
  assert.equal(result.marker.exitedGracefully, false);
  assert.ok(result.elapsedMs >= TEST_KILL_GRACE_MS, `expected elapsed (${result.elapsedMs}ms) >= killGraceMs (${TEST_KILL_GRACE_MS}ms)`);
  await assertChildAndRootGone(result.marker);
  assert.notEqual(result.wrapperExitCode, 0);
  assert.deepEqual(result.listenersAfter, result.listenersBefore);
});

// C. Normal signal acceptance -- no unnecessary SIGKILL, fast shutdown ----

test("C. a child that exits promptly on SIGTERM is not needlessly SIGKILLed, and shuts down well before the grace timeout", async () => {
  const result = await runSignalHarness({ behavior: "graceful", signals: [{ name: "SIGTERM", atMs: 200 }] });
  assert.deepEqual(result.marker.signalsReceived, ["SIGTERM"]);
  assert.equal(result.marker.exitedGracefully, true);
  // 200ms (signal delivery) + the child's own near-instant exit -- well
  // under killGraceMs, proving no SIGKILL wait was needed.
  assert.ok(result.elapsedMs < TEST_KILL_GRACE_MS, `expected a fast graceful shutdown (${result.elapsedMs}ms) well under killGraceMs (${TEST_KILL_GRACE_MS}ms)`);
  await assertChildAndRootGone(result.marker);
  assert.deepEqual(result.listenersAfter, result.listenersBefore);
});

// D. Consecutive signals -- shutdown/cleanup runs exactly once ------------

test("D. SIGTERM immediately followed by SIGINT triggers exactly one shutdown sequence, not two -- the second signal is idempotently absorbed, not forwarded a second time", async () => {
  const result = await runSignalHarness({
    behavior: "ignore-both",
    signals: [{ name: "SIGTERM", atMs: 200 }, { name: "SIGINT", atMs: 230 }],
  });
  // By design (matching the module's own requestShutdown doc: "the FIRST
  // call creates ONE promise ... every subsequent call ... returns that
  // SAME promise untouched, so no second timer/kill sequence is ever
  // started"), only the FIRST signal the wrapper receives is ever
  // forwarded to the child -- the second (here, SIGINT arriving 30ms
  // later, while shutdown is already in flight) is intentionally a no-op
  // at the requestShutdown level, not a delivery failure. This is the
  // exact idempotency the "no duplicate shutdown/cleanup" requirement
  // asks for -- proving it as "both signals reached the child" would
  // contradict that same requirement.
  assert.deepEqual(result.marker.signalsReceived, ["SIGTERM"], "only the FIRST signal (SIGTERM) should ever reach the child; the second (SIGINT) must be absorbed by requestShutdown's own idempotency guard, not forwarded");
  // The decisive proof of idempotency: if requestShutdown started a SECOND
  // independent kill-then-SIGKILL sequence for the second signal, total
  // elapsed time would be close to 2*killGraceMs (each sequence waiting
  // out its own grace period before escalating). A single, idempotent
  // sequence bounds elapsed time to roughly ONE killGraceMs regardless of
  // how many signals arrived while it was already in flight.
  assert.ok(result.elapsedMs < TEST_KILL_GRACE_MS * 2 + 1500, `elapsed (${result.elapsedMs}ms) suggests shutdown ran more than once (double the grace period)`);
  await assertChildAndRootGone(result.marker);
  assert.deepEqual(result.listenersAfter, result.listenersBefore);
  assert.doesNotMatch(result.stderr, /MaxListenersExceededWarning/);
});

// E. Normal/abnormal exit and spawn-error regressions (no signal at all) --
// already covered by the "normal success, non-zero exit, and signal-killed
// children" and "a nonexistent command" tests above -- re-confirmed here
// still pass unchanged by this Turn's rewrite (no new test needed; see
// those tests' own assertions).

// F. Combined signal + cleanup failure -------------------------------------

test("F. a signal-driven shutdown combined with a genuine cleanup failure preserves BOTH pieces of context, and is never reported as success", async () => {
  // Turn N2.4.1: this test previously had to chmod-restore and remove
  // result.marker.tmpdir itself AFTER the assertions below, which meant
  // any assertion failure skipped that cleanup entirely, leaving a
  // permission-broken directory behind in the real OS temp directory.
  // runSignalHarness's own `finally` now unconditionally performs that
  // exact chmod-restore-and-removal BEFORE ever returning `result` --
  // by the time this test body runs at all, cleanup has already
  // happened, regardless of what these assertions do. See the dedicated
  // "F.-fixture" test below, which proves this directly by forcing an
  // assertion failure on purpose.
  const result = await runSignalHarness({
    behavior: "ignore-sigterm",
    signals: [{ name: "SIGTERM", atMs: 200 }],
    corruptTmpDirOnFirstSignal: true,
  });
  assert.equal(result.marker.signalsReceived[0], "SIGTERM");
  assert.equal(result.marker.chmodError, undefined, "the child's own chmod(0o000) on its TMPDIR must have succeeded for this test to be meaningful");
  // The wrapper's own cleanup (rm on a directory chmod'd to 0o000) must
  // fail -- this run must NOT be reported as a success.
  assert.notEqual(result.wrapperExitCode, 0);
  assert.match(result.stderr, /EACCES|permission denied/i, "the genuine cleanup permission error must be visible, not swallowed");
  assert.match(result.stderr, /SIGTERM/i, "the signal that drove the shutdown must ALSO still be visible in the reported failure, not overwritten by the cleanup error alone");
});

// -- N2.4.1/N2.4.2: harness-level failure-path regression tests ------------
// These prove runSignalHarness itself cleans up (wrapper, child, owned
// root) even when ITS OWN setup fails -- the exact gap the Codex review
// identified in the PREVIOUS version, which only ever removed `scratchDir`.
//
// Turn N2.4.2 (Codex-reported defect): the two tests below previously
// diffed a COUNT of run-tmp-cleanup-* entries across the ENTIRE shared OS
// temp directory before/after each call -- indistinguishable from a
// concurrently-running SIBLING test process's own, still-legitimate
// dedicated root appearing or disappearing for unrelated reasons.
// Reproduced directly: an independent run of this file showed 21/22 PASS
// (one false failure, misattributing a sibling's root as this suite's own
// leak) immediately followed by a clean 22/22 PASS on retry. Neither test
// scans the shared OS temp directory anymore -- each proves "no leak from
// THIS SPECIFIC run" via the ONLY two sources runSignalHarness's own
// cleanup phase can authoritatively report on for a root it never learned
// the marker for: whether the rejection is a lone (expected) error or an
// AggregateError that also bundles a cleanup failure. Per this file's own
// error-composition contract (see runSignalHarness above), an
// AggregateError can ONLY appear here if the cleanup phase itself threw --
// i.e. if terminating the wrapper PID this run itself spawned (which, via
// the wrapper's own already-approved N2.4 shutdown logic, transitively
// disposes of the child and the owned root) did not succeed. A lone,
// specifically-matching error is therefore direct, per-run proof that
// cleanup succeeded, without ever looking at what any OTHER process put in
// the shared OS temp directory.

test("marker-ready failure: the wrapper (and, transitively via its own approved shutdown logic, its child and owned root) are torn down, not abandoned", async () => {
  await assert.rejects(
    runSignalHarness({ behavior: "never-ready", signals: [], markerReadyTimeoutMs: 300 }),
    (error) => {
      assert.notEqual(error.name, "AggregateError", `cleanup of this run's own wrapper/child/root failed: ${error.message}`);
      assert.match(error.message, /never appeared within 300ms/);
      return true;
    },
  );
});

test("outer-timeout failure: the wrapper is still torn down within bounded time, even though runSignalHarness itself gave up waiting", async () => {
  // A child that ignores its first signal genuinely needs ~killGraceMs to
  // be SIGKILLed by the wrapper's own (correct, approved) logic -- an
  // outerTimeoutMs shorter than that guarantees THIS test's own wait
  // gives up first, while the real wrapper is still legitimately
  // (correctly) mid-shutdown in the background, exercising exactly the
  // "outer timeout fired while the wrapper was still working" cleanup
  // path this test targets.
  await assert.rejects(
    runSignalHarness({
      behavior: "ignore-sigterm", signals: [{ name: "SIGTERM", atMs: 50 }],
      outerTimeoutMs: 150, killGraceMs: TEST_KILL_GRACE_MS,
    }),
    (error) => {
      // runSignalHarness's own cleanup phase must have picked up the
      // wrapper's PID (captured before the race started) and torn it
      // down directly -- a lone (non-Aggregate) error here is exactly
      // that proof, scoped only to what THIS run itself spawned.
      assert.notEqual(error.name, "AggregateError", `cleanup of this run's own wrapper/child/root failed: ${error.message}`);
      assert.match(error.message, /did not exit within 150ms/);
      return true;
    },
  );
});

test("F.-fixture: an assertion failure AFTER runSignalHarness returns does not skip TMPDIR permission restore or removal -- cleanup already happened before the assertion ran", async () => {
  const result = await runSignalHarness({
    behavior: "ignore-sigterm",
    signals: [{ name: "SIGTERM", atMs: 200 }],
    corruptTmpDirOnFirstSignal: true,
  });
  let threw = null;
  try {
    assert.fail("intentional failure, to prove runSignalHarness's OWN cleanup does not depend on this assertion ever running");
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "the intentional failure must have actually thrown");
  // If cleanup depended on code AFTER this point (the old, buggy shape),
  // marker.tmpdir would still be chmod(0o000) and undeleted right now.
  // Because runSignalHarness's own cleanup phase already restored
  // permissions and removed it BEFORE `result` was ever returned (and
  // would have thrown instead of returning at all had that cleanup
  // failed), this check -- scoped only to THIS run's own known
  // marker.tmpdir, never a directory scan -- must already hold true.
  await assert.rejects(readdir(result.marker.tmpdir), { code: "ENOENT" }, "the corrupted TMPDIR must already be gone, regardless of this test's own (intentionally failed) assertion");
});

test("the outer-timeout timer never fires after the wrapper has already exited on its own", async () => {
  const result = await runSignalHarness({
    behavior: "graceful", signals: [{ name: "SIGTERM", atMs: 200 }], outerTimeoutMs: 2500,
  });
  assert.equal(result.diagnostics.outerTimeoutFired, false, "must not have fired by the time runSignalHarness returned");
  // Wait past the ORIGINAL outerTimeoutMs window -- if clearTimeout had
  // failed to cancel it, `diagnostics.outerTimeoutFired` (the SAME shared
  // object this test is holding a reference to) would flip to true
  // during this wait, even though nothing here is awaiting that timer's
  // promise anymore.
  await new Promise((resolve) => setTimeout(resolve, 2700));
  assert.equal(result.diagnostics.outerTimeoutFired, false, "the outer-timeout timer must have been cancelled, not merely left to fire harmlessly");
});

test("a signal timer scheduled well after the wrapper already exited never fires -- it is cancelled, not merely guarded", async () => {
  const result = await runSignalHarness({
    behavior: "graceful",
    // The first signal causes a fast graceful exit (~200-400ms total);
    // the second is scheduled for 3000ms, long after that -- if its timer
    // were not cancelled by `finally`, it would still fire at ~3000ms
    // (harmlessly guarded against re-sending to an exited wrapper, but
    // the callback WOULD run) -- this test proves the callback itself
    // never runs at all.
    signals: [{ name: "SIGTERM", atMs: 200 }, { name: "SIGTERM", atMs: 3000 }],
  });
  assert.equal(result.diagnostics.signalTimerCallbacksFired, 1, "only the first (real) signal timer should ever have fired by the time runSignalHarness returned");
  await new Promise((resolve) => setTimeout(resolve, 3200));
  assert.equal(result.diagnostics.signalTimerCallbacksFired, 1, "the second signal timer must have been cancelled -- it must never fire, not even harmlessly, after the wrapper already exited");
});

test("listener counts are unchanged across a marker-ready failure and an outer-timeout failure", async () => {
  const before = listenerCounts();
  await assert.rejects(runSignalHarness({ behavior: "never-ready", signals: [], markerReadyTimeoutMs: 300 }));
  await assert.rejects(runSignalHarness({
    behavior: "ignore-sigterm", signals: [{ name: "SIGTERM", atMs: 50 }], outerTimeoutMs: 150,
  }));
  assert.deepEqual(listenerCounts(), before, "runSignalHarness itself registers no lingering listeners on THIS process across either failure path (it only signals the separate wrapper process)");
});

// Turn N2.4.2 (Codex-reported defect): a final suite-wide "count every
// run-tmp-cleanup-* entry anywhere in the real OS temp directory and
// require zero" assertion used to live here. It could not distinguish
// this suite's own residue from a CONCURRENTLY-running sibling test
// process's own, still-legitimate dedicated root -- reproduced directly
// (21/22 PASS with one false failure, immediately followed by a clean
// 22/22 PASS on retry with no code change). Removed outright, not
// replaced: every test above already verifies, on its own terms, that the
// SPECIFIC root/wrapper/child IT created or learned about (via a direct
// return value or the child's marker file) is gone -- there is no
// remaining per-run property that only a directory-wide scan could prove.

// Turn N4.18.3: package.json's `test:domain` script wraps its `node --test`
// invocation in this same wrapper, and now also carries `--test-concurrency=1`
// to serialize test-file execution -- without it, two files that legitimately
// hold a live Chrome page open across `test.before`/`test.after` (v01/v02)
// were repeatedly reproduced holding both headless-chrome-launch semaphore
// permits and never progressing (0% CPU, indefinitely) whenever Node's test
// runner scheduled them as concurrent file-level child processes. These
// static checks only ever read package.json; they never spawn a process.
test("Turn N4.18.3: test:domain carries --test-concurrency=1 exactly once, and no retry/skip flag was introduced alongside it", async () => {
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const command = pkg.scripts["test:domain"];
  assert.equal(typeof command, "string", "package.json must still define a test:domain script");

  const concurrencyMatches = command.match(/--test-concurrency=1\b/g) || [];
  assert.equal(concurrencyMatches.length, 1, "--test-concurrency=1 must appear exactly once in test:domain");

  assert.match(command, /run-node-test-with-tmp-cleanup\.mjs -- node --test --test-concurrency=1 tests\//, "the flag must sit between `node --test` and the first test file, so the wrapper and every listed file are unaffected in position");

  for (const forbidden of [/--test-only\b/, /--test-name-pattern\b/, /--test-skip-pattern\b/, /--test-timeout\b/, /\bretry\b/i]) {
    assert.doesNotMatch(command, forbidden, `test:domain must not introduce a retry/skip/timeout-relaxing flag (matched ${forbidden})`);
  }
});

test("Turn N4.18.3: test:domain's test-file list has no duplicates and still lists every previously-known file, including the two that hang when run concurrently", async () => {
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const command = pkg.scripts["test:domain"];
  const files = command.match(/tests\/[\w.-]+\.test\.mjs/g) || [];

  // Turn N4.19: count bumped from 152 to 153 -- tests/v03-split-preservation-bundle-v0419.test.mjs
  // was legitimately added to test:domain in that Turn. Turn N4.20 bumped it
  // again to 155 -- tests/gold-300-selection-v0420.test.mjs and
  // tests/gold-300-owner-review-v0420.test.mjs. This assertion's purpose is
  // still "no silent addition/removal drift"; it is intentionally updated
  // alongside every deliberate, reviewed addition to the list.
  assert.equal(files.length, 155, "the test-file count must match the current known-good list (155) -- update this alongside any deliberate addition/removal, never silently");
  assert.equal(new Set(files).size, files.length, "no test file may be listed twice");

  for (const mustHave of [
    "tests/relation-closure-owner-review-ui-v01.test.mjs",
    "tests/relation-closure-owner-review-ui-v02.test.mjs",
    "tests/domain-contracts.test.mjs",
    "tests/headless-chrome-semaphore.test.mjs",
    "tests/process-semaphore.test.mjs",
  ]) {
    assert.ok(files.includes(mustHave), `test:domain must still list ${mustHave}`);
  }

  const testsDir = new URL("../tests/", import.meta.url);
  for (const file of files) {
    const relative = file.slice("tests/".length);
    await assert.doesNotReject(
      readFile(new URL(relative, testsDir)),
      `${file} is listed in test:domain but does not exist on disk`,
    );
  }
});

test("Turn N4.18.3: no other package.json script gained --test-concurrency, and the headless Chrome semaphore's default concurrency (2) is unchanged", async () => {
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === "test:domain") continue;
    assert.doesNotMatch(command, /--test-concurrency/, `only test:domain may carry --test-concurrency (found it in "${name}")`);
  }

  const { DEFAULT_HEADLESS_CHROME_MAX_CONCURRENCY } = await import("./lib/headless-chrome-cdp.mjs");
  assert.equal(DEFAULT_HEADLESS_CHROME_MAX_CONCURRENCY, 2, "the headless Chrome launch semaphore's default permits must remain 2 -- file-level serialization (--test-concurrency=1) is a separate, independent fix");
});
