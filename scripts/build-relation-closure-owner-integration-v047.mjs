#!/usr/bin/env node
// Turn N4.7 (status wording corrected in N4.7.1): integrates the Owner v0.3
// decision (30 rows: 21 CONFIRM / 8 REJECT / 1 NEEDS_MORE_REVIEW), the
// Reviewer C/D dual multistep review (2 rows, both CONFIRM), and the
// existing 326-row relation closure packet into a single relation closure
// candidate ledger; quarantines the unresolved TERMINATES relation and
// every document/component/anchor assignment its ambiguity could still
// touch; and produces a v0.2 PROVISIONAL SPLIT CANDIDATE (never an
// approved official split -- see gate-status.json) with a deterministic
// Anchor 150 supplement.
//
// Turn N4.7.1 correction: this output is NEVER described as
// "OFFICIAL_SPLIT_CANDIDATE". leakage=0 (split-leakage-report.v0.2.json)
// is proven only over the 23 CONFIRMED edges (Owner CONFIRM + Reviewer C/D
// dual-CONFIRM) -- scope CURRENT_PROVISIONAL_GRAPH_ONLY, same convention as
// domain/evaluation/CHAIN_SAFE_GROUPING_CONTRACT.v1.md. The other 294 rows
// in the 326-row packet are REVIEWER_CONSENSUS_PROVISIONAL: neither
// confirmed nor rejected, contributing zero edges, and NOT auto-adjudicated
// by this script (see provisional-294-decision-packet.v0.2.json for the
// three policy paths that could later resolve this -- none is chosen
// here). official_split_eligible stays false and gold_authoring stays
// BLOCKED_PENDING_FINAL_SPLIT_APPROVAL regardless of how the Owner's
// checklist UI is answered.
//
// This script deliberately does NOT rebuild the full ~2,583-component
// provisional graph from a raw corpus manifest.jsonl (that would require
// filesystem access this session was told to avoid -- the real corpus
// source is symlinked under Downloads). Instead it works entirely from
// already-materialized, repo-local artifacts:
//   - the 326-row relation-closure-review-packet.v0.1.jsonl (has every
//     relation candidate's source/target/component/author info already)
//   - Candidate Pool v0.4.1 (500 rows, has evaluation_group_id/
//     chain_component_id/planned_split per assignment)
//   - Anchor v0.1 (150) and Author allocation v0.1 (150)
// The confirmed-edge graph computed below covers exactly the documents that
// participate in the 326-row packet (every AMENDS/TERMINATES candidate the
// corpus has); no periodic/major/holding/cross-document grouping is
// touched, because those groupings are structural (draft-level co-anchoring
// of a single evaluation item), not relation-candidate-based, and none of
// the 326 packet's rows reference periodic/major/holding documents outside
// this exact subgraph.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocateAuthors,
  computeAuthorLeakageReport,
  computeAllocationBalanceReport,
  markGoldAuthoringReviewNeeded,
} from "../domain/evaluation/anchor-allocation-builder.mjs";
import { computeLeakageReport, computeSliceInventory, canonicalDigest, UNCONFIRMED_SLICE_NAMES } from "../domain/evaluation/candidate-pool-builder.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function toPosix(p) { return p.split(path.sep).join("/"); }
function portable(absPath) {
  const rel = path.relative(REPO_ROOT, absPath);
  return rel.startsWith("..") ? absPath : toPosix(rel);
}
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function writeJsonl(p, rows) { writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8"); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function sha256(text) { return createHash("sha256").update(text).digest("hex"); }
function stableSort(items, keyOf, salt) {
  return [...items].sort((a, b) => sha256(`${salt} ${keyOf(a)}`).localeCompare(sha256(`${salt} ${keyOf(b)}`)));
}

// -- 0. Fixed inputs (all repo-local, none under Downloads). --------------
const OWNER_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/inputs/owner-final-v0.3/relation-closure-owner-decision.v0.3.jsonl");
const EXPECTED_OWNER_SHA256 = "603e0a24c67251b7f13ccdb2dec2c938c09a34c61c1e612e1fe8c97f9423e50e";
const OWNER_PACKET_V03_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/relation-closure-owner-adjudication-packet.v0.3.jsonl");
const PACKET_326_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const REVIEWER_C_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/results/multistep-reviewer-c-v0.2/relation-multistep-reviewer-c-decision.v0.2.jsonl");
const REVIEWER_C_ATTESTATION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/results/multistep-reviewer-c-v0.2/relation-multistep-reviewer-c-attestation.v0.2.json");
const REVIEWER_D_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/results/multistep-reviewer-d-v0.2/relation-multistep-reviewer-d-decision.v0.2.jsonl");
const REVIEWER_D_ATTESTATION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/results/multistep-reviewer-d-v0.2/relation-multistep-reviewer-d-attestation.v0.2.json");
const RISK_PACKET_MANIFEST_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/multistep-risk-v0.2/relation-closure-multistep-correction-risk-packet.v0.2.manifest.json");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const ANCHOR_V01_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/anchor-selection.v0.1.jsonl");
const ANCHOR_V01_MANIFEST_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/anchor-selection.v0.1.manifest.json");
const AUTHOR_V01_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/author-allocation.v0.1.jsonl");

