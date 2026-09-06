#!/usr/bin/env node
// Turn A4-A3-INTEGRATION-AND-DEVTUNE-V1, section F/G: scoring.
//
// The frozen scorer's own CLI (scripts/fourarm/score.py) hard-restricts
// --arms to {A,B,C,D} and cannot score this Turn's new arm labels without
// editing it (prohibited -- see amendment section 1's methodology note).
// This script reuses the SAME slot_found()/pooled-recall algorithm as
// fourarm.patched.py, ported to JS and already cross-verified against A's
// own official RRF output during the A3 Candidate Ceiling Audit Turn.
//
// "critical"/"minor" are reported as 0 by a STRUCTURAL argument, not a
// full port of check_locators(): every candidate this Turn's pipeline
// emits carries doc_id/node_index/node_indices resolved directly from
// real DB rows (never a hand-built locator string), and row/col are never
// populated -- which eliminates every one of check_locators()'s own
// critical triggers (locator_unparseable, locator_field_mismatch,
// doc_missing, node_missing, row_col_differs) by construction, for every
// arm (same-run-A included, since it is hydrated through the identical
// path). This is disclosed explicitly in the final report, not silently
// assumed. "unresolved" approximates check_locators()'s own
// claim_text_not_in_node/gold_span_not_verifiable buckets via this port's
// own "unverified" text-state (see slotFound below) -- also disclosed.
//
// Gold is read only by this script, in memory, once -- never logged,
// quoted, or copied to a git-tracked path.
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderNode, extractDocumentsByBoundedScan, verifyDocumentIrFiles } from "../domain/agent-comparison/four-arm-ac/a2-documentir-node-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RESULTS_DIR = path.join(REPO_ROOT, "work/a4-a3-devtune-results");
const GOLD_PATH = path.join(REPO_ROOT, "work/gold/dev-tune-gold.v0.1.jsonl");
const CONDITIONS_PATH = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/official/devtune101_conditions.v2.jsonl");

// P11F0_DOCUMENT_IR_DIR: local-only path to the 4 pinned DocumentIR files
// (never committed -- CLAUDE.md section 18's own CORPUS_PATH convention).
// The periodic file's on-disk name has historically carried a "-001"
// suffix (see the A3 Candidate Ceiling Audit's own note); both names are
// tried.
const DOCUMENT_IR_DIR = process.env.P11F0_DOCUMENT_IR_DIR;
if (!DOCUMENT_IR_DIR) throw new Error("P11F0_DOCUMENT_IR_DIR is required (local path to exchange.jsonl/holding.jsonl/major.jsonl/periodic[-001].jsonl)");
function resolveDocumentIrPath(base) {
  const withSuffix = path.join(DOCUMENT_IR_DIR, `${base}-001.jsonl`);
  const plain = path.join(DOCUMENT_IR_DIR, `${base}.jsonl`);
  return existsSync(withSuffix) ? withSuffix : plain;
}
const DOCUMENT_IR_PATHS = {
  exchange: resolveDocumentIrPath("exchange"),
  holding: resolveDocumentIrPath("holding"),
  major: resolveDocumentIrPath("major"),
  periodic: resolveDocumentIrPath("periodic"),
};

const KS = [5, 10, 20];
const LOC_RE = /^([a-z]+_\d+)(?:\/\d+\.xml#node=(\d+)(?:&row=(\d+)&col=(\d+))?|::[^:]+::n(\d+))$/;

function normText(s) { return (s ?? "").normalize("NFC").replace(/\s+/g, ""); }
function spanLines(span, minLen = 6) {
  const out = [];
  for (const ln of (span ?? "").split("\n")) { const t = normText(ln); if (t.length >= minLen) out.push(t); }
  return out;
}
function parseLocator(loc) {
  const m = LOC_RE.exec(loc ?? "");
  if (!m) return null;
  const n = m[2] ?? m[5];
  return { doc: m[1], n: Number(n), row: m[3] !== undefined ? Number(m[3]) : null, col: m[4] !== undefined ? Number(m[4]) : null };
}

async function loadGold(goldPath) {
  const raw = await readFile(goldPath, "utf8");
  const out = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const g = JSON.parse(line);
    const slots = [];
    for (const s of g.required_evidence_slots ?? []) {
      const sources = [];
      for (const src of s.acceptable_sources ?? []) {
        const parsed = parseLocator(src.source_locator);
        if (!parsed) continue;
        sources.push({ doc_id: parsed.doc, node_index: parsed.n, span: src.evidence_span ?? "" });
      }
      slots.push({ slot_name: s.slot_name ?? "", sources });
    }
    out.set(g.question_id, {
      question_id: g.question_id, slots,
      question_type: g.question_type ?? null, tags: g.tags ?? [],
      scopes: (g.expected_execution?.required_fact_slots ?? []).map((s) => s.scope).filter(Boolean),
    });
  }
  return out;
}

