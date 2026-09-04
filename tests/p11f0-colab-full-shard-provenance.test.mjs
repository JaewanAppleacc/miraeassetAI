// Turn AC-COLAB-FULL-SHARDS-V1, remaining item 3: scoped unit tests for
// scripts/p11f0-colab-full-shard-provenance.mjs's pure assembly function
// buildExecutionProvenanceManifest, against small SYNTHETIC inputs. Never
// touches git, the real shard files, or DB/Gold/DEV_CHECK/HOLDOUT content.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionProvenanceManifest, writeJsonAtomic, sha256HexOfFile,
  PROVENANCE_MANIFEST_SCHEMA, TURN_ID,
} from "../scripts/p11f0-colab-full-shard-provenance.mjs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const OK_VERIFICATION = {
  ok: true, errors: [], total_rows_verified: 20, membership_sha256: "m-sha", ordering_sha256: "o-sha",
  overlap_count: 0, missing_global_index_count: 0,
  shards: [{ shard_id: "kure-full-input-shard-000", ok: true }, { shard_id: "kure-full-input-shard-001", ok: true }],
};
const FAILED_VERIFICATION = { ...OK_VERIFICATION, ok: false, errors: ["COMPRESSED_FILE_SHA_MISMATCH: x"] };
const CLEAN_SOURCE_TREE = { git_commit: "a".repeat(40), source_tree_hash: "b".repeat(64), clean: true, release_eligible: true, status_summary: [] };
const DIRTY_SOURCE_TREE = { ...CLEAN_SOURCE_TREE, clean: false, release_eligible: false, status_summary: [" M scripts/foo.mjs", "?? scripts/bar.mjs"] };
const SCRIPT_HASHES = { "scripts/p11f0-colab-full-shard-verify.mjs": "c".repeat(64) };

test("all-ok inputs (no merge manifest yet) produce an ok:true provenance record with the correct schema/turn id", () => {
  const provenance = buildExecutionProvenanceManifest({ localShardVerification: OK_VERIFICATION, sourceTree: CLEAN_SOURCE_TREE, scriptHashes: SCRIPT_HASHES });
  assert.equal(provenance.ok, true);
  assert.deepEqual(provenance.errors, []);
  assert.equal(provenance.schema_version, PROVENANCE_MANIFEST_SCHEMA);
  assert.equal(provenance.turn_id, TURN_ID);
  assert.equal(provenance.logical_merge_manifest, null);
  assert.equal(provenance.local_shard_verification.total_rows_verified, 20);
});

test("a failed local shard verification propagates into provenance.ok=false with a diagnosable error", () => {
  const provenance = buildExecutionProvenanceManifest({ localShardVerification: FAILED_VERIFICATION, sourceTree: CLEAN_SOURCE_TREE, scriptHashes: SCRIPT_HASHES });
  assert.equal(provenance.ok, false);
  assert.ok(provenance.errors.some((e) => /LOCAL_SHARD_VERIFICATION_FAILED/.test(e)));
  assert.equal(provenance.local_shard_verification.ok, false);
  assert.equal(provenance.local_shard_verification.error_count, 1);
});

test("a dirty source tree is recorded (not thrown away) but does not by itself flip provenance.ok to false", () => {
  const provenance = buildExecutionProvenanceManifest({ localShardVerification: OK_VERIFICATION, sourceTree: DIRTY_SOURCE_TREE, scriptHashes: SCRIPT_HASHES });
  assert.equal(provenance.source_tree.clean, false);
  assert.equal(provenance.source_tree.dirty_entry_count, 2);
  assert.equal(provenance.ok, true);
});

test("missing source tree is refused (never silently produces a provenance record with no source binding)", () => {
  const provenance = buildExecutionProvenanceManifest({ localShardVerification: OK_VERIFICATION, sourceTree: null, scriptHashes: SCRIPT_HASHES });
  assert.equal(provenance.ok, false);
  assert.ok(provenance.errors.includes("MISSING_SOURCE_TREE"));
  assert.equal(provenance.source_tree, null);
});

