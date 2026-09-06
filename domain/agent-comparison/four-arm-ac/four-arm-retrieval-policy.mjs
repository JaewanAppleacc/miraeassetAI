// Turn A-RETRIEVAL-REMEDIATION-V1: an OPT-IN retrieval policy for arms A/C.
//
// The frozen official A/C behaviour (the one that produced the committed
// results/A.results.jsonl / C.results.jsonl) is `FROZEN_POLICY`, and it is
// the DEFAULT everywhere a policy can be supplied -- a caller that never
// mentions a policy gets the byte-identical frozen code path. Every
// remediation below lives behind `REMEDIATION_V1_POLICY` so the two can be
// executed side by side on the same input and compared, never overwritten.
//
// What the remediation addresses (all measured on the committed A results
// against DEV_TUNE-101, see A_RETRIEVAL_REMEDIATION_V1_HANDOFF.md):
//   1. `correction` semantics -- the official conditions artifact's
//      `correction` flag means "the question mentions 정정", not "exclude
//      corrected filings". Mapping it to `is_correction=false` removed every
//      정정 filing (1,004/4,204 documents, 24% of the corpus) from the pool
//      on 98/101 questions (A returned 0/1,809 정정 chunks; D 170/1,940).
//   2. extracted doc_subtype used as a HARD prefilter -- when the extractor's
//      guess is wrong the correct filing is unreachable by BOTH legs
//      (2 real questions returned 0 results).
//   3. no receipt-date binding for exchange/holding/major -- 21/81
//      date-anchored questions missed all_found@10 vs 6/19 without a date.
//   4. BM25 candidates with score 0 still entering RRF with a rank credit.
//   5. overlapping Fixed-512 windows of the same document occupying several
//      top-10 slots (27% same-document repeats, 14% node-overlapping).
//
// Everything here is question-text/conditions-only (vFINAL 20: no Gold-
// derived input anywhere). No Gold, DEV_CHECK or HOLDOUT is read.
import { buildMetadataFiltersFromConditions } from "./conditions-fixture.mjs";

export const POLICY_IDS = Object.freeze({ FROZEN: "frozen-a-v1", REMEDIATION_V1: "remediation-v1" });

export const FROZEN_POLICY = Object.freeze({
  id: POLICY_IDS.FROZEN,
  // is_correction := conditions.correction (boolean) -- the official-run mapping.
  correction_filter: "AS_EXTRACTED",
  // extracted doc_subtypes are a hard prefilter, single pass.
  doc_subtype_filter: "HARD",
  receipt_date_window: "OFF",
  receipt_window_days: Object.freeze({ before: 0, holding: 0, default: 0 }),
  bm25_zero_score: "KEEP",
  // null = dense candidate count follows request.top_k (the frozen coupling).
  dense_candidate_k: null,
  // null = fusion output equals k.
  fusion_pool_k: null,
  dedupe_contained_windows: false,
  per_doc_cap: 0,
});

export const REMEDIATION_V1_POLICY = Object.freeze({
  id: POLICY_IDS.REMEDIATION_V1,
  // is_correction filter only when the question itself asks about 정정;
  // otherwise no correction filter at all (both original and corrected
  // filings stay in the pool, ranking decides).
  correction_filter: "ONLY_WHEN_ASKED",
  // subtype prefilter first; if the pass falls short of k, re-run without
  // the (extracted, therefore fallible) subtype and fill from that.
  doc_subtype_filter: "RELAX_ON_SHORTFALL",
  // a full date in the question text (YYYY-MM-DD / YYYY.MM.DD / YYYY년 M월
  // D일) binds a receipt_date window pass FIRST, then unfiltered fill.
  receipt_date_window: "TWO_PASS",
  // Measured on DEV_TUNE-101 (rcept_dt minus the date written in the
  // question): exchange 0..3 days, major 0..1, holding 0..30 (보고서작성
  // 기준일 -> 접수일 lag), periodic 42..45 (period END, never a filing
  // date -- so periodic-only conditions get no window at all).
  receipt_window_days: Object.freeze({ before: 1, holding: 30, default: 3 }),
  bm25_zero_score: "DROP",
  dense_candidate_k: 20,
  fusion_pool_k: 40,
  dedupe_contained_windows: true,
  // 0 = off. A hard per-document cap is deliberately NOT enabled by
  // default: multi-slot single-document questions (대량보유 표지+요약표+
  // 연혁표) legitimately need several chunks of one document. Left as a
  // knob for a measured sweep.
  per_doc_cap: 0,
});