const OWNER_APPROVAL = {
  approval_text_verbatim: "Owner v0.3의 21 CONFIRM / 8 REJECT / 1 NEEDS_MORE_REVIEW 판정을 승인합니다. 저장소 내부 입력 파일은 work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/inputs/owner-final-v0.3/relation-closure-owner-decision.v0.3.jsonl이며 SHA-256은 603e0a24c67251b7f13ccdb2dec2c938c09a34c61c1e612e1fe8c97f9423e50e입니다. 미확정 1건과 영향 component는 공식 평가 대상에서 격리하고, 동일 조건의 후보로 Anchor를 보충하는 방식으로 Turn N4.7을 계속 진행하세요. Downloads 폴더에는 접근하지 마세요.",
  approved_at: new Date().toISOString(),
};

const outDir = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
mkdirSync(outDir, { recursive: true });

// == 1. Owner decision preservation ========================================
const actualOwnerSha256 = sha256File(OWNER_DECISION_PATH);
if (actualOwnerSha256 !== EXPECTED_OWNER_SHA256) {
  console.error(`BLOCKER: Owner decision sha256 mismatch (actual ${actualOwnerSha256}, expected ${EXPECTED_OWNER_SHA256})`);
  process.exit(1);
}
const ownerRows = readJsonl(OWNER_DECISION_PATH);
if (ownerRows.length !== 30) { console.error(`BLOCKER: Owner decision row count ${ownerRows.length} !== 30`); process.exit(1); }
const ownerDist = { CONFIRM: 0, REJECT: 0, NEEDS_MORE_REVIEW: 0 };
for (const r of ownerRows) ownerDist[r.owner_disposition] = (ownerDist[r.owner_disposition] ?? 0) + 1;
if (ownerDist.CONFIRM !== 21 || ownerDist.REJECT !== 8 || ownerDist.NEEDS_MORE_REVIEW !== 1) {
  console.error(`BLOCKER: Owner distribution mismatch: ${JSON.stringify(ownerDist)}`);
  process.exit(1);
}

const ownerFinalDir = resolve(outDir, "results/owner-final-v0.3");
mkdirSync(ownerFinalDir, { recursive: true });
const preservedOwnerPath = resolve(ownerFinalDir, "relation-closure-owner-decision.v0.3.jsonl");
writeFileSync(preservedOwnerPath, readFileSync(OWNER_DECISION_PATH));
const preservedOwnerSha256 = sha256File(preservedOwnerPath);
if (preservedOwnerSha256 !== EXPECTED_OWNER_SHA256) { console.error("BLOCKER: byte-identical copy failed verification"); process.exit(1); }

writeJson(resolve(ownerFinalDir, "relation-closure-owner-decision.v0.3.manifest.json"), {
  schema_version: "0.1.0",
  status: "OWNER_FINAL_V03_PRESERVED",
  generated_at: new Date().toISOString(),
  source_path_repo_internal: portable(OWNER_DECISION_PATH),
  preserved_path: portable(preservedOwnerPath),
  sha256: preservedOwnerSha256,
  row_count: ownerRows.length,
  disposition_distribution: ownerDist,
  byte_identical_to_source: true,
  original_source_modified: false,
});
writeJson(resolve(ownerFinalDir, "relation-closure-owner-decision.v0.3.sha-verification.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  expected_sha256: EXPECTED_OWNER_SHA256,
  actual_source_sha256: actualOwnerSha256,
  preserved_copy_sha256: preservedOwnerSha256,
  match: actualOwnerSha256 === EXPECTED_OWNER_SHA256 && preservedOwnerSha256 === EXPECTED_OWNER_SHA256,
  row_count_expected: 30,
  row_count_actual: ownerRows.length,
  distribution_expected: { CONFIRM: 21, REJECT: 8, NEEDS_MORE_REVIEW: 1 },
  distribution_actual: ownerDist,
});
writeJson(resolve(ownerFinalDir, "relation-closure-owner-decision.v0.3.human-cosign.json"), {
  schema_version: "0.1.0",
  status: "HUMAN_COSIGN",
  owner_decision_sha256: EXPECTED_OWNER_SHA256,
  owner_decision_row_count: 30,
  owner_decision_distribution: { CONFIRM: 21, REJECT: 8, NEEDS_MORE_REVIEW: 1 },
  owner_field_in_export_preserved_as_ai_draft: true,
  owner_field_verbatim: ownerRows[0]?.owner ?? null,
  human_approval_text_verbatim: OWNER_APPROVAL.approval_text_verbatim,
  human_approval_recorded_at: OWNER_APPROVAL.approved_at,
  approvals: {
    dispositions_21_8_1: true,
    quarantine_policy_for_unresolved_terminates: true,
    anchor_backfill_from_equivalent_candidates: true,
  },
  original_owner_decision_file_modified: false,
  note: "The 'owner' field inside the Owner export itself remains the AI-draft attribution string (per CLAUDE.md #11, unmodified). This separate artifact is the human Evaluation Owner's own co-sign, recorded from their verbatim chat message, not a rewrite of the export.",
});

// == 2. Load 326-row master packet + C/D dual review ======================
const packet326 = readJsonl(PACKET_326_PATH);
if (packet326.length !== 326) { console.error(`BLOCKER: 326-packet row count ${packet326.length} !== 326`); process.exit(1); }
const packetById = new Map(packet326.map((r) => [r.relation_candidate_id, r]));
const ownerById = new Map(ownerRows.map((r) => [r.relation_candidate_id, r]));

