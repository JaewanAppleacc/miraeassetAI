#!/usr/bin/env node
// Turn N4.0: CLI wrapper around domain/evaluation/candidate-pool-builder.mjs
// -- reads the real corpus manifest, the real AMENDS/TERMINATES relation
// candidate queue, and the real document parse-coverage file, and writes
// the resulting Candidate Pool + reports under work/domain-seed/ (gitignored
// -- never the raw corpus, never a manifest copy). Every output is
// CANDIDATE/PROVISIONAL -- this script never marks anything as official
// Gold, Owner-approved, or a locked lifecycle state.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCandidateDrafts,
  buildChainComponents,
  assignEvaluationGroups,
  selectCandidatePool,
  assignProvisionalSplits,
  markParseBlocked,
  computeSliceInventory,
  computeLeakageReport,
  canonicalDigest,
} from "../domain/evaluation/candidate-pool-builder.mjs";

const corpusRoot = resolve(process.argv[2] ?? process.env.DISCLOSURE_CORPUS_ROOT ?? "");
const relationQueuePath = resolve(process.argv[3] ?? "work/domain-seed/relation-review-queue.jsonl");
const parseCoveragePath = resolve(process.argv[4] ?? "work/domain-seed/document-parse-coverage.jsonl");
const outDir = resolve(process.argv[5] ?? "work/domain-seed/candidate-pool-v0.4.1");

