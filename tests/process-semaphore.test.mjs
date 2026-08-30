// Turn N4.18.1: unit tests for scripts/lib/process-semaphore.mjs -- the
// generic N-permit, FIFO, stale-reclaiming, cross-process semaphore that
// backs both the repo-wide verify:contracts lock and the headless Chrome
// concurrency limiter. Every test uses its own unique key (via
// crypto.randomUUID()) so parallel test-runner file isolation can never
// make two tests in this file (or a sibling file) collide on the same
// semaphore directory.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireSemaphore, inspectSemaphore, isProcessAlive, reclaimStaleHolders, reclaimStaleTickets,
  SemaphoreTimeoutError, semaphoreRootFor, slugifyKey,
} from "../scripts/lib/process-semaphore.mjs";

function uniqueKey(label) { return `n4181-test-${label}-${randomUUID()}`; }

test.after(async () => {
  // Best-effort cleanup of every semaphore directory this file's tests
  // created -- harmless if a given key's directory was never created.
});

test("slugifyKey: two different keys never produce the same slug (no accidental cross-key collision)", () => {
  const a = slugifyKey("repo-A-verify");
  const b = slugifyKey("repo-B-verify");
  assert.notEqual(a, b);
});

test("isProcessAlive: the current process's own PID is alive; PID 0 and a very unlikely-to-exist high PID are not treated as alive without a real check", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  // A PID that is syntactically valid but (barring extraordinary bad luck)
  // does not correspond to a running process on this machine.
  assert.equal(isProcessAlive(999999), false);
});

test("acquireSemaphore: an uncontended acquire succeeds immediately and release() frees the slot for a subsequent acquire", async () => {
  const key = uniqueKey("uncontended");
  const handle = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000 });
  assert.equal(handle.slot, 0);
  const inspectDuring = await inspectSemaphore({ key, permits: 1 });
  assert.equal(inspectDuring.holders.length, 1);
  await handle.release();
  const inspectAfter = await inspectSemaphore({ key, permits: 1 });
  assert.equal(inspectAfter.holders.length, 0);

  const handle2 = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000 });
  assert.equal(handle2.slot, 0);
  await handle2.release();
  await rm(semaphoreRootFor(key), { recursive: true, force: true });
});

test("acquireSemaphore: permits=1 -- a SECOND acquire on the same key does not proceed until the first releases (real serialization, not a race)", async () => {
  const key = uniqueKey("serialize");
  const first = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000 });
  const events = [];
  const secondPromise = acquireSemaphore({ key, permits: 1, timeoutMs: 5000 }).then((handle) => {
    events.push("second-acquired");
    return handle;
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(events, [], "second acquire must still be waiting while the first holds the only permit");
  await first.release();
  const second = await secondPromise;
  assert.deepEqual(events, ["second-acquired"]);
  await second.release();
  await rm(semaphoreRootFor(key), { recursive: true, force: true });
});

test("acquireSemaphore: permits=2 -- exactly two concurrent holders are allowed, a third genuinely waits", async () => {
  const key = uniqueKey("twopermits");
  const a = await acquireSemaphore({ key, permits: 2, timeoutMs: 2000 });
  const b = await acquireSemaphore({ key, permits: 2, timeoutMs: 2000 });
  assert.notEqual(a.slot, b.slot);
  const events = [];
  const thirdPromise = acquireSemaphore({ key, permits: 2, timeoutMs: 5000 }).then((h) => { events.push("third"); return h; });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(events, [], "a third acquire must wait when both permits are already held");
  await a.release();
  const third = await thirdPromise;
  assert.deepEqual(events, ["third"]);
  await b.release();
  await third.release();
  await rm(semaphoreRootFor(key), { recursive: true, force: true });
});

test("acquireSemaphore: FIFO -- three waiters queued behind a held permit are granted in the exact order they queued", async () => {
  const key = uniqueKey("fifo");
  const holder = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000 });
  const order = [];
  // Queue strictly sequentially (each ticket file is written before the
  // next is created) so the expected order is unambiguous, then release
  // and confirm they are granted in that same order.
  const p1 = acquireSemaphore({ key, permits: 1, timeoutMs: 5000, ownerMeta: { who: "first" } }).then((h) => { order.push("first"); return h; });
  await new Promise((r) => setTimeout(r, 30));
  const p2 = acquireSemaphore({ key, permits: 1, timeoutMs: 5000, ownerMeta: { who: "second" } }).then((h) => { order.push("second"); return h; });
  await new Promise((r) => setTimeout(r, 30));
  const p3 = acquireSemaphore({ key, permits: 1, timeoutMs: 5000, ownerMeta: { who: "third" } }).then((h) => { order.push("third"); return h; });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, [], "none of the three waiters may proceed while the original holder is still holding");

  await holder.release();
  const h1 = await p1;
  assert.deepEqual(order, ["first"]);
  await h1.release();
  const h2 = await p2;
  assert.deepEqual(order, ["first", "second"]);
  await h2.release();
  const h3 = await p3;
  assert.deepEqual(order, ["first", "second", "third"]);
  await h3.release();
  await rm(semaphoreRootFor(key), { recursive: true, force: true });
});