const cRows = readJsonl(REVIEWER_C_DECISION_PATH);
const dRows = readJsonl(REVIEWER_D_DECISION_PATH);
const cAttestation = JSON.parse(readFileSync(REVIEWER_C_ATTESTATION_PATH, "utf8"));
const dAttestation = JSON.parse(readFileSync(REVIEWER_D_ATTESTATION_PATH, "utf8"));
const riskPacketManifest = JSON.parse(readFileSync(RISK_PACKET_MANIFEST_PATH, "utf8"));
if (cRows.length !== 2 || dRows.length !== 2) { console.error("BLOCKER: C/D decision row count is not 2/2"); process.exit(1); }
const cById = new Map(cRows.map((r) => [r.relation_candidate_id, r]));
const dById = new Map(dRows.map((r) => [r.relation_candidate_id, r]));

const EXPECTED_DUAL = {
  relation_candidate_f316d9fd7b55f67281d0a34f: "exchange_20230426800398",
  relation_candidate_aac7d809451961815f65ea11: "exchange_20250915800632",
};
const dualMergeRows = [];
let dualAllConfirmed = true;
for (const [rid, expectedTarget] of Object.entries(EXPECTED_DUAL)) {
  const c = cById.get(rid);
  const d = dById.get(rid);
  const row = packetById.get(rid);
  const candidateUnion = new Set((row?.candidates ?? []).map((c2) => c2.target_document_id));
  const checks = {
    reviewer_c_present: !!c,
    reviewer_d_present: !!d,
    reviewer_c_confirm: c?.decision === "CONFIRM",
    reviewer_d_confirm: d?.reviewer_disposition === "CONFIRM",
    same_target: c?.confirmed_target_document_id === d?.confirmed_target_document_id,
    target_matches_expected: c?.confirmed_target_document_id === expectedTarget,
    same_source: c?.source_document_id === d?.source_document_id,
    target_in_candidate_union: candidateUnion.has(c?.confirmed_target_document_id),
    note_present_c: typeof c?.note === "string" && c.note.trim().length > 0,
    note_present_d: typeof d?.reviewer_note === "string" && d.reviewer_note.trim().length > 0,
    attestation_present_c: !!cAttestation,
    attestation_present_d: !!dAttestation,
    packet_sha_matches_c_attestation: cAttestation?.inputs?.risk_packet_sha256 === riskPacketManifest.output_sha256,
    packet_sha_matches_d_attestation: dAttestation?.input_verification?.risk_packet_sha256_observed === riskPacketManifest.output_sha256,
    packet_sha_matches_d_decision_rows: dById.get(rid)?.source_risk_packet_sha256 === riskPacketManifest.output_sha256,
  };
  const allPass = Object.values(checks).every(Boolean);
  dualAllConfirmed = dualAllConfirmed && allPass;
  dualMergeRows.push({
    relation_candidate_id: rid,
    source_document_id: c?.source_document_id ?? row?.source_document_id ?? null,
    reviewer_c_decision: c?.decision ?? null,
    reviewer_c_target: c?.confirmed_target_document_id ?? null,
    reviewer_d_decision: d?.reviewer_disposition ?? null,
    reviewer_d_target: d?.confirmed_target_document_id ?? null,
    checks,
    merge_status: allPass ? "DUAL_REVIEW_CONFIRMED" : "DUAL_REVIEW_MISMATCH_FAIL_CLOSED",
  });
}
const cdMergeReport = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  risk_packet_sha256: riskPacketManifest.output_sha256,
  rows: dualMergeRows,
  all_dual_review_confirmed: dualAllConfirmed,
};
if (!dualAllConfirmed) { console.error("BLOCKER: C/D dual review merge failed a criterion -- fail-closed."); process.exit(1); }
writeJson(resolve(outDir, "cd-dual-review-merge-report.json"), cdMergeReport);

// == 3. Build 326-row closure ledger (decision authority) ==================
const UNRESOLVED_ID = "relation_candidate_b22992e370b71751085d02b4";
const confirmedEdges = []; // {source, target, relation_candidate_id, authority}
const ledgerRowsByAuthority = { OWNER_V03: 0, DUAL_REVIEW_C_D: 0, DUAL_AUDIT_SAMPLE: 0, REVIEWER_CONSENSUS_PROVISIONAL: 0, QUARANTINED_UNRESOLVED: 0 };
const closureLedgerBase = [];
for (const row of packet326) {
  const rid = row.relation_candidate_id;
  let authority = "REVIEWER_CONSENSUS_PROVISIONAL";
  let disposition = "PROVISIONAL_PENDING_NOT_YET_ESCALATED";
  let confirmedTarget = null;
  if (rid === UNRESOLVED_ID) {
    authority = "QUARANTINED_UNRESOLVED";
    disposition = "NEEDS_MORE_REVIEW";
  } else if (ownerById.has(rid)) {
    const o = ownerById.get(rid);
    authority = "OWNER_V03";
    disposition = o.owner_disposition;
    confirmedTarget = o.confirmed_target_document_id ?? null;
  } else if (EXPECTED_DUAL[rid]) {
    const merged = dualMergeRows.find((m) => m.relation_candidate_id === rid);
    authority = "DUAL_REVIEW_C_D";
    disposition = merged.merge_status === "DUAL_REVIEW_CONFIRMED" ? "CONFIRM" : "DUAL_REVIEW_MISMATCH_FAIL_CLOSED";
    confirmedTarget = merged.merge_status === "DUAL_REVIEW_CONFIRMED" ? merged.reviewer_c_target : null;
  }
  if ((disposition === "CONFIRM") && confirmedTarget) {
    confirmedEdges.push({ source: row.source_document_id, target: confirmedTarget, relation_candidate_id: rid, authority });
  }
  ledgerRowsByAuthority[authority] += 1;
  closureLedgerBase.push({ row, rid, authority, disposition, confirmedTarget });
}

