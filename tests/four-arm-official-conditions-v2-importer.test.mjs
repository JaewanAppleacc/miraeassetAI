import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateOfficialConditionsV2Artifact, validateOfficialUniverseArtifact,
  OfficialConditionsV2ValidationError, CONDITIONS_V2_FORBIDDEN_FIELDS,
} from "../domain/agent-comparison/four-arm-ac/official-conditions-v2-importer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/official");
const EXPECTED_CONDITIONS_SHA256 = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
const EXPECTED_UNIVERSE_SHA256 = "96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc";

function jsonl(rows) {
  return Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function validRow(id, overrides = {}) {
  return {
    question_id: id,
    question: "삼성전자의 2024년 3월 정기공시 매출액은 얼마인가요?",
    segment: "LOW",
    n_hard_conditions: 2,
    conditions: {
      corps: ["삼성전자"], doc_groups: ["periodic"], years: [2024], year_months: [[2024, 3]],
      correction: false, candidate_terms: ["매출액"], wants_latest: false,
      exchange_subtypes: [], major_labels: [], periodic_subtypes: [],
    },
    ...overrides,
  };
}

function makeRows(n) {
  return Array.from({ length: n }, (_, i) => validRow(`q${i}`));
}

test("real imported artifact: devtune101_conditions.v2.jsonl matches the pinned SHA exactly", async () => {
  const raw = await readFile(path.join(OFFICIAL_DIR, "devtune101_conditions.v2.jsonl"));
  const result = validateOfficialConditionsV2Artifact(raw, { expectedSha256: EXPECTED_CONDITIONS_SHA256, expectedRowCount: 101 });
  assert.equal(result.file_sha256, EXPECTED_CONDITIONS_SHA256);
  assert.equal(result.row_count, 101);
  assert.equal(result.official_execution_ready, true);
  assert.equal(result.source, "OFFICIAL_CONDITIONS_ARTIFACT");
  assert.equal(result.low_count + result.high_count, 101);
});

test("real imported artifact: universe.csv matches the pinned SHA exactly", async () => {
  const raw = await readFile(path.join(OFFICIAL_DIR, "universe.csv"));
  const result = validateOfficialUniverseArtifact(raw, { expectedSha256: EXPECTED_UNIVERSE_SHA256 });
  assert.equal(result.file_sha256, EXPECTED_UNIVERSE_SHA256);
  assert.equal(result.official_execution_ready, true);
});

test("config.A.json and config.C.json pin the SAME literal conditions/universe SHA as the real artifact", async () => {
  const [configA, configC] = await Promise.all([
    readFile(path.join(OFFICIAL_DIR, "../config.A.json"), "utf8").then(JSON.parse),
    readFile(path.join(OFFICIAL_DIR, "../config.C.json"), "utf8").then(JSON.parse),
  ]);
  for (const config of [configA, configC]) {
    assert.equal(config.metadata_filter.source, "OFFICIAL_CONDITIONS_ARTIFACT");
    assert.equal(config.metadata_filter.conditions_sha256, EXPECTED_CONDITIONS_SHA256);
    assert.equal(config.metadata_filter.universe_sha256, EXPECTED_UNIVERSE_SHA256);
  }
});

test("rejects a wrong sha256 (tampered/substituted file) fail-closed", () => {
  const rows = jsonl(makeRows(101));
  assert.throws(
    () => validateOfficialConditionsV2Artifact(rows, { expectedSha256: "0".repeat(64), expectedRowCount: 101 }),
    (err) => err instanceof OfficialConditionsV2ValidationError && err.code === "CONDITIONS_V2_SHA256_MISMATCH",
  );
});

test("rejects wrong row count", () => {
  const rows = jsonl(makeRows(100));
  assert.throws(
    () => validateOfficialConditionsV2Artifact(rows, { expectedRowCount: 101 }),
    (err) => err.code === "CONDITIONS_V2_ROW_COUNT_MISMATCH",
  );
});

test("rejects a Gold-shaped forbidden field at top level", () => {
  const rows = makeRows(100);
  rows.push({ ...validRow("q100"), gold_document_ids: ["doc_1"] });
  assert.throws(
    () => validateOfficialConditionsV2Artifact(jsonl(rows), { expectedRowCount: 101 }),
    (err) => err.code === "CONDITIONS_V2_FORBIDDEN_FIELD",
  );
});

test("rejects a Gold-shaped forbidden field nested inside conditions", () => {
  const rows = makeRows(100);
  const bad = validRow("q100");
  bad.conditions.evidence_locator = "doc_1#node_5";
  rows.push(bad);
  assert.throws(
    () => validateOfficialConditionsV2Artifact(jsonl(rows), { expectedRowCount: 101 }),
    (err) => err.code === "CONDITIONS_V2_FORBIDDEN_CONDITION_FIELD",
  );
});

test("every declared CONDITIONS_V2_FORBIDDEN_FIELDS entry is independently rejected", () => {
  for (const field of CONDITIONS_V2_FORBIDDEN_FIELDS) {
    const rows = makeRows(100);
    rows.push({ ...validRow("q100"), [field]: "x" });
    assert.throws(
      () => validateOfficialConditionsV2Artifact(jsonl(rows), { expectedRowCount: 101 }),
      (err) => err.code === "CONDITIONS_V2_FORBIDDEN_FIELD",
      `field ${field} should be rejected`,
    );
  }
});

test("rejects duplicate question_id", () => {
  const rows = makeRows(100);
  rows.push(validRow("q0"));
  assert.throws(
    () => validateOfficialConditionsV2Artifact(jsonl(rows), { expectedRowCount: 101 }),
    (err) => err.code === "CONDITIONS_V2_DUPLICATE_QUESTION_ID",
  );
});

test("rejects a segment that does not match the recomputed LOW/HIGH rule", () => {
  const rows = makeRows(100);
  rows.push(validRow("q100", { segment: "HIGH" })); // n_hard_conditions=2 -> LOW
  assert.throws(
    () => validateOfficialConditionsV2Artifact(jsonl(rows), { expectedRowCount: 101 }),
    (err) => err.code === "CONDITIONS_V2_SEGMENT_MISMATCH",
  );
});

test("rejects an unknown top-level field", () => {
  const rows = makeRows(100);
  rows.push({ ...validRow("q100"), extra_unexpected_field: 1 });
  assert.throws(
    () => validateOfficialConditionsV2Artifact(jsonl(rows), { expectedRowCount: 101 }),
    (err) => err.code === "CONDITIONS_V2_UNKNOWN_TOP_LEVEL_FIELD",
  );
});

test("rejects an unknown condition field", () => {
  const rows = makeRows(100);
  const bad = validRow("q100");
  bad.conditions.some_new_field = true;
  rows.push(bad);
  assert.throws(
    () => validateOfficialConditionsV2Artifact(jsonl(rows), { expectedRowCount: 101 }),
    (err) => err.code === "CONDITIONS_V2_UNKNOWN_CONDITION_FIELD",
  );
});

test("accepts a valid synthetic 101-row artifact with no expectedSha256 pin", () => {
  const result = validateOfficialConditionsV2Artifact(jsonl(makeRows(101)), { expectedRowCount: 101 });
  assert.equal(result.row_count, 101);
  assert.equal(result.official_execution_ready, true);
});

test("universe validator rejects sha256 mismatch and empty file", () => {
  assert.throws(() => validateOfficialUniverseArtifact(Buffer.from("a,b\n1,2\n"), { expectedSha256: "0".repeat(64) }));
  assert.throws(() => validateOfficialUniverseArtifact(Buffer.from("")), (err) => err.code === "UNIVERSE_EMPTY");
});
