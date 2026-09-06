#!/usr/bin/env node
// Turn A3-CANDIDATE-CEILING-AUDIT-V1, sections D/E/F: oracle Recall
// computation over the candidate pools scripts/p11f0-fourarm-a3-ceiling-
// candidates.mjs already wrote to work/a3-candidates/. Ports (does not
// import, since the frozen scorer is Python and lives in a sibling
// worktree) the frozen scorer's own `slot_found` hit definition
// (domain/agent-comparison/four-arm-ac/scorer-patch-multinode-v1/
// fourarm.patched.py) faithfully: primary (doc_id, node_index-in-
// node_indices) match, text-verified/blind/unverified disambiguation via
// the SAME DocumentIR NodeStore module A2 already built and this Turn
// reuses unmodified (a2-documentir-node-store.mjs's
// createDocumentIrFetchNode).
//
// Reads Gold (work/gold/dev-tune-gold.v0.1.jsonl, gitignored) and the raw
// candidate-pool text (work/a3-candidates/*.json, gitignored) -- this
// script's own console output and its one committed artifact (the section
// H report, written by a separate step) never include raw Gold text or
// raw chunk text, only aggregate counts/SHAs/classifications.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { renderNode, extractDocumentsByBoundedScan, verifyDocumentIrFiles } from "../domain/agent-comparison/four-arm-ac/a2-documentir-node-store.mjs";
import { passesMetadataFilters } from "../domain/retrieval/metadata-filter.mjs";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CANDIDATES_DIR = path.join(REPO_ROOT, "work/a3-candidates");
const GOLD_PATH = path.join(REPO_ROOT, "work/gold/dev-tune-gold.v0.1.jsonl");
const CONDITIONS_PATH = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/official/devtune101_conditions.v2.jsonl");
const A_RESULTS_PATH = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/results/A.results.jsonl");
const RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";

const DOCUMENT_IR_PATHS = {
  exchange: "/Users/jaewan/Downloads/drive-download-20260804T043134Z-1-002/exchange.jsonl",
  holding: "/Users/jaewan/Downloads/drive-download-20260804T043134Z-1-002/holding.jsonl",
  major: "/Users/jaewan/Downloads/drive-download-20260804T043134Z-1-002/major.jsonl",
  periodic: "/Users/jaewan/Downloads/drive-download-20260804T043134Z-1-002/periodic-001.jsonl",
};

const KS = [10, 20, 50, 100];
const LOC_RE = /^([a-z]+_\d+)(?:\/\d+\.xml#node=(\d+)(?:&row=(\d+)&col=(\d+))?|::[^:]+::n(\d+))$/;

function normText(s) {
  return (s ?? "").normalize("NFC").replace(/\s+/g, "");
}
function spanLines(span, minLen = 6) {
  const out = [];
  for (const ln of (span ?? "").split("\n")) {
    const t = normText(ln);
    if (t.length >= minLen) out.push(t);
  }
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
        sources.push({ doc_id: parsed.doc, node_index: parsed.n, span: src.evidence_span ?? "", row: parsed.row, col: parsed.col });
      }
      slots.push({ slot_name: s.slot_name ?? "", sources });
    }
    out.set(g.question_id, {
      question_id: g.question_id,
      slots,
      gold_document_ids: new Set(g.gold_document_ids ?? []),
      question_type: g.question_type ?? null,
      tags: g.tags ?? [],
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
    out.set(r.question_id, { segment: r.segment, doc_group: (r.conditions?.doc_groups ?? [])[0] ?? "UNKNOWN", question: r.question });
  }
  return out;
}

function resultNodes(r) {
  const nodes = new Set([r.node_index]);
  for (const n of r.node_indices ?? []) nodes.add(n);
  return nodes;
}

