import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSeedFactArtifactStore } from "../domain/adapters/seed-fact-artifact-store.mjs";
import { createFactProvenanceValidator, createFactStore } from "../domain/runtime/fact-store.mjs";

// ---------------------------------------------------------------------------
// Seed Fact Artifact Store: a read-only adapter over an explicitly PINNED
// Fact artifact (JSONL) + Fact Coverage Snapshot (single JSON document),
// satisfying domain/runtime/fact-store.mjs's `{ getFact }` interface. This
// factory accepts ONLY explicit pins -- there is no allowUnpinned/sandbox
// escape hatch (unlike the DocumentIR/Evidence stores) because the task
// explicitly calls for "명시적으로 pin된 입력만" with no exception.
//
// No real Fact artifact exists in this repo yet (VERIFIED Fact generation
// is out of scope for this task), so every fixture here is a hand-built,
// schema-valid record -- there is no "real data" optional integration
// test in this file.
// ---------------------------------------------------------------------------

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "fact-store-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";
const FACT_COVERAGE_SNAPSHOT_ID = `fact_coverage_snapshot_${"b".repeat(24)}`;
const FACT_ID_A = `fact_${"a".repeat(24)}`;
const FACT_ID_B = `fact_${"c".repeat(24)}`;

function factRecord(overrides = {}) {
  return {
    fact_id: FACT_ID_A,
    corp_code: "00126380",
    event_id: null,
    source_document_id: "exchange_20230428800439",
    metric_code: "REVENUE",
    raw_label: "매출액",
    value_type: "NUMERIC",
    value_status: "DISCLOSED",
    value_certainty: "CONFIRMED",
    raw_value_text: "1,000,000",
    raw_unit_text: "원",
    normalized_value: 1000000,
    unit: "KRW",
    currency: "KRW",
    scale: 1,
    scope: "CONSOLIDATED",
    period_type: "ANNUAL",
    period_start: "2022-01-01",
    period_end: "2022-12-31",
    as_of_date: "2022-12-31",
    known_at: "2023-04-28T00:00:00Z",
    valid_from: "2023-04-28T00:00:00Z",
    valid_to: null,
    withheld_until: null,
    extraction_method: "DETERMINISTIC",
    confidence: 1,
    verification_status: "VERIFIED",
    evidence_ids: [],
    attributes: {},
    ...overrides,
  };
}

function coverageSlot(overrides = {}) {
  return {
    slot_key: "slot-1",
    corp_code: "00126380",
    metric_code: "REVENUE",
    period_key: "2022-ANNUAL",
    scope: "CONSOLIDATED",
    coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED",
    verification_status: "VERIFIED",
    fact_ids: [FACT_ID_A],
    evidence_ids: [],
    reason_code: null,
    ...overrides,
  };
}

function coverageSnapshot(overrides = {}) {
  return {
    schema_version: "0.1.0",
    fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    semantic_bundle_schema_version: "0.2.0",
    producer_version: "test-0.0.0",
    created_at: "2026-08-12T00:00:00Z",
    slots: [coverageSlot()],
    ...overrides,
  };
}

function writePinnedFactArtifact(path, records) {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, body);
  return { path, sha256: sha256Hex(Buffer.from(body, "utf8")), record_count: records.length };
}

function writePinnedCoverageSnapshot(path, snapshot) {
  const body = JSON.stringify(snapshot);
  writeFileSync(path, body);
  return { path, sha256: sha256Hex(Buffer.from(body, "utf8")) };
}

// Builds a genuinely valid, cross-consistent pair (Fact artifact + Coverage
// Snapshot referencing it) and constructs the store from their real pins.
async function buildStore(dir, { facts = [factRecord()], slots, coverageOverrides = {} } = {}) {
  const factPath = join(dir, "facts.jsonl");
  const pinnedFacts = writePinnedFactArtifact(factPath, facts);
  const coveragePath = join(dir, "coverage.json");
  const finalSlots = slots ?? [coverageSlot({ fact_ids: facts.map((f) => f.fact_id) })];
  const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot({ slots: finalSlots, ...coverageOverrides }));
  return createSeedFactArtifactStore({
    factArtifactPath: pinnedFacts.path,
    factArtifactSha256: pinnedFacts.sha256,
    factRecordCount: pinnedFacts.record_count,
    factCoverageSnapshotPath: pinnedCoverage.path,
    factCoverageSnapshotSha256: pinnedCoverage.sha256,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("resolves a VERIFIED fact referenced by a coverage slot, with the correct envelope shape", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir);
    const envelope = await store.getFact(FACT_ID_A);
    assert.equal(envelope.corpus_snapshot_id, CORPUS_SNAPSHOT_ID);
    assert.equal(envelope.fact_coverage_snapshot_id, FACT_COVERAGE_SNAPSHOT_ID);
    assert.equal(envelope.record.fact_id, FACT_ID_A);
    assert.equal(envelope.record.verification_status, "VERIFIED");
    assert.equal(envelope.record.normalized_value, 1000000);
  }));