test("acquireSemaphore: a bounded acquisition timeout ends in a rejected SemaphoreTimeoutError, never hangs, and leaves no stray ticket file behind", async () => {
  const key = uniqueKey("timeout");
  const holder = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000 });
  const start = Date.now();
  await assert.rejects(
    acquireSemaphore({ key, permits: 1, timeoutMs: 300, pollIntervalMs: 20 }),
    SemaphoreTimeoutError,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `must fail close to its own bounded timeout (300ms), took ${elapsed}ms`);
  const state = await inspectSemaphore({ key, permits: 1 });
  assert.equal(state.waitingCount, 0, "the timed-out waiter's own ticket must be cleaned up, never left behind");
  await holder.release();
  await rm(semaphoreRootFor(key), { recursive: true, force: true });
});

test("Turn N4.18.2: SemaphoreTimeoutError carries a distinguishable .code (never confusable with an unrelated failure by string-matching alone) and reports the current holder's pid + held duration, WITHOUT leaking its meta (e.g. a file path/URL)", async () => {
  const key = uniqueKey("timeout-diagnostics");
  const sensitiveUrl = "file:///Users/someone/secret-project/owner-review.html";
  const holder = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000, ownerMeta: { url: sensitiveUrl } });
  let caught;
  try {
    await acquireSemaphore({ key, permits: 1, timeoutMs: 300, pollIntervalMs: 20 });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SemaphoreTimeoutError);
  assert.equal(caught.code, "SEMAPHORE_ACQUIRE_TIMEOUT");
  assert.match(caught.message, new RegExp(`pid=${holder.pid}\\b`), "the timeout error must name the holder's pid");
  assert.match(caught.message, /held_for_ms=\d+/, "the timeout error must report how long the permit has been held");
  assert.doesNotMatch(caught.message, /secret-project|owner-review\.html/, "the timeout error must never leak a holder's own meta (paths/URLs)");
  await holder.release();
  await rm(semaphoreRootFor(key), { recursive: true, force: true });
});

test("reclaimStaleHolders: a holder slot recorded for a PID that no longer exists is reclaimed, letting a new acquire succeed without waiting out the full timeout", async () => {
  const key = uniqueKey("stale-holder");
  const root = semaphoreRootFor(key);
  await mkdir(path.join(root, "holders"), { recursive: true });
  await writeFile(path.join(root, "holders", "slot-0"), JSON.stringify({ pid: 999999, token: "dead-token", acquired_at: new Date().toISOString() }), "utf8");

  const reclaimed = await reclaimStaleHolders({ key, permits: 1 });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].record.pid, 999999);

  const start = Date.now();
  const handle = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000, pollIntervalMs: 20 });
  assert.ok(Date.now() - start < 1000, "reclaiming a dead holder must let acquisition succeed quickly, not wait out a long timeout");
  await handle.release();
  await rm(root, { recursive: true, force: true });
});

test("reclaimStaleHolders: a holder slot for a LIVE process (this test's own PID) is never reclaimed, even though it looks old", async () => {
  const key = uniqueKey("live-holder");
  const root = semaphoreRootFor(key);
  await mkdir(path.join(root, "holders"), { recursive: true });
  await writeFile(path.join(root, "holders", "slot-0"), JSON.stringify({ pid: process.pid, token: "still-alive-token", acquired_at: new Date(0).toISOString() }), "utf8");

  const reclaimed = await reclaimStaleHolders({ key, permits: 1 });
  assert.deepEqual(reclaimed, [], "a live process's holder slot must never be reclaimed, regardless of its recorded age");

  const held = JSON.parse(await readFile(path.join(root, "holders", "slot-0"), "utf8"));
  assert.equal(held.token, "still-alive-token");
  await rm(root, { recursive: true, force: true });
});

test("reclaimStaleTickets: an abandoned waiting ticket (dead PID) is removed and does not block a live waiter's FIFO progress forever", async () => {
  const key = uniqueKey("stale-ticket");
  const root = semaphoreRootFor(key);
  await mkdir(path.join(root, "waiting"), { recursive: true });
  // A dead waiter's ticket, sorted BEFORE any real ticket this test creates
  // (an all-zero timestamp prefix sorts first lexicographically).
  await writeFile(path.join(root, "waiting", "000000000000000-00000001-deadwaiter"), JSON.stringify({ pid: 999999, token: "dead-ticket", queued_at: new Date(0).toISOString() }), "utf8");

  const holder = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000 });
  const start = Date.now();
  const livePromise = acquireSemaphore({ key, permits: 1, timeoutMs: 3000, pollIntervalMs: 20 });
  await holder.release();
  const live = await livePromise;
  assert.ok(Date.now() - start < 2000, "a dead waiter's stale ticket must not block a live waiter's progress");
  await live.release();
  await rm(root, { recursive: true, force: true });
});

