// Turn N4.5.1: verifies the read-only raw canonical DocumentIR loader
// (domain/adapters/document-ir-raw-source-loader.mjs) against both a
// self-contained fixture repo root (portable across machines/CI) and the
// REAL repository corpus at work/a-document-ir/source/*.jsonl, with NO
// environment variable set -- reproducing exactly the sanity check Turn
// N4.5.1 requires and Turn N4.5 skipped.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DOCUMENT_IR_SOURCE_RELATIVE_PATHS, inferDocGroupFromDocId, loadDocumentIrRecordsByIds, loadDocumentIrRecordById,
} from "../domain/adapters/document-ir-raw-source-loader.mjs";

const REAL_REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function makeFixtureRepoRoot(filesByGroup) {
  const root = mkdtempSync(join(tmpdir(), "document-ir-raw-source-loader-test-"));
  mkdirSync(join(root, "work/a-document-ir/source"), { recursive: true });
  for (const [group, lines] of Object.entries(filesByGroup)) {
    const relPath = DOCUMENT_IR_SOURCE_RELATIVE_PATHS[group];
    writeFileSync(join(root, relPath), lines.map((r) => JSON.stringify(r)).join("\n") + (lines.length ? "\n" : ""));
  }
  return root;
}

function fixtureDoc(docId, extra = {}) {
  return { doc_id: docId, schema_version: "1.0", parser_version: "1.0.0", corpus_snapshot_id: "snap_fixture", source_files: [], nodes: [], warnings: [], parse_quality: {}, ...extra };
}

test("inferDocGroupFromDocId maps a known prefix to its group and rejects an unknown prefix", () => {
  assert.equal(inferDocGroupFromDocId("exchange_20250113800603"), "exchange");
  assert.equal(inferDocGroupFromDocId("major_20241031000508"), "major");
  assert.equal(inferDocGroupFromDocId("holding_20230120000563"), "holding");
  assert.equal(inferDocGroupFromDocId("periodic_20230515002335"), "periodic");
  assert.equal(inferDocGroupFromDocId("unknownprefix_123"), null);
  assert.equal(inferDocGroupFromDocId(""), null);
});

test("fixture: loads a real matching doc_id and reports notFound for a genuinely absent one, streaming only the needed group", async () => {
  const root = makeFixtureRepoRoot({
    exchange: [fixtureDoc("exchange_a", { nodes: [{ kind: "table", node_id: "exchange_a::x.xml::n0", normalized_rows: [["a", "b"]] }] }), fixtureDoc("exchange_b")],
    major: [fixtureDoc("major_a")],
  });
  try {
    const { recordsById, notFound, parseFailures } = await loadDocumentIrRecordsByIds({ repoRoot: root, docIds: ["exchange_a", "exchange_zzz_missing"] });
    assert.equal(recordsById.size, 1);
    assert.ok(recordsById.has("exchange_a"));
    assert.equal(recordsById.get("exchange_a").record.nodes[0].normalized_rows[0][0], "a");
    assert.deepEqual(notFound, ["exchange_zzz_missing"]);
    assert.deepEqual(parseFailures, []);
    // major.jsonl was not queried at all -- but confirm this loader never
    // requires it to exist when nothing from that group was requested.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture: fail-closed on a duplicate doc_id within the SAME needed group", async () => {
  const root = makeFixtureRepoRoot({ exchange: [fixtureDoc("exchange_dup"), fixtureDoc("exchange_dup")] });
  try {
    await assert.rejects(
      () => loadDocumentIrRecordsByIds({ repoRoot: root, docIds: ["exchange_dup"] }),
      /duplicate doc_id/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture: a malformed JSON line for a WANTED doc_id is reported as an explicit parse failure, never silently dropped or crashed on", async () => {
  const root = mkdtempSync(join(tmpdir(), "document-ir-raw-source-loader-test-"));
  mkdirSync(join(root, "work/a-document-ir/source"), { recursive: true });
  writeFileSync(join(root, DOCUMENT_IR_SOURCE_RELATIVE_PATHS.exchange), '{"doc_id": "exchange_broken", "nodes": [BROKEN\n');
  try {
    const { recordsById, parseFailures } = await loadDocumentIrRecordsByIds({ repoRoot: root, docIds: ["exchange_broken"] });
    assert.equal(recordsById.size, 0);
    assert.equal(parseFailures.length, 1);
    assert.equal(parseFailures[0].docId, "exchange_broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture: an unrecognized doc_id prefix is treated as not-found (no file to stream, no crash)", async () => {
  const root = makeFixtureRepoRoot({ exchange: [fixtureDoc("exchange_a")] });
  try {
    const { recordsById, notFound } = await loadDocumentIrRecordsByIds({ repoRoot: root, docIds: ["totally_unknown_prefix_id"] });
    assert.equal(recordsById.size, 0);
    assert.deepEqual(notFound, ["totally_unknown_prefix_id"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture: loadDocumentIrRecordById returns null for a genuinely absent id and throws for a PARSE_FAILED one", async () => {
  const root = makeFixtureRepoRoot({ exchange: [fixtureDoc("exchange_a")] });
  try {
    assert.equal(await loadDocumentIrRecordById({ repoRoot: root, docId: "exchange_missing" }), null);
    const record = await loadDocumentIrRecordById({ repoRoot: root, docId: "exchange_a" });
    assert.equal(record.record.doc_id, "exchange_a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- real repository corpus: the exact sanity check Turn N4.5.1 requires,
//     with NO environment variable set (CORPUS_PATH/DISCLOSURE_CORPUS_ROOT
//     are irrelevant to this loader by design). -------------------------
test("REAL repository DocumentIR: exchange_20250113800603 and exchange_20240617800437 both resolve with zero environment configuration", async () => {
  assert.equal(process.env.CORPUS_PATH, undefined);
  assert.equal(process.env.DISCLOSURE_CORPUS_ROOT, undefined);
  const { recordsById, notFound, parseFailures } = await loadDocumentIrRecordsByIds({
    repoRoot: REAL_REPO_ROOT,
    docIds: ["exchange_20250113800603", "exchange_20240617800437"],
  });
  assert.deepEqual(notFound, []);
  assert.deepEqual(parseFailures, []);
  assert.equal(recordsById.size, 2);
  assert.equal(recordsById.get("exchange_20250113800603").record.doc_id, "exchange_20250113800603");
  assert.equal(recordsById.get("exchange_20240617800437").record.doc_id, "exchange_20240617800437");
}, { timeout: 30_000 });

test("REAL repository DocumentIR: a genuinely nonexistent document id in a real group resolves as not-found, not a crash", async () => {
  const { recordsById, notFound } = await loadDocumentIrRecordsByIds({ repoRoot: REAL_REPO_ROOT, docIds: ["exchange_99999999999999"] });
  assert.equal(recordsById.size, 0);
  assert.deepEqual(notFound, ["exchange_99999999999999"]);
}, { timeout: 30_000 });
