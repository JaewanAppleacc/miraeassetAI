import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createSeedEvidenceArtifactStore } from "../domain/adapters/seed-evidence-artifact-store.mjs";
import { createCitationValidator, createDocumentStore, createEvidenceStore } from "../domain/runtime/citation-validator.mjs";

// ---------------------------------------------------------------------------
// Always-run: small self-contained fixtures, no dependency on local work/
// data.
// ---------------------------------------------------------------------------

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "evidence-store-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function evidenceRecord(overrides = {}) {
  const quotedText = overrides.quoted_text ?? "54,495";
  return {
    evidence_id: "evidence_aaaaaaaaaaaaaaaaaaaaaaaa",
    document_id: "exchange_00000000000001",
    file_id: "file_aaaaaaaaaaaaaaaaaaaaaaaa",
    chunk_id: null,
    source_locator: "exchange_00000000000001/x.xml#node=0",
    quoted_text: quotedText,
    quote_sha256: sha256Hex(quotedText),
    extraction_method: "DETERMINISTIC",
    confidence: 1,
    verification_status: "VERIFIED",
    metadata: {},
    ...overrides,
  };
}

// Writes a valid, self-consistent evidence.jsonl + manifest.json pair for
// the given records, computing artifact_sha256/record_count/evidence_ids
// from the records themselves -- so tests that want to break ONE specific
// cross-check can start from a known-good pair and corrupt only that field.
function writeArtifact(dir, records, manifestOverrides = {}) {
  const evidencePath = join(dir, "evidence.jsonl");
  const manifestPath = join(dir, "evidence.manifest.json");
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(evidencePath, body);
  const manifest = {
    schema_version: "0.1.0",
    artifact: "evidence.jsonl",
    artifact_sha256: sha256Hex(body),
    corpus_snapshot_id: "corpus_04750795e1a2d5c3",
    record_count: records.length,
    evidence_ids: records.map((r) => r.evidence_id),
    ...manifestOverrides,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { evidencePath, manifestPath, body, manifest };
}

test("getEvidence resolves a record with the correct { corpus_snapshot_id, record } envelope", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [record]);
    const store = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath });
    const envelope = await store.getEvidence(record.evidence_id);
    assert.equal(envelope.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
    assert.equal(envelope.record.evidence_id, record.evidence_id);
    assert.equal(envelope.record.quoted_text, "54,495");
    assert.equal(store.recordCount(), 1);
  }));

test("getEvidence returns null for an unknown evidence_id (never throws for 'not found')", () =>
  withTmpDir(async (dir) => {
    const { evidencePath, manifestPath } = writeArtifact(dir, [evidenceRecord()]);
    const store = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath });
    const result = await store.getEvidence("evidence_does_not_exist_000000");
    assert.equal(result, null);
  }));

test("rejects when the artifact's real SHA-256 disagrees with the manifest", () =>
  withTmpDir(async (dir) => {
    const { evidencePath, manifestPath } = writeArtifact(dir, [evidenceRecord()]);
    writeFileSync(evidencePath, `${readFileSync(evidencePath, "utf8")}\n`); // tamper: extra blank line changes the hash
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /SHA-256 mismatch/);
  }));

test("rejects when the manifest's record_count disagrees with the actual count", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const { evidencePath, manifestPath, body } = writeArtifact(dir, [record]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.record_count = 2;
    // Recompute artifact_sha256 against the SAME body so only record_count is wrong.
    manifest.artifact_sha256 = sha256Hex(body);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /record count mismatch/);
  }));

test("rejects when the manifest's evidence_ids set is missing an id that IS in the artifact", () =>
  withTmpDir(async (dir) => {
    const a = evidenceRecord({ evidence_id: "evidence_aaaaaaaaaaaaaaaaaaaaaaaa" });
    const b = evidenceRecord({ evidence_id: "evidence_bbbbbbbbbbbbbbbbbbbbbbbb" });
    const evidencePath = join(dir, "evidence.jsonl");
    const manifestPath = join(dir, "evidence.manifest.json");
    const body = [a, b].map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(evidencePath, body);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        artifact_sha256: sha256Hex(body),
        record_count: 2,
        evidence_ids: [a.evidence_id], // b is missing from the declared set
        corpus_snapshot_id: "corpus_04750795e1a2d5c3",
      })
    );
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /evidence_id set does not match/);
  }));