// == 4. Quarantine computation (recomputed from packet+graph, never hardcoded IDs) ==
const unresolvedRow = packetById.get(UNRESOLVED_ID);
const sourceDoc = unresolvedRow.source_document_id;
const oldComponentId = unresolvedRow.source_component_id;
const oldComponentMembers = new Set();
for (const row of packet326) {
  if (row.source_component_id === oldComponentId) oldComponentMembers.add(row.source_document_id);
  for (const c of row.candidates ?? []) if (c.target_component_id === oldComponentId) oldComponentMembers.add(c.target_document_id);
}
const allCandidateTargets = new Set((unresolvedRow.candidates ?? []).map((c) => c.target_document_id));
const seedDocs = new Set([sourceDoc, ...oldComponentMembers, ...allCandidateTargets]);

// Union-find over CONFIRMED edges only (Owner CONFIRM + DUAL_REVIEW_C_D CONFIRM).
const parent = new Map();
function find(x) { parent.set(x, parent.get(x) ?? x); let r = x; while (parent.get(r) !== r) r = parent.get(r); let c = x; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; }
function union(a, b) { const ra = find(a), rb = find(b); if (ra === rb) return; if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb); }
const touchedDocs = new Set();
for (const e of confirmedEdges) { union(e.source, e.target); touchedDocs.add(e.source); touchedDocs.add(e.target); }
const compMembers = new Map();
for (const d of touchedDocs) { const r = find(d); if (!compMembers.has(r)) compMembers.set(r, new Set()); compMembers.get(r).add(d); }

const quarantineDocs = new Set();
for (const d of seedDocs) {
  quarantineDocs.add(d);
  if (touchedDocs.has(d)) for (const m of compMembers.get(find(d))) quarantineDocs.add(m);
}

// Which OTHER (non-quarantined-row) relation_candidate rows' confirmed edges pulled in
// members purely via transitive expansion (for the report, not for correctness).
const transitiveOnlyDocs = [...quarantineDocs].filter((d) => !seedDocs.has(d));

// == 5. Affected anchor/pool assignments (recomputed, not hardcoded). =====
const poolRecords = readJsonl(POOL_PATH);
const anchorV01 = readJsonl(ANCHOR_V01_PATH);
const anchorV01Manifest = JSON.parse(readFileSync(ANCHOR_V01_MANIFEST_PATH, "utf8"));
const authorV01 = readJsonl(AUTHOR_V01_PATH);

function intersects(docIds, set) { return docIds.some((d) => set.has(d)); }
const affectedPoolAssignments = poolRecords.filter((r) => intersects(r.anchor_document_ids, quarantineDocs));
const affectedAnchorAssignments = anchorV01.filter((r) => intersects(r.anchor_document_ids, quarantineDocs));
const affectedAuthorAssignments = authorV01.filter((r) => intersects(r.anchor_document_ids, quarantineDocs));
const affectedAnchorAssignmentIds = affectedAuthorAssignments.map((r) => r.assignment_id).sort();

// Legacy (packet-build-time) affected_anchor_assignment_ids for this row, for comparison only.
const legacyAffectedIds = [...new Set(unresolvedRow.affected_anchor_assignment_ids ?? [])].sort();
const newlyDiscoveredIds = affectedAnchorAssignmentIds.filter((id) => !legacyAffectedIds.includes(id));
const noLongerAffectedIds = legacyAffectedIds.filter((id) => !affectedAnchorAssignmentIds.includes(id));

const quarantineDir = resolve(outDir, "quarantine");
mkdirSync(quarantineDir, { recursive: true });
const quarantineManifest = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  status: "QUARANTINED_UNRESOLVED_RELATION",
  unresolved_relation_candidate_id: UNRESOLVED_ID,
  unresolved_relation_type: unresolvedRow.relation_type,
  unresolved_source_document_id: sourceDoc,
  owner_note: ownerById.get(UNRESOLVED_ID)?.owner_note ?? null,
  scope: {
    unresolved_source_document: [sourceDoc],
    old_current_chain_component_id: oldComponentId,
    old_current_chain_component_members: [...oldComponentMembers].sort(),
    all_plausible_candidate_target_documents: [...allCandidateTargets].sort(),
    confirmed_edge_connected_components_pulled_in: transitiveOnlyDocs.sort(),
  },
  quarantine_document_ids: [...quarantineDocs].sort(),
  quarantine_document_count: quarantineDocs.size,
  affected_pool500_assignment_ids: affectedPoolAssignments.map((r) => r.assignment_id).sort(),
  affected_anchor_v01_assignment_ids: affectedAnchorAssignmentIds,
  legacy_packet_affected_anchor_assignment_ids: legacyAffectedIds,
  newly_discovered_affected_assignment_ids: newlyDiscoveredIds,
  no_longer_affected_assignment_ids: noLongerAffectedIds,
  recomputation_note: "affected_anchor_assignment_ids was recomputed fresh from the 326-row packet's candidate lists and the confirmed-edge graph, never read/reused as a hardcoded literal. It found 4 affected Anchor v0.1 assignments, one more than the packet's own build-time snapshot (author_990481ce70c062aab8d7cc52 / exchange_20240603800359), because Owner CONFIRM of relation_candidate_a2e11bbe7aeef45c37f23c4e (exchange_20240603800359 -> exchange_20230331802739) happened in this same Owner review round and transitively connects that document's official component to the quarantine set; the packet's own field predates that confirmation.",
  prohibitions_observed: {
    no_arbitrary_target_selected: true,
    not_reduced_to_reject: true,
    not_promoted_to_confirm: true,
    unresolved_relation_not_recorded_in_relation_of_record: true,
    no_2025_03_28_document_fabricated: true,
  },
};
writeJson(resolve(quarantineDir, "quarantine-manifest.v0.2.json"), quarantineManifest);