test("getFact returns null for an unknown fact_id (never throws for 'not found')", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir);
    const result = await store.getFact(`fact_${"9".repeat(24)}`);
    assert.equal(result, null);
  }));

test("factCount and slotCount report the indexed sizes", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir);
    assert.equal(store.factCount(), 1);
    assert.equal(store.slotCount(), 1);
  }));

// ---------------------------------------------------------------------------
// Explicit-pins-only construction (no allowUnpinned escape hatch)
// ---------------------------------------------------------------------------

test("construction rejects when any required pin field is missing", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot());
    const fullOptions = {
      factArtifactPath: pinnedFacts.path,
      factArtifactSha256: pinnedFacts.sha256,
      factRecordCount: pinnedFacts.record_count,
      factCoverageSnapshotPath: pinnedCoverage.path,
      factCoverageSnapshotSha256: pinnedCoverage.sha256,
    };
    for (const key of Object.keys(fullOptions)) {
      const { [key]: _omit, ...withoutField } = fullOptions;
      await assert.rejects(() => createSeedFactArtifactStore(withoutField), new RegExp(key));
    }
    await assert.rejects(() => createSeedFactArtifactStore());
    await assert.rejects(() => createSeedFactArtifactStore({}));
  }));

test("construction rejects a factRecordCount that is negative or non-integer", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot());
    const base = {
      factArtifactPath: pinnedFacts.path,
      factArtifactSha256: pinnedFacts.sha256,
      factCoverageSnapshotPath: pinnedCoverage.path,
      factCoverageSnapshotSha256: pinnedCoverage.sha256,
    };
    await assert.rejects(() => createSeedFactArtifactStore({ ...base, factRecordCount: -1 }), /factRecordCount/);
    await assert.rejects(() => createSeedFactArtifactStore({ ...base, factRecordCount: 1.5 }), /factRecordCount/);
  }));

test("construction rejects a sha256 that is not a 64-character lowercase hex string", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot());
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: pinnedFacts.path,
          factArtifactSha256: "not-hex",
          factRecordCount: pinnedFacts.record_count,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /factArtifactSha256/
    );
  }));

// ---------------------------------------------------------------------------
// Fact artifact integrity
// ---------------------------------------------------------------------------

test("rejects a fact artifact whose real SHA-256 disagrees with the pinned value", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot());
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: pinnedFacts.path,
          factArtifactSha256: "f".repeat(64),
          factRecordCount: pinnedFacts.record_count,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /sha256 mismatch/
    );
  }));

test("rejects a fact artifact whose actual valid record count disagrees with the pinned record_count", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot());
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: pinnedFacts.path,
          factArtifactSha256: pinnedFacts.sha256,
          factRecordCount: 2,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /record count mismatch/
    );
  }));

test("rejects malformed JSON on any fact artifact line", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const body = `${JSON.stringify(factRecord())}\nnot valid json\n`;
    writeFileSync(factPath, body);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot());
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: factPath,
          factArtifactSha256: sha256Hex(Buffer.from(body, "utf8")),
          factRecordCount: 1,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /malformed JSON/
    );
  }));

test("rejects an empty fact artifact (zero valid records)", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    writeFileSync(factPath, "");
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot({ slots: [] }));
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: factPath,
          factArtifactSha256: sha256Hex(Buffer.from("", "utf8")),
          factRecordCount: 0,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /zero valid records/
    );
  }));

test("rejects a fact record that does not satisfy the official Fact schema (missing a required field)", () =>
  withTmpDir(async (dir) => {
    const { fact_id, ...withoutFactId } = factRecord();
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [withoutFactId]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot({ slots: [] }));
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: pinnedFacts.path,
          factArtifactSha256: pinnedFacts.sha256,
          factRecordCount: pinnedFacts.record_count,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /does not satisfy .*Fact/
    );
  }));

