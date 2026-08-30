#!/usr/bin/env node
// Turn N4.18.1: wraps `npm run verify:contracts`'s real check chain in a
// repo-scoped MUTEX (a permits=1 process-semaphore keyed by this repo's own
// absolute root path), so that a PostToolUse-hook-triggered run, a
// Stop-hook-triggered run, and any manually started run can never execute
// the full test suite (and therefore never launch headless Chrome) AT THE
// SAME TIME against this repo. This is the fix for the exact, previously
// observed and documented collision in tests/headless-chrome-cdp-cleanup
// .test.mjs's Turn N4.2.1 comment: "a real verify:contracts collided with
// the Stop hook's own automatic re-verification".
//
// What this script deliberately does NOT do:
//   - it does not change a single check inside verify:contracts' own chain
//     (schema:validate && test:domain && test:reference-db && the v0.20
//     node --test invocation && typecheck) -- that exact command string is
//     run, unmodified, as this script's child process
//   - it does not skip or shortcut verification for a caller that has to
//     wait -- a caller that acquires the lock always runs the REAL, full
//     chain against the CURRENT working tree; "only one run at a time"
//     never becomes "skip if someone else recently ran it"
//   - it never touches a DIFFERENT repo/worktree's lock: the key is this
//     process's own realpath(repo root), so two worktrees checked out from
//     the same origin never share a lock directory
//
// Acquisition is bounded (VERIFY_LOCK_TIMEOUT_MS, default 25 minutes) --
// long enough that a hook-triggered run queued behind a real, in-progress
// full suite (which has been observed in this repo's own history to take
// anywhere from under a minute to over 20 minutes under headless-Chrome
// resource contention) gets a real chance to run for real once the lock
// frees, rather than failing before the first run could plausibly finish.
// It is not unbounded: a caller that still cannot get the lock after that
// window fails closed with a clear, distinguishable message, never hangs.
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSemaphore, SemaphoreTimeoutError } from "./lib/process-semaphore.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;

// The exact, unmodified verify:contracts chain. Kept as one shell command
// (matching the existing `&&`-chained package.json script) so its
// short-circuit-on-first-failure semantics are byte-for-byte identical to
// running `npm run verify:contracts` directly ever was.
const VERIFY_CHAIN = "npm run schema:validate && npm run test:domain && npm run test:reference-db && node scripts/run-node-test-with-tmp-cleanup.mjs -- node --test tests/seed-release-v020-r3-owner-decision.test.mjs tests/seed-release-v020-final.test.mjs && npm run typecheck";

export async function runVerifyContractsWithLock({
  repoRoot = REPO_ROOT,
  timeoutMs = Number(process.env.VERIFY_LOCK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  command = VERIFY_CHAIN,
  spawnFn = spawn,
} = {}) {
  const canonicalRoot = await realpath(repoRoot);
  const lockKey = `verify-contracts:${canonicalRoot}`;

  let handle;
  const waitStartedAt = Date.now();
  try {
    handle = await acquireSemaphore({
      key: lockKey,
      permits: 1,
      timeoutMs,
      ownerMeta: { purpose: "verify:contracts", repoRoot: canonicalRoot, startedAt: new Date().toISOString() },
    });
  } catch (error) {
    if (error instanceof SemaphoreTimeoutError) {
      return {
        acquired: false,
        exitCode: 75, // EX_TEMPFAIL-style: distinguishable from a real check failure (1) or a signal (>128)
        waitedMs: Date.now() - waitStartedAt,
        message: `verify:contracts is already running for this repo (${canonicalRoot}) and did not free up within ${timeoutMs}ms. Not starting a second, overlapping full suite run. Re-run once the in-progress verification finishes.`,
      };
    }
    throw error;
  }

  let releaseOnce = false;
  const release = async () => {
    if (releaseOnce) return;
    releaseOnce = true;
    await handle.release();
  };

  let sigintHandler = null;
  let sigtermHandler = null;
  try {
    const child = spawnFn(command, { cwd: canonicalRoot, stdio: "inherit", shell: true });
    sigintHandler = () => child.kill("SIGINT");
    sigtermHandler = () => child.kill("SIGTERM");
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);

    const [exitCode, signal] = await new Promise((res, rej) => {
      child.once("error", rej);
      child.once("exit", (code, sig) => res([code, sig]));
    });
    return {
      acquired: true,
      exitCode: signal ? 1 : (exitCode ?? 1),
      waitedMs: Date.now() - waitStartedAt,
    };
  } finally {
    if (sigintHandler) process.removeListener("SIGINT", sigintHandler);
    if (sigtermHandler) process.removeListener("SIGTERM", sigtermHandler);
    await release();
  }
}

async function main() {
  const result = await runVerifyContractsWithLock();
  if (!result.acquired) {
    console.error(result.message);
  }
  process.exit(result.exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