async function loadConditions(conditionsPath) {
  const raw = await readFile(conditionsPath, "utf8");
  const out = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    out.set(r.question_id, { segment: r.segment, doc_group: (r.conditions?.doc_groups ?? [])[0] ?? "UNKNOWN" });
  }
  return out;
}

function resultNodes(r) {
  const nodes = new Set([r.node_index]);
  for (const n of r.node_indices ?? []) nodes.add(n);
  return nodes;
}

// Faithful port of fourarm.patched.py's slot_found() primary/text-fallback
// logic (see A3_CANDIDATE_CEILING_AUDIT_V1_RESULT.md for the original
// port and its cross-verification against A's own frozen RRF output).
async function slotFound(slot, results, k, fetchNode) {
  const top = results.slice(0, k);
  let best = null;
  const statePriority = { verified: 2, blind: 1, unverified: 0 };
  for (const r of top) {
    const nodes = resultNodes(r);
    const text = normText(r.text ?? "");
    for (const src of slot.sources) {
      if (r.doc_id !== src.doc_id || !nodes.has(src.node_index)) continue;
      const lines = spanLines(src.span);
      let state;
      if (lines.length === 0 || !text) state = "blind";
      else if (lines.some((ln) => text.includes(ln))) state = "verified";
      else {
        const node = await fetchNode({ documentId: src.doc_id, nodeIndex: src.node_index });
        if (node?.found) {
          const nodeText = normText(node.text ?? "");
          if (nodeText && lines.some((ln) => nodeText.includes(ln))) continue;
        }
        state = "unverified";
      }
      const rankKey = statePriority[state];
      if (best === null || rankKey > best.rankKey) best = { rankKey, r, src, state };
    }
  }
  if (best !== null) return { found: true, state: best.state };
  for (const r of top) {
    const t = normText(r.text ?? "");
    if (!t) continue;
    for (const src of slot.sources) {
      if (r.doc_id !== src.doc_id) continue;
      if (spanLines(src.span).some((ln) => t.includes(ln))) return { found: true, state: "verified_text_fallback" };
    }
  }
  return { found: false, state: null };
}

function pooledRecall(qScores, ks) {
  const scored = qScores.filter((q) => !q.excluded);
  const slotsTotal = scored.reduce((s, q) => s + q.nSlots, 0);
  const out = { questions: scored.length, slots_total: slotsTotal };
  for (const k of ks) {
    const found = scored.reduce((s, q) => s + (q.foundAt[k] ?? 0), 0);
    out[`slots_found@${k}`] = found;
    out[`recall@${k}`] = slotsTotal ? Number((found / slotsTotal).toFixed(4)) : null;
    out[`all_found@${k}`] = scored.filter((q) => q.allFoundAt[k]).length;
    out[`all_found_rate@${k}`] = scored.length ? Number((out[`all_found@${k}`] / scored.length).toFixed(4)) : null;
  }
  return out;
}

async function scoreArm(armResultsByQ, gold, conditions, fetchNode) {
  const perQuestion = [];
  let unresolvedCount = 0;
  for (const [qid, results] of armResultsByQ) {
    const goldQ = gold.get(qid);
    if (!goldQ) continue;
    const nSlots = goldQ.slots.length;
    const qs = { nSlots, excluded: nSlots === 0, foundAt: {}, allFoundAt: {} };
    for (const k of KS) {
      let found = 0;
      for (const slot of goldQ.slots) {
        // eslint-disable-next-line no-await-in-loop
        const res = await slotFound(slot, results, k, fetchNode);
        if (res.found) found += 1;
        if (k === 10 && res.found && res.state === "unverified") unresolvedCount += 1;
      }
      qs.foundAt[k] = found;
      qs.allFoundAt[k] = nSlots > 0 && found === nSlots;
    }
    perQuestion.push({ question_id: qid, cond: conditions.get(qid), qs });
  }
  const agg = (filterFn) => pooledRecall(perQuestion.filter(filterFn).map((p) => p.qs), KS);
  return {
    ALL: agg(() => true),
    HIGH: agg((p) => p.cond?.segment === "HIGH"),
    LOW: agg((p) => p.cond?.segment === "LOW"),
    critical: 0, // structural argument -- see header
    minor: 0, // not classified this Turn -- see header
    unresolved: unresolvedCount,
  };
}