const POLICIES = Object.freeze({
  [FROZEN_POLICY.id]: FROZEN_POLICY,
  [REMEDIATION_V1_POLICY.id]: REMEDIATION_V1_POLICY,
});

export function resolvePolicy(policy) {
  if (policy === undefined || policy === null) return FROZEN_POLICY;
  if (typeof policy === "string") {
    const known = POLICIES[policy];
    if (!known) throw new Error(`unknown retrieval policy id: ${JSON.stringify(policy)} (known: ${Object.keys(POLICIES).join(", ")})`);
    return known;
  }
  if (typeof policy === "object" && typeof policy.id === "string") {
    return Object.freeze({ ...FROZEN_POLICY, ...policy });
  }
  throw new TypeError("policy must be a known policy id or a policy object with an `id`");
}

export function isFrozenPolicy(policy) {
  return resolvePolicy(policy).id === FROZEN_POLICY.id;
}

// ---------------------------------------------------------------------------
// Question-text full-date parser (Gold-blind: reads only the question).
// ---------------------------------------------------------------------------

// YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD, YYYY년 M월 D일 (spaces tolerated).
// Year-month-only phrases ("2023년 4월", "2024.03") do NOT match: a day is
// required, because only a full date can name a filing.
const FULL_DATE_RE = /(20\d{2})\s*(?:[.\-/]|년)\s*(\d{1,2})\s*(?:[.\-/]|월)\s*(\d{1,2})(?!\d)/g;

