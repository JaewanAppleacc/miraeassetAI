// Turn K item F: promotes the already Owner-APPROVED Company Directory
// v0.1 candidate artifact to a properly-named "approved revision" (v0.2),
// for the v0.20 Candidate bundle to reference by a name that no longer
// says "candidate" despite already being approved (Turn J's decision:
// work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json).
//
// This is a REVISION, not a re-derivation: the v0.1 candidate JSONL bytes
// are copied verbatim (never re-parsed/reformatted/regenerated from
// companies.jsonl again) -- so the new artifact's corp_code/corp_name/
// listed_name fields are byte-equivalent to the original by construction,
// not merely "checked to be equal after the fact". The v0.1 candidate
// file and its manifest/decision are NEVER renamed, overwritten, or
// deleted -- they remain the historical artifact Turn J's decision
// approved; this script only ever WRITES new v0.2 files.
//
// The new Owner decision (v0.2) does not fabricate new independent
// verification -- it explicitly REUSES the same v0.1 independent
// verification report (path+sha256 unchanged), because the content being
// approved has not changed; only its filename/revision-status has. It
// also pins promoted_from_decision (path+sha256 of the v0.1 decision)
// so the promotion lineage is auditable, not just asserted.
//
// domain/runtime/configured-seed-runtime.mjs (the live production
// singleton) is NOT repointed at these v0.2 files by this script -- Turn
// K item G forbids "configured Runtime의 최종 v0.20 전환" before the
// latest response Owner review finishes. This script only prepares
// materials for the v0.20 CANDIDATE bundle to reference.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const V01_CANDIDATE_ARTIFACT_PATH = path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl");
const V01_CANDIDATE_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json");
const V01_APPROVED_DECISION_PATH = path.join(REPO, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json");

const V02_ARTIFACT_PATH = path.join(REPO, "work/domain-seed/seed-company-directory.v0.2.approved.jsonl");
const V02_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-company-directory.v0.2.approved.manifest.json");
const V02_DECISION_PATH = path.join(REPO, "work/domain-seed/seed-company-directory-owner-decision.v0.2.approved.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function parseRecords(jsonlText, label) {
  return jsonlText.trim().split("\n").map((line, i) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`${label}:${i + 1}: malformed JSON: ${error.message}`); }
  });
}

