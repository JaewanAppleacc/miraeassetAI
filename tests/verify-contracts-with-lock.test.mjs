// Turn N4.18.1: verifies scripts/verify-contracts-with-lock.mjs's repo-
// scoped MUTEX behavior in isolation, using a cheap stub command instead of
// the real (multi-minute) verify:contracts chain, and stand-in "repo root"
// temp directories instead of this actual checkout, so these tests run in
// well under a second and can exercise contention/timeout/stale-reclaim
// paths deterministically.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runVerifyContractsWithLock } from "../scripts/verify-contracts-with-lock.mjs";
import { acquireSemaphore, inspectSemaphore, semaphoreRootFor } from "../scripts/lib/process-semaphore.mjs";

async function makeRepoRoot(label) {
  return mkdtemp(path.join(os.tmpdir(), `n4181-lock-repo-${label}-`));
}

// Removes both this test's stand-in "repo root" AND the semaphore's own
// state directory keyed off it (holders/waiting/ -- otherwise left behind
// forever, since a semaphore directory is normally meant to persist across
// the many real acquire/release cycles of an actual repo's lifetime, not
// torn down when "done"). Real, non-test repo lock directories are never
// touched by this helper -- only ever a path this test itself just created
// via makeRepoRoot() and mkdtemp().
async function cleanupRepoRootAndLock(repoRoot) {
  // Must match runVerifyContractsWithLock's own key derivation EXACTLY,
  // including the realpath() resolution -- on macOS, os.tmpdir() (and
  // therefore every mkdtemp() dir this test file creates) lives under
  // /var/folders/..., a symlink whose realpath is /private/var/folders/...,
  // so the raw (non-realpath'd) path would compute a DIFFERENT, wrong
  // semaphore key here and leave the real one behind as debris.
  const canonicalRoot = await realpath(repoRoot).catch(() => repoRoot);
  await rm(semaphoreRootFor(`verify-contracts:${canonicalRoot}`), { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
}

// A slow stub "verify chain" -- sleeps for a bit then exits 0. Using the
// real `sleep` binary via a real spawn (not a fake) keeps this an authentic
// exercise of the actual spawn/kill/exit wiring in
// runVerifyContractsWithLock, just against a command that finishes in
// milliseconds instead of minutes.
const SLOW_OK_COMMAND = "sleep 0.4 && exit 0";
const FAST_FAIL_COMMAND = "exit 7";

test("Turn N4.18.1 D1: two lock acquisitions requested at the same time for the SAME repo never run their command bodies concurrently -- the second only starts once the first's child has exited", async () => {
  const repoRoot = await makeRepoRoot("d1");
  try {
    const events = [];
    const first = runVerifyContractsWithLock({ repoRoot, command: "sleep 0.3 && echo first-done", timeoutMs: 5000 })
      .then((r) => { events.push("first-finished"); return r; });
    await new Promise((r) => setTimeout(r, 50)); // ensure the first has already acquired the lock
    const second = runVerifyContractsWithLock({ repoRoot, command: "echo second-ran", timeoutMs: 5000 })
      .then((r) => { events.push("second-finished"); return r; });

    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.acquired, true);
    assert.equal(r1.exitCode, 0);
    assert.equal(r2.acquired, true);
    assert.equal(r2.exitCode, 0);
    assert.deepEqual(events, ["first-finished", "second-finished"], "the second run's command must never start before the first's finished");
  } finally {
    await cleanupRepoRootAndLock(repoRoot);
  }
});

test("Turn N4.18.1 D2: after the lock-holding process exits normally, a fresh run for the same repo acquires and runs immediately", async () => {
  const repoRoot = await makeRepoRoot("d2");
  try {
    const first = await runVerifyContractsWithLock({ repoRoot, command: SLOW_OK_COMMAND, timeoutMs: 5000 });
    assert.equal(first.acquired, true);
    assert.equal(first.exitCode, 0);

    const start = Date.now();
    const second = await runVerifyContractsWithLock({ repoRoot, command: "exit 0", timeoutMs: 5000 });
    assert.equal(second.acquired, true);
    assert.equal(second.exitCode, 0);
    assert.ok(Date.now() - start < 1000, "re-running after a clean release must not wait");
  } finally {
    await cleanupRepoRootAndLock(repoRoot);
  }
});

test("Turn N4.18.1 D2b: a FAILED verify run still releases the lock (failure is not left holding the mutex forever)", async () => {
  const repoRoot = await makeRepoRoot("d2b");
  try {
    const first = await runVerifyContractsWithLock({ repoRoot, command: FAST_FAIL_COMMAND, timeoutMs: 5000 });
    assert.equal(first.acquired, true);
    assert.equal(first.exitCode, 7);

    const second = await runVerifyContractsWithLock({ repoRoot, command: "exit 0", timeoutMs: 2000 });
    assert.equal(second.acquired, true, "the lock must be free again after the failing run's process exited, regardless of its exit code");
    assert.equal(second.exitCode, 0);
  } finally {
    await cleanupRepoRootAndLock(repoRoot);
  }
});

test("Turn N4.18.1 D3: after the lock owner is force-killed (process no longer exists), the stale lock is reclaimed rather than blocking forever", async () => {
  const repoRoot = await makeRepoRoot("d3");
  // MUST match runVerifyContractsWithLock's own key derivation exactly,
  // including realpath() -- on macOS, os.tmpdir() (and therefore any
  // mkdtemp() dir under it) resolves through a real symlink
  // (/var/folders/... -> /private/var/folders/...), so skipping this step
  // would silently plant the "stale holder" in the WRONG directory and
  // make this test pass for the wrong reason (no real contention at all).
  const canonicalRoot = await realpath(repoRoot);
  const lockKey = `verify-contracts:${canonicalRoot}`;
  try {
    // Simulate "a verify-contracts-with-lock.mjs process was killed with
    // SIGKILL mid-run": acquire the real semaphore directly (bypassing the
    // wrapper's own clean release path) under a PID that we then make
    // "not exist" by never actually running that PID -- i.e., record a
    // holder with a PID from a genuinely-not-running short-lived child.
    const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => deadChild.once("exit", resolve));
    // deadChild.pid now refers to a process that has already exited.
    const staleHandle = await acquireSemaphore({ key: lockKey, permits: 1, timeoutMs: 2000, ownerMeta: { simulating: "killed-lock-owner" } });
    // Overwrite the holder record's pid to the already-exited child's pid,
    // simulating what a real crash leaves behind (a holder file recorded
    // for a PID that is now gone), without going through release().
    const fs = await import("node:fs/promises");
    const record = JSON.parse(await fs.readFile(staleHandle.slotPath, "utf8"));
    await fs.writeFile(staleHandle.slotPath, JSON.stringify({ ...record, pid: deadChild.pid }), "utf8");

    // Prove real contention exists on the SAME key runVerifyContractsWithLock
    // will use, before claiming any "reclaim" happened.
    const before = await inspectSemaphore({ key: lockKey, permits: 1 });
    assert.equal(before.holders.length, 1, "a stale holder record must genuinely be present on the exact key the wrapper will check");

    const start = Date.now();
    const recovered = await runVerifyContractsWithLock({ repoRoot, command: "exit 0", timeoutMs: 5000 });
    assert.equal(recovered.acquired, true);
    assert.equal(recovered.exitCode, 0);
    assert.ok(Date.now() - start < 3000, "a stale lock (dead owner PID) must be reclaimed well before the full timeout elapses");
  } finally {
    await cleanupRepoRootAndLock(repoRoot);
  }
});