function isoOrNull(y, m, d) {
  const year = Number(y); const month = Number(m); const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function questionFullDates(question) {
  if (typeof question !== "string" || question === "") return Object.freeze([]);
  const out = [];
  for (const match of question.matchAll(FULL_DATE_RE)) {
    const iso = isoOrNull(match[1], match[2], match[3]);
    if (iso && !out.includes(iso)) out.push(iso);
  }
  return Object.freeze(out);
}

export function shiftIsoDate(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

// docGroups: the condition's doc_groups (may be empty = unknown). A
// periodic-only condition never gets a window (its dates are period ends).
// An unknown/empty doc_groups gets the widest (holding) window, since a
// holding filing cannot be excluded.
export function deriveReceiptWindow(questionDates, docGroups, policy) {
  const p = resolvePolicy(policy);
  if (p.receipt_date_window !== "TWO_PASS") return null;
  const dates = Array.isArray(questionDates) ? questionDates.filter((d) => typeof d === "string" && d !== "") : [];
  if (dates.length === 0) return null;
  const groups = Array.isArray(docGroups) ? docGroups : [];
  if (groups.length > 0 && groups.every((g) => g === "periodic")) return null;
  const days = p.receipt_window_days;
  const afterDays = (groups.length === 0 || groups.includes("holding")) ? days.holding : days.default;
  const sorted = [...dates].sort();
  return Object.freeze({
    from: shiftIsoDate(sorted[0], -days.before),
    to: shiftIsoDate(sorted[sorted.length - 1], afterDays),
    question_dates: Object.freeze(sorted),
    before_days: days.before,
    after_days: afterDays,
  });
}

// ---------------------------------------------------------------------------
// Retrieval plan + filter passes.
// ---------------------------------------------------------------------------

// filters: a METADATA_FILTER_KEYS-shaped object (already mapped). Returns
// null under the frozen policy -- the caller then takes the frozen single-
// pass path unchanged.
export function buildRetrievalPlan({ question, filters, policy }) {
  const p = resolvePolicy(policy);
  if (p.id === FROZEN_POLICY.id) return null;
  const dates = questionFullDates(question ?? "");
  const window = deriveReceiptWindow(dates, filters?.doc_groups, p);
  const subtypeRelaxable = p.doc_subtype_filter === "RELAX_ON_SHORTFALL"
    && Array.isArray(filters?.doc_subtypes) && filters.doc_subtypes.length > 0;
  return Object.freeze({
    policy_id: p.id,
    question_dates: dates,
    receipt_window: window,
    subtype_relaxable: subtypeRelaxable,
  });
}

// Priority order (most specific first; each pass only FILLS what the
// previous passes left short, never re-ranks them):
//   window            base filters + receipt window       (if window)
//   window_relaxed    base - doc_subtypes + receipt window (if window && relaxable)
//   base              base filters as mapped               (always)
//   base_relaxed      base - doc_subtypes                  (if relaxable)
// Passes whose filter object is identical to an earlier one are dropped.
export function buildFilterPasses(filters, plan) {
  const base = buildMetadataFiltersFromConditions(filters ?? {});
  if (!plan) return Object.freeze([Object.freeze({ label: "base", filters: base })]);
  const withWindow = (f) => (plan.receipt_window
    ? buildMetadataFiltersFromConditions({ ...f, receipt_date_from: plan.receipt_window.from, receipt_date_to: plan.receipt_window.to })
    : null);
  const withoutSubtype = (f) => (plan.subtype_relaxable ? buildMetadataFiltersFromConditions({ ...f, doc_subtypes: [] }) : null);
  const candidates = [
    ["window", withWindow(base)],
    ["window_relaxed", plan.receipt_window && plan.subtype_relaxable ? withoutSubtype(withWindow(base)) : null],
    ["base", base],
    ["base_relaxed", withoutSubtype(base)],
  ];
  const seen = new Set();
  const passes = [];
  for (const [label, f] of candidates) {
    if (!f) continue;
    const key = JSON.stringify(f);
    if (seen.has(key)) continue;
    seen.add(key);
    passes.push(Object.freeze({ label, filters: f }));
  }
  return Object.freeze(passes);
}

// ---------------------------------------------------------------------------
// Result diversification (post-fusion, order-preserving).
// ---------------------------------------------------------------------------

export function nodeIndicesOfItem(item) {
  const nodes = new Set();
  if (Number.isInteger(item?.node_index)) nodes.add(item.node_index);
  for (const n of item?.node_indices ?? []) if (Number.isInteger(n)) nodes.add(n);
  for (const c of item?.provenance?.candidates ?? []) if (Number.isInteger(c?.node_index)) nodes.add(c.node_index);
  return nodes;
}

// items: ranked result items (doc_id + node provenance), best first.
// A window whose node set is entirely covered by already-kept windows of
// the same document adds no new source node -- it is deferred behind
// everything that does. Deferred items are appended (never discarded) so
// the caller still receives min(k, items.length) results.
export function diversifyResults(items, { k, dedupeContainedWindows = false, perDocCap = 0 } = {}) {
  if (!Number.isInteger(k) || k < 1) throw new TypeError("k must be a positive integer");
  const kept = [];
  const deferred = [];
  const coveredByDoc = new Map();
  const countByDoc = new Map();
  for (const item of items) {
    const nodes = nodeIndicesOfItem(item);
    const covered = coveredByDoc.get(item.doc_id) ?? new Set();
    const count = countByDoc.get(item.doc_id) ?? 0;
    const contained = dedupeContainedWindows && nodes.size > 0 && [...nodes].every((n) => covered.has(n));
    const capped = perDocCap > 0 && count >= perDocCap;
    if (contained || capped) { deferred.push(item); continue; }
    kept.push(item);
    for (const n of nodes) covered.add(n);
    coveredByDoc.set(item.doc_id, covered);
    countByDoc.set(item.doc_id, count + 1);
  }
  return [...kept, ...deferred].slice(0, k);
}