test("rejects when the manifest declares an evidence_id that is NOT actually in the artifact", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const { evidencePath, manifestPath, body } = writeArtifact(dir, [record]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.evidence_ids.push("evidence_cccccccccccccccccccccccc"); // never actually written
    manifest.record_count = 1; // still 1 real record
    manifest.artifact_sha256 = sha256Hex(body);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /evidence_id set does not match/);
  }));

test("rejects a duplicate evidence_id within the artifact itself", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const evidencePath = join(dir, "evidence.jsonl");
    const manifestPath = join(dir, "evidence.manifest.json");
    const body = [record, record].map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(evidencePath, body);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        artifact_sha256: sha256Hex(body),
        record_count: 2,
        evidence_ids: [record.evidence_id, record.evidence_id],
        corpus_snapshot_id: "corpus_04750795e1a2d5c3",
      })
    );
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /duplicate evidence_id/);
  }));

test("rejects a duplicate evidence_id within the manifest's own declared list", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const { evidencePath, manifestPath, body } = writeArtifact(dir, [record]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.evidence_ids = [record.evidence_id, record.evidence_id];
    manifest.artifact_sha256 = sha256Hex(body);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /duplicate evidence_id/);
  }));

test("rejects malformed JSON on any artifact line", () =>
  withTmpDir(async (dir) => {
    const evidencePath = join(dir, "evidence.jsonl");
    const manifestPath = join(dir, "evidence.manifest.json");
    const body = `${JSON.stringify(evidenceRecord())}\nnot valid json\n`;
    writeFileSync(evidencePath, body);
    writeFileSync(
      manifestPath,
      JSON.stringify({ artifact_sha256: sha256Hex(body), record_count: 1, evidence_ids: ["evidence_aaaaaaaaaaaaaaaaaaaaaaaa"], corpus_snapshot_id: "corpus_04750795e1a2d5c3" })
    );
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /malformed JSON/);
  }));

test("rejects malformed manifest JSON", () =>
  withTmpDir(async (dir) => {
    const { evidencePath, manifestPath } = writeArtifact(dir, [evidenceRecord()]);
    writeFileSync(manifestPath, "{ this is not valid json");
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /malformed manifest JSON/);
  }));

test("rejects a manifest missing a required cross-check field", () =>
  withTmpDir(async (dir) => {
    const { evidencePath, manifestPath, body } = writeArtifact(dir, [evidenceRecord()]);
    writeFileSync(manifestPath, JSON.stringify({ artifact_sha256: sha256Hex(body), record_count: 1, corpus_snapshot_id: "corpus_04750795e1a2d5c3" })); // evidence_ids missing
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /missing required field "evidence_ids"/);
  }));

test("rejects a manifest whose corpus_snapshot_id is an empty string", () =>
  withTmpDir(async (dir) => {
    const { evidencePath, manifestPath } = writeArtifact(dir, [evidenceRecord()], { corpus_snapshot_id: "" });
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /corpus_snapshot_id must be a non-empty string/);
  }));

test("rejects a manifest whose corpus_snapshot_id is not a string", () =>
  withTmpDir(async (dir) => {
    const { evidencePath, manifestPath } = writeArtifact(dir, [evidenceRecord()], { corpus_snapshot_id: 12345 });
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /corpus_snapshot_id must be a non-empty string/);
  }));

test("rejects a manifest whose corpus_snapshot_id is null", () =>
  withTmpDir(async (dir) => {
    const { evidencePath, manifestPath } = writeArtifact(dir, [evidenceRecord()], { corpus_snapshot_id: null });
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /corpus_snapshot_id must be a non-empty string/);
  }));

test("rejects a manifest whose corpus_snapshot_id is whitespace-only", () =>
  withTmpDir(async (dir) => {
    const { evidencePath, manifestPath } = writeArtifact(dir, [evidenceRecord()], { corpus_snapshot_id: "   " });
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /corpus_snapshot_id must be a non-empty string/);
  }));

