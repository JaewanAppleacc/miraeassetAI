// Turn A-RETRIEVAL-REMEDIATION-V1 (review round 3): result-file integrity for
// the DEV_TUNE runner's checkpoint/resume/completion path, as pure functions
// with no `pg` dependency so they can be unit-tested offline.
//
// Contract the runner enforces with these helpers:
//   * resume only continues the SAME run: every existing row must carry the
//     current arm / batch_id / code_sha256 / config_sha256 / policy_id
//     (frozen rows carry no policy_id -> null); any mismatch refuses to
//     resume instead of silently stitching two executions together;
//   * a question is done iff it has a successful row (no `error`); errored
//     rows are retried, and the retry's success row supersedes them;
//   * on completion the results file is rewritten canonically -- exactly one
//     successful row per question in the batch's own order, error/duplicate
//     history removed -- atomically (temp file + rename), and THAT content is
//     what results_sha256 pins.
import { writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";

export const IDENTITY_FIELDS = Object.freeze(["arm", "batch_id", "code_sha256", "config_sha256", "policy_id"]);

export class CheckpointIdentityMismatchError extends Error {
  constructor(mismatches) {
    const first = mismatches[0];
    super(`checkpoint belongs to a different run: ${mismatches.length} mismatch(es); first: line ${first.line} (${first.question_id}) ${first.field} expected ${JSON.stringify(first.expected)}, found ${JSON.stringify(first.actual)} -- use a fresh --out-dir or --overwrite`);
    this.name = "CheckpointIdentityMismatchError";
    this.code = "CHECKPOINT_IDENTITY_MISMATCH";
    this.mismatches = mismatches;
  }
}

export class CheckpointFormatError extends Error {
  constructor(message, line) {
    super(`checkpoint line ${line}: ${message}`);
    this.name = "CheckpointFormatError";
    this.code = "CHECKPOINT_FORMAT";
    this.line = line;
  }
}

export function parseCheckpointLines(text) {
  const rows = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new CheckpointFormatError("not valid JSON", i + 1); }
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.question_id !== "string" || row.question_id === "") {
      throw new CheckpointFormatError("no question_id", i + 1);
    }
    rows.push(row);
  }
  return rows;
}

// identity: { arm, batch_id, code_sha256, config_sha256, policy_id } --
// policy_id null for the frozen policy (its rows carry no policy_id).
export function validateCheckpointIdentity(rows, identity) {
  const mismatches = [];
  rows.forEach((row, index) => {
    for (const field of IDENTITY_FIELDS) {
      const expected = identity[field] ?? null;
      const actual = row[field] ?? null;
      if (expected !== actual) mismatches.push({ line: index + 1, question_id: row.question_id, field, expected, actual });
    }
  });
  if (mismatches.length > 0) throw new CheckpointIdentityMismatchError(mismatches);
  return rows;
}

// done: question_id -> its (last) successful row; errored: question_id ->
// its (last) error row, only for questions with NO successful row.
export function checkpointState(rows) {
  const done = new Map();
  const errored = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    if (row.error) {
      if (!done.has(row.question_id)) errored.set(row.question_id, row);
      continue;
    }
    if (done.has(row.question_id)) duplicates.add(row.question_id);
    done.set(row.question_id, row);
    errored.delete(row.question_id);
  }
  return Object.freeze({ done, errored, duplicate_success_ids: Object.freeze([...duplicates]), rows: rows.length });
}

// Exactly one successful row per question, in questionIds order. Fails
// closed on any question without a successful row and on any row for a
// question outside the batch. Rows are re-serialised with JSON.stringify,
// which reproduces a line appended by the runner byte for byte (same key
// order, no whitespace).
export function canonicalizeResults(done, questionIds) {
  if (!(done instanceof Map)) throw new TypeError("done must be a Map of question_id -> successful row");
  const missing = questionIds.filter((q) => !done.has(q));
  if (missing.length > 0) {
    throw new Error(`cannot canonicalize: ${missing.length} question(s) have no successful row (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""})`);
  }
  const batch = new Set(questionIds);
  const extra = [...done.keys()].filter((q) => !batch.has(q));
  if (extra.length > 0) {
    throw new Error(`cannot canonicalize: ${extra.length} row(s) belong to question_ids outside this batch (${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", ..." : ""})`);
  }
  const lines = questionIds.map((q) => {
    const row = done.get(q);
    if (row.error) throw new Error(`cannot canonicalize: ${q} has an error row where a successful row was expected`);
    return JSON.stringify(row);
  });
  return Object.freeze({ text: `${lines.join("\n")}\n`, rows: lines.length });
}

// Write-then-rename so a reader never sees a half-written results file.
export function atomicWriteFileSync(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, filePath);
}
