#!/usr/bin/env node
// Turn N2.2/N2.3: a thin, test-infrastructure-only wrapper that runs an
// arbitrary child command (in practice, `node --test <files...>`) inside a
// PER-RUN DEDICATED temp root, and removes exactly that dedicated root
// (nothing else) once the child has fully exited.
//
// WHY A WRAPPER, NOT A PER-TEST-FILE FIX: domain/runtime/bundle-backed-seed-runtime.mjs's
// `createBundleBackedSeedRuntime` intentionally never removes its own
// materialized temp directory on a SUCCESSFUL initialize() -- in
// production this object is a long-lived process-wide singleton
// (domain/runtime/configured-seed-runtime.mjs's `configuredSeedRuntime`)
// and the materialized files must stay alive for the whole process
// lifetime to keep serving requests; there is no "done, tear down" moment
// for production code to hook. This is NOT a bug to fix in production code
// (this Turn's own scope explicitly forbids adding a cleanup branch
// there), and per-test-file cleanup is unsafe here for a different reason:
// `node --test file-a.mjs file-b.mjs` spawns file-a and file-b as SEPARATE
// OS processes that can run CONCURRENTLY.
//
// TURN N2.3 OWNERSHIP MODEL (replaces N2.2's shared-os.tmpdir()
// prefix+birthtime scan, which a Codex review correctly flagged as able to
// delete a concurrently-running SIBLING run's still-in-use directory):
//   - each `runWithTmpCleanup` call creates exactly ONE dedicated root via
//     mkdtemp() under the real OS temp directory, ONCE, at the start of
//     that run
//   - the child is spawned with TMPDIR (and, for compatibility, TMP/TEMP)
//     pointed at that dedicated root -- os.tmpdir() inside the child (and
//     any grandchild it spawns, e.g. `npm ci`) then resolves there, so
//     EVERY temp file/directory the child creates -- under any prefix,
//     including Node's own node-compile-cache -- lands inside this run's
//     own dedicated root, never in the shared OS temp directory at all
//   - cleanup removes ONLY that one exact dedicated root (the mkdtemp()
//     return value itself, never re-derived from a prefix scan, a glob, or
//     a birthtime heuristic) -- the dedicated root's OWN PATH is the
//     ownership token; there is no other bookkeeping to get wrong
//   - a concurrently-running sibling run has its OWN, differently-named
//     dedicated root; nothing this run does can ever reach it, because
//     this run's cleanup never lists or scans the shared OS temp directory
//     at all -- see tests/run-node-test-with-tmp-cleanup.test.mjs's
//     concurrent A/B regression test
//
// Before ever removing the dedicated root, assertOwnedCleanupTarget()
// fails closed if: the path is empty, is "/", resolves to HOME, resolves
// to the workspace root (process.cwd()), resolves to the OS temp root
// itself, is not a direct child of the OS temp root, or is a symlink.
// ENOENT during the final rm() is treated as "already clean"; any OTHER
// error is preserved and reported, never swallowed (see cleanupError on
// the returned result, and the AggregateError path when BOTH the child
// and cleanup fail).
//
// TURN N2.4 (Codex-reported defect): SIGINT/SIGTERM handling used to only
// forward the signal to the child; the grace-timeout-then-SIGKILL
// escalation lived in the `finally` block below, which is only ever
// reached once the awaited child 'exit' event fires. A child that installs
// its own SIGTERM handler and ignores it (`process.on("SIGTERM", () =>
// {})`) therefore never produced an 'exit' event, the `try` block's await
// never settled, `finally` was never reached, and the wrapper hung
// forever -- reproduced directly: SIGTERM delivered to the wrapper at
// t=800ms, wrapper still alive at t=6200ms despite the default 5000ms
// killGraceMs. Fixed with a single idempotent requestShutdown(signal)
// (see below): the FIRST signal received starts its own bounded
// kill-then-SIGKILL sequence immediately, concurrently with (not
// dependent on) the main exit-wait -- SIGKILL cannot be caught or ignored
// by any process, so it always eventually produces a real 'exit' event,
// which is what actually lets the main await (and therefore `finally`)
// proceed within bounded time. A second signal (same or different) while
// shutdown is already in flight reuses the SAME promise and starts no new
// timer/kill attempt.
//
// HONEST LIMITATION: none of this can help if the WRAPPER process itself
// receives SIGKILL -- no userspace code, in this file or anywhere else,
// can observe or react to SIGKILL. In that case this script's child (and
// its dedicated temp root) are simply abandoned; nothing here claims
// otherwise. Only an OS-level mechanism (process-group termination, a
// container/CI runner's own teardown) can bound that specific case.
//
// Usage: node scripts/run-node-test-with-tmp-cleanup.mjs -- <command> [args...]
import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEDICATED_ROOT_PREFIX = "run-tmp-cleanup-";
const DEFAULT_KILL_GRACE_MS = 5000;

