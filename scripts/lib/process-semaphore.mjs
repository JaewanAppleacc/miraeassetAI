// Turn N4.18.1: a generic, cross-OS-process, N-permit semaphore built ONLY
// from filesystem primitives (atomic exclusive-create, i.e. `wx`) plus
// `process.kill(pid, 0)` liveness checks. No daemon, no network port, no
// database -- every property below is achieved with plain files under a
// key-derived directory in the OS temp root, so it works identically for
// the repo-wide "only one verify:contracts run at a time" MUTEX (permits=1)
// and the "at most N concurrent headless Chrome launches" SEMAPHORE
// (permits=N, default 1) that this Turn adds.
//
// CONTRACT (mirrors the ownership-token discipline already established in
// scripts/run-node-test-with-tmp-cleanup.mjs's assertOwnedCleanupTarget):
//   - a holder or waiter file's OWN PATH + a random token embedded in its
//     content is the sole ownership proof; nothing is ever reconstructed
//     from a prefix scan or a birthtime heuristic
//   - a stale holder/waiter (its recorded PID no longer exists) is reclaimed
//     ONLY after a direct process.kill(pid, 0) liveness check -- a LIVE
//     process's slot/ticket is never touched, regardless of how old it is
//   - acquisition is FIFO via a deterministic (Date.now(), pid, random)
//     sort key on each waiter's ticket filename -- see the HONEST
//     LIMITATION note on TicketOrdering below
//   - every acquire() call is BOUNDED by timeoutMs; there is no unbounded
//     wait anywhere in this module
//   - keys are hashed into a short, filesystem-safe slug, so two different
//     repos/worktrees (different absolute paths -> different keys ->
//     different hashes) can never share a directory and therefore can never
//     block each other
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { openSync, closeSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class SemaphoreTimeoutError extends Error {
  constructor(message, { code = "SEMAPHORE_ACQUIRE_TIMEOUT" } = {}) {
    super(message);
    this.name = "SemaphoreTimeoutError";
    // Turn N4.18.2: a distinguishable, string-matchable code so a caller
    // (or a test) can tell "I never got a permit in time" apart from any
    // OTHER failure shape (a real Chrome/CDP setup error, a network error,
    // etc.) without parsing the message text. Never overload this error
    // type to mean "Chrome itself failed to start" -- those are unrelated
    // failure classes and must never be reported through the same path.
    this.code = code;
  }
}

// HONEST LIMITATION: Date.now() is wall-clock, not monotonic -- a system
// clock adjustment mid-run could reorder two waiters relative to true
// arrival order. This is accepted here (same tradeoff class already
// documented for run-node-test-with-tmp-cleanup.mjs's own limitations):
// the goal is a DETERMINISTIC, livelock-free total order among waiters
// (any two waiters always agree on who goes first, and that answer never
// flips once both tickets exist), not a courtroom-grade linearizability
// proof against adversarial clock changes on a test machine.
function ticketSortKey(nowMs, pid, random) {
  return `${String(nowMs).padStart(15, "0")}-${String(pid).padStart(8, "0")}-${random}`;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    // EPERM means the process exists but we lack permission to signal it --
    // that is still "alive" for staleness purposes (never reclaim someone
    // else's live-but-unsignalable process).
    if (error && error.code === "EPERM") return true;
    return false;
  }
}

export function slugifyKey(key) {
  const hash = createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
  const safeSuffix = String(key).replace(/[^a-zA-Z0-9]+/g, "-").slice(-24);
  return `${hash}${safeSuffix ? `-${safeSuffix}` : ""}`;
}

