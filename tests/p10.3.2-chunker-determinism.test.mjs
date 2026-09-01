import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: "0".repeat(40), parserConfigHash: "0".repeat(64) });

if (existsSync(RAW_CACHE_PATH)) {
  test("real chunker.mjs double-run determinism: chunking the SAME real documents twice produces byte-identical chunks (content_sha256, chunk_id, source_spans)", () => {
    const lines = readFileSync(RAW_CACHE_PATH, "utf8").split("\n").filter(Boolean).slice(0, 5).map((l) => JSON.parse(l));
    const fixedConfig = P10_STRATEGIES.find((s) => s.chunking_config_id === "fixed-token-512-o64.v0.1.0");
    for (const entry of lines) {
      const run1 = chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), fixedConfig, PROVENANCE);
      const run2 = chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), fixedConfig, PROVENANCE);
      assert.deepEqual(run1, run2, `non-deterministic chunking for ${entry.document_id}`);
    }
  });

  test("real chunker.mjs double-run determinism: Section-Aware-Flat is also deterministic", () => {
    const lines = readFileSync(RAW_CACHE_PATH, "utf8").split("\n").filter(Boolean).slice(0, 5).map((l) => JSON.parse(l));
    const sectionConfig = P10_STRATEGIES.find((s) => s.chunking_config_id === "section-aware-flat-512-o64.v0.1.0");
    for (const entry of lines) {
      const run1 = chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), sectionConfig, PROVENANCE);
      const run2 = chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), sectionConfig, PROVENANCE);
      assert.deepEqual(run1, run2, `non-deterministic chunking for ${entry.document_id}`);
    }
  });
}