export class UnsafeCleanupRootError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeCleanupRootError";
  }
}

// Fails closed (throws) rather than silently narrowing scope on its own.
// `ownedRoot` must be the EXACT string returned by the mkdtemp() call that
// created this run's dedicated root -- callers never reconstruct it from a
// prefix, an env var read-back, or any other indirection, so this
// function's job is purely to confirm that value is still safe to delete,
// not to go find "the right" directory some other way.
export async function assertOwnedCleanupTarget(ownedRoot, osTmpRoot) {
  if (typeof ownedRoot !== "string" || ownedRoot.trim() === "") {
    throw new UnsafeCleanupRootError(`refusing to clean up ${JSON.stringify(ownedRoot)} -- empty path`);
  }
  if (ownedRoot === "/" || ownedRoot === path.sep) {
    throw new UnsafeCleanupRootError(`refusing to clean up ${JSON.stringify(ownedRoot)} -- filesystem root`);
  }
  if (typeof osTmpRoot !== "string" || osTmpRoot.trim() === "") {
    throw new UnsafeCleanupRootError("osTmpRoot is required to validate a cleanup target");
  }

  const [homeReal, cwdReal] = await Promise.all([
    realpath(os.homedir()).catch(() => null),
    realpath(process.cwd()).catch(() => null),
  ]);
  if (ownedRoot === homeReal) {
    throw new UnsafeCleanupRootError(`refusing to clean up ${JSON.stringify(ownedRoot)} -- resolves to HOME`);
  }
  if (ownedRoot === cwdReal) {
    throw new UnsafeCleanupRootError(`refusing to clean up ${JSON.stringify(ownedRoot)} -- resolves to the workspace root`);
  }
  if (ownedRoot === osTmpRoot) {
    throw new UnsafeCleanupRootError(`refusing to clean up ${JSON.stringify(ownedRoot)} -- resolves to the OS tmp root itself`);
  }

  // Must be a DIRECT child of osTmpRoot -- mkdtemp(path.join(osTmpRoot, prefix))
  // only ever creates direct children, so anything else (deeper nesting, a
  // ".."-escaping alias, an unrelated absolute path) is refused rather than
  // silently normalized.
  const relative = path.relative(osTmpRoot, ownedRoot);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new UnsafeCleanupRootError(
      `refusing to clean up ${JSON.stringify(ownedRoot)} -- not a direct child of the OS tmp root ${JSON.stringify(osTmpRoot)}`,
    );
  }

  let lstatResult;
  try {
    lstatResult = await lstat(ownedRoot);
  } catch (error) {
    if (error.code === "ENOENT") return { alreadyGone: true };
    throw error;
  }
  if (lstatResult.isSymbolicLink()) {
    throw new UnsafeCleanupRootError(`refusing to clean up ${JSON.stringify(ownedRoot)} -- it is a symlink`);
  }
  if (!lstatResult.isDirectory()) {
    throw new UnsafeCleanupRootError(`refusing to clean up ${JSON.stringify(ownedRoot)} -- not a directory`);
  }
  return { alreadyGone: false };
}