test("rejects a duplicate fact_id within the fact artifact", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord(), factRecord()]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot({ slots: [] }));
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: pinnedFacts.path,
          factArtifactSha256: pinnedFacts.sha256,
          factRecordCount: pinnedFacts.record_count,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /duplicate fact_id/
    );
  }));

test("rejects a fact artifact containing invalid UTF-8 bytes even when its SHA-256 correctly matches those exact bytes", () =>
  withTmpDir(async (dir) => {
    const validLine = Buffer.from(`${JSON.stringify(factRecord())}\n`, "utf8");
    const invalidByte = Buffer.from([0xff]);
    const body = Buffer.concat([validLine, invalidByte, Buffer.from("\n")]);
    const factPath = join(dir, "facts.jsonl");
    writeFileSync(factPath, body);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot({ slots: [] }));
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: factPath,
          factArtifactSha256: sha256Hex(body),
          factRecordCount: 1,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /is not valid UTF-8/
    );
  }));

// ---------------------------------------------------------------------------
// Fact Coverage Snapshot integrity
// ---------------------------------------------------------------------------

test("rejects a coverage snapshot whose real SHA-256 disagrees with the pinned value", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot());
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: pinnedFacts.path,
          factArtifactSha256: pinnedFacts.sha256,
          factRecordCount: pinnedFacts.record_count,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: "f".repeat(64),
        }),
      /sha256 mismatch/
    );
  }));

test("rejects a coverage snapshot that does not satisfy the official fact-coverage-snapshot.schema.json (missing a required field)", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const { created_at, ...withoutCreatedAt } = coverageSnapshot();
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, withoutCreatedAt);
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: pinnedFacts.path,
          factArtifactSha256: pinnedFacts.sha256,
          factRecordCount: pinnedFacts.record_count,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /does not satisfy .*fact-coverage-snapshot\.schema\.json/
    );
  }));

test("rejects a coverage snapshot whose slot has an invalid coverage_state enum value", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(
      coveragePath,
      coverageSnapshot({ slots: [coverageSlot({ coverage_state: "NOT_A_REAL_STATE" })] })
    );
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: pinnedFacts.path,
          factArtifactSha256: pinnedFacts.sha256,
          factRecordCount: pinnedFacts.record_count,
          factCoverageSnapshotPath: pinnedCoverage.path,
          factCoverageSnapshotSha256: pinnedCoverage.sha256,
        }),
      /does not satisfy .*fact-coverage-snapshot\.schema\.json/
    );
  }));

test("rejects a coverage snapshot containing invalid UTF-8 bytes even when its SHA-256 correctly matches those exact bytes", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const validJson = Buffer.from(JSON.stringify(coverageSnapshot()), "utf8");
    const body = Buffer.concat([validJson, Buffer.from([0xff])]);
    const coveragePath = join(dir, "coverage.json");
    writeFileSync(coveragePath, body);
    await assert.rejects(
      () =>
        createSeedFactArtifactStore({
          factArtifactPath: pinnedFacts.path,
          factArtifactSha256: pinnedFacts.sha256,
          factRecordCount: pinnedFacts.record_count,
          factCoverageSnapshotPath: coveragePath,
          factCoverageSnapshotSha256: sha256Hex(body),
        }),
      /is not valid UTF-8/
    );
  }));

// ---------------------------------------------------------------------------
// Coverage <-> Fact cross-validation
// ---------------------------------------------------------------------------

test("rejects a coverage snapshot with a duplicate slot_key", () =>
  withTmpDir(async (dir) => {
    await assert.rejects(
      () =>
        buildStore(dir, {
          slots: [coverageSlot({ slot_key: "dup", fact_ids: [FACT_ID_A] }), coverageSlot({ slot_key: "dup", fact_ids: [FACT_ID_A] })],
        }),
      /duplicate slot_key/
    );
  }));

test("rejects a coverage slot referencing a fact_id that does not exist in the fact artifact", () =>
  withTmpDir(async (dir) => {
    await assert.rejects(
      () => buildStore(dir, { slots: [coverageSlot({ fact_ids: [`fact_${"9".repeat(24)}`] })] }),
      /references unknown fact_id/
    );
  }));

