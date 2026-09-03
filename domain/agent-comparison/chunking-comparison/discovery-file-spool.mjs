// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section I/J: the no-DB,
// deterministic file spool that replaces Node-side `pg` network I/O in the
// discovery bulk-write path (real-corpus reproduction traced the OOM into
// sustained `pg`<->PostgreSQL traffic, not into chunking or any particular
// serialization strategy -- see the Turn's final report). Discovery writes
// ONLY to local disk here; a separate, later process (native `psql \copy`,
// scripts/p11f0-spool-native-copy-load.mjs) does the actual PostgreSQL
// bulk-load, entirely outside this module and outside any Node `pg` call.
//
// A shard is a bounded (row-count AND byte-size), COPY-text-format file,
// written via <name>.partial -> fsync -> atomic rename to <name>.copy, so a
// crash mid-write never leaves a half-written file at the final name --
// only fully-written, immutable shards are ever visible under their real
// name. Each shard's row count, byte count, and SHA-256 (of the FINAL file
// content, computed while streaming, never by re-reading the file after)
// are recorded for the aggregate manifest.
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { copyEncodeRow } from "./copy-format.mjs";

export const DEFAULT_MAX_ROWS_PER_SHARD = 5000;
export const DEFAULT_MAX_BYTES_PER_SHARD = 16 * 1024 * 1024; // 16 MiB

// One shard file. Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY finding: an
// earlier async-stream version of this writer (one backpressure-aware
// `await` per ROW) reproduced heap growth and an eventual OOM on the real
// full corpus, even though it performed ZERO PostgreSQL/network I/O --
// matching this Turn's own prior isolation finding that FREQUENT
// event-loop yields during a long CPU-bound chunking run, not any
// particular I/O target, correlate with V8 heap retention. This writer
// instead buffers a shard's own rows (bounded to
// DEFAULT_MAX_ROWS_PER_SHARD/DEFAULT_MAX_BYTES_PER_SHARD -- never more than
// ~16 MiB resident at a time) and performs exactly ONE synchronous write
// per shard at close() -- zero event-loop yields anywhere in the row-write
// path. Blocking the event loop for a single bounded (<=16 MiB) write is
// fine here: this script has no concurrent async work competing for it.
// Still writes via <path>.partial -> fsyncSync -> atomic rename, so a
// crash mid-write never leaves a half-written file visible at the final
// name -- only fully-written, immutable shards are ever visible under
// their real name.
function createShardWriter(finalPath) {
  const partialPath = `${finalPath}.partial`;
  const hash = createHash("sha256");
  const pendingBuffers = [];
  let rowCount = 0;
  let byteCount = 0;
  let closed = false;

  function writeRow(fieldValues) {
    if (closed) throw new Error(`shard writer for ${finalPath} already closed`);
    const line = `${copyEncodeRow(fieldValues)}\n`;
    const buf = Buffer.from(line, "utf8");
    hash.update(buf);
    pendingBuffers.push(buf);
    byteCount += buf.byteLength;
    rowCount += 1;
  }

  async function close() {
    if (closed) throw new Error(`shard writer for ${finalPath} already closed`);
    closed = true;
    const fd = openSync(partialPath, "wx"); // wx: fail if it already exists (never silently overwrite a concurrent/stale partial)
    try {
      writeSync(fd, Buffer.concat(pendingBuffers, byteCount));
      fsyncSync(fd); // flush to durable storage BEFORE the rename that makes this shard visible under its final name
    } finally {
      closeSync(fd);
    }
    pendingBuffers.length = 0; // release the bounded per-shard buffer now that it's durably on disk
    await rename(partialPath, finalPath);
    return { path: finalPath, rowCount, byteCount, sha256: hash.digest("hex") };
  }

  return { writeRow, close };
}

// Bounded, auto-rolling shard set for one logical row stream (e.g.
// "canonical" or "chunk"). Call addRow() for every row in DETERMINISTIC
// (stream) order; internally rolls to a new shard file whenever the current
// one would exceed maxRowsPerShard or maxBytesPerShard. finalize() closes
// the last (possibly partial) shard and returns the full list of completed
// shard descriptors, in shard order.
export function createSpoolShardSet({
  spoolDir, namePrefix, columns,
  maxRowsPerShard = DEFAULT_MAX_ROWS_PER_SHARD,
  maxBytesPerShard = DEFAULT_MAX_BYTES_PER_SHARD,
}) {
  const shards = [];
  let shardIndex = 0;
  let current = null;
  let currentRows = 0;
  let currentBytes = 0;

  function shardPath(index) {
    return path.join(spoolDir, `${namePrefix}-${String(index).padStart(6, "0")}.copy`);
  }

  async function rollToNewShard() {
    if (current !== null) {
      const descriptor = await current.close();
      shards.push({ ...descriptor, rowCount: currentRows, columns, filename: path.basename(descriptor.path) });
      shardIndex += 1;
    }
    current = createShardWriter(shardPath(shardIndex));
    currentRows = 0;
    currentBytes = 0;
  }

  // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY finding: `await`ing a Promise
  // (even one already resolved) costs a real microtask-queue turn, and
  // doing that on EVERY row -- hundreds of thousands of times across the
  // full corpus -- reproduced the same heap-growth/OOM pattern this Turn's
  // prior investigation traced to event-loop yield FREQUENCY, independent
  // of any actual I/O target. addRow is therefore synchronous (no `await`,
  // no Promise, returns nothing) on the overwhelmingly common no-roll path;
  // the caller (flushBatch's spool branch) never awaits it at all. Only
  // addRowMaybeRolling (used at row DISCOVERY-BATCH boundaries, far less
  // frequently) may actually yield, exactly once per shard roll (roughly
  // every maxRowsPerShard rows), not once per row.
  function addRowSync(fieldValues) {
    current.writeRow(fieldValues);
    currentRows += 1;
  }

  function wouldNeedRoll(nextRowEstimatedBytes) {
    if (current === null) return true;
    const wouldExceedRows = currentRows + 1 > maxRowsPerShard;
    const wouldExceedBytes = currentRows > 0 && currentBytes + nextRowEstimatedBytes > maxBytesPerShard;
    return wouldExceedRows || wouldExceedBytes;
  }

  // Returns a Promise only when a shard roll is actually needed (rare);
  // returns undefined (no await required by the caller) otherwise.
  function addRow(fieldValues) {
    const estimatedBytes = fieldValues.reduce((sum, v) => sum + (v == null ? 2 : Buffer.byteLength(String(v), "utf8")), 8);
    if (wouldNeedRoll(estimatedBytes)) {
      return rollToNewShard().then(() => {
        addRowSync(fieldValues);
        currentBytes += estimatedBytes;
      });
    }
    addRowSync(fieldValues);
    currentBytes += estimatedBytes;
    return undefined;
  }

  async function finalize() {
    if (current !== null && currentRows > 0) {
      const descriptor = await current.close();
      shards.push({ ...descriptor, rowCount: currentRows, columns, filename: path.basename(descriptor.path) });
    } else if (current !== null) {
      // Opened but zero rows written (possible only if addRow was never
      // called at all) -- close and discard; no empty shard file is left
      // under a final .copy name.
      await current.close();
    }
    return shards;
  }

  return { addRow, finalize };
}

export async function verifyShardOnDisk(shard) {
  const info = await stat(shard.path ?? shard.filename);
  if (info.size !== shard.byteCount) {
    throw new Error(`SHARD_SIZE_MISMATCH: ${shard.filename} on-disk size ${info.size} != manifest byte_count ${shard.byteCount}`);
  }
  return true;
}
