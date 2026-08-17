// Tests for the CANDIDATE-only CompanyResolver adapter
// (domain/adapters/seed-company-resolver.mjs) and its wiring into the
// Response Composer as a request-scoped label map (never a raw directory
// path). Mirrors the construction-time-validate/Map-lookup-only pattern
// already covered for seed-question-plan-store.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createSeedCompanyResolver, createGatedSeedCompanyResolver } from "../domain/adapters/seed-company-resolver.mjs";
import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { composeResponse } from "../domain/flows/synthesis/response-composer.mjs";
import { validateSynthesis } from "../domain/flows/synthesis/final-synthesis-validator.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// `fn` receives (paths, dir) -- `dir` is passed to createSeedCompanyResolver
// as `root` in every test below, so `manifest.artifact` can stay the bare
// relative filename ("dir.jsonl") without needing to know the randomly-
// generated temp directory in advance. Uses a repo-relative work/ tmp dir,
// NOT os.tmpdir() -- on macOS, os.tmpdir() itself resolves through a
// symlink (/var/folders/... -> /private/var/folders/...), which would
// trip the adapter's own symlink defense on every "happy path" fixture
// here regardless of what this test is actually checking.
async function withTempFiles(files, fn) {
  const dir = await mkdtemp(path.join(ROOT, "work", "seed-company-resolver-test-"));
  try {
    const paths = {};
    for (const [name, content] of Object.entries(files)) {
      paths[name] = path.join(dir, name);
      await writeFile(paths[name], content);
    }
    return await fn(paths, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function directoryFixture(records) {
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const bytes = Buffer.from(text, "utf8");
  return {
    bytes,
    manifest: (overrides = {}) => ({
      artifact: "dir.jsonl",
      artifact_sha256: sha256(bytes),
      record_count: records.length,
      corpus_snapshot_id: "corpus_test",
      corp_code_set_sha256: sha256(Buffer.from([...records.map((r) => r.corp_code)].sort().join(","), "utf8")),
      ...overrides,
    }),
  };
}

const VALID_RECORDS = [
  { corp_code: "00000001", corp_name: "가상전자", listed_name: "가상전자" },
  { corp_code: "00000002", corp_name: "가상중공업", listed_name: "가상중공업" },
];

test("CompanyResolver: resolves a valid corp_code to its corp_name/listed_name", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(manifest()) }, async (paths, dir) => {
    const resolver = await createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir });
    const record = resolver.resolve("00000001");
    assert.equal(record.corp_name, "가상전자");
    assert.equal(record.listed_name, "가상전자");
    assert.equal(resolver.count(), 2);
  });
});

test("CompanyResolver: unknown corp_code resolves to null (never throws, never invents a label)", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(manifest()) }, async (paths, dir) => {
    const resolver = await createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir });
    assert.equal(resolver.resolve("00099999"), null);
    assert.equal(resolver.resolve(undefined), null);
    assert.equal(resolver.resolve(123), null);
  });
});

test("CompanyResolver: rejects a duplicate corp_code at construction", async () => {
  const dupText = [VALID_RECORDS[0], VALID_RECORDS[0]].map((r) => JSON.stringify(r)).join("\n") + "\n";
  const dupBytes = Buffer.from(dupText, "utf8");
  const manifest = { artifact: "dir.jsonl", artifact_sha256: sha256(dupBytes), record_count: 2, corpus_snapshot_id: "corpus_test" };
  await withTempFiles({ "dir.jsonl": dupBytes, "manifest.json": JSON.stringify(manifest) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /duplicate corp_code/);
  });
});

test("CompanyResolver: rejects an invalid (non-8-digit) corp_code", async () => {
  const { bytes, manifest } = directoryFixture([{ corp_code: "123", corp_name: "x", listed_name: "x" }]);
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(manifest()) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /invalid corp_code/);
  });
});

test("CompanyResolver: rejects a blank/whitespace-untrimmed corp_name", async () => {
  const { bytes, manifest } = directoryFixture([{ corp_code: "00000001", corp_name: "  ", listed_name: "x" }]);
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(manifest()) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /invalid corp_name/);
  });
});

test("CompanyResolver: rejects an artifact/manifest SHA-256 mismatch", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const badManifest = { ...manifest(), artifact_sha256: "0".repeat(64) };
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(badManifest) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /hash mismatch/);
  });
});

test("CompanyResolver: rejects a record_count mismatch", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const badManifest = { ...manifest(), record_count: 999 };
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(badManifest) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /record count mismatch/);
  });
});