test("rejects a coverage slot referencing a CANDIDATE (not yet VERIFIED) fact_id", () =>
  withTmpDir(async (dir) => {
    const candidate = factRecord({ verification_status: "CANDIDATE" });
    await assert.rejects(
      () => buildStore(dir, { facts: [candidate], slots: [coverageSlot({ fact_ids: [FACT_ID_A] })] }),
      /not VERIFIED/
    );
  }));

test("allows the SAME fact_id to appear in two different slots -- no invented cross-slot exclusivity policy", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir, {
      slots: [
        coverageSlot({ slot_key: "slot-1", fact_ids: [FACT_ID_A] }),
        coverageSlot({ slot_key: "slot-2", fact_ids: [FACT_ID_A] }),
      ],
    });
    assert.equal(store.slotCount(), 2);
    assert.ok(await store.getFact(FACT_ID_A));
  }));

test("KNOWN LIMITATION: an evidence_id in a coverage slot is NOT cross-checked against any real Evidence artifact -- a nonexistent evidence_id does not fail construction", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir, {
      slots: [coverageSlot({ fact_ids: [FACT_ID_A], evidence_ids: [`evidence_${"9".repeat(24)}`] })],
    });
    assert.equal(store.slotCount(), 1);
  }));

// ---------------------------------------------------------------------------
// Authorization boundary: getFact() only ever serves a fact_id that is
// actually referenced by the CURRENT Coverage Snapshot's slot.fact_ids --
// "present in the Fact artifact" is not enough on its own. The artifact
// may legitimately hold more Facts than the current Coverage Snapshot
// covers; this store must never conflate "exists" with "authorized".
// ---------------------------------------------------------------------------

test("a VERIFIED fact present in the artifact but NOT referenced by any coverage slot is null from getFact() -- 'in the artifact' is not 'authorized'", () =>
  withTmpDir(async (dir) => {
    const covered = factRecord({ fact_id: FACT_ID_A, verification_status: "VERIFIED" });
    const uncovered = factRecord({ fact_id: FACT_ID_B, verification_status: "VERIFIED" });
    const store = await buildStore(dir, {
      facts: [covered, uncovered],
      slots: [coverageSlot({ fact_ids: [FACT_ID_A] })], // FACT_ID_B is never referenced
    });
    assert.equal(await store.getFact(FACT_ID_B), null);
    // Positive control -- the covered fact still resolves normally.
    assert.ok(await store.getFact(FACT_ID_A));
  }));

test("through the real createFactStore: a VERIFIED fact not covered by any slot resolves as FACT_NOT_FOUND, not as a usable record", () =>
  withTmpDir(async (dir) => {
    const covered = factRecord({ fact_id: FACT_ID_A, verification_status: "VERIFIED" });
    const uncovered = factRecord({ fact_id: FACT_ID_B, verification_status: "VERIFIED" });
    const store = await buildStore(dir, {
      facts: [covered, uncovered],
      slots: [coverageSlot({ fact_ids: [FACT_ID_A] })],
    });
    const context = { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID };
    const result = await createFactStore(store, context).resolve(FACT_ID_B);
    assert.deepEqual(result, { ok: false, code: "FACT_NOT_FOUND" });
  }));

test("a CANDIDATE fact not referenced by any coverage slot is null from getFact() (it could never have been referenced -- a slot may only reference VERIFIED facts)", () =>
  withTmpDir(async (dir) => {
    const verified = factRecord({ fact_id: FACT_ID_A, verification_status: "VERIFIED" });
    const candidate = factRecord({ fact_id: FACT_ID_B, verification_status: "CANDIDATE" });
    const store = await buildStore(dir, {
      facts: [verified, candidate],
      slots: [coverageSlot({ fact_ids: [FACT_ID_A] })],
    });
    assert.equal(await store.getFact(FACT_ID_B), null);
  }));

test("factCount() is the full Fact artifact record count; authorizedFactCount() is only the distinct fact_ids the current Coverage Snapshot actually authorizes", () =>
  withTmpDir(async (dir) => {
    const covered = factRecord({ fact_id: FACT_ID_A, verification_status: "VERIFIED" });
    const uncoveredVerified = factRecord({ fact_id: FACT_ID_B, verification_status: "VERIFIED" });
    const uncoveredCandidate = factRecord({ fact_id: `fact_${"d".repeat(24)}`, verification_status: "CANDIDATE" });
    const store = await buildStore(dir, {
      facts: [covered, uncoveredVerified, uncoveredCandidate],
      slots: [coverageSlot({ fact_ids: [FACT_ID_A] })],
    });
    assert.equal(store.factCount(), 3);
    assert.equal(store.authorizedFactCount(), 1);
  }));