// Turn N4.18.1 CRITICAL FIX (found via a real full npm run test:domain
// stress run, not by inspection alone): this MUST NOT be based on
// os.tmpdir(). scripts/run-node-test-with-tmp-cleanup.mjs -- the wrapper
// EVERY test:domain/verify:contracts invocation already runs through --
// deliberately points the child process's TMPDIR/TMP/TEMP at a fresh,
// per-invocation-unique dedicated root (by design, for its own, unrelated
// purpose: isolating leaked test artifacts). Since Node's os.tmpdir()
// reads that env var at call time, two SEPARATE invocations (e.g. a
// PostToolUse-hook-triggered verify:contracts run and a manually started
// test:domain run, or simply two overlapping hook firings) each get a
// DIFFERENT os.tmpdir() value, and therefore, if this function used it,
// would compute a DIFFERENT semaphore directory for the IDENTICAL logical
// key -- completely defeating cross-invocation coordination. Reproduced
// directly: a real `npm run test:domain` run showed the real-Chrome-process
// count climb to 4 (double the configured permits=2) for sustained
// multi-second windows, while `inspectSemaphore()` on the SAME key still
// (correctly, but uselessly) reported only 2 holders -- because a SECOND,
// concurrently-running invocation's Chrome usage was being tracked in a
// completely different, TMPDIR-namespaced semaphore directory that this
// invocation's own inspection never saw.
//
// os.homedir() is not touched by that wrapper (it only overrides
// TMPDIR/TMP/TEMP, never HOME) and is otherwise about as stable a
// per-machine-per-user location as this environment offers, so it is used
// here instead -- deliberately bypassing the "respect TMPDIR" convention
// that is correct for throwaway test artifacts but wrong for a
// coordination primitive that specifically needs to be found by EVERY
// concurrent invocation, regardless of that invocation's own temp-dir
// sandboxing.
function semaphoreRootFor(key) {
  return path.join(os.homedir(), ".cache", "ai-festival-process-semaphore", `pxsem-${slugifyKey(key)}`);
}