test("Turn N4.18.1 D4: a LIVE lock owner's lock is never reclaimed early -- a genuinely bounded wait still applies, it does not fail-fast just because the holder looks 'old'", async () => {
  const repoRoot = await makeRepoRoot("d4");
  try {
    const holderPromise = runVerifyContractsWithLock({ repoRoot, command: "sleep 0.5 && exit 0", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    const waiter = await runVerifyContractsWithLock({ repoRoot, command: "echo after-live-holder", timeoutMs: 5000 });
    const elapsed = Date.now() - start;
    assert.equal(waiter.acquired, true);
    assert.ok(elapsed >= 300, `the waiter must genuinely wait for the live holder to finish (>=300ms), only waited ${elapsed}ms`);
    await holderPromise;
  } finally {
    await cleanupRepoRootAndLock(repoRoot);
  }
});

test("Turn N4.18.1 D4b: a bounded wait that exceeds the timeout while the holder is still genuinely alive fails closed with a distinguishable exit code, never hangs", async () => {
  const repoRoot = await makeRepoRoot("d4b");
  try {
    const holderPromise = runVerifyContractsWithLock({ repoRoot, command: "sleep 2 && exit 0", timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    const impatient = await runVerifyContractsWithLock({ repoRoot, command: "echo should-not-run", timeoutMs: 300 });
    assert.equal(impatient.acquired, false);
    assert.equal(impatient.exitCode, 75);
    assert.match(impatient.message, /did not free up within/);
    assert.ok(Date.now() - start < 2000, "the impatient waiter must fail at its OWN bounded timeout, not wait for the holder");
    await holderPromise;
  } finally {
    await cleanupRepoRootAndLock(repoRoot);
  }
});

test("Turn N4.18.1 D5: two DIFFERENT repo roots never cross-contaminate each other's lock, even when contended simultaneously", async () => {
  const repoA = await makeRepoRoot("d5-a");
  const repoB = await makeRepoRoot("d5-b");
  try {
    const events = [];
    const aHolder = runVerifyContractsWithLock({ repoRoot: repoA, command: "sleep 0.3 && exit 0", timeoutMs: 5000 }).then((r) => { events.push("a-done"); return r; });
    await new Promise((r) => setTimeout(r, 30));
    const start = Date.now();
    const bRun = await runVerifyContractsWithLock({ repoRoot: repoB, command: "exit 0", timeoutMs: 2000 });
    assert.equal(bRun.acquired, true);
    assert.ok(Date.now() - start < 500, "repo B's run must never be blocked by repo A's in-progress lock");
    await aHolder;
    assert.deepEqual(events, ["a-done"]);
  } finally {
    await cleanupRepoRootAndLock(repoA);
    await cleanupRepoRootAndLock(repoB);
  }
});

test("Turn N4.18.1: SIGINT delivered to the wrapper forwards to the child and still releases the lock afterward", async () => {
  const repoRoot = await makeRepoRoot("sigint");
  try {
    const child = spawn(process.execPath, [
      "-e",
      `
      import("${new URL("../scripts/verify-contracts-with-lock.mjs", import.meta.url).href}").then(async (mod) => {
        const r = await mod.runVerifyContractsWithLock({ repoRoot: ${JSON.stringify(repoRoot)}, command: "sleep 5", timeoutMs: 10000 });
        console.log(JSON.stringify(r));
      });
      `,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGINT");
    await new Promise((resolve) => child.once("exit", resolve));

    // The lock must be free again immediately -- proves release() ran even
    // though the wrapper was interrupted mid-run, not left held forever.
    const start = Date.now();
    const after = await runVerifyContractsWithLock({ repoRoot, command: "exit 0", timeoutMs: 2000 });
    assert.equal(after.acquired, true);
    assert.ok(Date.now() - start < 1000, "the lock must already be free after the SIGINT-interrupted run exited");
  } finally {
    await cleanupRepoRootAndLock(repoRoot);
  }
});
