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
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { killAndCleanup, launchHeadlessChromePage } from "./lib/headless-chrome-cdp.mjs";

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

// -- End-to-end: a genuine Chrome CDP handshake failure (unreachable
// debugging port) forces launchHeadlessChromePage's own catch block to
// run killAndCleanup for real. Verifies (1) the ORIGINAL setup error
// (waitForCdp's own timeout message) survives, and (2) no Chrome process
// referencing this test's unique port is left running afterward. -------

test("launchHeadlessChromePage: a real CDP handshake failure preserves the original setup error and leaves no Chrome process behind", async () => {
  // Port 1 is a privileged port (<1024) an unprivileged process cannot
  // bind -- Chrome's own --remote-debugging-port=1 reliably fails to
  // serve CDP, so waitForCdp() genuinely times out (~10s) and
  // launchHeadlessChromePage's catch block genuinely runs
  // killAndCleanup() for real.
  //
  // Turn N2.4 (Codex-reported defect): the previous version used
  // `await assert.rejects(promise.then(page => { unexpectedPage = page; ... }))`
  // -- if the promise unexpectedly RESOLVED, assert.rejects itself threw
  // "Missing expected rejection" from INSIDE that awaited call, which
  // skipped the `if (unexpectedPage) await unexpectedPage.close()` line
  // entirely (it never ran), leaking a real Chrome process/userDataDir.
  // Reproduced directly: pointing this same call at an ordinary
  // (non-privileged) port that Chrome CAN bind made exactly this happen.
  // Fixed with an explicit try/finally so page.close() is unconditionally
  // attempted whenever `page` was ever assigned, regardless of what the
  // assertion logic below does with the outcome.
  const port = 1;
  let page = null;
  let thrown = null;
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
    // Port 1 unexpectedly succeeded in this environment (e.g. running as
    // root, or a sandbox that permits privileged-port binds) -- the real
    // page was still safely closed above. Fail explicitly rather than
    // silently passing or skipping, so this environment difference stays
    // visible instead of being hidden behind a green checkmark.
    assert.fail(
      "port 1 unexpectedly succeeded in this environment -- the privileged-port failure this test relies on did not occur here "
      + "(the real Chrome page/process/userDataDir were still closed safely above via the try/finally)",
    );
  }

  const { stdout } = await execFileAsync("ps", ["aux"]).catch(() => ({ stdout: "" }));
  assert.doesNotMatch(stdout, new RegExp(`remote-debugging-port=${port}\\b`), "no Chrome process for this test's port must remain running");
});