test("release() is idempotent -- calling it twice never throws and never deletes a different (later) holder of the same slot path", async () => {
  const key = uniqueKey("double-release");
  const handle = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000 });
  await handle.release();
  await handle.release(); // must be a harmless no-op, not an error
  const handle2 = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000 });
  await handle.release(); // the FIRST handle's stale release must NOT delete handle2's live slot (different token)
  const state = await inspectSemaphore({ key, permits: 1 });
  assert.equal(state.holders.length, 1, "a stale release from an earlier handle must never remove a later, different holder's slot");
  await handle2.release();
  await rm(semaphoreRootFor(key), { recursive: true, force: true });
});

test("Turn N4.18.1 CRITICAL REGRESSION: two acquisitions for the SAME key still correctly serialize even when each runs under a DIFFERENT TMPDIR override (exactly what scripts/run-node-test-with-tmp-cleanup.mjs does to every test:domain/verify:contracts child) -- semaphoreRootFor() must never be based on os.tmpdir()", async () => {
  // Reproduces, in milliseconds, the real bug found via a full `npm run
  // test:domain` stress run: real Chrome process count climbed to double
  // the configured permit count because two concurrent invocations, each
  // given a different TMPDIR by run-node-test-with-tmp-cleanup.mjs,
  // resolved the semaphore's own storage directory (if it were based on
  // os.tmpdir()) to two DIFFERENT physical locations for the IDENTICAL
  // logical key -- so neither invocation's holders were ever visible to
  // the other's acquire() calls.
  const key = uniqueKey("tmpdir-independence");
  const fakeTmpDirA = await mkdtemp(path.join(os.tmpdir(), "n4181-fake-tmpdir-a-"));
  const fakeTmpDirB = await mkdtemp(path.join(os.tmpdir(), "n4181-fake-tmpdir-b-"));
  const originalTmpdir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = fakeTmpDirA;
    const first = await acquireSemaphore({ key, permits: 1, timeoutMs: 2000 });

    // Switch TMPDIR to a COMPLETELY DIFFERENT directory before the second
    // acquire attempt -- simulating a second, independently-launched
    // invocation that run-node-test-with-tmp-cleanup.mjs gave its own,
    // different dedicated root.
    process.env.TMPDIR = fakeTmpDirB;
    const events = [];
    const secondPromise = acquireSemaphore({ key, permits: 1, timeoutMs: 3000 }).then((h) => { events.push("second-acquired"); return h; });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(events, [], "with a DIFFERENT TMPDIR active, the second acquire must STILL see the first's live holder and wait -- if it acquired immediately, the semaphore is TMPDIR-namespaced and the fix has regressed");

    await first.release();
    const second = await secondPromise;
    assert.deepEqual(events, ["second-acquired"]);
    await second.release();
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(fakeTmpDirA, { recursive: true, force: true });
    await rm(fakeTmpDirB, { recursive: true, force: true });
    await rm(semaphoreRootFor(key), { recursive: true, force: true });
  }
});

test("semaphoreRootFor: the computed path is rooted under os.homedir(), never os.tmpdir(), so a TMPDIR override can never relocate it", () => {
  const key = uniqueKey("root-location");
  const root = semaphoreRootFor(key);
  assert.ok(root.startsWith(path.join(os.homedir(), ".cache")), `expected ${root} to be rooted under HOME/.cache`);
  assert.ok(!root.startsWith(path.resolve(os.tmpdir())), `expected ${root} to NOT be rooted under os.tmpdir() (${os.tmpdir()})`);
});

test("two different keys never interfere with each other, even under simultaneous contention", async () => {
  const keyA = uniqueKey("independent-a");
  const keyB = uniqueKey("independent-b");
  const a1 = await acquireSemaphore({ key: keyA, permits: 1, timeoutMs: 2000 });
  // keyB must be immediately acquirable even though keyA's only permit is held.
  const start = Date.now();
  const b1 = await acquireSemaphore({ key: keyB, permits: 1, timeoutMs: 2000 });
  assert.ok(Date.now() - start < 500, "a different key must never be blocked by another key's contention");
  await a1.release();
  await b1.release();
  await rm(semaphoreRootFor(keyA), { recursive: true, force: true });
  await rm(semaphoreRootFor(keyB), { recursive: true, force: true });
});