// Turn N4.0.1: absolute, user/machine-specific paths (e.g. `/Users/<name>/...`)
// must never be written into a manifest/report a reader treats as portable.
// REPO_ROOT is used to express repo-internal inputs (relation queue, parse
// coverage) relative to the repository; OUT_DIR is used to express this
// run's own outputs relative to itself. The real corpus root
// (DISCLOSURE_CORPUS_ROOT) is never written anywhere -- only
// manifest_sha256 (already the real portable identity anchor) and the
// corpus-root-relative constant "manifest.jsonl" are recorded for it.
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function toPosix(p) { return p.split(path.sep).join("/"); }
function portableRelativeTo(baseDir, absPath) {
  const rel = path.relative(baseDir, absPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

if (!corpusRoot || !existsSync(resolve(corpusRoot, "manifest.jsonl"))) {
  console.error("Usage: node scripts/build-evaluation-candidate-pool-v040.mjs <corpus-root> [relation-queue-path] [parse-coverage-path] [out-dir]");
  process.exit(2);
}

function readJsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const manifestPath = resolve(corpusRoot, "manifest.jsonl");
const manifestRows = readJsonl(manifestPath);
const relationCandidates = existsSync(relationQueuePath) ? readJsonl(relationQueuePath) : [];
const parseCoverageRows = existsSync(parseCoveragePath) ? readJsonl(parseCoveragePath) : [];
const parseCoverageByDocumentId = new Map(parseCoverageRows.map((row) => [row.document_id, row.state]));

const TARGET_MIN = 300;
const TARGET_MAX = 500;
const SPLIT_TARGETS = { DEV_TUNE: 150, DEV_CHECK: 50, HOLDOUT: 100 };
// Tag-keyed only (never company/document-keyed) -- see selectCandidatePool's
// own comment for why this exists: a plain stable-hash walk can sample a
// rare-but-real critical slice (e.g. only 20 real TERMINATES candidates in
// the whole corpus) down to zero purely by chance.
const CRITICAL_TAG_FLOORS = {
  termination: 10, correction_chain: 20, zero_document: 5, withheld_candidate: 10,
  cross_company: 10, same_company_different_period: 10, investment_judgement: 5,
  holding_within_report_change: 10,
};

function runOnce() {
  const drafts = generateCandidateDrafts({ manifestRows });
  const { docToComponentId, components, relationEdges } = buildChainComponents({ drafts, relationCandidates });
  const grouped = assignEvaluationGroups({ drafts, docToComponentId });
  const { selected, includedGroupIds, oversizedComponents, criticalTagShortfalls, totalGroupsAvailable } = selectCandidatePool({
    groupedDrafts: grouped, targetMin: TARGET_MIN, targetMax: TARGET_MAX, criticalTagFloors: CRITICAL_TAG_FLOORS,
  });
  const { assigned: assignedRaw, used } = assignProvisionalSplits({ selected, targets: SPLIT_TARGETS });
  const assigned = markParseBlocked({ assigned: assignedRaw, parseCoverageByDocumentId });
  const sliceInventory = computeSliceInventory({ assigned, parseCoverageByDocumentId });
  const leakageReport = computeLeakageReport({ assigned });
  return { drafts, components, grouped, selected, includedGroupIds, oversizedComponents, criticalTagShortfalls, totalGroupsAvailable, assigned, used, sliceInventory, leakageReport };
}

// Determinism check: build twice from the same in-memory input, compare digests.
const runA = runOnce();
const runB = runOnce();
const digestA = canonicalDigest(runA.assigned);
const digestB = canonicalDigest(runB.assigned);
const deterministicRebuild = {
  status: digestA === digestB ? "PASS" : "FAIL",
  digest_run_a: digestA,
  digest_run_b: digestB,
};
if (deterministicRebuild.status !== "PASS") {
  console.error("BLOCKER: candidate pool build is not deterministic across two in-memory runs of the same input");
  process.exit(1);
}
if (!runA.leakageReport.ok) {
  console.error(`BLOCKER: ${runA.leakageReport.violations.length} leakage violation(s) found -- refusing to write output`);
  console.error(JSON.stringify(runA.leakageReport.violations.slice(0, 10), null, 2));
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const poolPath = resolve(outDir, "candidate-pool.v0.1.jsonl");
const poolText = `${runA.assigned.map((item) => JSON.stringify({
  ...item,
  known_chain_ids: [],
  authoring_status: item.authoring_status ?? "DRAFT_NEEDS_SOURCE_LOCATOR",
  gold_status: "NOT_STARTED",
  dependencies: [...new Set([...item.content_dependencies, ...item.split_dependencies])],
})).join("\n")}\n`;
writeFileSync(poolPath, poolText, "utf8");
const poolSha256 = sha256File(poolPath);

const manifestSha256 = sha256File(manifestPath);
// Portable path fields only -- never an absolute, user/machine-specific
// path. candidate_pool_path is relative to THIS manifest's own directory
// (works regardless of where outDir is mounted); the two repo-tracked
// inputs are relative to the repository root; the corpus manifest's real
// location (DISCLOSURE_CORPUS_ROOT, always external/private) is
// deliberately never recorded -- only its corpus-root-relative constant
// name and its sha256 (the real portable identity anchor) are.
const manifestOut = {
  schema_version: "0.1.0",
  status: "CANDIDATE_POOL",
  generated_at: new Date().toISOString().slice(0, 10) + "T00:00:00Z", // date-only precision keeps reruns comparable; exact digest is what determinism actually pins
  corpus_snapshot_id: "corpus_04750795e1a2d5c3",
  source_corpus_snapshot_id: "snap_7484a10220422056",
  manifest_source_relative_path: "manifest.jsonl",
  manifest_sha256: manifestSha256,
  candidate_pool_path: portableRelativeTo(outDir, poolPath),
  candidate_pool_sha256: poolSha256,
  candidate_pool_record_count: runA.assigned.length,
  relation_queue_source_path: portableRelativeTo(REPO_ROOT, relationQueuePath),
  parse_coverage_source_path: portableRelativeTo(REPO_ROOT, parseCoveragePath),
  target_min: TARGET_MIN,
  target_max: TARGET_MAX,
  split_targets: SPLIT_TARGETS,
  split_actual: runA.used,
  total_chain_components: runA.components.length,
  included_groups: runA.includedGroupIds.length,
  oversized_components_kept_whole: runA.oversizedComponents,
  critical_tag_floors: CRITICAL_TAG_FLOORS,
  critical_tag_shortfalls: runA.criticalTagShortfalls,
  max_component_size: Math.max(...runA.components.map((c) => c.member_document_ids.length)),
  deterministic_rebuild: deterministicRebuild,
  leakage_report_status: runA.leakageReport.ok ? "PASS" : "FAIL",
  // Turn N4.0.1: precise, non-overclaiming grouping-guarantee scope --
  // see domain/evaluation/CHAIN_SAFE_GROUPING_CONTRACT.v1.md.
  grouping_status: "PROVISIONAL_HEURISTIC",
  relation_basis: "TOP_CANDIDATE_PENDING_REVIEW",
  leakage_report_scope: "CURRENT_PROVISIONAL_GRAPH_ONLY",
  official_split_eligible: false,
  chain_closure_required: true,
};
writeFileSync(resolve(outDir, "candidate-pool.v0.1.manifest.json"), `${JSON.stringify(manifestOut, null, 2)}\n`, "utf8");
writeFileSync(resolve(outDir, "slice-coverage-report.json"), `${JSON.stringify(runA.sliceInventory, null, 2)}\n`, "utf8");
writeFileSync(resolve(outDir, "leakage-report.json"), `${JSON.stringify(runA.leakageReport, null, 2)}\n`, "utf8");
writeFileSync(resolve(outDir, "deterministic-rebuild-report.json"), `${JSON.stringify(deterministicRebuild, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  status: "PASS",
  out_dir: outDir,
  candidate_pool_record_count: runA.assigned.length,
  total_chain_components: runA.components.length,
  by_split: runA.used,
  leakage_violations: runA.leakageReport.violations.length,
  critical_tag_shortfalls: runA.criticalTagShortfalls,
  deterministic_rebuild: deterministicRebuild.status,
}, null, 2));