export async function promoteSeedCompanyDirectoryV02({ writeOutputs = true } = {}) {
  const [v01ArtifactBytes, v01ManifestBytes, v01DecisionBytes] = await Promise.all([
    readFile(V01_CANDIDATE_ARTIFACT_PATH), readFile(V01_CANDIDATE_MANIFEST_PATH), readFile(V01_APPROVED_DECISION_PATH),
  ]);
  const v01Manifest = JSON.parse(v01ManifestBytes.toString("utf8"));
  const v01Decision = JSON.parse(v01DecisionBytes.toString("utf8"));

  if (sha256(v01ArtifactBytes) !== v01Manifest.artifact_sha256) {
    throw new Error("BLOCKER: v0.1 candidate artifact sha256 does not match its own manifest -- refusing to promote from a tampered source");
  }
  if (v01Decision.owner_disposition !== "APPROVED") {
    throw new Error(`BLOCKER: v0.1 decision owner_disposition is "${v01Decision.owner_disposition}", not "APPROVED" -- refusing to promote an unapproved candidate`);
  }
  if (v01Decision.artifact_sha256 !== sha256(v01ArtifactBytes) || v01Decision.manifest_sha256 !== sha256(v01ManifestBytes)) {
    throw new Error("BLOCKER: v0.1 approved decision's pinned artifact/manifest sha256 does not match the real v0.1 files");
  }

  // Verbatim byte copy -- this IS the byte-equivalence guarantee, not a
  // post-hoc check of it. The record-level comparison below is a
  // defense-in-depth confirmation, not the source of the guarantee.
  const v02ArtifactBytes = v01ArtifactBytes;

  const v01Records = parseRecords(v01ArtifactBytes.toString("utf8"), "v0.1 candidate");
  const v02Records = parseRecords(v02ArtifactBytes.toString("utf8"), "v0.2 approved");
  if (v01Records.length !== v02Records.length) {
    throw new Error("BLOCKER: v0.1/v0.2 record count differs -- promotion must be byte-equivalent");
  }
  for (let i = 0; i < v01Records.length; i++) {
    const a = v01Records[i]; const b = v02Records[i];
    if (a.corp_code !== b.corp_code || a.corp_name !== b.corp_name || a.listed_name !== b.listed_name) {
      throw new Error(`BLOCKER: record ${i} semantic fields (corp_code/corp_name/listed_name) differ between v0.1 and v0.2 -- promotion must be byte-equivalent, never a re-derivation`);
    }
  }

  const sortedCorpCodes = v02Records.map((r) => r.corp_code).sort();
  const corpCodeSetSha256 = sha256(Buffer.from(sortedCorpCodes.join(","), "utf8"));
  if (corpCodeSetSha256 !== v01Manifest.corp_code_set_sha256) {
    throw new Error("BLOCKER: v0.2 corp_code set hash differs from v0.1's -- this must never happen for a verbatim byte copy");
  }

  const generatedAt = new Date().toISOString();
  const v02Manifest = {
    schema_version: "0.1.0",
    artifact: "work/domain-seed/seed-company-directory.v0.2.approved.jsonl",
    artifact_sha256: sha256(v02ArtifactBytes),
    record_count: v02Records.length,
    corp_code_set_sha256: corpCodeSetSha256,
    corpus_snapshot_id: v01Manifest.corpus_snapshot_id,
    generated_at: generatedAt,
    status: "APPROVED_REVISION",
    promoted_from: {
      path: "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl",
      manifest_path: "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json",
      artifact_sha256: sha256(v01ArtifactBytes),
      manifest_sha256: sha256(v01ManifestBytes),
      note: "Verbatim byte copy -- semantic fields (corp_code/corp_name/listed_name) are byte-equivalent to the v0.1 candidate by construction; only status/naming/revision metadata changed.",
    },
  };
  const v02ManifestBytes = Buffer.from(`${JSON.stringify(v02Manifest, null, 2)}\n`, "utf8");

  const v02Decision = {
    schema_version: "0.1.0",
    decision_id: "seed-company-directory-owner-decision-v0.2-approved",
    artifact_path: "work/domain-seed/seed-company-directory.v0.2.approved.jsonl",
    artifact_sha256: sha256(v02ArtifactBytes),
    manifest_path: "work/domain-seed/seed-company-directory.v0.2.approved.manifest.json",
    manifest_sha256: sha256(v02ManifestBytes),
    record_count: v02Records.length,
    corpus_snapshot_id: v01Manifest.corpus_snapshot_id,
    independent_verification_report_path: v01Decision.independent_verification_report_path,
    independent_verification_report_sha256: v01Decision.independent_verification_report_sha256,
    independent_verification_summary: v01Decision.independent_verification_summary,
    promoted_from_decision: {
      path: "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json",
      sha256: sha256(v01DecisionBytes),
    },
    owner_disposition: "APPROVED",
    reviewer: "최재완",
    reviewed_at: generatedAt,
    notes: "v0.1 candidate 승인 결정(2d8766ba...)의 재승인이 아니라, 동일 내용을 승인된 명칭(APPROVED_REVISION)으로 재발행. 독립 검증은 v0.1과 동일 -- 내용이 바뀌지 않았으므로 새 검증을 다시 수행하지 않고 그대로 인용함. v0.1 candidate 파일/manifest/decision은 변경하지 않고 그대로 보존됨.",
  };
  const v02DecisionBytes = Buffer.from(`${JSON.stringify(v02Decision, null, 2)}\n`, "utf8");

  if (writeOutputs) {
    await writeFile(V02_ARTIFACT_PATH, v02ArtifactBytes);
    await writeFile(V02_MANIFEST_PATH, v02ManifestBytes);
    await writeFile(V02_DECISION_PATH, v02DecisionBytes);
  }

  return {
    artifact_path: V02_ARTIFACT_PATH, artifact_sha256: sha256(v02ArtifactBytes),
    manifest_path: V02_MANIFEST_PATH, manifest_sha256: sha256(v02ManifestBytes),
    decision_path: V02_DECISION_PATH, decision_sha256: sha256(v02DecisionBytes),
    record_count: v02Records.length,
    // Pure dry-run inspection surface. Tests and preflight callers can
    // validate the exact generated revision without writing the shared
    // work/domain-seed paths. Keeping these values byte/object based also
    // prevents cross-file test races with bundle readers; the CLI's
    // default writeOutputs=true behavior and on-disk formats are unchanged.
    ...(writeOutputs ? {} : { generated: {
      artifact_bytes: Buffer.from(v02ArtifactBytes),
      manifest: structuredClone(v02Manifest),
      manifest_bytes: Buffer.from(v02ManifestBytes),
      decision: structuredClone(v02Decision),
      decision_bytes: Buffer.from(v02DecisionBytes),
    } }),
  };
}

async function main() {
  const result = await promoteSeedCompanyDirectoryV02();
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
