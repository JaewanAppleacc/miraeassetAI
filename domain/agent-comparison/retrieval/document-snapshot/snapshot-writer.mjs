// Turn P5: bounded-memory, atomic-rename file writers for the snapshot's
// large JSONL artifacts. No file this module writes is ever visible at its
// FINAL path until writing has fully succeeded -- every writer goes to a
// `<final>.tmp-<pid>-<random>` sibling first and renames only on a clean
// finish(). A thrown error (or abort()) unlinks the temp file so a failed
// run never leaves a partial, misleadingly-named "final" artifact behind.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function tempSuffix() {
  return `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

// One line per write(), newline-terminated, backpressure-aware (awaits
// 'drain' the same way scripts/adapt-a-document-ir.mjs's own writeLine()
// does), with a running sha256 over the exact bytes written -- so the
// "canonical hash" of a multi-hundred-thousand-line file never requires a
// second full read pass after writing.
export function createAtomicJsonlWriter(finalPath) {
  const tempPath = `${finalPath}${tempSuffix()}`;
  let stream;
  let hash = createHash("sha256");
  let lineCount = 0;
  let bytesWritten = 0;
  let started = false;
  let finished = false;

  async function ensureStarted() {
    if (started) return;
    started = true;
    await mkdir(dirname(finalPath), { recursive: true });
    stream = createWriteStream(tempPath, { encoding: "utf8", flags: "wx" });
    await new Promise((resolvePromise, rejectPromise) => {
      stream.once("open", resolvePromise);
      stream.once("error", rejectPromise);
    });
  }

  return {
    tempPath,
    async writeLine(record) {
      await ensureStarted();
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.from(line, "utf8");
      hash.update(bytes);
      bytesWritten += bytes.length;
      lineCount += 1;
      if (!stream.write(line)) {
        await new Promise((resolveDrain) => stream.once("drain", resolveDrain));
      }
    },
    async finish() {
      if (!started) {
        // Zero-line output is still a real, valid (empty) artifact -- e.g.
        // a fixture corpus with no eligible chunks. Create it explicitly
        // rather than silently skipping the rename.
        await ensureStarted();
      }
      await new Promise((resolvePromise, rejectPromise) => {
        stream.end((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
      await rename(tempPath, finalPath);
      finished = true;
      return { path: finalPath, lineCount, bytesWritten, sha256: hash.digest("hex") };
    },
    async abort() {
      if (finished) return;
      if (stream && !stream.destroyed) stream.destroy();
      await rm(tempPath, { force: true });
    },
  };
}

// For the small, whole-object report/manifest files (never streamed --
// these are at most a few KB to a few MB, bounded by document/group counts,
// not by corpus size).
export async function writeJsonFileAtomic(finalPath, value) {
  const tempPath = `${finalPath}${tempSuffix()}`;
  await mkdir(dirname(finalPath), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
