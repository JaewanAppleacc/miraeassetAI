// Real-data integration tests for Turn P10's chunking comparison pipeline.
// Reads the SAME real, committed seed-release-v0.20-r3.candidate bundle
// this repo's other real-data tests already use (e.g. tests/citation-real-
// data-integration.test.mjs) -- read-only, no PostgreSQL, no network,
// no HCX, no Gold/DEV/HOLDOUT access.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES, P10_EMBEDDING_CANDIDATE } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { collectResolvableBundleCorpus, resolvableDocumentEntries, P10_BUNDLE_OPTIONS_FACTORY } from "../domain/agent-comparison/chunking-comparison/resolvable-bundle-corpus.mjs";
import { adaptCanonicalRecordToChunkerInput } from "../domain/agent-comparison/chunking-comparison/b-canonical-to-chunker-input.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PROVENANCE = { targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: "e4a417c280aa0bfb437f8c15c60a36c3b777798d", parserConfigHash: "52b37a07da4cb420cb607183fb2e1f088634eb003b69435748b0670eb366bfe1" };

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

async function loadEntries() {
  const corpus = await collectResolvableBundleCorpus(P10_BUNDLE_OPTIONS_FACTORY(ROOT));
  return resolvableDocumentEntries(corpus);
}

function chunkAll(entries, strategyConfig) {
  const chunks = [];
  for (const entry of entries) {
    const { record, document } = adaptCanonicalRecordToChunkerInput(entry.canonicalRecord, { corpCode: entry.corpCode, corpName: entry.corpName, listedName: entry.listedName });
    chunks.push(...chunkDocument(record, document, strategyConfig, PROVENANCE));
  }
  return chunks;
}

test("P10_EMBEDDING_CANDIDATE pins the exact BGE-M3 repository_id and revision from this Turn's brief", () => {
  assert.equal(P10_EMBEDDING_CANDIDATE.repository_id, "BAAI/bge-m3");
  assert.equal(P10_EMBEDDING_CANDIDATE.immutable_revision, "5617a9f61b028005a4858fdac845db406aefb181");
  assert.equal(P10_EMBEDDING_CANDIDATE.final_embedding_model_selected, false);
});

test("resolvable corpus: only documents with a REAL VERIFIED_FACT-resolved corp_code are included (no placeholder corp_code)", async () => {
  const entries = await loadEntries();
  assert.ok(entries.length > 0, "expected at least one resolvable document in the real bundle sample");
  for (const entry of entries) assert.match(entry.corpCode, /^[0-9]{8}$/);
  // sorted deterministically by document_id
  const ids = entries.map((e) => e.documentId);
  assert.deepEqual(ids, [...ids].sort());
});

test("determinism: rebuilding the same strategy over the same real documents twice yields an identical chunk_id set", async () => {
  const entries = await loadEntries();
  const strategyConfig = P10_STRATEGIES[0];
  const first = chunkAll(entries, strategyConfig).map((c) => c.chunk_id).sort();
  const second = chunkAll(entries, strategyConfig).map((c) => c.chunk_id).sort();
  assert.deepEqual(first, second);
  assert.equal(sha256Hex(first), sha256Hex(second));
});

test("no cross-document/cross-company node contamination across all 3 strategies", async () => {
  const entries = await loadEntries();
  const entryByDocId = new Map(entries.map((e) => [e.documentId, e]));
  for (const strategyConfig of P10_STRATEGIES) {
    const chunks = chunkAll(entries, strategyConfig);
    for (const chunk of chunks) {
      const expected = entryByDocId.get(chunk.document_id);
      assert.ok(expected, `chunk document_id ${chunk.document_id} is not one of the bounded documents`);
      assert.equal(chunk.metadata.corp_code, expected.corpCode, `chunk from ${chunk.document_id} carries the wrong corp_code`);
      for (const span of chunk.source_spans) assert.ok(span.rel_path && !span.rel_path.startsWith("/") && !span.rel_path.includes(".."));
    }
  }
});

test("FAILED/PARTIAL (fallback-tier) documents in the real sample only ever produce non-retrieval-eligible DOCUMENT_FALLBACK chunks", async () => {
  const entries = await loadEntries();
  const fallbackEntries = entries.filter((e) => e.canonicalRecord.quality_summary?.source_parse_tier === "fallback");
  if (fallbackEntries.length === 0) return; // no fallback-tier document happens to be in this real sample -- nothing to assert
  for (const strategyConfig of P10_STRATEGIES) {
    const chunks = chunkAll(fallbackEntries, strategyConfig);
    for (const chunk of chunks) {
      assert.equal(chunk.chunk_type, "DOCUMENT_FALLBACK");
      assert.equal(chunk.metadata.retrieval_eligible, false);
      assert.equal(chunk.metadata.fact_eligible, false);
    }
  }
});

test("hierarchical P10 variant: every TABLE_ROW chunk links to a real TABLE_WHOLE parent that shares the same document", async () => {
  const entries = await loadEntries();
  const hierarchical = P10_STRATEGIES.find((s) => s.strategy_name === "document-type-hierarchical-parent-child");
  const chunks = chunkAll(entries, hierarchical);
  const byId = new Map(chunks.map((c) => [c.chunk_id, c]));
  const tableRows = chunks.filter((c) => c.chunk_type === "TABLE_ROW");
  assert.ok(tableRows.length > 0, "expected at least one TABLE_ROW chunk in the real sample under the hierarchical strategy");
  for (const row of tableRows) {
    assert.ok(row.parent_chunk_id, "TABLE_ROW chunk missing a parent_chunk_id");
    const parent = byId.get(row.parent_chunk_id);
    assert.ok(parent, "TABLE_ROW parent_chunk_id does not resolve to a real chunk in the same build");
    assert.equal(parent.chunk_type, "TABLE_WHOLE");
    assert.equal(parent.document_id, row.document_id);
  }
});

test("hierarchical P10 variant respects the overridden parent_max_tokens=1536 (never exceeds it)", async () => {
  const entries = await loadEntries();
  const hierarchical = P10_STRATEGIES.find((s) => s.strategy_name === "document-type-hierarchical-parent-child");
  assert.equal(hierarchical.parent_max_tokens, 1536);
  const chunks = chunkAll(entries, hierarchical);
  const parents = chunks.filter((c) => ["SECTION_PARENT", "EVENT_PARENT", "HOLDING_STATUS_PARENT", "TABLE_WHOLE"].includes(c.chunk_type));
  for (const parent of parents) assert.ok(parent.token_count <= 1536, `parent chunk ${parent.chunk_id} exceeds parent_max_tokens=1536 (token_count=${parent.token_count})`);
});

test("every chunk's content_sha256 matches sha256(raw_text) -- no drift between stored hash and text", async () => {
  const entries = await loadEntries();
  const chunks = chunkAll(entries, P10_STRATEGIES[1]);
  for (const chunk of chunks) assert.equal(chunk.content_sha256, sha256Hex(chunk.raw_text));
});