test("CompanyResolver: rejects a corp_code-set hash mismatch", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const badManifest = { ...manifest(), corp_code_set_sha256: "0".repeat(64) };
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(badManifest) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /corp_code set hash mismatch/);
  });
});

test("CompanyResolver: rejects a manifest whose declared artifact path points at a different file than artifactPath", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const badManifest = { ...manifest(), artifact: "some-other-file.jsonl" };
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(badManifest) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /artifact path does not match/);
  });
});

test("CompanyResolver: rejects a manifest missing its own artifact path declaration", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const { artifact, ...noArtifact } = manifest();
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(noArtifact) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /missing its own artifact path/);
  });
});

test("CompanyResolver: rejects fatal UTF-8 decode errors", async () => {
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
  const manifest = { artifact: "dir.jsonl", artifact_sha256: sha256(invalidUtf8), record_count: 0, corpus_snapshot_id: "corpus_test" };
  await withTempFiles({ "dir.jsonl": invalidUtf8, "manifest.json": JSON.stringify(manifest) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /invalid UTF-8/);
  });
});

test("CompanyResolver: an unexpected extra field on a record is rejected", async () => {
  const { bytes, manifest } = directoryFixture([{ corp_code: "00000001", corp_name: "x", listed_name: "x", market_cap: "999" }]);
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(manifest()) }, async (paths, dir) => {
    await assert.rejects(createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir }), /unexpected company record field/);
  });
});

test("CompanyResolver: returned records are deep-frozen; caller mutation attempts throw/no-op", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(manifest()) }, async (paths, dir) => {
    const resolver = await createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir });
    const record = resolver.resolve("00000001");
    assert.ok(Object.isFrozen(record));
    assert.throws(() => { record.corp_name = "tampered"; });
    assert.equal(resolver.resolve("00000001").corp_name, "가상전자");
  });
});

test("CompanyResolver: an already-aborted signal throws RequestAbortedError before any lookup", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(manifest()) }, async (paths, dir) => {
    const resolver = await createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir });
    const controller = new AbortController();
    controller.abort();
    assert.throws(() => resolver.resolve("00000001", { signal: controller.signal }), /RequestAbortedError|request aborted/);
  });
});

test("CompanyResolver: resolve() with no signal or a non-aborted signal behaves exactly as before (no regression)", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(manifest()) }, async (paths, dir) => {
    const resolver = await createSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], root: dir });
    assert.equal(resolver.resolve("00000001").corp_name, "가상전자");
    const controller = new AbortController();
    assert.equal(resolver.resolve("00000001", { signal: controller.signal }).corp_name, "가상전자");
  });
});

// -- Composer integration --------------------------------------------------

function fact(overrides) {
  return {
    fact_id: "fact_default", corp_code: "00000000", metric_code: "revenue",
    normalized_value: 100, unit: "KRW", scope: "COMPANY", value_status: "DISCLOSED",
    scale: 1, period_start: "2024-01-01", period_end: "2024-12-31", as_of_date: "2025-01-01",
    raw_label: "매출", attributes: {}, ...overrides,
  };
}

test("Composer: two synthetic companies' resolved names appear exactly in the comparison answer", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "00000001", normalized_value: 1000 }),
    fact({ fact_id: "f2", corp_code: "00000002", normalized_value: 2000 }),
  ];
  const calculationValue = { revenue_diff_krw: 1000, revenue_winner: "가상중공업" };
  const companyLabels = { "00000001": { corp_code: "00000001", corp_name: "가상전자", listed_name: "가상전자" }, "00000002": { corp_code: "00000002", corp_name: "가상중공업", listed_name: "가상중공업" } };
  const signals = planSynthesisSignals({ question: "두 회사 매출 비교해줘", facts, events: [], evidence: [], calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue, signals, narrativeFields, companyLabels });
  assert.ok(composed.answer.includes("가상전자"));
  assert.ok(composed.answer.includes("가상중공업"));
  assert.equal(composed.answer.includes("00000001"), false);
  assert.deepEqual(composed.resolved_company_labels.map((r) => r.corp_code).sort(), ["00000001", "00000002"]);
  assert.deepEqual(composed.unresolved_company_codes, []);
});