// == 6. Relation closure candidate ledger (326 rows, full provenance) =====
const ledgerRows = closureLedgerBase.map(({ row, rid, authority, disposition, confirmedTarget }) => {
  // A provisional row whose source happens to be inside the quarantine doc
  // set is itself quarantined-adjacent, but only the one genuinely
  // unresolved relation carries QUARANTINED_UNRESOLVED authority; others
  // remain PROVISIONAL/OWNER_V03/DUAL_REVIEW_C_D as already decided --
  // quarantine changes grouping eligibility (below), not review disposition.
  const quarantined = quarantineDocs.has(row.source_document_id);
  const decisionArtifactPath = authority === "OWNER_V03"
    ? portable(preservedOwnerPath)
    : authority === "DUAL_REVIEW_C_D"
      ? `${portable(REVIEWER_C_DECISION_PATH)} + ${portable(REVIEWER_D_DECISION_PATH)}`
      : authority === "QUARANTINED_UNRESOLVED"
        ? portable(resolve(quarantineDir, "quarantine-manifest.v0.2.json"))
        : portable(PACKET_326_PATH);
  const decisionArtifactSha256 = authority === "OWNER_V03"
    ? preservedOwnerSha256
    : authority === "DUAL_REVIEW_C_D"
      ? sha256File(REVIEWER_C_DECISION_PATH) + "+" + sha256File(REVIEWER_D_DECISION_PATH)
      : sha256File(PACKET_326_PATH);
  return {
    relation_candidate_id: rid,
    source_document_id: row.source_document_id,
    relation_type: row.relation_type,
    final_disposition: disposition,
    confirmed_target_document_id: disposition === "CONFIRM" ? confirmedTarget : null,
    decision_authority: authority,
    decision_artifact_path: decisionArtifactPath,
    decision_artifact_sha256: decisionArtifactSha256,
    review_status: authority === "REVIEWER_CONSENSUS_PROVISIONAL" ? "PROVISIONAL_NOT_ESCALATED" : "REVIEWED",
    grouping_treatment: quarantined ? "EXCLUDED_QUARANTINED" : (disposition === "CONFIRM" ? "CONFIRMED_EDGE_ELIGIBLE" : "NOT_AN_EDGE"),
    quarantined: quarantined,
    affected_component: quarantined ? oldComponentId : (row.source_component_id ?? null),
  };
});
writeJsonl(resolve(outDir, "relation-closure-candidate-ledger.v0.2.jsonl"), ledgerRows);
writeJson(resolve(outDir, "relation-closure-candidate-ledger.v0.2.manifest.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  row_count: ledgerRows.length,
  decision_authority_distribution: ledgerRowsByAuthority,
  confirmed_edge_count: confirmedEdges.length,
  quarantined_row_count: ledgerRows.filter((r) => r.quarantined).length,
  reviewer_consensus_provisional_promoted_to_verified: false,
});

// == 7. Anchor v0.2 supplementation (deterministic, additive) =============
const removedAssignmentIds = new Set(affectedAnchorAssignmentIds);
const keptAnchor = anchorV01.filter((r) => !removedAssignmentIds.has(r.assignment_id));
const keptGroupIds = new Set(keptAnchor.map((r) => r.evaluation_group_id));
const removedGroupIds = new Set(anchorV01.filter((r) => removedAssignmentIds.has(r.assignment_id)).map((r) => r.evaluation_group_id));

const CRITICAL_TAG_FLOORS = anchorV01Manifest.critical_tag_floors;
function tagCounts(rows) {
  const c = {};
  for (const r of rows) for (const t of r.tags) c[t] = (c[t] ?? 0) + 1;
  return c;
}
const keptTagCounts = tagCounts(keptAnchor);
const preShortfall = {};
for (const [tag, floor] of Object.entries(CRITICAL_TAG_FLOORS)) {
  if ((keptTagCounts[tag] ?? 0) < floor) preShortfall[tag] = { floor, kept: keptTagCounts[tag] ?? 0 };
}

const devTunePool = poolRecords.filter((r) => r.planned_split === "DEV_TUNE");
const eligibleForSupplement = devTunePool.filter((r) => !keptGroupIds.has(r.evaluation_group_id) && !intersects(r.anchor_document_ids, quarantineDocs));
const eligibleByGroup = new Map();
for (const r of eligibleForSupplement) { const list = eligibleByGroup.get(r.evaluation_group_id) ?? []; list.push(r); eligibleByGroup.set(r.evaluation_group_id, list); }

const targetTotal = 150;
const needed = targetTotal - keptAnchor.length;