test("rejects a manifest whose corpus_snapshot_id contains embedded whitespace or path-like characters (common corpus snapshot id format)", () =>
  withTmpDir(async (dir) => {
    const { evidencePath, manifestPath } = writeArtifact(dir, [evidenceRecord()], { corpus_snapshot_id: "corpus 04750795e1a2d5c3" });
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /corpus_snapshot_id must be a non-empty string/);
  }));

// ---------------------------------------------------------------------------
// SHA-256 is computed over the evidence artifact's raw Buffer bytes, never
// a UTF-8-decoded string -- byte-level tampering that would be silently
// normalized away by lossy UTF-8 decoding must still be caught.
// ---------------------------------------------------------------------------

test("detects byte-level tampering that is invisible after (lossy) UTF-8 decoding", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [record]);
    // Flip a single byte inside a UTF-8 continuation-byte position to
    // invalid UTF-8. If the hash were computed AFTER a lossy UTF-8 decode
    // (readFile(path, "utf8") then hash the resulting string), this
    // corruption would already have been replaced with U+FFFD before
    // hashing and could slip through as a hash "match" against a manifest
    // that was (incorrectly) computed the same lossy way. Computed over
    // raw bytes, it must always be caught as a straightforward mismatch
    // against the manifest's originally-correct sha256.
    const original = readFileSync(evidencePath);
    const corrupted = Buffer.from(original);
    corrupted[0] = 0xff; // 0xFF is never valid as a UTF-8 lead byte
    writeFileSync(evidencePath, corrupted);
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /SHA-256 mismatch/);
  }));

test("rejects an artifact containing invalid UTF-8 byte sequences even when its SHA-256 correctly matches those exact (invalid) bytes", () =>
  withTmpDir(async (dir) => {
    const validLine = Buffer.from(`${JSON.stringify(evidenceRecord())}\n`, "utf8");
    const invalidByte = Buffer.from([0xff]); // never valid as a UTF-8 lead byte
    const body = Buffer.concat([validLine, invalidByte, Buffer.from("\n")]);
    const evidencePath = join(dir, "evidence.jsonl");
    const manifestPath = join(dir, "evidence.manifest.json");
    writeFileSync(evidencePath, body);
    // The manifest's sha256 is computed over these EXACT (invalid-UTF-8)
    // bytes, so the raw-byte hash check passes -- proving the UTF-8
    // rejection below is a genuinely separate, later fail-closed gate, not
    // something the hash check happens to catch as a side effect.
    writeFileSync(
      manifestPath,
      JSON.stringify({
        artifact_sha256: sha256Hex(body),
        record_count: 1,
        evidence_ids: ["evidence_aaaaaaaaaaaaaaaaaaaaaaaa"],
        corpus_snapshot_id: "corpus_04750795e1a2d5c3",
      })
    );
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /is not valid UTF-8/);
  }));

// ---------------------------------------------------------------------------
// Official schema validation (semantic-bundle.schema.json's Evidence shape)
// -- a record with matching evidence_id/document_id but missing another
// required field must be rejected at construction time, not merely "look
// close enough".
// ---------------------------------------------------------------------------

test("rejects a record missing document_id", () =>
  withTmpDir(async (dir) => {
    const { document_id, ...withoutDocId } = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [withoutDocId]);
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /does not satisfy semantic-bundle\.schema\.json/);
  }));

test("rejects a record missing source_locator", () =>
  withTmpDir(async (dir) => {
    const { source_locator, ...withoutLocator } = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [withoutLocator]);
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /does not satisfy semantic-bundle\.schema\.json/);
  }));

test("rejects a record missing quoted_text", () =>
  withTmpDir(async (dir) => {
    const { quoted_text, ...withoutQuotedText } = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [withoutQuotedText]);
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /does not satisfy semantic-bundle\.schema\.json/);
  }));

test("rejects a record missing verification_status", () =>
  withTmpDir(async (dir) => {
    const { verification_status, ...withoutStatus } = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [withoutStatus]);
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /does not satisfy semantic-bundle\.schema\.json/);
  }));