// Removes exactly `ownedRoot` (this run's own dedicated temp root) after
// validating it. Whatever the child left inside it -- a leaked
// seed-release-v020-production-* directory, Node's own node-compile-cache,
// anything else -- is this run's own property (nothing else was ever
// pointed at this root) and is removed together with it; there is no
// per-entry prefix/birthtime filtering left to get wrong.
export async function cleanupOwnedRoot(ownedRoot, osTmpRoot) {
  const { alreadyGone } = await assertOwnedCleanupTarget(ownedRoot, osTmpRoot);
  if (alreadyGone) return;
  await rm(ownedRoot, { recursive: true, force: true });
}

function killIfAlive(child, signal) {
  if (child && child.pid && child.exitCode === null && child.signalCode === null) {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(); };
    child.once("exit", onExit);
    const timer = setTimeout(() => { child.removeListener("exit", onExit); resolve(); }, timeoutMs);
  });
}

// Conventional POSIX shell exit-code-for-signal mapping (128 + signal
// number) -- used only to give a signal-terminated wrapper run a
// non-zero, non-ambiguous exit code; not load-bearing anywhere else.
const SIGNAL_EXIT_CODE = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

// Spawns `command` with `args` inside a fresh, per-run dedicated temp root
// (TMPDIR/TMP/TEMP all pointed at it), waits for the child to fully exit,
// then removes exactly that root. The ENTIRE lifecycle -- spawn success,
// spawn 'error', child exit 0, child exit non-zero, child killed by a
// signal, this wrapper receiving SIGINT/SIGTERM (including a child that
// ignores it), repeated/consecutive signals, and a cleanup failure -- runs
// inside one try/finally so every path removes the SIGINT/SIGTERM
// listeners and attempts the dedicated-root cleanup exactly once, never
// skipping either step. spawnError/signalError/cleanupError are all
// collected and reported together (via AggregateError when more than one
// occurred) -- none ever silently replaces another.
export async function runWithTmpCleanup({ command, args = [], root = os.tmpdir(), env = process.env, killGraceMs = DEFAULT_KILL_GRACE_MS } = {}) {
  if (typeof command !== "string" || command === "") throw new TypeError("command is required");

  const osTmpRoot = await realpath(root);
  const ownedRoot = await mkdtemp(path.join(osTmpRoot, DEDICATED_ROOT_PREFIX));

  let child = null;
  let sigintHandler = null;
  let sigtermHandler = null;
  let spawnError = null;
  let signalError = null;
  let exitCode = null;
  let exitSignal = null;
  let cleanupError = null;
  let receivedSignal = null;

  // The single, idempotent shutdown routine (per the module doc above).
  // The FIRST call (from either the SIGINT or the SIGTERM handler) creates
  // ONE promise and starts the bounded kill-then-SIGKILL sequence; every
  // subsequent call -- a repeat of the same signal, or the other signal
  // arriving afterward -- returns that SAME promise untouched, so no
  // second timer/kill sequence is ever started. Because SIGKILL cannot be
  // caught or ignored, this sequence is guaranteed to produce a real
  // 'exit' event on `child` within (at most, barring OS scheduling
  // delays) 2*killGraceMs, which is what actually lets the main exit-wait
  // below (and therefore this function's `finally` block) proceed even
  // against a child that ignores the original signal entirely.
  let shutdownPromise = null;
  function requestShutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    receivedSignal = signal;
    shutdownPromise = (async () => {
      try {
        killIfAlive(child, signal);
        await waitForExit(child, killGraceMs);
        killIfAlive(child, "SIGKILL");
        await waitForExit(child, killGraceMs);
      } catch (error) {
        signalError = error;
      }
    })();
    return shutdownPromise;
  }

  try {
    child = spawn(command, args, {
      stdio: "inherit",
      env: { ...env, TMPDIR: ownedRoot, TMP: ownedRoot, TEMP: ownedRoot },
    });

    sigintHandler = () => { requestShutdown("SIGINT"); };
    sigtermHandler = () => { requestShutdown("SIGTERM"); };
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);

    try {
      [exitCode, exitSignal] = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve([code, signal]));
      });
    } catch (error) {
      spawnError = error;
    }
  } finally {
    if (sigintHandler) process.removeListener("SIGINT", sigintHandler);
    if (sigtermHandler) process.removeListener("SIGTERM", sigtermHandler);

    if (shutdownPromise) {
      // A signal already triggered (and, since the main await above has
      // now settled, has either completed or is on the verge of
      // completing) the kill/SIGKILL sequence -- await it so the child is
      // confirmed fully gone before cleanup runs, and so this never starts
      // a SECOND kill sequence of its own.
      await shutdownPromise;
    } else if (child) {
      // No signal was received by the wrapper itself, but we may still be
      // here because of a spawn error while the process object exists --
      // a best-effort defensive kill+wait in case it somehow represents a
      // still-alive process (a harmless no-op otherwise, since
      // killIfAlive/waitForExit both check exitCode/signalCode first).
      killIfAlive(child, "SIGTERM");
      await waitForExit(child, killGraceMs);
      killIfAlive(child, "SIGKILL");
      await waitForExit(child, killGraceMs);
    }

    try {
      await cleanupOwnedRoot(ownedRoot, osTmpRoot);
    } catch (error) {
      cleanupError = error;
    }
  }

  const errors = [spawnError, signalError, cleanupError].filter(Boolean);
  if (errors.length > 1) {
    throw new AggregateError(errors, `multiple failures during this run: ${errors.map((e) => e.message).join("; ")}`);
  }
  if (spawnError) throw spawnError;
  if (signalError) throw signalError;
  if (cleanupError) {
    // The child's own outcome (even a clean exit 0) must never be reported
    // as an overall success if this run's temp root could not actually be
    // removed -- surface the cleanup error, tagging on the child's own
    // result for context rather than discarding it.
    cleanupError.childExitCode = exitCode;
    cleanupError.childSignal = exitSignal;
    cleanupError.receivedSignal = receivedSignal;
    throw cleanupError;
  }

  // A signal received by the WRAPPER always makes this run a non-success,
  // regardless of whatever exit reason the child itself happened to end
  // up with (which could coincidentally look like a clean 0 if it exited
  // right as the shutdown sequence landed) -- the run was externally
  // aborted, not completed.
  const childFailed = exitCode !== 0 || exitSignal !== null;
  const finalExitCode = receivedSignal
    ? (SIGNAL_EXIT_CODE[receivedSignal] ?? 1)
    : (childFailed ? (exitCode ?? 1) : 0);
  return Object.freeze({
    exitCode: finalExitCode, childExitCode: exitCode, childSignal: exitSignal, receivedSignal, root: ownedRoot,
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const separatorIndex = rawArgs.indexOf("--");
  const commandArgs = separatorIndex === -1 ? rawArgs : rawArgs.slice(separatorIndex + 1);
  if (commandArgs.length === 0) {
    console.error("usage: node scripts/run-node-test-with-tmp-cleanup.mjs -- <command> [args...]");
    process.exit(2);
  }
  const [command, ...args] = commandArgs;
  // Turn N2.4: test-only override, absent in every real invocation (the
  // two package.json call sites never set this env var, so production use
  // always gets the real DEFAULT_KILL_GRACE_MS=5000ms). Regression tests
  // that need to exercise the grace-timeout-then-SIGKILL escalation
  // through a real separate wrapper PROCESS (not just by calling
  // runWithTmpCleanup() directly, which already accepts killGraceMs as a
  // normal option) would otherwise have to wait the full 5s default on
  // every run; this lets those tests use a much shorter, still-real grace
  // period instead.
  const killGraceMsOverride = process.env.RUN_TMP_CLEANUP_TEST_KILL_GRACE_MS;
  const killGraceMs = killGraceMsOverride ? Number(killGraceMsOverride) : undefined;
  const result = await runWithTmpCleanup({ command, args, ...(killGraceMs !== undefined ? { killGraceMs } : {}) });
  process.exit(result.exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