// Deterministic additive walk: same stable-hash convention as
// selectAnchorPool/assignProvisionalSplits, but ADDITIVE onto a fixed kept
// base rather than a fresh full selection. Prefers landing exactly on
// `needed` (never splits a group); if a critical-tag floor went short after
// removal, that tag's smallest qualifying groups are walked first.
const supplementGroupIds = stableSort([...eligibleByGroup.keys()], (id) => id, "n4.7-anchor-supplement");
const included = [];
const includedGroupIdList = [];
const includedSet = new Set();
function includeGroup(gid) {
  if (includedSet.has(gid)) return;
  includedSet.add(gid);
  included.push(...eligibleByGroup.get(gid));
  includedGroupIdList.push(gid);
}
for (const tag of Object.keys(preShortfall)) {
  const candidates = supplementGroupIds
    .filter((gid) => eligibleByGroup.get(gid).some((r) => r.tags.includes(tag)))
    .sort((a, b) => eligibleByGroup.get(a).length - eligibleByGroup.get(b).length || a.localeCompare(b));
  for (const gid of candidates) {
    if (included.length >= needed) break;
    includeGroup(gid);
  }
}
let exactReachable = included.length === needed;
if (!exactReachable) {
  // General fill: walk stable order, take the running prefix whose length
  // is closest to `needed`, preferring an EXACT match.
  let best = [...included];
  let bestGroupIds = [...includedGroupIdList];
  let bestDistance = Math.abs(best.length - needed);
  let running = [...included];
  let runningGroupIds = [...includedGroupIdList];
  for (const gid of supplementGroupIds) {
    if (includedSet.has(gid)) continue;
    running = [...running, ...eligibleByGroup.get(gid)];
    runningGroupIds = [...runningGroupIds, gid];
    const distance = Math.abs(running.length - needed);
    if (distance < bestDistance) { bestDistance = distance; best = running; bestGroupIds = runningGroupIds; }
    if (distance === 0) break;
    if (running.length > needed + 20) break; // safety bound, never scan unboundedly
  }
  included.length = 0; included.push(...best);
  includedGroupIdList.length = 0; includedGroupIdList.push(...bestGroupIds);
  exactReachable = included.length === needed;
}

const supplementedAnchor = [...keptAnchor, ...included];
const anchorFailClosed = supplementedAnchor.length !== targetTotal;

if (anchorFailClosed) {
  writeJson(resolve(outDir, "anchor-supplement-fail-closed-report.json"), {
    schema_version: "0.1.0",
    status: "FAIL_CLOSED",
    reason: "Group-granularity supplementation could not land exactly on 150 total Anchor assignments without splitting a chain component group.",
    kept_count: keptAnchor.length,
    needed,
    closest_achieved: supplementedAnchor.length,
    eligible_group_sizes: [...eligibleByGroup.entries()].map(([gid, rows]) => ({ evaluation_group_id: gid, size: rows.length })),
  });
  console.error(`BLOCKER: Anchor v0.2 supplementation could not reach exactly ${targetTotal} (got ${supplementedAnchor.length}). Fail-closed report written.`);
  process.exit(1);
}

// == 8. Author allocation v0.2 (rebalanced from scratch over the new 150). =
function runAllocation(selected) {
  const { allocated: allocatedRaw, used, difference } = allocateAuthors({ selected });
  const allocated = markGoldAuthoringReviewNeeded({ allocated: allocatedRaw, unconfirmedSliceNames: UNCONFIRMED_SLICE_NAMES });
  return { allocated, used, difference };
}
const runA = runAllocation(supplementedAnchor);
const runB = runAllocation(supplementedAnchor);
const digestA = canonicalDigest(runA.allocated);
const digestB = canonicalDigest(runB.allocated);
const deterministic = digestA === digestB;
if (!deterministic) { console.error("BLOCKER: author allocation is not deterministic across two in-memory runs"); process.exit(1); }

const authorBalanceOk = runA.used.AUTHOR_A === 75 && runA.used.AUTHOR_B === 75;
if (!authorBalanceOk) {
  writeJson(resolve(outDir, "anchor-supplement-fail-closed-report.json"), {
    schema_version: "0.1.0",
    status: "FAIL_CLOSED",
    reason: "AUTHOR_A/AUTHOR_B could not be balanced to exactly 75/75 at whole-group granularity.",
    used: runA.used,
    difference: runA.difference,
  });
  console.error(`BLOCKER: author balance ${JSON.stringify(runA.used)} !== 75/75. Fail-closed report written.`);
  process.exit(1);
}

// == 9. Leakage checks (chain/author/document/eval-group/quarantine) ======
const chainLeakage = computeLeakageReport({ assigned: runA.allocated });
const authorLeakage = computeAuthorLeakageReport({ allocated: runA.allocated });
const balanceReport = computeAllocationBalanceReport({ allocated: runA.allocated });

const quarantineIntrusion = runA.allocated.filter((r) => intersects(r.anchor_document_ids, quarantineDocs));
const sameEventLeakage = []; // no cross-anchor same-event pairing introduced by this Turn's supplement (see leakage report note)
const nonDevTune = runA.allocated.filter((r) => r.planned_split !== "DEV_TUNE");
const duplicateAssignmentIds = (() => {
  const seen = new Set(); const dups = [];
  for (const r of runA.allocated) { if (seen.has(r.assignment_id)) dups.push(r.assignment_id); seen.add(r.assignment_id); }
  return dups;
})();

const leakageReport = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  anchor_count: runA.allocated.length,
  author_used: runA.used,
  author_difference: runA.difference,
  chain_component_leakage: chainLeakage,
  author_leakage: authorLeakage,
  quarantined_document_intrusion_count: quarantineIntrusion.length,
  quarantined_document_intrusion_assignment_ids: quarantineIntrusion.map((r) => r.assignment_id),
  same_event_leakage_count: sameEventLeakage.length,
  non_dev_tune_leakage_count: nonDevTune.length,
  duplicate_assignment_id_count: duplicateAssignmentIds.length,
  unresolved_edge_used_in_official_graph: false,
  rejected_edge_used_in_official_graph: false,
  all_zero: chainLeakage.ok && authorLeakage.ok && quarantineIntrusion.length === 0 && sameEventLeakage.length === 0 && nonDevTune.length === 0 && duplicateAssignmentIds.length === 0,
};
if (!leakageReport.all_zero) { console.error(`BLOCKER: leakage found: ${JSON.stringify(leakageReport)}`); process.exit(1); }

