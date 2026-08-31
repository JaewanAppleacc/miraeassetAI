#!/usr/bin/env node
// Turn N4.20.2: produces the AUTHORIZED per-author authoring packets
// (v0.2) -- read-only against the v0.1 packets, adding only a computed
// `authoring_status` field per row (via domain/evaluation/gold-300-
// authorization.mjs's rowAuthoringStatus) and re-confirming per-author
// eligible/manual-review/blocked counts against the REAL, recorded Owner
// decision. This script REFUSES to run unless
// gold-300-authoring-owner-decision-recorded-gate-status.v0.2.json shows
// a genuinely verified, real (not chat-pasted) Owner decision.
//
// It still never writes a question, expected_answer, or citation --
// question_status/expected_answer_status/citation_status stay NOT_AUTHORED
// on every row, exactly as in the v0.1 packets. AUTHORING_ALLOWED rows are
// now actionable by their assigned author; MANUAL_REVIEW/BLOCKED rows are
// explicitly marked as not yet startable.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rowAuthoringStatus } from "../domain/evaluation/gold-300-authorization.mjs";
import { REAL_DECISION_PATH } from "./build-gold-300-owner-decision-v0.2-verification-v04202.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function writeJsonl(p, rows) { writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const AUTHORING_V01_DIR = resolve(V02_DIR, "gold-authoring-300-v0.1");
const AUTHORING_V02_DIR = resolve(V02_DIR, "gold-authoring-300-v0.2");
const OWNER_REVIEW_V02_DIR = resolve(AUTHORING_V02_DIR, "owner-review-v0.2");

const PACKET_A_V01_PATH = resolve(AUTHORING_V01_DIR, "author-a-gold-150-authoring-packet.v0.1.jsonl");
const PACKET_B_V01_PATH = resolve(AUTHORING_V01_DIR, "author-b-gold-150-authoring-packet.v0.1.jsonl");
const RECORDED_GATE_STATUS_PATH = resolve(OWNER_REVIEW_V02_DIR, "gold-300-authoring-owner-decision-recorded-gate-status.v0.2.json");

