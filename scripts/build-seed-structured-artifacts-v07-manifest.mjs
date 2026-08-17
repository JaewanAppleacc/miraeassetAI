// Turn M7 Section 3: a NEW structured-artifacts manifest revision (v0.7)
// pointing at the Turn M7 promotion outputs -- never overwrites v0.6.
// VERIFIED_EVIDENCE/EVENT/RELATION/CHAIN are carried forward UNCHANGED
// (no new revision needed for any of them this Turn); only VERIFIED_FACT,
// FACT_COVERAGE_SNAPSHOT, and OWNER_DECISION move to their new Turn M7
// revisions. release_status is explicitly NOT "APPROVED" -- this Turn
// creates no release manifest/decision and authorizes no production
// transition.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V06_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json");
const OUT_PATH = path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.7.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`STRUCTURED_MANIFEST_V07_BLOCKED: ${msg}`); }

async function pinned(relPath) {
  const bytes = await readFile(path.join(REPO, relPath));
  return { path: relPath, sha256: sha256(bytes), bytes };
}
function countLines(bytes) { return bytes.toString("utf8").trim().split("\n").filter(Boolean).length; }

async function main() {
  const v06Bytes = await readFile(V06_MANIFEST_PATH);
  const v06 = JSON.parse(v06Bytes.toString("utf8"));

  const evidence = await pinned("work/domain-seed/seed-evidence-verified.v0.9.jsonl");
  const evidenceManifest = await pinned("work/domain-seed/seed-evidence-verified.v0.9.manifest.json");
  const events = await pinned("work/domain-seed/seed-events-verified.v0.1.jsonl");
  const relations = await pinned("work/domain-seed/seed-relation-gold.v0.2.jsonl");
  const chains = await pinned("work/domain-seed/seed-chain-manifest.v0.2.jsonl");
  const facts = await pinned("work/domain-seed/seed-facts-verified.v0.8.jsonl");
  const coverage = await pinned("work/domain-seed/seed-fact-coverage-verified.v0.7.json");
  const decision = await pinned("work/domain-seed/seed-structured-owner-decision.v0.10.jsonl");

  if (countLines(facts.bytes) !== 87) fail(`expected 87 VERIFIED facts (73 baseline + 14 promoted), found ${countLines(facts.bytes)}`);
  if (countLines(decision.bytes) !== 102) fail(`expected 102 merged decision rows, found ${countLines(decision.bytes)}`);
  const coverageJson = JSON.parse(coverage.bytes.toString("utf8"));
  if (coverageJson.slots.length !== 102) fail(`expected 102 coverage slots, found ${coverageJson.slots.length}`);

  const manifest = {
    schema_version: "0.1.0",
    artifact_set_id: "seed-structured-artifacts-v0.7",
    status: "VERIFIED_SEED_SUBSET",
    generated_at: new Date().toISOString(),
    corpus_snapshot_id: v06.corpus_snapshot_id,
    fact_coverage_snapshot_id: coverageJson.fact_coverage_snapshot_id,
    semantic_bundle_schema_version: v06.semantic_bundle_schema_version,
    artifacts: [
      { role: "VERIFIED_EVIDENCE", path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes.length, record_count: countLines(evidence.bytes) },
      { role: "VERIFIED_EVIDENCE_MANIFEST", path: evidenceManifest.path, sha256: evidenceManifest.sha256, bytes: evidenceManifest.bytes.length, record_count: null },
      { role: "VERIFIED_EVENT", path: events.path, sha256: events.sha256, bytes: events.bytes.length, record_count: countLines(events.bytes) },
      { role: "VERIFIED_RELATION", path: relations.path, sha256: relations.sha256, bytes: relations.bytes.length, record_count: countLines(relations.bytes) },
      { role: "CHAIN_MANIFEST", path: chains.path, sha256: chains.sha256, bytes: chains.bytes.length, record_count: countLines(chains.bytes) },
      { role: "VERIFIED_FACT", path: facts.path, sha256: facts.sha256, bytes: facts.bytes.length, record_count: countLines(facts.bytes) },
      { role: "FACT_COVERAGE_SNAPSHOT", path: coverage.path, sha256: coverage.sha256, bytes: coverage.bytes.length, record_count: coverageJson.slots.length },
      { role: "OWNER_DECISION", path: decision.path, sha256: decision.sha256, bytes: decision.bytes.length, record_count: countLines(decision.bytes) },
    ],
    excluded_question_ids: [],
    release_status: "CANDIDATE_NOT_YET_RELEASE_AUTHORIZED",
    supersedes: "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
    supersession_note: "Turn M7: Owner-approved 14개 Candidate Fact를 VERIFIED로 승격 (Fact 73->87, Coverage 88->102 slots, Owner decision 88->102 records). Evidence/Event/Relation/Chain은 이번 Turn에 변경되지 않아 v0.6과 동일 revision을 그대로 재사용함. 이 manifest는 release manifest/decision이 아니며 v0.20 release authorization을 부여하지 않음 -- release_status가 명시적으로 미승인 상태.",
    v06_left_unmodified: true,
    v06_sha256: sha256(v06Bytes),
  };

  await writeFile(OUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ artifact_set_id: manifest.artifact_set_id, fact_record_count: countLines(facts.bytes), coverage_slot_count: coverageJson.slots.length, decision_record_count: countLines(decision.bytes), release_status: manifest.release_status }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