test("Composer: an unresolved corp_code is reported in metadata, never silently filled from question text, and never shown as a bare number in the answer either", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "00000001", normalized_value: 1000 }),
    fact({ fact_id: "f2", corp_code: "00099999", normalized_value: 2000 }),
  ];
  const calculationValue = { revenue_diff_krw: 1000 };
  const companyLabels = { "00000001": { corp_code: "00000001", corp_name: "가상전자", listed_name: "가상전자" } };
  const signals = planSynthesisSignals({ question: "가상전자와 미상회사 매출 비교해줘", facts, events: [], evidence: [], calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue, signals, narrativeFields, companyLabels });
  assert.deepEqual(composed.unresolved_company_codes, ["00099999"]);
  // Never invented from the question text, and never exposed as a bare
  // numeric ID either -- unresolved entities get the generic placeholder,
  // and ENTITY_LABEL_RESOLUTION is withheld so a caller can force PARTIAL.
  assert.equal(composed.answer.includes("00099999"), false);
  assert.ok(composed.answer.includes("미해결 기업"));
  assert.equal(composed.applied_capabilities.includes("ENTITY_LABEL_RESOLUTION"), false);
});

test("an official-mode fixture with an unresolved company code must not silently PASS -- the metadata is sufficient for a caller to force a non-PASS decision", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "00000001", normalized_value: 1000 }),
    fact({ fact_id: "f2", corp_code: "00099999", normalized_value: 2000 }),
  ];
  const evidence = [{ evidence_id: "ev1", document_id: "doc1", file_id: "file1", source_locator: "doc1#node=1", quoted_text: "1,000 / 2,000", quote_sha256: "0".repeat(64) }];
  const calculationValue = { revenue_diff_krw: 1000, revenue_winner: "가상전자" };
  const companyLabels = { "00000001": { corp_code: "00000001", corp_name: "가상전자", listed_name: "가상전자" } };
  const signals = planSynthesisSignals({ question: "가상전자와 미상회사 매출 비교해줘", facts, events: [], evidence, calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence, calculationValue, signals, narrativeFields, companyLabels });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events: [],
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  // An OFFICIAL-mode caller policy (not built into the shared validator
  // this turn -- Part B explicitly stays Candidate/fixture-only) would
  // gate on this metadata; demonstrate the metadata makes that decision
  // possible instead of silently reporting PASS as if resolution fully
  // succeeded.
  const officialModeWouldPass = validation.status === "PASS" && composed.unresolved_company_codes.length === 0;
  assert.equal(officialModeWouldPass, false);
  assert.ok(composed.unresolved_company_codes.length > 0);
});

test("a Resolver-absent fixture (companyLabels not provided) is treated the SAME as an unresolved lookup -- never a bare corp_code fallback, always PARTIAL-eligible", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "00000001", normalized_value: 1000 }),
    fact({ fact_id: "f2", corp_code: "00000002", normalized_value: 2000 }),
  ];
  const calculationValue = { revenue_diff_krw: 1000 };
  const signals = planSynthesisSignals({ question: "두 회사 매출 비교해줘", facts, events: [], evidence: [], calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue, signals, narrativeFields });
  assert.deepEqual(composed.resolved_company_labels, []);
  // No CompanyResolver available is functionally identical to "tried and
  // failed" from the reader's point of view -- both mean no VERIFIED name
  // exists, so both are tracked as unresolved rather than silently
  // treated as "nothing to report".
  assert.deepEqual([...composed.unresolved_company_codes].sort(), ["00000001", "00000002"]);
  assert.equal(composed.answer.includes("00000001"), false);
  assert.equal(composed.answer.includes("00000002"), false);
  assert.ok(composed.answer.includes("미해결 기업"));
});

// -- Release-authorization gate: createGatedSeedCompanyResolver ----------

function decisionFixture(paths, dir, { artifactSha256, manifestSha256, recordCount, corpusSnapshotId, disposition = "APPROVED", reviewer = "테스트검수자" }) {
  return {
    artifact_path: path.relative(dir, paths["dir.jsonl"]),
    artifact_sha256: artifactSha256,
    manifest_path: path.relative(dir, paths["manifest.json"]),
    manifest_sha256: manifestSha256,
    record_count: recordCount,
    corpus_snapshot_id: corpusSnapshotId,
    owner_disposition: disposition,
    reviewer,
    reviewed_at: "2026-08-15T00:00:00.000Z",
  };
}

test("gate: refuses a PENDING decision (the real, un-self-approved default state)", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const m = manifest();
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(m) }, async (paths, dir) => {
    const decision = decisionFixture(paths, dir, { artifactSha256: m.artifact_sha256, manifestSha256: sha256(Buffer.from(JSON.stringify(m))), recordCount: 2, corpusSnapshotId: "corpus_test", disposition: "PENDING", reviewer: null });
    await writeFile(path.join(dir, "decision.json"), JSON.stringify(decision));
    await assert.rejects(
      createGatedSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], ownerDecisionPath: path.join(dir, "decision.json"), root: dir }),
      /owner_disposition is "PENDING", not "APPROVED"/,
    );
  });
});

