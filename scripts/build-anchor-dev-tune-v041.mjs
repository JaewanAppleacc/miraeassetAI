#!/usr/bin/env node
// Turn N4.1: builds the DEV_TUNE Anchor 150 selection, AUTHOR_A/AUTHOR_B
// provisional allocation, and the relation closure review packet from the
// PINNED Candidate Pool v0.4.1. Fails closed (never regenerates a new
// Candidate Pool) if the pinned input SHAs/snapshot ids do not match.
//
// Outputs are written under work/handoff/anchor-dev-tune-v0.1/ (gitignored
// -- never the raw corpus, never Gold, never a review decision result).
// Every status field written here is CANDIDATE/PROVISIONAL/NOT_STARTED.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCandidateDrafts,
  buildChainComponents,
  computeLeakageReport,
  canonicalDigest,
  UNCONFIRMED_SLICE_NAMES,
  computeSliceInventory,
} from "../domain/evaluation/candidate-pool-builder.mjs";
import {
  selectAnchorPool,
  allocateAuthors,
  computeAuthorLeakageReport,
  computeAllocationBalanceReport,
  markGoldAuthoringReviewNeeded,
  buildRelationClosurePacket,
} from "../domain/evaluation/anchor-allocation-builder.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function toPosix(p) { return p.split(path.sep).join("/"); }
function portableRelativeTo(baseDir, absPath) {
  const rel = path.relative(baseDir, absPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

// -- A. Pinned inputs (section A) -- fail-closed if any mismatch. ---------
const PINNED_POOL_SHA256 = "eee5a8367a54d62ae278e9e9578bf9dcc04056af99f9f2267dc24078f9d01153";
const PINNED_CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";
const PINNED_SOURCE_CORPUS_SNAPSHOT_ID = "snap_7484a10220422056";
const PINNED_N4_COMMIT = "51d84583a618343bb46ee9717128964bc29849f5";
const PINNED_TOTAL_CHAIN_COMPONENTS = 2583;
const PINNED_MAX_COMPONENT_SIZE = 33;

const corpusRoot = resolve(process.argv[2] ?? process.env.DISCLOSURE_CORPUS_ROOT ?? "");
const poolDir = resolve(process.argv[3] ?? "work/domain-seed/candidate-pool-v0.4.1");
const relationQueuePath = resolve(process.argv[4] ?? "work/domain-seed/relation-review-queue.jsonl");
const parseCoveragePath = resolve(process.argv[5] ?? "work/domain-seed/document-parse-coverage.jsonl");
const outDir = resolve(process.argv[6] ?? "work/handoff/anchor-dev-tune-v0.1");

if (!corpusRoot || !existsSync(resolve(corpusRoot, "manifest.jsonl"))) {
  console.error("Usage: node scripts/build-anchor-dev-tune-v041.mjs <corpus-root> [pool-dir] [relation-queue-path] [parse-coverage-path] [out-dir]");
  process.exit(2);
}

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

const poolPath = resolve(poolDir, "candidate-pool.v0.1.jsonl");
const poolManifestPath = resolve(poolDir, "candidate-pool.v0.1.manifest.json");
const actualPoolSha256 = sha256File(poolPath);
if (actualPoolSha256 !== PINNED_POOL_SHA256) {
  console.error(`BLOCKER: Candidate Pool sha256 mismatch (actual ${actualPoolSha256}, pinned ${PINNED_POOL_SHA256}) -- refusing to proceed. Never regenerating a new Pool.`);
  process.exit(1);
}
const poolManifest = JSON.parse(readFileSync(poolManifestPath, "utf8"));
if (poolManifest.corpus_snapshot_id !== PINNED_CORPUS_SNAPSHOT_ID || poolManifest.source_corpus_snapshot_id !== PINNED_SOURCE_CORPUS_SNAPSHOT_ID) {
  console.error(`BLOCKER: snapshot id mismatch (corpus_snapshot_id=${poolManifest.corpus_snapshot_id}, source_corpus_snapshot_id=${poolManifest.source_corpus_snapshot_id})`);
  process.exit(1);
}
const poolRecords = readJsonl(poolPath);

// -- Re-derive the FULL (all ~2,583-component) provisional graph from the
// same real inputs, so the closure packet can look up a component/author
// for ANY document a relation candidate touches -- not just the 500
// documents that made it into the Candidate Pool. This also doubles as an
// integrity check: if the regenerated component count/max size disagrees
// with what is pinned in the Pool's own manifest, something about the
// inputs has drifted and we fail closed rather than silently using a
// different graph than the one the Pool was actually built from. -------
const manifestRows = readJsonl(resolve(corpusRoot, "manifest.jsonl"));
const relationCandidates = existsSync(relationQueuePath) ? readJsonl(relationQueuePath) : [];
const parseCoverageRows = existsSync(parseCoveragePath) ? readJsonl(parseCoveragePath) : [];
const parseCoverageByDocumentId = new Map(parseCoverageRows.map((row) => [row.document_id, row.state]));
const manifestByDocumentId = new Map(manifestRows.map((row) => [row.doc_id, row]));

const drafts = generateCandidateDrafts({ manifestRows });
const { docToComponentId, components } = buildChainComponents({ drafts, relationCandidates });
if (components.length !== PINNED_TOTAL_CHAIN_COMPONENTS) {
  console.error(`BLOCKER: regenerated total_chain_components (${components.length}) does not match the Pool manifest's pinned value (${PINNED_TOTAL_CHAIN_COMPONENTS}) -- inputs have drifted since the Pool was built.`);
  process.exit(1);
}
const maxComponentSize = Math.max(...components.map((c) => c.member_document_ids.length));
if (maxComponentSize !== PINNED_MAX_COMPONENT_SIZE) {
  console.error(`BLOCKER: regenerated max_component_size (${maxComponentSize}) does not match the pinned value (${PINNED_MAX_COMPONENT_SIZE})`);
  process.exit(1);
}

// -- B. Anchor 150 selection (DEV_TUNE only). -----------------------------
// Tag-keyed only (never company/document-keyed) -- see selectAnchorPool's
// own comment: at ~150-out-of-242 scale a rare slice can be sampled away
// by a plain stable-hash walk purely by chance (measured directly: without
// this floor, facility_investment -- 3 real DEV_TUNE records -- was
// sampled to zero in this exact run).
const ANCHOR_CRITICAL_TAG_FLOORS = {
  termination: 1, correction_chain: 3, zero_document: 1, withheld_candidate: 3,
  cross_company: 1, same_company_different_period: 3, investment_judgement: 1,
  holding_within_report_change: 3, facility_investment: 1,
};

function runOnce() {
  const { selected, includedGroupIds, totalDevTuneGroupsAvailable, totalDevTuneRecordsAvailable, exactTargetReachable, actualCount, criticalTagShortfalls } =
    selectAnchorPool({ poolRecords, targetIdeal: 150, targetMin: 145, targetMax: 155, criticalTagFloors: ANCHOR_CRITICAL_TAG_FLOORS });
  const chainLeakage = computeLeakageReport({ assigned: selected });

  // -- C. Author A/B provisional allocation. ------------------------------
  const { allocated: allocatedRaw, used, difference } = allocateAuthors({ selected });
  const allocated = markGoldAuthoringReviewNeeded({ allocated: allocatedRaw, unconfirmedSliceNames: UNCONFIRMED_SLICE_NAMES });
  const authorLeakage = computeAuthorLeakageReport({ allocated });
  const balanceReport = computeAllocationBalanceReport({ allocated });
  const sliceReport = computeSliceInventory({ assigned: allocated, parseCoverageByDocumentId });

  // -- E. Relation closure review packet. ---------------------------------
  const anchorDocumentIds = [...new Set(allocated.flatMap((item) => item.anchor_document_ids))];
  const authorByDocumentId = new Map(allocated.flatMap((item) => item.anchor_document_ids.map((doc) => [doc, item.author_allocation])));
  const assignmentIdsByDocumentId = new Map();
  for (const item of allocated) {
    for (const doc of item.anchor_document_ids) {
      const list = assignmentIdsByDocumentId.get(doc) ?? [];
      list.push(item.assignment_id);
      assignmentIdsByDocumentId.set(doc, list);
    }
  }
  const { packet, hop0Count, hop1Count, totalCount } = buildRelationClosurePacket({
    anchorDocumentIds, relationCandidates, docToComponentId, authorByDocumentId, manifestByDocumentId, assignmentIdsByDocumentId,
  });

  return {
    selected, includedGroupIds, totalDevTuneGroupsAvailable, totalDevTuneRecordsAvailable, exactTargetReachable, actualCount,
    criticalTagShortfalls, chainLeakage, allocated, used, difference, authorLeakage, balanceReport, sliceReport,
    anchorDocumentIds, packet, hop0Count, hop1Count, totalCount,
  };
}

const runA = runOnce();
const runB = runOnce();
const digestA = canonicalDigest(runA.allocated);
const digestB = canonicalDigest(runB.allocated);
const packetDigestA = canonicalDigest(runA.packet);
const packetDigestB = canonicalDigest(runB.packet);
const deterministicRebuild = {
  status: (digestA === digestB && packetDigestA === packetDigestB) ? "PASS" : "FAIL",
  anchor_digest_run_a: digestA, anchor_digest_run_b: digestB,
  closure_packet_digest_run_a: packetDigestA, closure_packet_digest_run_b: packetDigestB,
};
if (deterministicRebuild.status !== "PASS") {
  console.error("BLOCKER: anchor selection/allocation or closure packet is not deterministic across two in-memory runs");
  process.exit(1);
}
if (!runA.chainLeakage.ok) {
  console.error(`BLOCKER: ${runA.chainLeakage.violations.length} chain-component leakage violation(s) in the Anchor selection`);
  process.exit(1);
}
if (!runA.authorLeakage.ok) {
  console.error(`BLOCKER: ${runA.authorLeakage.violations.length} author-allocation leakage violation(s)`);
  process.exit(1);
}
// DEV_CHECK/HOLDOUT must never appear in this output.
const forbiddenSplits = runA.allocated.filter((item) => item.planned_split !== "DEV_TUNE");
if (forbiddenSplits.length > 0) {
  console.error(`BLOCKER: ${forbiddenSplits.length} non-DEV_TUNE record(s) leaked into the Anchor selection`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// -- Anchor selection JSONL + manifest (selection only, no author field). -
const anchorSelectionPath = resolve(outDir, "anchor-selection.v0.1.jsonl");
writeFileSync(anchorSelectionPath, `${runA.selected.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
const anchorSelectionSha256 = sha256File(anchorSelectionPath);

// -- AUTHOR_A/AUTHOR_B allocation JSONL + manifest (full record + fields).
const authorAllocationPath = resolve(outDir, "author-allocation.v0.1.jsonl");
writeFileSync(authorAllocationPath, `${runA.allocated.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
const authorAllocationSha256 = sha256File(authorAllocationPath);

writeFileSync(resolve(outDir, "allocation-balance-report.json"), `${JSON.stringify(runA.balanceReport, null, 2)}\n`, "utf8");
writeFileSync(resolve(outDir, "anchor-slice-report.json"), `${JSON.stringify(runA.sliceReport, null, 2)}\n`, "utf8");

// -- Relation closure review packet JSONL + manifest. ---------------------
const closurePacketPath = resolve(outDir, "relation-closure-review-packet.v0.1.jsonl");
writeFileSync(closurePacketPath, `${runA.packet.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
const closurePacketSha256 = sha256File(closurePacketPath);

// -- Relation Owner decision template (same rows, PENDING, ready for the
// offline review UI's Draft export shape). --------------------------------
const decisionTemplatePath = resolve(outDir, "relation-owner-decision-template.v0.1.jsonl");
const decisionTemplate = runA.packet.map((row) => ({
  relation_candidate_id: row.relation_candidate_id, source_document_id: row.source_document_id, relation_type: row.relation_type,
  owner_disposition: "PENDING", confirmed_target_document_id: null, reviewer: null, reviewed_at: null, notes: "",
}));
writeFileSync(decisionTemplatePath, `${decisionTemplate.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

writeFileSync(resolve(outDir, "leakage-provisional-status-report.json"), `${JSON.stringify({
  chain_leakage: runA.chainLeakage, author_leakage: runA.authorLeakage,
  grouping_status: "PROVISIONAL_HEURISTIC", relation_basis: "TOP_CANDIDATE_PENDING_REVIEW",
  official_split_eligible: false, chain_closure_required: true,
}, null, 2)}\n`, "utf8");
writeFileSync(resolve(outDir, "deterministic-rebuild-report.json"), `${JSON.stringify(deterministicRebuild, null, 2)}\n`, "utf8");

const anchorManifest = {
  schema_version: "0.1.0", status: "ANCHOR_CANDIDATE_SELECTION",
  generated_at: `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
  input_pins: {
    n4_commit: PINNED_N4_COMMIT,
    candidate_pool_sha256: PINNED_POOL_SHA256,
    corpus_snapshot_id: PINNED_CORPUS_SNAPSHOT_ID,
    source_corpus_snapshot_id: PINNED_SOURCE_CORPUS_SNAPSHOT_ID,
    manifest_source_relative_path: "manifest.jsonl",
    corpus_manifest_sha256: sha256File(resolve(corpusRoot, "manifest.jsonl")),
    relation_queue_source_path: portableRelativeTo(REPO_ROOT, relationQueuePath),
    parse_coverage_source_path: portableRelativeTo(REPO_ROOT, parseCoveragePath),
    total_chain_components_verified: components.length,
    max_component_size_verified: maxComponentSize,
  },
  anchor_selection_path: portableRelativeTo(outDir, anchorSelectionPath),
  anchor_selection_sha256: anchorSelectionSha256,
  anchor_selection_count: runA.selected.length,
  target_ideal: 150, target_min: 145, target_max: 155,
  exact_target_reachable: runA.exactTargetReachable,
  total_dev_tune_groups_available: runA.totalDevTuneGroupsAvailable,
  total_dev_tune_records_available: runA.totalDevTuneRecordsAvailable,
  included_group_count: runA.includedGroupIds.length,
  parse_blocked_count: runA.selected.filter((item) => item.authoring_status === "PARSE_BLOCKED").length,
  critical_tag_floors: ANCHOR_CRITICAL_TAG_FLOORS,
  critical_tag_shortfalls: runA.criticalTagShortfalls,
  author_allocation_path: portableRelativeTo(outDir, authorAllocationPath),
  author_allocation_sha256: authorAllocationSha256,
  author_allocation_used: runA.used,
  author_allocation_difference: runA.difference,
  relation_closure_review_packet_path: portableRelativeTo(outDir, closurePacketPath),
  relation_closure_review_packet_sha256: closurePacketSha256,
  relation_closure_hop0_count: runA.hop0Count,
  relation_closure_hop1_count: runA.hop1Count,
  relation_closure_total_count: runA.totalCount,
  relation_owner_decision_template_path: portableRelativeTo(outDir, decisionTemplatePath),
  deterministic_rebuild: deterministicRebuild,
  chain_leakage_status: runA.chainLeakage.ok ? "PASS" : "FAIL",
  author_leakage_status: runA.authorLeakage.ok ? "PASS" : "FAIL",
  grouping_status: "PROVISIONAL_HEURISTIC",
  relation_basis: "TOP_CANDIDATE_PENDING_REVIEW",
  leakage_report_scope: "CURRENT_PROVISIONAL_GRAPH_ONLY",
  official_split_eligible: false,
  chain_closure_required: true,
  dev_check_holdout_included: false,
  gold_status: "NOT_STARTED",
};
writeFileSync(resolve(outDir, "anchor-selection.v0.1.manifest.json"), `${JSON.stringify(anchorManifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  status: "PASS",
  out_dir: outDir,
  anchor_count: runA.selected.length,
  author_used: runA.used,
  author_difference: runA.difference,
  total_chain_components: components.length,
  max_component_size: maxComponentSize,
  relation_closure_hop0: runA.hop0Count,
  relation_closure_hop1: runA.hop1Count,
  relation_closure_total: runA.totalCount,
  deterministic_rebuild: deterministicRebuild.status,
}, null, 2));