test("authorizedFactCount() counts DISTINCT fact_ids even when the same fact_id is authorized by more than one slot", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir, {
      slots: [
        coverageSlot({ slot_key: "slot-1", fact_ids: [FACT_ID_A] }),
        coverageSlot({ slot_key: "slot-2", fact_ids: [FACT_ID_A] }),
      ],
    });
    assert.equal(store.authorizedFactCount(), 1);
    assert.equal(store.slotCount(), 2);
  }));

// ---------------------------------------------------------------------------
// Coverage slot <-> Fact direct-dimension consistency (corp_code,
// metric_code, and non-null scope must agree; period_key has no official
// Fact-field mapping and is deliberately NOT checked).
// ---------------------------------------------------------------------------

test("rejects a coverage slot whose corp_code disagrees with the fact_id it references", () =>
  withTmpDir(async (dir) => {
    await assert.rejects(
      () => buildStore(dir, { slots: [coverageSlot({ corp_code: "99999999", fact_ids: [FACT_ID_A] })] }),
      /corp_code "99999999" does not match fact_id .* corp_code "00126380"/
    );
  }));

test("rejects a coverage slot whose metric_code disagrees with the fact_id it references", () =>
  withTmpDir(async (dir) => {
    await assert.rejects(
      () => buildStore(dir, { slots: [coverageSlot({ metric_code: "NET_INCOME", fact_ids: [FACT_ID_A] })] }),
      /metric_code "NET_INCOME" does not match fact_id .* metric_code "REVENUE"/
    );
  }));

test("rejects a coverage slot whose non-null scope disagrees with the fact_id it references", () =>
  withTmpDir(async (dir) => {
    await assert.rejects(
      () => buildStore(dir, { slots: [coverageSlot({ scope: "SEPARATE", fact_ids: [FACT_ID_A] })] }),
      /scope "SEPARATE" does not match fact_id .* scope "CONSOLIDATED"/
    );
  }));

test("a slot.scope of null is an explicit wildcard -- it is allowed to reference a fact_id with any scope value", () =>
  withTmpDir(async (dir) => {
    const fact = factRecord({ fact_id: FACT_ID_A, scope: "SUBSIDIARY" });
    const store = await buildStore(dir, {
      facts: [fact],
      slots: [coverageSlot({ scope: null, fact_ids: [FACT_ID_A] })],
    });
    assert.ok(await store.getFact(FACT_ID_A));
  }));

test("a slot with scope OMITTED ENTIRELY (not even null -- scope is not a required slot field) is also a wildcard, not a mismatch", () =>
  withTmpDir(async (dir) => {
    const fact = factRecord({ fact_id: FACT_ID_A, scope: "SUBSIDIARY" });
    const { scope, ...slotWithoutScope } = coverageSlot({ fact_ids: [FACT_ID_A] });
    assert.equal("scope" in slotWithoutScope, false);
    const store = await buildStore(dir, { facts: [fact], slots: [slotWithoutScope] });
    assert.ok(await store.getFact(FACT_ID_A));
  }));

test("a slot.scope that is an explicit string matching the fact's scope passes", () =>
  withTmpDir(async (dir) => {
    const fact = factRecord({ fact_id: FACT_ID_A, scope: "CONSOLIDATED" });
    const store = await buildStore(dir, {
      facts: [fact],
      slots: [coverageSlot({ scope: "CONSOLIDATED", fact_ids: [FACT_ID_A] })],
    });
    assert.ok(await store.getFact(FACT_ID_A));
  }));

test("the same fact_id in two different slots is still allowed as long as BOTH slots' dimensions agree with the fact", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir, {
      slots: [
        coverageSlot({ slot_key: "slot-1", corp_code: "00126380", metric_code: "REVENUE", scope: "CONSOLIDATED", fact_ids: [FACT_ID_A] }),
        coverageSlot({ slot_key: "slot-2", corp_code: "00126380", metric_code: "REVENUE", scope: null, fact_ids: [FACT_ID_A] }),
      ],
    });
    assert.equal(store.slotCount(), 2);
    assert.ok(await store.getFact(FACT_ID_A));
  }));