async function readJsonSafe(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

// Removes any holder slot whose recorded PID is confirmed dead. Exported so
// tests can exercise stale-reclaim deterministically without waiting out a
// real acquire() timeout window.
export async function reclaimStaleHolders({ key, permits }) {
  const root = semaphoreRootFor(key);
  const holdersDir = path.join(root, "holders");
  await mkdir(holdersDir, { recursive: true });
  const reclaimed = [];
  for (let slot = 0; slot < permits; slot += 1) {
    const slotPath = path.join(holdersDir, `slot-${slot}`);
    const record = await readJsonSafe(slotPath);
    if (!record) continue; // free, or unreadable -- leave unreadable-but-present alone, a live acquirer will just fail the exclusive-create
    if (!isProcessAlive(record.pid)) {
      await rm(slotPath, { force: true });
      reclaimed.push({ slot, record });
    }
  }
  return reclaimed;
}

// Removes any waiting ticket whose recorded PID is confirmed dead, so a
// crashed waiter can never permanently block everyone behind it in the FIFO
// order. Exported for the same testability reason as reclaimStaleHolders.
export async function reclaimStaleTickets({ key }) {
  const root = semaphoreRootFor(key);
  const waitingDir = path.join(root, "waiting");
  await mkdir(waitingDir, { recursive: true });
  const entries = await readdir(waitingDir).catch(() => []);
  const reclaimed = [];
  for (const name of entries) {
    const ticketPath = path.join(waitingDir, name);
    const record = await readJsonSafe(ticketPath);
    if (!record) continue;
    if (!isProcessAlive(record.pid)) {
      await rm(ticketPath, { force: true });
      reclaimed.push({ name, record });
    }
  }
  return reclaimed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Acquires one permit of the named semaphore, waiting (FIFO, per-process
// deterministic tie-break) up to `timeoutMs`. Resolves to a handle whose
// `release()` must be called exactly once. Never waits unboundedly: a
// caller that cannot get a permit within timeoutMs gets a
// SemaphoreTimeoutError, its own ticket file removed, and nothing else left
// behind.
export async function acquireSemaphore({ key, permits = 1, timeoutMs = 20 * 60 * 1000, pollIntervalMs = 50, ownerMeta = {} } = {}) {
  if (!key) throw new TypeError("acquireSemaphore requires a key");
  if (!Number.isInteger(permits) || permits < 1) throw new TypeError("permits must be a positive integer");
  const root = semaphoreRootFor(key);
  const waitingDir = path.join(root, "waiting");
  const holdersDir = path.join(root, "holders");
  await mkdir(waitingDir, { recursive: true });
  await mkdir(holdersDir, { recursive: true });

  const token = randomUUID();
  const pid = process.pid;
  const ticketName = ticketSortKey(Date.now(), pid, token.slice(0, 8));
  const ticketPath = path.join(waitingDir, ticketName);
  await writeFile(ticketPath, JSON.stringify({ pid, token, meta: ownerMeta, queued_at: new Date().toISOString() }), "utf8");

  const deadline = Date.now() + timeoutMs;
  try {
    // First-and-only-waiter fast path also goes through this loop -- there
    // is no separate "uncontended" shortcut to keep the logic single-path
    // and therefore singly-testable.
    for (;;) {
      await reclaimStaleTickets({ key });
      await reclaimStaleHolders({ key, permits });

      const waitingNames = (await readdir(waitingDir).catch(() => [])).sort();
      const myRank = waitingNames.indexOf(ticketName);
      if (myRank === 0) {
        for (let slot = 0; slot < permits; slot += 1) {
          const slotPath = path.join(holdersDir, `slot-${slot}`);
          const acquired = await tryClaimSlot(slotPath, { pid, token, meta: ownerMeta });
          if (acquired) {
            await rm(ticketPath, { force: true });
            return Object.freeze({
              key, slot, slotPath, token, pid,
              release: async () => releaseSlot(slotPath, token),
            });
          }
        }
      }

      if (Date.now() >= deadline) {
        // Diagnostic-but-not-sensitive: report WHO is holding the permits
        // (pid + how long, both harmless to disclose) so a timeout is
        // actionable, without ever including a holder's own userDataDir/
        // downloadDir/HTML path (those live in `meta` and are deliberately
        // left out here).
        const now = Date.now();
        const holderSummaries = [];
        for (let slot = 0; slot < permits; slot += 1) {
          const record = await readJsonSafe(path.join(holdersDir, `slot-${slot}`));
          if (record) holderSummaries.push(`pid=${record.pid} held_for_ms=${now - Date.parse(record.acquired_at || now)}`);
        }
        throw new SemaphoreTimeoutError(
          `acquireSemaphore("${key}"): timed out after ${timeoutMs}ms waiting for one of ${permits} permit(s) `
          + `(rank among ${waitingNames.length} waiter(s): ${myRank}; current holders: ${holderSummaries.length > 0 ? holderSummaries.join(", ") : "none (permits free but unclaimed by this waiter yet)"})`,
        );
      }
      await sleep(pollIntervalMs);
    }
  } catch (error) {
    await rm(ticketPath, { force: true }).catch(() => {});
    throw error;
  }
}

// Exclusive-create is atomic on POSIX filesystems: at most one concurrent
// caller's `wx` open can ever succeed for the same path. `EEXIST` means a
// DIFFERENT process's live-or-not-yet-reclaimed slot won the race.
function tryClaimSlot(slotPath, record) {
  let fd;
  try {
    fd = openSync(slotPath, "wx");
  } catch (error) {
    if (error && error.code === "EEXIST") return false;
    throw error;
  }
  try {
    const buf = Buffer.from(JSON.stringify({ ...record, acquired_at: new Date().toISOString() }), "utf8");
    writeSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  return true;
}

async function releaseSlot(slotPath, expectedToken) {
  const record = await readJsonSafe(slotPath);
  // Only remove a slot that still carries OUR OWN token -- if it is already
  // gone (we raced a stale reclaim of our own already-dead-looking record,
  // which cannot legitimately happen while this process is alive and
  // calling release() itself, but is cheap to guard anyway) or was somehow
  // reclaimed and reclaimed by someone else, do not blindly delete a
  // stranger's slot.
  if (!record) return; // already gone -- release is idempotent
  if (record.token !== expectedToken) return; // not ours (should not happen); never delete another holder's slot
  await rm(slotPath, { force: true });
}

// Test/diagnostic helper: current live holder count + waiting count for a
// key, without mutating anything.
export async function inspectSemaphore({ key, permits = 1 }) {
  const root = semaphoreRootFor(key);
  const waitingDir = path.join(root, "waiting");
  const holdersDir = path.join(root, "holders");
  await mkdir(waitingDir, { recursive: true });
  await mkdir(holdersDir, { recursive: true });
  const waitingNames = (await readdir(waitingDir).catch(() => [])).sort();
  const holders = [];
  for (let slot = 0; slot < permits; slot += 1) {
    const record = await readJsonSafe(path.join(holdersDir, `slot-${slot}`));
    if (record) holders.push({ slot, ...record });
  }
  return { waitingCount: waitingNames.length, waitingNames, holders };
}

export { semaphoreRootFor };