test("gate: refuses when the caller-pinned expectedOwnerDecisionSha256 does not match the real decision file (tamper/swap protection)", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const m = manifest();
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(m) }, async (paths, dir) => {
    const decision = decisionFixture(paths, dir, { artifactSha256: m.artifact_sha256, manifestSha256: sha256(Buffer.from(JSON.stringify(m))), recordCount: 2, corpusSnapshotId: "corpus_test" });
    await writeFile(path.join(dir, "decision.json"), JSON.stringify(decision));
    await assert.rejects(
      createGatedSeedCompanyResolver({
        artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"],
        ownerDecisionPath: path.join(dir, "decision.json"), expectedOwnerDecisionSha256: "0".repeat(64), root: dir,
      }),
      /does not match the caller-pinned expectedOwnerDecisionSha256/,
    );
  });
});

test("gate: refuses when the decision's pinned record_count does not match the real artifact", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const m = manifest();
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(m) }, async (paths, dir) => {
    const decision = decisionFixture(paths, dir, { artifactSha256: m.artifact_sha256, manifestSha256: sha256(Buffer.from(JSON.stringify(m))), recordCount: 999, corpusSnapshotId: "corpus_test" });
    await writeFile(path.join(dir, "decision.json"), JSON.stringify(decision));
    await assert.rejects(
      createGatedSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], ownerDecisionPath: path.join(dir, "decision.json"), root: dir }),
      /record_count/,
    );
  });
});

test("gate: refuses when the decision's pinned corpus_snapshot_id does not match the real manifest", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const m = manifest();
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(m) }, async (paths, dir) => {
    const decision = decisionFixture(paths, dir, { artifactSha256: m.artifact_sha256, manifestSha256: sha256(Buffer.from(JSON.stringify(m))), recordCount: 2, corpusSnapshotId: "corpus_WRONG" });
    await writeFile(path.join(dir, "decision.json"), JSON.stringify(decision));
    await assert.rejects(
      createGatedSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], ownerDecisionPath: path.join(dir, "decision.json"), root: dir }),
      /corpus_snapshot_id/,
    );
  });
});

test("gate: an APPROVED decision whose pins all genuinely match the real artifact/manifest produces a working resolver with real names", async () => {
  const { bytes, manifest } = directoryFixture(VALID_RECORDS);
  const m = manifest();
  await withTempFiles({ "dir.jsonl": bytes, "manifest.json": JSON.stringify(m) }, async (paths, dir) => {
    const decision = decisionFixture(paths, dir, { artifactSha256: m.artifact_sha256, manifestSha256: sha256(Buffer.from(JSON.stringify(m))), recordCount: 2, corpusSnapshotId: "corpus_test" });
    await writeFile(path.join(dir, "decision.json"), JSON.stringify(decision));
    const gated = await createGatedSeedCompanyResolver({ artifactPath: paths["dir.jsonl"], manifestPath: paths["manifest.json"], ownerDecisionPath: path.join(dir, "decision.json"), root: dir });
    assert.equal(gated.resolve("00000001").corp_name, "가상전자");
    assert.equal(gated.gate.reviewer, "테스트검수자");
  });
});

test("gate: the REAL Company Directory candidate v0.1's real PENDING decision template is correctly refused (production must not be wired until an Owner actually approves)", async () => {
  const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
  await assert.rejects(
    createGatedSeedCompanyResolver({
      artifactPath: path.join(ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
      manifestPath: path.join(ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
      ownerDecisionPath: path.join(ROOT, "work/domain-seed/seed-company-directory-owner-decision-template.v0.1.json"),
      root: ROOT,
    }),
    /owner_disposition is "PENDING", not "APPROVED"/,
  );
});

test("gate: the REAL Company Directory candidate v0.1's REAL APPROVED decision (Turn J, reviewer 최재완) succeeds and resolves real names -- the exact caller-pinned decision SHA-256 from this turn's report", async () => {
  const gated = await createGatedSeedCompanyResolver({
    artifactPath: path.join(ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
    manifestPath: path.join(ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
    ownerDecisionPath: path.join(ROOT, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"),
    expectedOwnerDecisionSha256: "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20",
    root: ROOT,
  });
  assert.equal(gated.resolve("01390344").corp_name, "HD현대중공업");
  assert.equal(gated.resolve("00164645").corp_name, "HMM");
  assert.equal(gated.resolve("00126478").corp_name, "삼성중공업");
  assert.equal(gated.resolve("00164788").corp_name, "현대모비스");
  assert.equal(gated.gate.reviewer, "최재완");
  assert.equal(gated.count(), 70);
});