// Faithful port of fourarm.patched.py's slot_found(), minus `banned`
// (16번 owner-adjudication invalidation -- not applicable: this Turn never
// runs owner adjudication, there is no ARM_SPECIFIC-invalidated set here).
async function slotFound(slot, results, k, fetchNode) {
  const top = results.slice(0, k);
  let best = null; // { rankKey: [statePriority, rowColMatch], state }
  const statePriority = { verified: 2, blind: 1, unverified: 0 };
  for (const r of top) {
    const nodes = resultNodes(r);
    const text = normText(r.text ?? "");
    const rc = [r.row ?? null, r.col ?? null];
    for (const src of slot.sources) {
      if (r.doc_id !== src.doc_id || !nodes.has(src.node_index)) continue;
      const lines = spanLines(src.span);
      let state;
      if (lines.length === 0 || !text) {
        state = "blind";
      } else if (lines.some((ln) => text.includes(ln))) {
        state = "verified";
      } else {
        // eslint-disable-next-line no-await-in-loop
        const node = await fetchNode({ documentId: src.doc_id, nodeIndex: src.node_index });
        if (node?.found) {
          const nodeText = normText(node.text ?? "");
          if (nodeText && lines.some((ln) => nodeText.includes(ln))) continue; // wrong window of the right node -- not a match
        }
        state = "unverified";
      }
      const rowColMatch = rc[0] !== null && rc[1] !== null && src.row === rc[0] && src.col === rc[1];
      const rankKey = [statePriority[state], rowColMatch ? 1 : 0];
      if (best === null || rankKey[0] > best.rankKey[0] || (rankKey[0] === best.rankKey[0] && rankKey[1] > best.rankKey[1])) {
        best = { rankKey, r, src, state };
      }
    }
  }
  if (best !== null) return { found: true, result: best.r, method: "node", src: best.src, state: best.state };
  for (const r of top) {
    const t = normText(r.text ?? "");
    if (!t) continue;
    for (const src of slot.sources) {
      if (r.doc_id !== src.doc_id) continue;
      if (spanLines(src.span).some((ln) => t.includes(ln))) return { found: true, result: r, method: "text", src, state: "verified" };
    }
  }
  return { found: false, result: null, method: "", src: null, state: "" };
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

async function classifyMiss({ slot, question, leg, client, filters }) {
  // Runs only for a slot that was NOT found at k=100 on this leg. Returns
  // one of the 9 pre-registered categories, per-source (a slot's sources
  // may span more than one doc; we report the BEST (least-severe) finding
  // across its sources so a slot is not marked NOT_RETRIEVED when one of
  // its acceptable alternates actually was, just under a different bucket).
  const legDocIds = new Set(leg.map((r) => r.doc_id));
  const legByDoc = new Map();
  for (const r of leg) {
    if (!legByDoc.has(r.doc_id)) legByDoc.set(r.doc_id, []);
    legByDoc.get(r.doc_id).push(r);
  }
  const verdicts = [];
  for (const src of slot.sources) {
    // eslint-disable-next-line no-await-in-loop
    const existsResult = await client.query(
      `SELECT source_document_id, corp_code, source_locator, chunk_ordinal, metadata FROM disclosure_reference.reference_retrieval_chunks
       WHERE retrieval_index_id = $1 AND source_document_id = $2 LIMIT 1`,
      [RETRIEVAL_INDEX_ID, src.doc_id],
    );
    if (existsResult.rows.length === 0) { verdicts.push("CORPUS_OR_GOLD_MISMATCH"); continue; }
    const sampleRow = existsResult.rows[0];
    if (!passesMetadataFilters(sampleRow, filters)) { verdicts.push("METADATA_FILTER_EXCLUDED"); continue; }
    if (!legDocIds.has(src.doc_id)) { verdicts.push("CORRECT_DOCUMENT_NOT_RETRIEVED"); continue; }
    const docCandidates = legByDoc.get(src.doc_id) ?? [];
    const nearMiss = docCandidates.some((c) => {
      const nodes = [...resultNodes(c)];
      return nodes.some((n) => Math.abs(n - src.node_index) <= 3);
    });
    if (src.row !== null && src.col !== null && nearMiss) { verdicts.push("TABLE_CONTEXT_FRAGMENTED"); continue; }
    verdicts.push("CORRECT_DOCUMENT_WRONG_NODE");
  }
  const priority = ["CORRECT_DOCUMENT_WRONG_NODE", "TABLE_CONTEXT_FRAGMENTED", "CORRECT_DOCUMENT_NOT_RETRIEVED", "METADATA_FILTER_EXCLUDED", "CORPUS_OR_GOLD_MISMATCH"];
  for (const p of priority) if (verdicts.includes(p)) return p;
  return "UNRESOLVED";
}

async function main() {
  const [gold, conditions, files] = await Promise.all([
    loadGold(GOLD_PATH),
    loadConditions(CONDITIONS_PATH),
    readdir(CANDIDATES_DIR),
  ]);
  const irCheck = await verifyDocumentIrFiles(DOCUMENT_IR_PATHS);
  if (!irCheck.ok) throw new Error(`DocumentIR SHA mismatch: ${JSON.stringify(irCheck.mismatches)}`);

  // Pre-batch: collect every distinct Gold-source doc_id up front and scan
  // each of the 4 DocumentIR files exactly ONCE for its own group's needed
  // ids (extractDocumentsByBoundedScan, reused unmodified) -- rather than
  // letting a per-lookup cache miss re-scan the whole file every time, which
  // would be ruinous for the 8.1GB periodic file if 20+ distinct periodic
  // docs are referenced across DEV_TUNE-101's Gold. renderNode (also reused
  // unmodified) is the SAME rendering rule a2-documentir-node-store.mjs's
  // own fetchNode uses; only the batching/caching orchestration is new.
  const neededByGroup = { exchange: new Set(), holding: new Set(), major: new Set(), periodic: new Set() };
  for (const g of gold.values()) {
    for (const slot of g.slots) {
      for (const src of slot.sources) {
        const group = src.doc_id.split("_")[0];
        if (neededByGroup[group]) neededByGroup[group].add(src.doc_id);
      }
    }
  }
  const rawDocCache = new Map();
  for (const [group, ids] of Object.entries(neededByGroup)) {
    if (ids.size === 0) continue;
    // eslint-disable-next-line no-await-in-loop
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

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required (read-only lookups for failure classification)");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const candidateFiles = files.filter((f) => f.endsWith(".json") && f !== "a3-manifest.json");
  if (candidateFiles.length !== 101) throw new Error(`expected 101 candidate files, found ${candidateFiles.length}`);

  const perQuestion = []; // { question_id, cond, goldQ, legs: {bm25,dense,union_rrf}, qScoreByLeg: {leg: {nSlots, excluded, foundAt, allFoundAt}} }
  const top20Mismatches = [];
  const aResultsByQ = new Map();
  {
    const raw = await readFile(A_RESULTS_PATH, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      aResultsByQ.set(r.question_id, r.results ?? []);
    }
  }

  const missByLeg = { bm25: [], dense: [], union_rrf: [] };

  for (const file of candidateFiles) {
    // eslint-disable-next-line no-await-in-loop
    const record = JSON.parse(await readFile(path.join(CANDIDATES_DIR, file), "utf8"));
    const qid = record.question_id;
    const goldQ = gold.get(qid);
    const cond = conditions.get(qid);
    if (!goldQ) throw new Error(`no Gold row for question_id ${qid}`);
    if (!cond) throw new Error(`no conditions row for question_id ${qid}`);

    // Section F: top-20 prefix replay check against A's frozen results.
    const officialTop20 = (aResultsByQ.get(qid) ?? []).slice(0, 20).map((r) => r.chunk_id);
    const newTop20 = record.union_rrf.slice(0, 20).map((r) => r.chunk_id);
    const prefixMatches = officialTop20.length === newTop20.length && officialTop20.every((id, i) => id === newTop20[i]);
    if (!prefixMatches) {
      top20Mismatches.push({
        question_id: qid,
        official_top20: officialTop20,
        new_top20: newTop20,
        first_diff_rank: officialTop20.findIndex((id, i) => id !== newTop20[i]) + 1,
      });
    }

    const legResult = {};
    for (const legName of ["bm25", "dense", "union_rrf"]) {
      const results = record[legName];
      const nSlots = goldQ.slots.length;
      const foundAt = {};
      const allFoundAt = {};
      const slotFoundAt100 = [];
      for (const k of KS) {
        let found = 0;
        // eslint-disable-next-line no-await-in-loop
        for (const slot of goldQ.slots) {
          // eslint-disable-next-line no-await-in-loop
          const res = await slotFound(slot, results, k, fetchNode);
          if (res.found) found += 1;
          if (k === 100) slotFoundAt100.push({ slot, found: res.found });
        }
        foundAt[k] = found;
        allFoundAt[k] = nSlots > 0 && found === nSlots;
      }
      legResult[legName] = { nSlots, excluded: nSlots === 0, foundAt, allFoundAt, slotFoundAt100 };
    }
    perQuestion.push({ question_id: qid, cond, goldQ, legResult, record });
  }

  // Failure decomposition (section E), union_rrf leg only (the ceiling
  // itself), at k=100. Per-question metadata_filters were not persisted
  // per candidate file, so they are recomputed here via the SAME
  // deterministic mapper the candidate generator used (identical inputs,
  // identical output -- no new retrieval call, just the pure filter-build
  // step re-run for classification purposes).
  const { createGatedSeedCompanyResolver } = await import("../domain/adapters/seed-company-resolver.mjs");
  const { buildNameToCorpCodeIndex, mapOfficialConditionToFilterInput } = await import("../domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs");
  const { buildMetadataFiltersFromConditions } = await import("../domain/agent-comparison/four-arm-ac/conditions-fixture.mjs");
  const resolver = await createGatedSeedCompanyResolver({
    artifactPath: path.join(REPO_ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
    manifestPath: path.join(REPO_ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
    ownerDecisionPath: path.join(REPO_ROOT, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"),
    expectedOwnerDecisionSha256: "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20",
    root: REPO_ROOT,
  });
  const nameToCorpCodeIndex = buildNameToCorpCodeIndex(resolver);
  const conditionsRawFull = JSON.parse("[" + (await readFile(CONDITIONS_PATH, "utf8")).trim().split("\n").filter(Boolean).join(",") + "]");
  const conditionsFullByQ = new Map(conditionsRawFull.map((r) => [r.question_id, r]));

  const failureClassCounts = {};
  const failureRecords = [];
  for (const pq of perQuestion) {
    const fullCond = conditionsFullByQ.get(pq.question_id);
    const mapped = mapOfficialConditionToFilterInput(fullCond.conditions, nameToCorpCodeIndex);
    const filters = buildMetadataFiltersFromConditions(mapped.filters);
    const leg = pq.record.union_rrf;
    for (const { slot, found } of pq.legResult.union_rrf.slotFoundAt100) {
      if (found) continue;
      // eslint-disable-next-line no-await-in-loop
      const cls = await classifyMiss({ slot, question: pq.question_id, leg, client, filters });
      failureClassCounts[cls] = (failureClassCounts[cls] ?? 0) + 1;
      failureRecords.push({ question_id: pq.question_id, slot_name: slot.slot_name, classification: cls });
    }
  }

  await client.end();

  // ---- Aggregation: overall + segments ----
  function agg(filterFn, legName) {
    const qs = perQuestion.filter(filterFn).map((pq) => ({ nSlots: pq.legResult[legName].nSlots, excluded: pq.legResult[legName].excluded, foundAt: pq.legResult[legName].foundAt, allFoundAt: pq.legResult[legName].allFoundAt }));
    return pooledRecall(qs, KS);
  }
  const segments = {
    ALL: () => true,
    HIGH: (pq) => pq.cond.segment === "HIGH",
    LOW: (pq) => pq.cond.segment === "LOW",
    periodic: (pq) => pq.cond.doc_group === "periodic",
    major: (pq) => pq.cond.doc_group === "major",
    holding: (pq) => pq.cond.doc_group === "holding",
    exchange: (pq) => pq.cond.doc_group === "exchange",
    scope_explicit_heuristic: (pq) => pq.goldQ.tags.includes("scope") || pq.goldQ.scopes.includes("CONSOLIDATED"),
    period_comparison_heuristic: (pq) => pq.goldQ.question_type === "COMPARISON_CALC" || pq.goldQ.tags.includes("same_company_different_period") || pq.goldQ.tags.includes("period_type"),
  };

  const report = { legs: {}, segments: {}, table_vs_non_table: {}, source_overlap: {}, top20_replay: {} };
  for (const legName of ["bm25", "dense", "union_rrf"]) {
    report.legs[legName] = agg(() => true, legName);
    report.segments[legName] = {};
    for (const [segName, fn] of Object.entries(segments)) report.segments[legName][segName] = agg(fn, legName);
  }

  // 표 node / 비표 node -- computed at SLOT-SOURCE granularity (section 5 of the amendment).
  for (const legName of ["bm25", "dense", "union_rrf"]) {
    let tableTotal = 0, tableFound = 0, nonTableTotal = 0, nonTableFound = 0;
    for (const pq of perQuestion) {
      const results = pq.record[legName].slice(0, 100);
      for (const slot of pq.goldQ.slots) {
        const isTableSlot = slot.sources.some((s) => s.row !== null && s.col !== null);
        // eslint-disable-next-line no-await-in-loop
        const res = await slotFound(slot, results, 100, fetchNode);
        if (isTableSlot) { tableTotal += 1; if (res.found) tableFound += 1; } else { nonTableTotal += 1; if (res.found) nonTableFound += 1; }
      }
    }
    report.table_vs_non_table[legName] = {
      table_node: { slots_total: tableTotal, slots_found: tableFound, "recall@100": tableTotal ? Number((tableFound / tableTotal).toFixed(4)) : null },
      non_table_node: { slots_total: nonTableTotal, slots_found: nonTableFound, "recall@100": nonTableTotal ? Number((nonTableFound / nonTableTotal).toFixed(4)) : null },
    };
  }

  // BM25-only / dense-only / both / neither, at k=100, per slot (union candidate definition = bm25 ∪ dense, matching union_rrf's own membership).
  let bm25Only = 0, denseOnly = 0, both = 0, neither = 0, totalSlots = 0;
  let below20Above50or100 = 0;
  const bestRankByQuestionSlot = [];
  for (const pq of perQuestion) {
    for (const slot of pq.goldQ.slots) {
      totalSlots += 1;
      // eslint-disable-next-line no-await-in-loop
      const [bm25Res, denseRes, at20, at50, at100] = await Promise.all([
        slotFound(slot, pq.record.bm25, 100, fetchNode),
        slotFound(slot, pq.record.dense, 100, fetchNode),
        slotFound(slot, pq.record.union_rrf, 20, fetchNode),
        slotFound(slot, pq.record.union_rrf, 50, fetchNode),
        slotFound(slot, pq.record.union_rrf, 100, fetchNode),
      ]);
      const inBm25 = bm25Res.found, inDense = denseRes.found;
      if (inBm25 && inDense) both += 1;
      else if (inBm25) bm25Only += 1;
      else if (inDense) denseOnly += 1;
      else neither += 1;
      if (!at20.found && (at50.found || at100.found)) below20Above50or100 += 1;

      // best rank across the union_rrf pool (min rank among matching candidates for this slot's sources).
      let bestRank = null;
      for (const r of pq.record.union_rrf) {
        const nodes = resultNodes(r);
        if (slot.sources.some((s) => r.doc_id === s.doc_id && nodes.has(s.node_index))) { bestRank = r.rank; break; }
      }
      bestRankByQuestionSlot.push({ question_id: pq.question_id, slot_name: slot.slot_name, best_rank_union_rrf: bestRank });
    }
  }
  report.source_overlap = { total_slots: totalSlots, bm25_only: bm25Only, dense_only: denseOnly, both, neither, not_in_top20_but_in_top50_or_100: below20Above50or100 };

  report.top20_replay = {
    questions_checked: perQuestion.length,
    mismatched_questions: top20Mismatches.length,
    match_rate: Number(((perQuestion.length - top20Mismatches.length) / perQuestion.length).toFixed(4)),
    mismatch_examples: top20Mismatches.slice(0, 5).map((m) => ({ question_id: m.question_id, first_diff_rank: m.first_diff_rank })),
  };
  report.failure_classification = failureClassCounts;
  report.failure_records_count = failureRecords.length;
  report.best_rank_summary = {
    slots_with_no_match_in_union_rrf_top100: bestRankByQuestionSlot.filter((x) => x.best_rank_union_rrf === null).length,
    slots_total: bestRankByQuestionSlot.length,
  };

  await import("node:fs/promises").then((fs) => fs.writeFile(path.join(REPO_ROOT, "work/a3-oracle-report.json"), JSON.stringify(report, null, 2)));
  await import("node:fs/promises").then((fs) => fs.writeFile(path.join(REPO_ROOT, "work/a3-failure-records.json"), JSON.stringify(failureRecords, null, 2)));
  await import("node:fs/promises").then((fs) => fs.writeFile(path.join(REPO_ROOT, "work/a3-best-rank.json"), JSON.stringify(bestRankByQuestionSlot, null, 2)));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`[a3-oracle] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