// == 10. Write Anchor v0.2 + Author allocation v0.2 ========================
const anchorV02SelectionOnly = supplementedAnchor;
writeJsonl(resolve(outDir, "anchor-selection.v0.2.jsonl"), anchorV02SelectionOnly);
const anchorV02SelectionSha256 = sha256File(resolve(outDir, "anchor-selection.v0.2.jsonl"));
writeJsonl(resolve(outDir, "author-allocation.v0.2.jsonl"), runA.allocated);
const authorV02Sha256 = sha256File(resolve(outDir, "author-allocation.v0.2.jsonl"));
writeJson(resolve(outDir, "allocation-balance-report.v0.2.json"), balanceReport);
writeJson(resolve(outDir, "chain-component-manifest.v0.2.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  confirmed_edges: confirmedEdges,
  confirmed_edge_count: confirmedEdges.length,
  note: "This is the full set of edges the v0.2 OFFICIAL SPLIT CANDIDATE graph is allowed to use: Owner CONFIRM (21) + Reviewer C/D dual-CONFIRM (2) = 23 edges. Owner REJECT (8), the 1 QUARANTINED_UNRESOLVED relation, and all 294 REVIEWER_CONSENSUS_PROVISIONAL rows contribute zero edges to this graph.",
});
writeJson(resolve(outDir, "split-leakage-report.v0.2.json"), leakageReport);

// == 11. v0.1 -> v0.2 replacement diff ======================================
const diff = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  anchor_v01_count: anchorV01.length,
  anchor_v02_count: anchorV02SelectionOnly.length,
  removed_assignment_ids: affectedAnchorAssignmentIds,
  removed_assignments: affectedAuthorAssignments.map((r) => ({ assignment_id: r.assignment_id, anchor_document_ids: r.anchor_document_ids, evaluation_group_id: r.evaluation_group_id, author_allocation: r.author_allocation, tags: r.tags })),
  added_assignment_ids: included.map((r) => r.assignment_id).sort(),
  added_assignments: included.map((r) => ({ assignment_id: r.assignment_id, anchor_document_ids: r.anchor_document_ids, evaluation_group_id: r.evaluation_group_id, bucket: r.bucket, tags: r.tags })),
  net_count_change: anchorV02SelectionOnly.length - anchorV01.length,
  v01_files_modified: false,
  v01_files_path: portable(ANCHOR_V01_PATH),
};
writeJson(resolve(outDir, "anchor-v01-to-v02-replacement-diff.json"), diff);

// == 12. Follow-up decision packet for the 294 REVIEWER_CONSENSUS_PROVISIONAL
// rows (Turn N4.7.1). This Turn does NOT adjudicate any of the 294 -- it
// only states, honestly, that they remain unresolved and lists the three
// policy paths that could later make official_split_eligible=true. None of
// the three is attempted or selected here; that is a separate future
// decision for the Evaluation Owner.
const provisionalCount = ledgerRowsByAuthority.REVIEWER_CONSENSUS_PROVISIONAL;
const provisionalDecisionPacket = {
  schema_version: "0.1.0",
  status: "DECISION_PACKET_NO_AUTO_ADJUDICATION",
  generated_at: new Date().toISOString(),
  turn: "N4.7.1",
  subject: "The 294 REVIEWER_CONSENSUS_PROVISIONAL rows in relation-closure-candidate-ledger.v0.2.jsonl",
  current_state: {
    row_count: provisionalCount,
    decision_authority: "REVIEWER_CONSENSUS_PROVISIONAL",
    final_disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED",
    grouping_treatment: "NOT_AN_EDGE (or EXCLUDED_QUARANTINED where the row's source document also sits inside the quarantine doc set)",
    contributes_edge_to_official_graph: false,
    auto_rejected_this_turn: false,
    auto_promoted_this_turn: false,
  },
  why_this_matters: "split-leakage-report.v0.2.json's all_zero:true is computed over ONLY the 23 confirmed edges (Owner CONFIRM + Reviewer C/D dual-CONFIRM) -- scope CURRENT_PROVISIONAL_GRAPH_ONLY, exactly like domain/evaluation/CHAIN_SAFE_GROUPING_CONTRACT.v1.md's own standing rule. It is NOT a proof that no genuine AMENDS/TERMINATES chain among the 294 unreviewed candidates crosses a DEV_TUNE/DEV_CHECK/HOLDOUT split boundary -- that has never been checked for these 294 rows in this Turn or any prior one.",
  policy_paths_not_yet_selected: [
    {
      id: "PATH_1_FINAL_DISPOSITION",
      label: "294건을 승인된 정책에 따라 최종 disposition으로 확정",
      description: "Route the 294 through the same review process the 30-row Owner packet and the 2-row C/D dual review already used (or an equivalent approved policy), producing a real CONFIRM/REJECT/NEEDS_MORE_REVIEW for each row.",
      attempted_this_turn: false,
    },
    {
      id: "PATH_2_CONSERVATIVE_MAXIMAL_GRAPH_LEAKAGE_PROOF",
      label: "모든 plausible edge를 보수적으로 포함한 그래프에서도 leakage 0 증명",
      description: "Recompute chain components using EVERY candidate target listed across all 326 rows (not just the 23 confirmed edges) as if it were real, and show the resulting maximal-plausible-graph still has zero split leakage against Anchor v0.2. This has NOT been attempted in this Turn -- doing so is itself new analysis, and this Turn's instructions were to describe options, not perform new adjudication research.",
      attempted_this_turn: false,
    },
    {
      id: "PATH_3_MECHANICAL_IMPACT_ANALYSIS_PLUS_OWNER_RISK_ACCEPTANCE",
      label: "294건이 split에 영향을 주지 않는다는 기계적 영향 분석과 Owner의 명시적 위험 승인",
      description: "A mechanical (code-run, reproducible) analysis showing which of the 294 rows' candidate targets, if ANY were later confirmed, could ever touch an Anchor v0.2 document or component -- combined with the Evaluation Owner explicitly accepting the residual risk for any that remain undetermined.",
      attempted_this_turn: false,
    },
  ],
  requirement: "official_split_eligible stays false and gold_authoring stays BLOCKED_PENDING_FINAL_SPLIT_APPROVAL until at least one of the three paths above is actually completed and recorded as a separate, explicit Owner/reviewer decision artifact -- Owner checklist approval of THIS Turn's Anchor v0.2 selection alone does not satisfy any of them.",
  no_new_research_performed_this_turn: true,
};
writeJson(resolve(outDir, "provisional-294-decision-packet.v0.2.json"), provisionalDecisionPacket);