test("rejects a record whose document_id does not match the required <group>_<14 digits> pattern", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord({ document_id: "not-a-valid-document-id" });
    const { evidencePath, manifestPath } = writeArtifact(dir, [record]);
    await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath, manifestPath }), /does not satisfy semantic-bundle\.schema\.json/);
  }));

test("rejects construction when the evidence or manifest file does not exist", () =>
  withTmpDir(async (dir) => {
    const { manifestPath } = writeArtifact(dir, [evidenceRecord()]);
    await assert.rejects(
      () => createSeedEvidenceArtifactStore({ evidencePath: join(dir, "does-not-exist.jsonl"), manifestPath }),
      /could not read evidence artifact/
    );
    const { evidencePath } = writeArtifact(dir, [evidenceRecord()]);
    await assert.rejects(
      () => createSeedEvidenceArtifactStore({ evidencePath, manifestPath: join(dir, "no-manifest.json") }),
      /could not read manifest/
    );
  }));

test("construction requires both evidencePath and manifestPath", async () => {
  await assert.rejects(() => createSeedEvidenceArtifactStore({}));
  await assert.rejects(() => createSeedEvidenceArtifactStore({ evidencePath: "/a" }));
  await assert.rejects(() => createSeedEvidenceArtifactStore({ manifestPath: "/b" }));
});

test("returns a CANDIDATE record's verification_status honestly -- never upgrades it", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord({ verification_status: "CANDIDATE" });
    const { evidencePath, manifestPath } = writeArtifact(dir, [record]);
    const store = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath });
    const envelope = await store.getEvidence(record.evidence_id);
    assert.equal(envelope.record.verification_status, "CANDIDATE");
  }));

test("integration with the REAL, unmodified citation-validator.mjs: a CANDIDATE record is rejected as UNVERIFIED_DATA_FORBIDDEN even when every field matches", () =>
  withTmpDir(async (dir) => {
    const quotedText = "1,463,679,344,160";
    const record = evidenceRecord({
      evidence_id: `evidence_${"1".repeat(24)}`,
      quoted_text: quotedText,
      quote_sha256: sha256Hex(quotedText),
      verification_status: "CANDIDATE", // not yet human-reviewed
    });
    const { evidencePath, manifestPath } = writeArtifact(dir, [record]);
    const store = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath });
    const context = { corpus_snapshot_id: "corpus_04750795e1a2d5c3" };
    const evidenceStore = createEvidenceStore(store, context);
    // A minimal DocumentStore is not even needed to prove this -- the
    // human-review check runs FIRST in createCitationValidator and short-
    // circuits before the document is ever resolved.
    const documentStore = createDocumentStore(null, context);
    const validator = createCitationValidator(documentStore, evidenceStore);

    const result = await validator.check({
      evidence_id: record.evidence_id,
      document_id: record.document_id,
      file_id: record.file_id,
      source_locator: record.source_locator,
      quoted_text: record.quoted_text,
      quote_sha256: record.quote_sha256,
    });
    assert.deepEqual(result, { ok: false, code: "UNVERIFIED_DATA_FORBIDDEN" });
  }));

test("integration with the REAL citation-validator.mjs: a VERIFIED record with matching fields is a positive control (proves the CANDIDATE test isn't vacuous)", () =>
  withTmpDir(async (dir) => {
    const quotedText = "fixture positive control text";
    const record = evidenceRecord({
      evidence_id: `evidence_${"2".repeat(24)}`,
      quoted_text: quotedText,
      quote_sha256: sha256Hex(quotedText),
      verification_status: "VERIFIED",
      source_locator: "exchange_00000000000001/x.xml#node=0",
    });
    const { evidencePath, manifestPath } = writeArtifact(dir, [record]);
    const store = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath });
    const context = { corpus_snapshot_id: "corpus_04750795e1a2d5c3" };
    const evidenceStore = createEvidenceStore(store, context);
    const documentAdapter = {
      getDocument: async () => ({
        document_id: record.document_id,
        corpus_snapshot_id: context.corpus_snapshot_id,
        blocks: [{ file_id: record.file_id, source_locator: record.source_locator, text: quotedText }],
      }),
    };
    const documentStore = createDocumentStore(documentAdapter, context);
    const validator = createCitationValidator(documentStore, evidenceStore);

    const result = await validator.check({
      evidence_id: record.evidence_id,
      document_id: record.document_id,
      file_id: record.file_id,
      source_locator: record.source_locator,
      quoted_text: record.quoted_text,
      quote_sha256: record.quote_sha256,
    });
    assert.deepEqual(result, { ok: true });
  }));