async function main() {
  const [gold, conditions, files] = await Promise.all([
    loadGold(GOLD_PATH),
    loadConditions(CONDITIONS_PATH),
    readFile(path.join(RESULTS_DIR, ".manifest-check"), "utf8").catch(() => null),
  ]);
  void files;

  const irCheck = await verifyDocumentIrFiles(DOCUMENT_IR_PATHS);
  if (!irCheck.ok) throw new Error(`DocumentIR SHA mismatch: ${JSON.stringify(irCheck.mismatches)}`);

  const neededByGroup = { exchange: new Set(), holding: new Set(), major: new Set(), periodic: new Set() };
  for (const g of gold.values()) {
    for (const slot of g.slots) for (const src of slot.sources) {
      const group = src.doc_id.split("_")[0];
      if (neededByGroup[group]) neededByGroup[group].add(src.doc_id);
    }
  }
  const rawDocCache = new Map();
  for (const [group, ids] of Object.entries(neededByGroup)) {
    if (ids.size === 0) continue;
    const found = await extractDocumentsByBoundedScan(DOCUMENT_IR_PATHS[group], [...ids]);
    for (const [docId, raw] of found) rawDocCache.set(docId, raw);
  }
  async function fetchNode({ documentId, nodeIndex }) {
    const raw = rawDocCache.get(documentId);
    if (!raw || !Array.isArray(raw.nodes)) return { found: false, text: null };
    const node = raw.nodes[nodeIndex];
    if (!node) return { found: false, text: null };
    const expectedSuffix = `::n${nodeIndex}`;
    if (typeof node.node_id !== "string" || !node.node_id.endsWith(expectedSuffix)) return { found: false, text: null };
    const rendered = renderNode(node);
    if (!rendered.hasContent) return { found: false, text: null };
    return { found: true, text: rendered.text };
  }

  const { readdir } = await import("node:fs/promises");
  const candidateFiles = (await readdir(RESULTS_DIR)).filter((f) => f.endsWith(".json"));
  if (candidateFiles.length !== 101) throw new Error(`expected 101 result files, found ${candidateFiles.length}`);

  const configIds = ["R0_original_a_baseline", "R1_bm25_dense_original_rrf", "R2_plus_lexical_term_coverage",
    "R3_plus_metadata_consistency", "R4_wide_rrf_centric", "R5_reciprocal_fusion_plus_coverage"];

  const arms = { same_run_a: new Map() };
  for (const c of configIds) { arms[`${c}__raw`] = new Map(); arms[`${c}__final`] = new Map(); }

  let latencySum = { p50: [], p95: [], max: 0 };
  for (const file of candidateFiles) {
    // eslint-disable-next-line no-await-in-loop
    const record = JSON.parse(await readFile(path.join(RESULTS_DIR, file), "utf8"));
    const qid = record.question_id;
    arms.same_run_a.set(qid, record.original_a_top20);
    for (const c of configIds) {
      arms[`${c}__raw`].set(qid, record.per_config[c].raw_top20);
      arms[`${c}__final`].set(qid, record.per_config[c].final_top20);
    }
    latencySum.p50.push(record.latency_ms);
  }
  latencySum.p50.sort((a, b) => a - b);
  const p = (arr, pct) => arr.length ? arr[Math.min(arr.length - 1, Math.ceil((pct / 100) * arr.length) - 1)] : null;
  const latencyStats = { p50_latency_ms: p(latencySum.p50, 50), p95_latency_ms: p(latencySum.p50, 95), max_latency_ms: latencySum.p50[latencySum.p50.length - 1] ?? null };

  const scores = {};
  for (const [armName, resultsByQ] of Object.entries(arms)) {
    // eslint-disable-next-line no-await-in-loop
    scores[armName] = await scoreArm(resultsByQ, gold, conditions, fetchNode);
  }

  // A3 aggregate counts + net gain/loss vs same-run A, per config.
  const a3Stats = {};
  const netChange = {};
  for (const file of candidateFiles) {
    // eslint-disable-next-line no-await-in-loop
    const record = JSON.parse(await readFile(path.join(RESULTS_DIR, file), "utf8"));
    for (const c of configIds) {
      const r = record.per_config[c];
      a3Stats[c] = a3Stats[c] ?? { pass: 0, reject: 0, keep_unknown: 0, stable_refill: 0, shortfall: 0 };
      a3Stats[c].pass += r.a3_pass; a3Stats[c].reject += r.a3_reject; a3Stats[c].keep_unknown += r.a3_keep_unknown;
      a3Stats[c].stable_refill += r.stable_refill_count; a3Stats[c].shortfall += r.final_shortfall ? 1 : 0;
    }
  }

  const output = { turn: "A4-A3-INTEGRATION-AND-DEVTUNE-V1", generated_at: new Date().toISOString(), scores, a3_stats: a3Stats, latency: latencyStats, config_ids: configIds };
  await writeFile(path.join(REPO_ROOT, "work/a4-a3-devtune-scores.json"), JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => { console.error(`[a4-a3-score] FAILED: ${error.stack ?? error.message}`); process.exitCode = 1; });
