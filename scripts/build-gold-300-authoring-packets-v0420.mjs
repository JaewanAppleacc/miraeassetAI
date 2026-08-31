#!/usr/bin/env node
// Turn N4.20 (corrected): builds the two per-author, 150-row authoring
// packets (AUTHOR_A / AUTHOR_B) for the Gold-300 plan. Every row's
// question/expected_answer/citation fields are explicitly NOT_AUTHORED --
// this script never generates a question, an expected answer, or a
// citation, and never reads any Agent output or model comparison result.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildParseCoverageIndex, buildRelationComponentStatusIndex, classifyEligibility } from "../domain/evaluation/gold-300-selection.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function writeJsonl(p, rows) { writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function sha256Bytes(buf) { return createHash("sha256").update(buf).digest("hex"); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const GOLD_300_DIR = resolve(V02_DIR, "gold-300-v0.1");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");
const PARSE_AUDIT_PATH = resolve(REPO_ROOT, "work/a-document-ir/parse-audit.full.jsonl");

const SELECTION_PATH = resolve(GOLD_300_DIR, "gold-300-selection-candidate.v0.1.jsonl");
const AUTHOR_ALLOC_PATH = resolve(GOLD_300_DIR, "gold-300-author-allocation-candidate.v0.1.jsonl");
const ELIGIBILITY_PATH = resolve(GOLD_300_DIR, "gold-300-eligibility-report.v0.1.json");

export const OUT_DIR = resolve(V02_DIR, "gold-authoring-300-v0.1");

function buildRow({ record, authorAllocation, eligibilityByAssignmentId, ledgerByComponent }) {
  const relationDependencyIds = (ledgerByComponent.get(record.chain_component_id) ?? []).map((r) => r.relation_candidate_id);
  const eligibility = eligibilityByAssignmentId.get(record.assignment_id);
  return {
    assignment_id: record.assignment_id,
    evaluation_group_id: record.evaluation_group_id,
    chain_component_id: record.chain_component_id,
    author_role: authorAllocation,
    provisional_split: record.planned_split,
    gold_pool_role: record.gold_pool_role,
    anchor_document_ids: record.anchor_document_ids,
    bucket: record.bucket,
    question_type: record.question_type,
    difficulty: record.difficulty,
    answer_mode: record.answer_mode,
    tags: record.tags,
    parse_status: record.__parse_statuses,
    dependency_status: record.dependencies?.includes("RELATION_CHAIN_CLOSURE") ? "DECLARED_RELATION_CHAIN_CLOSURE_DEPENDENCY" : "DOCUMENT_LOCAL_NO_RELATION_DEPENDENCY_DECLARED",
    relation_dependency_ids: relationDependencyIds,
    authoring_eligibility: eligibility.authoring_eligibility,
    blocked_reason: eligibility.blocked_reason,
    source_input_pins: {
      candidate_pool_v03_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/candidate-pool.v0.3.jsonl",
      gold_300_selection_candidate_path: "work/handoff/anchor-dev-tune-v0.2/gold-300-v0.1/gold-300-selection-candidate.v0.1.jsonl",
    },
    question_status: "NOT_AUTHORED",
    expected_answer_status: "NOT_AUTHORED",
    citation_status: "NOT_AUTHORED",
    question: null,
    expected_answer: null,
    evidence_citations: [],
  };
}