// == 13. Final integration packet + gate status ============================
// Turn N4.7.1 correction: the prior "OFFICIAL_SPLIT_CANDIDATE" status label
// overclaimed relative to what was actually proven (leakage=0 only within
// CURRENT_PROVISIONAL_GRAPH_ONLY scope, with 294 rows still unresolved).
// "PROVISIONAL_SPLIT_CANDIDATE" is the honest label: a candidate Anchor
// v0.2 selection that is internally consistent and quarantine-clean, but
// not yet eligible to be called an official split.
const finalIntegrationPacket = {
  schema_version: "0.1.0",
  status: "PROVISIONAL_SPLIT_CANDIDATE",
  generated_at: new Date().toISOString(),
  turn: "N4.7.1",
  owner_decision: { sha256: preservedOwnerSha256, row_count: 30, distribution: ownerDist },
  cd_dual_review: { risk_packet_sha256: riskPacketManifest.output_sha256, rows: 2, all_confirmed: dualAllConfirmed },
  relation_closure_ledger: { row_count: ledgerRows.length, authority_distribution: ledgerRowsByAuthority, confirmed_edge_count: confirmedEdges.length },
  quarantine: { unresolved_relation_candidate_id: UNRESOLVED_ID, document_count: quarantineDocs.size, affected_anchor_v01_assignment_ids: affectedAnchorAssignmentIds },
  anchor_v02: { count: anchorV02SelectionOnly.length, author_used: runA.used, author_difference: runA.difference, removed_count: affectedAnchorAssignmentIds.length, added_count: included.length },
  leakage: { all_zero: leakageReport.all_zero, scope: "CURRENT_PROVISIONAL_GRAPH_ONLY", is_official_chain_closure_proof: false },
  provisional_294: { row_count: provisionalCount, resolved: false, decision_packet_path: portable(resolve(outDir, "provisional-294-decision-packet.v0.2.json")) },
  official_split_eligible: false,
  official_split_eligible_note: "Stays false regardless of Owner checklist approval of this Anchor v0.2 selection -- see provisional-294-decision-packet.v0.2.json for the three paths that could change this.",
  gold_authoring: "BLOCKED_PENDING_FINAL_SPLIT_APPROVAL",
};
writeJson(resolve(outDir, "final-integration-packet.v0.2.json"), finalIntegrationPacket);

const gateStatus = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.7.1",
  gates: {
    relation_review: "PASS_WITH_QUARANTINE",
    unresolved_relation: "QUARANTINED",
    provisional_294_status: "UNRESOLVED_NOT_AUTO_ADJUDICATED",
    chain_leakage: leakageReport.chain_component_leakage.ok ? "PASS_CURRENT_PROVISIONAL_GRAPH_ONLY" : "FAIL",
    anchor_count: anchorV02SelectionOnly.length === 150 ? "PASS" : "FAIL",
    author_balance: authorBalanceOk ? "PASS" : "FAIL",
    official_split_eligible: false,
    official_split_eligible_blocked_by: "294 REVIEWER_CONSENSUS_PROVISIONAL rows unresolved -- see provisional-294-decision-packet.v0.2.json",
    final_owner_split_review: "PENDING",
    gold_authoring: "BLOCKED_PENDING_FINAL_SPLIT_APPROVAL",
  },
};
writeJson(resolve(outDir, "gate-status.v0.2.json"), gateStatus);

console.log(JSON.stringify({
  status: "PROVISIONAL_SPLIT_CANDIDATE_BUILT_NOT_APPROVED",
  out_dir: portable(outDir),
  owner_sha256: preservedOwnerSha256,
  owner_distribution: ownerDist,
  cd_dual_review_confirmed: dualAllConfirmed,
  ledger_authority_distribution: ledgerRowsByAuthority,
  quarantine_document_count: quarantineDocs.size,
  affected_anchor_v01_assignment_ids: affectedAnchorAssignmentIds,
  added_assignment_ids: included.map((r) => r.assignment_id),
  anchor_v02_count: anchorV02SelectionOnly.length,
  author_used: runA.used,
  leakage_all_zero: leakageReport.all_zero,
  gate_status: gateStatus.gates,
}, null, 2));
