#!/usr/bin/env node
// Turn A4-A3-INTEGRATION-AND-DEVTUNE-V1, section G supplementary: per-slot
// net gain/loss of same_run_a vs the winning config's __final arm at k=10,
// plus how many A3-REJECTed candidates in the raw top-20 would otherwise
// have caused a slot-level false hit (approximated: none, since REJECT
// only fires on evidence that already failed dimension checks -- reported
// as a count of REJECTed candidates that were also a slot_found() match,
// which by definition cannot happen for a genuinely correct slot match
// unless the extraction mis-fired; used here purely as an A3-side-effect
// audit, not a critical-count claim).
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderNode, extractDocumentsByBoundedScan, verifyDocumentIrFiles } from "../domain/agent-comparison/four-arm-ac/a2-documentir-node-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RESULTS_DIR = path.join(REPO_ROOT, "work/a4-a3-devtune-results");
const GOLD_PATH = path.join(REPO_ROOT, "work/gold/dev-tune-gold.v0.1.jsonl");
const WINNING_CONFIG = "R4_wide_rrf_centric";

// P11F0_DOCUMENT_IR_DIR: local-only path to the 4 pinned DocumentIR files
// (never committed -- CLAUDE.md section 18's own CORPUS_PATH convention).
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
const LOC_RE = /^([a-z]+_\d+)(?:\/\d+\.xml#node=(\d+)(?:&row=(\d+)&col=(\d+))?|::[^:]+::n(\d+))$/;
function normText(s) { return (s ?? "").normalize("NFC").replace(/\s+/g, ""); }
function spanLines(span, minLen = 6) { const out = []; for (const ln of (span ?? "").split("\n")) { const t = normText(ln); if (t.length >= minLen) out.push(t); } return out; }
function parseLocator(loc) { const m = LOC_RE.exec(loc ?? ""); if (!m) return null; const n = m[2] ?? m[5]; return { doc: m[1], n: Number(n) }; }
function resultNodes(r) { const nodes = new Set([r.node_index]); for (const n of r.node_indices ?? []) nodes.add(n); return nodes; }

async function loadGold(goldPath) {
  const raw = await readFile(goldPath, "utf8");
  const out = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const g = JSON.parse(line);
    const slots = [];
    for (const s of g.required_evidence_slots ?? []) {
      const sources = [];
      for (const src of s.acceptable_sources ?? []) { const parsed = parseLocator(src.source_locator); if (parsed) sources.push({ doc_id: parsed.doc, node_index: parsed.n, span: src.evidence_span ?? "" }); }
      slots.push({ slot_name: s.slot_name ?? "", sources });
    }
    out.set(g.question_id, { slots });
  }
  return out;
}

async function slotFound(slot, results, k, fetchNode) {
  const top = results.slice(0, k);
  for (const r of top) {
    const nodes = resultNodes(r);
    const text = normText(r.text ?? "");
    for (const src of slot.sources) {
      if (r.doc_id !== src.doc_id || !nodes.has(src.node_index)) continue;
      const lines = spanLines(src.span);
      if (lines.length === 0 || !text) return true;
      if (lines.some((ln) => text.includes(ln))) return true;
      const node = await fetchNode({ documentId: src.doc_id, nodeIndex: src.node_index });
      if (node?.found) { const nodeText = normText(node.text ?? ""); if (nodeText && lines.some((ln) => nodeText.includes(ln))) continue; }
      return true; // unverified still counts as found, matching the main scorer
    }
  }
  for (const r of top) {
    const t = normText(r.text ?? "");
    if (!t) continue;
    for (const src of slot.sources) { if (r.doc_id === src.doc_id && spanLines(src.span).some((ln) => t.includes(ln))) return true; }
  }
  return false;
}

async function main() {
  const gold = await loadGold(GOLD_PATH);
  const irCheck = await verifyDocumentIrFiles(DOCUMENT_IR_PATHS);
  if (!irCheck.ok) throw new Error("DocumentIR mismatch");
  const neededByGroup = { exchange: new Set(), holding: new Set(), major: new Set(), periodic: new Set() };
  for (const g of gold.values()) for (const slot of g.slots) for (const src of slot.sources) { const grp = src.doc_id.split("_")[0]; if (neededByGroup[grp]) neededByGroup[grp].add(src.doc_id); }
  const rawDocCache = new Map();
  for (const [group, ids] of Object.entries(neededByGroup)) { if (!ids.size) continue; const found = await extractDocumentsByBoundedScan(DOCUMENT_IR_PATHS[group], [...ids]); for (const [d, r] of found) rawDocCache.set(d, r); }
  async function fetchNode({ documentId, nodeIndex }) {
    const raw = rawDocCache.get(documentId); if (!raw?.nodes) return { found: false };
    const node = raw.nodes[nodeIndex]; if (!node || !node.node_id?.endsWith(`::n${nodeIndex}`)) return { found: false };
    const rendered = renderNode(node); return rendered.hasContent ? { found: true, text: rendered.text } : { found: false };
  }

  const files = (await readdir(RESULTS_DIR)).filter((f) => f.endsWith(".json"));
  let gainedSlots = 0, lostSlots = 0, sameSlots = 0, rejectedTruePositives = 0;
  for (const file of files) {
    const record = JSON.parse(await readFile(path.join(RESULTS_DIR, file), "utf8"));
    const goldQ = gold.get(record.question_id);
    if (!goldQ) continue;
    const aTop10 = record.original_a_top20.slice(0, 10);
    const r4Final = record.per_config[WINNING_CONFIG].final_top20.slice(0, 10);
    for (const slot of goldQ.slots) {
      // eslint-disable-next-line no-await-in-loop
      const inA = await slotFound(slot, aTop10, 10, fetchNode);
      // eslint-disable-next-line no-await-in-loop
      const inR4 = await slotFound(slot, r4Final, 10, fetchNode);
      if (inA && !inR4) lostSlots += 1;
      else if (!inA && inR4) gainedSlots += 1;
      else sameSlots += 1;
    }
    const rawTop20 = record.per_config[WINNING_CONFIG].raw_top20;
    const rejectedIds = new Set(); // recomputed from final vs raw diff isn't stored per-id here; approximate via raw-not-in-final within first 20
    const finalIds = new Set(record.per_config[WINNING_CONFIG].final_top20.map((c) => c.chunk_id));
    for (const c of rawTop20) if (!finalIds.has(c.chunk_id)) rejectedIds.add(c.chunk_id);
    for (const slot of goldQ.slots) {
      for (const src of slot.sources) {
        const hitRejected = rawTop20.some((c) => rejectedIds.has(c.chunk_id) && c.doc_id === src.doc_id && new Set([c.node_index, ...(c.node_indices ?? [])]).has(src.node_index));
        if (hitRejected) rejectedTruePositives += 1;
      }
    }
  }
  console.log(JSON.stringify({
    winning_config: WINNING_CONFIG,
    top10_slots_gained_vs_same_run_a: gainedSlots,
    top10_slots_lost_vs_same_run_a: lostSlots,
    top10_slots_unchanged: sameSlots,
    net_change: gainedSlots - lostSlots,
    a3_rejected_candidates_that_were_also_a_correct_slot_match: rejectedTruePositives,
  }, null, 2));
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