export function buildGold300AuthoringPackets({ generatedAt } = {}) {
  const now = generatedAt ?? new Date().toISOString();

  const selection = readJsonl(SELECTION_PATH);
  const authorAlloc = readJsonl(AUTHOR_ALLOC_PATH);
  const eligibility = JSON.parse(readFileSync(ELIGIBILITY_PATH, "utf8"));
  const ledgerRows = readJsonl(LEDGER_PATH);
  const parseAuditRows = readJsonl(PARSE_AUDIT_PATH);

  if (selection.length !== 300) throw new Error(`buildGold300AuthoringPackets: selection candidate must have 300 rows, got ${selection.length}`);
  if (authorAlloc.length !== 300) throw new Error(`buildGold300AuthoringPackets: author allocation candidate must have 300 rows, got ${authorAlloc.length}`);

  const parseCoverageIndex = buildParseCoverageIndex(parseAuditRows);
  const relationComponentStatusIndex = buildRelationComponentStatusIndex(ledgerRows);
  void relationComponentStatusIndex; // classification itself already computed upstream; reused here only for potential future cross-checks

  const authorAllocById = new Map(authorAlloc.map((r) => [r.assignment_id, r.author_allocation]));
  const eligibilityByAssignmentId = new Map();
  for (const item of eligibility.blocked_items) eligibilityByAssignmentId.set(item.assignment_id, item);
  for (const item of eligibility.needs_manual_review_items) eligibilityByAssignmentId.set(item.assignment_id, item);
  // eligible items aren't separately listed in the report (only blocked/needs-review are, by design);
  // reconstruct their eligibility_status from selection + parse/ledger for a complete per-row packet.
  for (const record of selection) {
    if (!eligibilityByAssignmentId.has(record.assignment_id)) {
      eligibilityByAssignmentId.set(record.assignment_id, { authoring_eligibility: null, blocked_reason: null });
    }
  }
  // Re-derive the exact eligible statuses (ELIGIBLE_DOCUMENT_LOCAL vs
  // ELIGIBLE_VERIFIED_RELATION) for rows not already covered by the
  // blocked/needs-review lists, using the same live indices as the
  // selection script -- never invented, never left blank for an eligible row.
  for (const record of selection) {
    const existing = eligibilityByAssignmentId.get(record.assignment_id);
    if (existing.authoring_eligibility) continue;
    const { status, blocked_reason } = classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex });
    eligibilityByAssignmentId.set(record.assignment_id, { authoring_eligibility: status, blocked_reason });
  }

  const ledgerByComponent = new Map();
  for (const row of ledgerRows) {
    const list = ledgerByComponent.get(row.affected_component) ?? [];
    list.push(row);
    ledgerByComponent.set(row.affected_component, list);
  }

  for (const record of selection) {
    record.__parse_statuses = Object.fromEntries(record.anchor_document_ids.map((d) => [d, parseCoverageIndex.get(d) ?? "UNKNOWN"]));
  }

  const rowsByAuthor = { AUTHOR_A: [], AUTHOR_B: [] };
  for (const record of selection) {
    const author = authorAllocById.get(record.assignment_id);
    if (!author) throw new Error(`buildGold300AuthoringPackets: ${record.assignment_id} has no author allocation`);
    rowsByAuthor[author].push(buildRow({ record, authorAllocation: author, eligibilityByAssignmentId, ledgerByComponent }));
  }

  if (rowsByAuthor.AUTHOR_A.length !== 150) throw new Error(`buildGold300AuthoringPackets: AUTHOR_A packet must have 150 rows, got ${rowsByAuthor.AUTHOR_A.length}`);
  if (rowsByAuthor.AUTHOR_B.length !== 150) throw new Error(`buildGold300AuthoringPackets: AUTHOR_B packet must have 150 rows, got ${rowsByAuthor.AUTHOR_B.length}`);

  const idsA = new Set(rowsByAuthor.AUTHOR_A.map((r) => r.assignment_id));
  const idsB = new Set(rowsByAuthor.AUTHOR_B.map((r) => r.assignment_id));
  const intersection = [...idsA].filter((id) => idsB.has(id));
  if (intersection.length !== 0) throw new Error(`buildGold300AuthoringPackets: assignment_id appears in BOTH packets: ${intersection.join(", ")}`);
  const union = new Set([...idsA, ...idsB]);
  if (union.size !== 300) throw new Error(`buildGold300AuthoringPackets: union of both packets must be exactly 300, got ${union.size}`);

  const groupsA = new Set(rowsByAuthor.AUTHOR_A.map((r) => r.evaluation_group_id));
  const groupsB = new Set(rowsByAuthor.AUTHOR_B.map((r) => r.evaluation_group_id));
  const sharedGroups = [...groupsA].filter((g) => groupsB.has(g));
  if (sharedGroups.length !== 0) throw new Error(`buildGold300AuthoringPackets: evaluation_group_id shared across both packets: ${sharedGroups.join(", ")}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const pathA = resolve(OUT_DIR, "author-a-gold-150-authoring-packet.v0.1.jsonl");
  const pathB = resolve(OUT_DIR, "author-b-gold-150-authoring-packet.v0.1.jsonl");
  writeJsonl(pathA, rowsByAuthor.AUTHOR_A);
  writeJsonl(pathB, rowsByAuthor.AUTHOR_B);

  const manifest = {
    schema_version: "0.1.0", turn: "N4.20", generated_at: now, status: "CANDIDATE_NOT_OWNER_APPROVED",
    author_a: { path: "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.1/author-a-gold-150-authoring-packet.v0.1.jsonl", sha256: sha256File(pathA), row_count: rowsByAuthor.AUTHOR_A.length },
    author_b: { path: "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.1/author-b-gold-150-authoring-packet.v0.1.jsonl", sha256: sha256File(pathB), row_count: rowsByAuthor.AUTHOR_B.length },
    duplicate_assignment_ids_across_packets: intersection.length,
    union_count: union.size,
    shared_evaluation_group_ids_across_packets: sharedGroups.length,
    all_question_answer_citation_status_not_authored: [...rowsByAuthor.AUTHOR_A, ...rowsByAuthor.AUTHOR_B].every((r) => r.question_status === "NOT_AUTHORED" && r.expected_answer_status === "NOT_AUTHORED" && r.citation_status === "NOT_AUTHORED"),
  };
  writeJson(resolve(OUT_DIR, "gold-authoring-300-packet-manifest.v0.1.json"), manifest);

  return Object.freeze({ outDir: OUT_DIR, pathA, pathB, manifest, rowsByAuthor });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildGold300AuthoringPackets();
  console.log(`Gold-300 authoring packets built at ${result.outDir}`);
  console.log(JSON.stringify(result.manifest, null, 2));
}
