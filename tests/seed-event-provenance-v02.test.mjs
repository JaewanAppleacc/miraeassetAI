import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateEventRecord, validateEvidenceRecord } from "../domain/adapters/seed-artifact-schema-validators.mjs";
import { buildSeedEventProvenanceV02 } from "../scripts/build-seed-event-provenance-v02.mjs";

test("builds a complete, unpromoted Event provenance v0.2 revision", async () => {
  const result = await buildSeedEventProvenanceV02({ writeOutputs: false, generatedAt: "2026-08-13T00:00:00Z" });
  assert.equal(result.eventsV02.length, 24);
  assert.equal(result.reviewQueue.length, 19);
  assert.equal(result.summary.direct_literal_event_count, 14);
  assert.equal(result.summary.table_row_composite_event_count, 5);
  assert.equal(result.summary.promotion_allowed, false);
  assert.ok(result.newEvidence.length > 19);
  assert.ok(result.eventsV02.every((record) => record.verification_status === "CANDIDATE"));
  assert.ok(result.newEvidence.every((record) => record.verification_status === "CANDIDATE"));
  for (const event of result.eventsV02) assert.deepEqual(validateEventRecord(event), []);
  for (const evidence of result.newEvidence) assert.deepEqual(validateEvidenceRecord(evidence), []);
});

test("changes only provenance fields and the corrected LOI occurrence date", async () => {
  const result = await buildSeedEventProvenanceV02({ writeOutputs: false });
  for (const mapping of result.mapping) {
    if (mapping.event_id === "event_cffef01467a71df30fdbb9c6") {
      assert.deepEqual(mapping.changed_fields, ["event_date", "evidence_ids"]);
      assert.equal(mapping.event_date_before, "2023-06-05");
      assert.equal(mapping.event_date_after, "2023-06-03");
    } else if (mapping.changed_fields.length > 0) {
      assert.deepEqual(mapping.changed_fields, ["evidence_ids"]);
    }
  }
  const loi = result.eventsV02.find((record) => record.event_id === "event_cffef01467a71df30fdbb9c6");
  assert.equal(loi.known_at, "2023-06-05T00:00:00Z");
  assert.equal(loi.valid_from, "2023-06-05T00:00:00Z");
});

test("table composite Evidence shares one row and every review item has new provenance", async () => {
  const result = await buildSeedEventProvenanceV02({ writeOutputs: false });
  const byEvent = new Map();
  for (const record of result.newEvidence) {
    const eventId = record.metadata.linked_event_ids[0];
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), record]);
  }
  for (const item of result.reviewQueue) {
    const records = byEvent.get(item.event_id);
    assert.ok(records?.length > 0);
    if (item.provenance_strength === "TABLE_ROW_COMPOSITE") {
      assert.equal(new Set(records.map((record) => record.metadata.row)).size, 1);
      assert.notEqual(records[0].metadata.row, null);
    }
  }
});

test("writes a review packet and leaves all source artifacts byte-identical", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seed-event-v02-"));
  const inputs = [
    "work/domain-seed/seed-event-candidates.v0.1.jsonl",
    "work/domain-seed/seed-evidence-verified.v0.3.jsonl",
    "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl",
    "work/domain-seed/seed-canonical-document-ir.v0.7.delta.jsonl",
  ];
  const before = await Promise.all(inputs.map((file) => readFile(file)));
  const paths = {
    eventsV01: inputs[0], evidenceV03: inputs[1], canonicalBase: inputs[2], canonicalDelta: inputs[3],
    eventsV02: path.join(temp, "events.jsonl"), evidenceDelta: path.join(temp, "evidence.jsonl"), mapping: path.join(temp, "mapping.jsonl"),
    reviewQueue: path.join(temp, "queue.jsonl"), summary: path.join(temp, "summary.json"), report: path.join(temp, "report.md"), claudePrompt: path.join(temp, "prompt.md"),
  };
  await buildSeedEventProvenanceV02({ root: process.cwd(), paths });
  assert.deepEqual(await Promise.all(inputs.map((file) => readFile(file))), before);
  for (const key of ["eventsV02", "evidenceDelta", "mapping", "reviewQueue", "summary", "report", "claudePrompt"]) {
    assert.ok((await readFile(paths[key])).length > 0);
  }
});