// ---------------------------------------------------------------------------
// semantic_bundle_schema_version binding: the Coverage Snapshot must claim
// the SAME version this store actually validated every Fact record
// against (read from the official schema itself, never a hardcoded copy).
// ---------------------------------------------------------------------------

test("accepts a coverage snapshot whose semantic_bundle_schema_version matches the official schema's version (0.2.0)", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir, { coverageOverrides: { semantic_bundle_schema_version: "0.2.0" } });
    assert.ok(await store.getFact(FACT_ID_A));
  }));

test("rejects a coverage snapshot whose semantic_bundle_schema_version disagrees with the official schema's version, even though that string is otherwise schema-valid", () =>
  withTmpDir(async (dir) => {
    await assert.rejects(
      () => buildStore(dir, { coverageOverrides: { semantic_bundle_schema_version: "0.1.0" } }),
      /semantic_bundle_schema_version "0\.1\.0" does not match/
    );
  }));

// ---------------------------------------------------------------------------
// Trust boundary: immutability, abort handling
// ---------------------------------------------------------------------------

test("returned envelopes and records are deep-frozen -- mutation fails and does not persist", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir);
    const envelope = await store.getFact(FACT_ID_A);
    assert.throws(() => {
      envelope.corpus_snapshot_id = "hacked";
    }, TypeError);
    assert.throws(() => {
      envelope.record.verification_status = "TAMPERED";
    }, TypeError);
    assert.throws(() => {
      envelope.record.attributes.injected = true;
    }, TypeError);

    const again = await store.getFact(FACT_ID_A);
    assert.equal(again.record.verification_status, "VERIFIED");
    assert.deepEqual(again.record.attributes, {});
  }));

test("an already-aborted signal rejects with RequestAbortedError and never returns the fact, even though it IS indexed", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => store.getFact(FACT_ID_A, { signal: controller.signal }), /request aborted/);
  }));

// ---------------------------------------------------------------------------
// Integration with the REAL, unmodified domain/runtime/fact-store.mjs --
// this module is never edited here; these tests only prove the adapter
// satisfies the boundary that module already enforces.
// ---------------------------------------------------------------------------

// The exact CalculationInput shape createFactProvenanceValidator.check()
// compares against a resolved Fact record's projection (see fact-store.mjs's
// projectFactToCalculationInput) -- built from a fixture record so a test
// can assert "every field matches, only verification_status differs".
function matchingCalculationInput(record) {
  return {
    fact_id: record.fact_id,
    value: record.normalized_value,
    unit: record.unit,
    scope: record.scope,
    value_status: record.value_status,
    known_at: record.known_at,
    valid_from: record.valid_from,
    valid_to: record.valid_to,
  };
}

test("through the real (unmodified) createFactStore: a VERIFIED fact resolves ok", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir);
    const context = { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID };
    const factStore = createFactStore(store, context);
    const result = await factStore.resolve(FACT_ID_A);
    assert.equal(result.ok, true);
    assert.equal(result.record.fact_id, FACT_ID_A);
  }));

test("through the real createFactStore: a CANDIDATE fact (never authorized by any slot, per requirement 1) resolves as FACT_NOT_FOUND through THIS adapter -- it can never reach a Runtime caller at all", () =>
  withTmpDir(async (dir) => {
    const verified = factRecord({ fact_id: FACT_ID_A });
    const candidate = factRecord({ fact_id: FACT_ID_B, verification_status: "CANDIDATE" });
    const store = await buildStore(dir, { facts: [verified, candidate], slots: [coverageSlot({ fact_ids: [FACT_ID_A] })] });
    const context = { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID };
    const result = await createFactStore(store, context).resolve(FACT_ID_B);
    assert.deepEqual(result, { ok: false, code: "FACT_NOT_FOUND" });
  }));