test("a failed logical merge manifest also flips provenance.ok to false", () => {
  const failedMerge = { ok: false, is_complete: false, shards_present: [0], shards_missing: [1, 2, 3], total_rows_covered_so_far: 5, errors: ["SHARD_GZ_SHA_MISMATCH: x"] };
  const provenance = buildExecutionProvenanceManifest({ localShardVerification: OK_VERIFICATION, logicalMergeManifest: failedMerge, sourceTree: CLEAN_SOURCE_TREE, scriptHashes: SCRIPT_HASHES });
  assert.equal(provenance.ok, false);
  assert.ok(provenance.errors.some((e) => /LOGICAL_MERGE_MANIFEST_FAILED/.test(e)));
});

test("an ok, complete logical merge manifest is summarized without inflating provenance with vector bytes", () => {
  const okMerge = { ok: true, is_complete: true, shards_present: [0, 1, 2, 3], shards_missing: [], total_rows_covered_so_far: 20, errors: [] };
  const provenance = buildExecutionProvenanceManifest({ localShardVerification: OK_VERIFICATION, logicalMergeManifest: okMerge, sourceTree: CLEAN_SOURCE_TREE, scriptHashes: SCRIPT_HASHES });
  assert.equal(provenance.ok, true);
  assert.equal(provenance.logical_merge_manifest.is_complete, true);
  assert.deepEqual(Object.keys(provenance.logical_merge_manifest).sort(), ["error_count", "is_complete", "ok", "shards_missing", "shards_present", "total_rows_covered_so_far"].sort());
});

test("negative-confirmation fields are always present and false/zero -- this Turn never uploads, embeds, or writes to a DB", () => {
  const provenance = buildExecutionProvenanceManifest({ localShardVerification: OK_VERIFICATION, sourceTree: CLEAN_SOURCE_TREE, scriptHashes: SCRIPT_HASHES });
  assert.equal(provenance.external_upload_performed, false);
  assert.equal(provenance.real_embedding_calls_performed, 0);
  assert.equal(provenance.database_write_performed, false);
  assert.equal(provenance.restricted_evaluation_splits_accessed, false);
});

test("provenance JSON never contains forbidden markers (Gold/DEV_CHECK/HOLDOUT/question_id/DATABASE_URL/api_key)", () => {
  const provenance = buildExecutionProvenanceManifest({ localShardVerification: OK_VERIFICATION, sourceTree: CLEAN_SOURCE_TREE, scriptHashes: SCRIPT_HASHES });
  const serialized = JSON.stringify(provenance);
  for (const marker of ["DEV_CHECK", "HOLDOUT", "question_id", "expected_answer", "DATABASE_URL", "api_key"]) {
    assert.doesNotMatch(serialized, new RegExp(marker, "i"));
  }
});

let workDir;
test.beforeEach(async () => { workDir = await mkdtemp(path.join(tmpdir(), "p11f0-full-shard-provenance-")); });
test.afterEach(async () => { await rm(workDir, { recursive: true, force: true }); });

test("writeJsonAtomic + sha256HexOfFile round-trip correctly", async () => {
  const filePath = path.join(workDir, "sample.txt");
  await writeFile(filePath, "hello world\n", "utf8");
  const expectedSha = createHash("sha256").update(await readFile(filePath)).digest("hex");
  assert.equal(await sha256HexOfFile(filePath), expectedSha);

  const provenance = buildExecutionProvenanceManifest({ localShardVerification: OK_VERIFICATION, sourceTree: CLEAN_SOURCE_TREE, scriptHashes: SCRIPT_HASHES });
  const outPath = path.join(workDir, "provenance.json");
  await writeJsonAtomic(outPath, provenance);
  const readBack = JSON.parse(await readFile(outPath, "utf8"));
  assert.equal(readBack.schema_version, PROVENANCE_MANIFEST_SCHEMA);
  await assert.rejects(readFile(`${outPath}.partial`));
});