test("through the real createEvidenceStore: EVIDENCE_SNAPSHOT_MISMATCH is caught even though the record resolves", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [record], { corpus_snapshot_id: "corpus_04750795e1a2d5c3" });
    const store = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath });
    const wrongContext = { corpus_snapshot_id: "corpus_some_other_snapshot" };
    const evidenceStore = createEvidenceStore(store, wrongContext);
    const result = await evidenceStore.resolve(record.evidence_id);
    assert.deepEqual(result, { ok: false, code: "EVIDENCE_SNAPSHOT_MISMATCH" });
  }));

test("returned envelopes and records are deep-frozen -- mutation fails and does not persist", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [record]);
    const store = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath });
    const envelope = await store.getEvidence(record.evidence_id);
    assert.throws(() => {
      envelope.corpus_snapshot_id = "hacked";
    }, TypeError);
    assert.throws(() => {
      envelope.record.verification_status = "VERIFIED_BY_TAMPERING";
    }, TypeError);
    assert.throws(() => {
      envelope.record.metadata.injected = true;
    }, TypeError);

    const again = await store.getEvidence(record.evidence_id);
    assert.equal(again.record.verification_status, "VERIFIED");
    assert.deepEqual(again.record.metadata, {});
  }));

test("an already-aborted signal rejects with RequestAbortedError and never returns the record, even though it IS indexed", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [record]);
    const store = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => store.getEvidence(record.evidence_id, { signal: controller.signal }), /request aborted/);
  }));

test("through the real createEvidenceStore: an already-aborted signal throws before the adapter is ever called", () =>
  withTmpDir(async (dir) => {
    const record = evidenceRecord();
    const { evidencePath, manifestPath } = writeArtifact(dir, [record]);
    const store = await createSeedEvidenceArtifactStore({ evidencePath, manifestPath });
    const context = { corpus_snapshot_id: "corpus_04750795e1a2d5c3" };
    const controller = new AbortController();
    controller.abort();
    const evidenceStore = createEvidenceStore(store, context, controller.signal);
    await assert.rejects(() => evidenceStore.resolve(record.evidence_id));
  }));

// ---------------------------------------------------------------------------
// Optional, read-only integration against the real Seed Evidence artifact.
// Skips cleanly when that local-only data isn't present. Never writes to
// these files, and never promotes/re-verifies anything -- purely confirms
// the store can index the real artifact and honestly report what is
// already stored.
// ---------------------------------------------------------------------------

const REAL_EVIDENCE_PATH = resolve("work/domain-seed/seed-evidence-verified.v0.2.jsonl");
const REAL_MANIFEST_PATH = resolve("work/domain-seed/seed-evidence-verified.v0.2.manifest.json");
const HAS_REAL_EVIDENCE = existsSync(REAL_EVIDENCE_PATH) && existsSync(REAL_MANIFEST_PATH);

test(
  "real data: indexes the real Seed Evidence v0.2 artifact against its own manifest and resolves a known evidence_id",
  { skip: !HAS_REAL_EVIDENCE },
  async () => {
    const store = await createSeedEvidenceArtifactStore({ evidencePath: REAL_EVIDENCE_PATH, manifestPath: REAL_MANIFEST_PATH });
    assert.equal(store.recordCount(), 121);

    const envelope = await store.getEvidence("evidence_05dabd799b44945b5d8d0f61");
    assert.ok(envelope);
    assert.equal(envelope.record.document_id, "exchange_20250428800409");
    assert.equal(envelope.record.verification_status, "VERIFIED");
    assert.equal(envelope.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
  }
);