test("integration with the REAL, unmodified fact-store.mjs: createFactProvenanceValidator's UNVERIFIED_DATA_FORBIDDEN check is a genuine, independent second layer of defense -- proven with a minimal adapter, since THIS Seed adapter's own authorization gate (requirement 1) now makes a CANDIDATE fact unreachable through it by construction", () =>
  withTmpDir(async (dir) => {
    const candidate = factRecord({ verification_status: "CANDIDATE" });
    const context = { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID };
    // Deliberately NOT the Seed adapter under test elsewhere in this file
    // -- a minimal hand-built adapter that (unlike the real one) DOES
    // hand back a CANDIDATE record, so this test can still prove
    // fact-store.mjs's own verification_status gate works on its own
    // terms, independent of any one adapter's additional restrictions.
    const fakeAdapter = {
      async getFact() {
        return { corpus_snapshot_id: context.corpus_snapshot_id, fact_coverage_snapshot_id: context.fact_coverage_snapshot_id, record: candidate };
      },
    };
    const factStore = createFactStore(fakeAdapter, context);
    const validator = createFactProvenanceValidator(factStore);
    const result = await validator.check([matchingCalculationInput(candidate)]);
    assert.deepEqual(result, { ok: false, code: "UNVERIFIED_DATA_FORBIDDEN" });
  }));

test("through the real createFactStore: a corpus_snapshot_id mismatch is caught even though the fact itself resolves", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir);
    const wrongContext = { corpus_snapshot_id: "corpus_some_other_snapshot", fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID };
    const factStore = createFactStore(store, wrongContext);
    const result = await factStore.resolve(FACT_ID_A);
    assert.deepEqual(result, { ok: false, code: "FACT_SNAPSHOT_MISMATCH" });
  }));

test("through the real createFactStore: a fact_coverage_snapshot_id mismatch is caught even though the fact resolves and the corpus snapshot matches", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir);
    const wrongContext = {
      corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
      fact_coverage_snapshot_id: `fact_coverage_snapshot_${"9".repeat(24)}`,
    };
    const factStore = createFactStore(store, wrongContext);
    const result = await factStore.resolve(FACT_ID_A);
    assert.deepEqual(result, { ok: false, code: "FACT_COVERAGE_SNAPSHOT_MISMATCH" });
  }));

test("through the real createFactStore: an unknown fact_id resolves as FACT_NOT_FOUND", () =>
  withTmpDir(async (dir) => {
    const store = await buildStore(dir);
    const context = { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID };
    const factStore = createFactStore(store, context);
    const result = await factStore.resolve(`fact_${"9".repeat(24)}`);
    assert.deepEqual(result, { ok: false, code: "FACT_NOT_FOUND" });
  }));

test("adapter construction failure is distinguished from FACT_NOT_FOUND: falling back to no adapter after a construction rejection yields FACT_STORE_UNAVAILABLE, never FACT_NOT_FOUND", () =>
  withTmpDir(async (dir) => {
    const factPath = join(dir, "facts.jsonl");
    const pinnedFacts = writePinnedFactArtifact(factPath, [factRecord()]);
    const coveragePath = join(dir, "coverage.json");
    const pinnedCoverage = writePinnedCoverageSnapshot(coveragePath, coverageSnapshot());

    let adapter = null;
    try {
      adapter = await createSeedFactArtifactStore({
        factArtifactPath: pinnedFacts.path,
        factArtifactSha256: "f".repeat(64), // deliberately wrong -- construction rejects
        factRecordCount: pinnedFacts.record_count,
        factCoverageSnapshotPath: pinnedCoverage.path,
        factCoverageSnapshotSha256: pinnedCoverage.sha256,
      });
    } catch {
      adapter = null; // exactly what a real caller does on a construction failure
    }
    assert.equal(adapter, null);

    const context = { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID };
    const unavailableResult = await createFactStore(adapter, context).resolve(FACT_ID_A);
    assert.deepEqual(unavailableResult, { ok: false, code: "FACT_STORE_UNAVAILABLE" });

    // Positive control: a genuinely missing fact_id against a WORKING
    // store is a different code entirely.
    const workingStore = await createSeedFactArtifactStore({
      factArtifactPath: pinnedFacts.path,
      factArtifactSha256: pinnedFacts.sha256,
      factRecordCount: pinnedFacts.record_count,
      factCoverageSnapshotPath: pinnedCoverage.path,
      factCoverageSnapshotSha256: pinnedCoverage.sha256,
    });
    const notFoundResult = await createFactStore(workingStore, context).resolve(`fact_${"9".repeat(24)}`);
    assert.deepEqual(notFoundResult, { ok: false, code: "FACT_NOT_FOUND" });
  }));