export function buildGold300AuthoringPacketsV02({ generatedAt } = {}) {
  const now = generatedAt ?? new Date().toISOString();

  const gate = readJson(RECORDED_GATE_STATUS_PATH);
  if (!gate.real_decision_verified) throw new Error("buildGold300AuthoringPacketsV02: gate-status does not show real_decision_verified=true -- run ingestGold300OwnerDecisionV02 + verifyAndRecordGold300OwnerDecisionV02 against a real downloaded decision first");
  if (gate.gold_300_plan_authorized !== true || gate.eligible_authoring_authorized !== true) {
    throw new Error(`buildGold300AuthoringPacketsV02: plan is not authorized (gold_300_plan_authorized=${gate.gold_300_plan_authorized}, eligible_authoring_authorized=${gate.eligible_authoring_authorized}) -- refusing to mark any row AUTHORING_ALLOWED`);
  }
  const decision = readJson(REAL_DECISION_PATH);
  if (decision.owner_disposition !== "APPROVE_GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING") throw new Error("buildGold300AuthoringPacketsV02: recorded decision is not a genuine APPROVE");

  const packetABefore = sha256File(PACKET_A_V01_PATH);
  const packetBBefore = sha256File(PACKET_B_V01_PATH);
  const rowsA = readJsonl(PACKET_A_V01_PATH);
  const rowsB = readJsonl(PACKET_B_V01_PATH);
  if (rowsA.length !== 150) throw new Error(`buildGold300AuthoringPacketsV02: AUTHOR_A v0.1 packet must have 150 rows, got ${rowsA.length}`);
  if (rowsB.length !== 150) throw new Error(`buildGold300AuthoringPacketsV02: AUTHOR_B v0.1 packet must have 150 rows, got ${rowsB.length}`);

  function annotate(rows) {
    return rows.map((row) => ({
      ...row,
      authoring_status: rowAuthoringStatus({ authoringEligibility: row.authoring_eligibility, planApproved: true }),
      // Explicit, redundant-by-design HOLDOUT/Agent separation marker on
      // every HOLDOUT row: the DESIGNATED author may write it once its
      // authoring_status allows, but no Agent development/evaluation
      // session may ever read expected_answer/evidence_citations from a
      // HOLDOUT row -- that gate is tracked separately (holdout_agent_
      // access_authorized / holdout_evaluation_authorized), never implied
      // by authoring_status alone.
      agent_access_to_this_row_authorized: false,
    }));
  }
  const annotatedA = annotate(rowsA);
  const annotatedB = annotate(rowsB);

  function statusCounts(rows) {
    const counts = { AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL: 0, MANUAL_REVIEW_REQUIRED_BEFORE_AUTHORING: 0, AUTHORING_BLOCKED: 0 };
    for (const row of rows) counts[row.authoring_status] += 1;
    return counts;
  }
  const countsA = statusCounts(annotatedA);
  const countsB = statusCounts(annotatedB);

  // Cross-check against the REAL recorded decision's own per-author counts
  // -- never just trust this script's own recomputation in isolation.
  if (countsA.AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL !== decision.author_a_immediately_authorizable_count) {
    throw new Error(`buildGold300AuthoringPacketsV02: AUTHOR_A eligible count mismatch (packet ${countsA.AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL} vs decision ${decision.author_a_immediately_authorizable_count})`);
  }
  if (countsB.AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL !== decision.author_b_immediately_authorizable_count) {
    throw new Error(`buildGold300AuthoringPacketsV02: AUTHOR_B eligible count mismatch (packet ${countsB.AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL} vs decision ${decision.author_b_immediately_authorizable_count})`);
  }
  if (countsA.AUTHORING_BLOCKED !== decision.author_a_blocked_count) throw new Error(`buildGold300AuthoringPacketsV02: AUTHOR_A blocked count mismatch (packet ${countsA.AUTHORING_BLOCKED} vs decision ${decision.author_a_blocked_count})`);
  if (countsB.AUTHORING_BLOCKED !== decision.author_b_blocked_count) throw new Error(`buildGold300AuthoringPacketsV02: AUTHOR_B blocked count mismatch (packet ${countsB.AUTHORING_BLOCKED} vs decision ${decision.author_b_blocked_count})`);

  // No actual authoring content anywhere.
  for (const row of [...annotatedA, ...annotatedB]) {
    if (row.question_status !== "NOT_AUTHORED" || row.expected_answer_status !== "NOT_AUTHORED" || row.citation_status !== "NOT_AUTHORED") {
      throw new Error(`buildGold300AuthoringPacketsV02: ${row.assignment_id} has non-NOT_AUTHORED status -- this script must never touch actual authoring content`);
    }
  }

  mkdirSync(AUTHORING_V02_DIR, { recursive: true });
  const pathA = resolve(AUTHORING_V02_DIR, "author-a-gold-150-authoring-packet.v0.2.jsonl");
  const pathB = resolve(AUTHORING_V02_DIR, "author-b-gold-150-authoring-packet.v0.2.jsonl");
  writeJsonl(pathA, annotatedA);
  writeJsonl(pathB, annotatedB);

  const packetABeforeAfter = sha256File(PACKET_A_V01_PATH);
  const packetBBeforeAfter = sha256File(PACKET_B_V01_PATH);

  const manifest = {
    schema_version: "0.1.0", turn: "N4.20.2", generated_at: now,
    status: "AUTHORIZED_PACKETS_READY",
    source_decision_id: decision.decision_id,
    source_decision_sha256: sha256File(REAL_DECISION_PATH),
    v01_packets_unmodified: { author_a: packetABefore === packetABeforeAfter, author_b: packetBBefore === packetBBeforeAfter },
    author_a: { path: "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/author-a-gold-150-authoring-packet.v0.2.jsonl", sha256: sha256File(pathA), row_count: annotatedA.length, status_counts: countsA },
    author_b: { path: "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/author-b-gold-150-authoring-packet.v0.2.jsonl", sha256: sha256File(pathB), row_count: annotatedB.length, status_counts: countsB },
    holdout_authoring_vs_agent_access: {
      note: "Every row's agent_access_to_this_row_authorized is hard-coded false regardless of authoring_status or planned_split. A row's designated author may write a HOLDOUT row once authoring_status allows it; no Agent development/evaluation session may ever read its expected_answer or evidence_citations. This is tracked separately from authoring_status by design.",
      holdout_agent_access_authorized: false,
      holdout_evaluation_authorized: false,
    },
    all_question_answer_citation_status_not_authored: true,
  };
  writeJson(resolve(AUTHORING_V02_DIR, "gold-authoring-300-packet-manifest.v0.2.json"), manifest);

  return Object.freeze({ pathA, pathB, manifest, countsA, countsB });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildGold300AuthoringPacketsV02();
  console.log(JSON.stringify({ status: "V02_AUTHORIZED_PACKETS_BUILT", countsA: result.countsA, countsB: result.countsB, v01_unmodified: result.manifest.v01_packets_unmodified }, null, 2));
}
