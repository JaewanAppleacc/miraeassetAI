// Durability and cross-process mutual exclusion for the Usage Ledger, built
// entirely out of Harness-owned code and Node's fs primitives — this
// deliberately does not modify domain/runtime/evaluation-usage-ledger.mjs
// (out of scope for the Harness integration; that module's own
// appendEventLineAtomic() is atomic per line via O_APPEND but never calls
// fsync, so it is NOT durable against a host crash/power loss immediately
// after the write returns).
// Imported as the default export (node:fs's CommonJS-style module.exports
// object) rather than destructured named imports: named ESM bindings are
// non-configurable, so a test cannot mock.method() them, but the default
// export is a plain mutable object tests can spy on to prove fsync is
// actually invoked, not just called by convention in a comment.
import fs from "node:fs";
import { dirname } from "node:path";

// Appends one JSONL line and fsyncs the file descriptor before returning,
// so the event is actually on stable storage — not just handed to the OS
// page cache — by the time the caller proceeds to make an HTTP request.
// This is the only appropriately "durable" write in this module; nothing
// elsewhere in the Harness claims durability without calling this.
//
// writeSync is not guaranteed to write the whole buffer in one call (a
// short write is a real, if rare, possibility, e.g. if interrupted by a
// signal) — the return value (bytes actually written) is checked and the
// call repeated against the remaining bytes until the whole line is
// written, rather than trusting a single call to have flushed everything
// fsyncSync is then told to sync.
//
// A newly created ledger file's fsync only guarantees the file's own bytes
// are durable — on POSIX, the directory entry that makes the filename
// exist at all is a separate piece of metadata that a crash could still
// lose even though the file's content survived. When this call is the one
// that creates the file, the parent directory is opened and fsynced too,
// so the file's very existence is durable, not just its content.
export function appendEventLineDurable(filePath, event) {
  const line = `${JSON.stringify(event)}\n`;
  const buffer = Buffer.from(line, "utf8");
  const isNewFile = !fs.existsSync(filePath);

  const fd = fs.openSync(filePath, "a");
  try {
    let written = 0;
    while (written < buffer.length) {
      const chunk = fs.writeSync(fd, buffer, written, buffer.length - written);
      // A writeSync call that reports 0 (or, defensively, any non-positive
      // value) bytes written must never be treated as "try again" — with
      // `written` unchanged, that would spin the loop forever. This is a
      // genuine I/O failure (e.g. a full disk returning 0 without throwing
      // on some platforms) and is surfaced as an explicit, immediate error
      // instead of hanging the reservation (and therefore the HTTP call
      // that is gated behind it) indefinitely.
      if (!(chunk > 0)) {
        throw new Error(`appendEventLineDurable: writeSync returned ${chunk} bytes (expected a positive number) at offset ${written}/${buffer.length}`);
      }
      written += chunk;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (isNewFile) {
    const dirFd = fs.openSync(dirname(filePath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }
}

// Cross-process exclusive lock via atomic O_CREAT|O_EXCL file creation —
// this is a real OS-level guarantee (two processes racing to open the same
// path with "wx" can never both succeed), unlike an in-process
// Promise-chain queue, which only serializes concurrent async tasks within
// ONE process and does nothing to stop a second `node
// scripts/run-evaluation-harness.mjs` invocation from touching the same
// ledger file at the same time.
//
// Fails closed: if the lock cannot be acquired within timeoutMs (another
// process holds it, or a crashed process left a stale lock file), this
// throws rather than silently proceeding unprotected. A stale lock from a
// crashed process is not auto-reclaimed — that would risk two processes
// both believing they hold the lock if the "stale" process was merely
// slow, not dead. Removing a confirmed-stale lock file is a manual,
// deliberate operator action.
export function acquireExclusiveLock(lockPath, { retryMs = 25, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      return fd;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `LEDGER_LOCK_TIMEOUT: could not acquire the exclusive lock at ${lockPath} within ${timeoutMs}ms. ` +
            `Another Harness process may currently be using this ledger. If none is running, this is a stale ` +
            `lock from a crashed process and must be removed manually before retrying.`
        );
      }
      Atomics.wait(sleepBuffer, 0, 0, retryMs);
    }
  }
}

export function releaseExclusiveLock(fd, lockPath) {
  fs.closeSync(fd);
  fs.unlinkSync(lockPath);
}
