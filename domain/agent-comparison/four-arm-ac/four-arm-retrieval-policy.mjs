// Turn A-RETRIEVAL-REMEDIATION-V1 (+ review round 1): an OPT-IN retrieval
// policy for arms A/C.
//
// The frozen official behaviour (the one that produced the committed
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
//      date-anchored questions missed all_found@10.
//   4. BM25 candidates with score 0 still entering RRF with a rank credit.
//   5. `search(k)` coupling the dense candidate count and the fusion output
//      to the output k (k=10 was not the prefix of k=20).
//
// Review round 1 (c6b9a19 -> this version) changed:
//   - candidate collection is independent of the output k: primary passes
//     run until a FIXED pool is full, relaxed passes ALWAYS run, the whole
//     pool is ranked once, then cut to k (prefix property for every k <= pool);
//   - subtype relaxation is no longer "only on shortfall": relaxed-pass
//     candidates are interleaved into the ranking at a fixed stride, so a
//     wrong extracted subtype that happens to fill the pool cannot hide the
//     right filing;
//   - one receipt window PER question date (merged only when windows
//     overlap), never one range spanning distant dates;
//   - the node-set "contained window" dedupe was wrong (different rows of
//     one table share a node_index) and is replaced by verified text
//     containment; it is OFF by default.
// Review round 2 (40686e7 -> this version) changed:
//   - relaxed-pass candidates are no longer inserted at a fixed stride
//     regardless of score; they are PROMOTED by evidence, pair-wise against
//     the primary pass they relax (promoteRelaxed below);
//   - every receipt-date window pass runs and the windows are merged
//     round-robin, so one date's document cannot crowd the other date out.
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
  max_receipt_windows: 0,
  bm25_zero_score: "KEEP",
  // null = dense candidate count follows request.top_k (the frozen coupling).
  dense_candidate_k: null,
  // null = fusion output equals k, single pass.
  fusion_pool_k: null,
  // 0 = relaxed-pass candidates are never interleaved/promoted (no relaxed passes exist).
  relaxed_interleave_every: 0,
  relaxed_promote_top: 0,
  dedupe_contained_windows: false,
  per_doc_cap: 0,
});

export const REMEDIATION_V1_POLICY = Object.freeze({
  id: POLICY_IDS.REMEDIATION_V1,
  // is_correction filter only when the question itself asks about 정정;
  // otherwise no correction filter at all (both original and corrected
  // filings stay in the pool, ranking decides).
  correction_filter: "ONLY_WHEN_ASKED",
  // subtype prefilter passes are "primary"; passes without the (extracted,
  // therefore fallible) subtype are "relaxed" and ALWAYS run; their
  // candidates are interleaved into the ranking (relaxed_interleave_every).
  doc_subtype_filter: "RELAX_ALWAYS",
  // every full date in the question text (YYYY-MM-DD / YYYY.MM.DD / YYYY년
  // M월 D일) gets its OWN receipt_date window pass; windows are merged only
  // when they overlap. Measured on DEV_TUNE-101 (rcept_dt minus the date in
  // the question): exchange 0..3 days, major 0..1, holding 0..30 (보고서
  // 작성기준일 -> 접수일 lag), periodic 42..45 (a period END, never a filing
  // date -- periodic-only conditions get no window at all).
  receipt_date_window: "PER_DATE",
  receipt_window_days: Object.freeze({ before: 1, holding: 30, default: 3 }),
  max_receipt_windows: 3,
  bm25_zero_score: "DROP",
  dense_candidate_k: 20,
  // the FIXED candidate pool each primary pass fills towards; never k.
  fusion_pool_k: 40,
  // 0 = OFF (review round 2: a fixed stride put relaxed candidates at rank
  // 4/8 regardless of score, taking top-10 slots from a correct subtype).
  // Kept only as an ablation knob.
  relaxed_interleave_every: 0,
  // Relaxed-pass candidates are PROMOTED by evidence, pair-wise against the
  // primary pass they relax (window:n <-> window_relaxed:n, base <->
  // base_relaxed). A relaxed pass ranks the SUPERSET of its partner's pool,
  // so its ranks compare like for like: a relaxed-only candidate that ranks
  // within the top N of its own relaxed pass is inserted before the first
  // partner-pass item that ranks worse than it in that same relaxed pass;
  // every other relaxed candidate stays behind all primary items. 0 = off.
  relaxed_promote_top: 5,
  // OFF: the only safe containment test is "this chunk's text is entirely
  // inside an already-kept chunk of the same document" (verified from the
  // hydrated text); node/row provenance cannot prove containment (different
  // rows of one table share a node_index, and a row span only records that
  // the window TOUCHED the row). Left as a knob for a measured sweep.
  dedupe_contained_windows: false,
  // 0 = off. Multi-slot single-document questions (대량보유 표지+요약표+
  // 연혁표) legitimately need several chunks of one document.
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

function utcOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function shiftIsoDate(iso, days) {
  const date = new Date(utcOf(iso) + days * 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function daysBetween(fromIso, toIso) {
  return Math.round((utcOf(toIso) - utcOf(fromIso)) / 86_400_000);
}

// One window per question date, [date - before, date + after]; two dates
// whose windows overlap or touch are merged into one; distant dates stay
// separate (a 2023-01-01 vs 2025-01-01 comparison never becomes one 2-year
// range). docGroups: the condition's doc_groups (may be empty = unknown). A
// periodic-only condition never gets a window (its dates are period ends).
// An unknown/empty doc_groups gets the widest (holding) width, since a
// holding filing cannot be excluded. At most `max_receipt_windows` windows
// (earliest first).
export function deriveReceiptWindows(questionDates, docGroups, policy) {
  const p = resolvePolicy(policy);
  if (p.receipt_date_window !== "PER_DATE") return Object.freeze([]);
  const dates = [...new Set((Array.isArray(questionDates) ? questionDates : []).filter((d) => typeof d === "string" && d !== ""))].sort();
  if (dates.length === 0) return Object.freeze([]);
  const groups = Array.isArray(docGroups) ? docGroups : [];
  if (groups.length > 0 && groups.every((g) => g === "periodic")) return Object.freeze([]);
  const before = p.receipt_window_days.before;
  const after = (groups.length === 0 || groups.includes("holding")) ? p.receipt_window_days.holding : p.receipt_window_days.default;
  const clusters = [];
  for (const d of dates) {
    const current = clusters[clusters.length - 1];
    // windows [a-before, a+after] and [b-before, b+after] overlap or touch iff b - a <= before + after
    if (current && daysBetween(current.dates[current.dates.length - 1], d) <= before + after) current.dates.push(d);
    else clusters.push({ dates: [d] });
  }
  const limit = Number.isInteger(p.max_receipt_windows) && p.max_receipt_windows > 0 ? p.max_receipt_windows : clusters.length;
  return Object.freeze(clusters.slice(0, limit).map((c) => Object.freeze({
    from: shiftIsoDate(c.dates[0], -before),
    to: shiftIsoDate(c.dates[c.dates.length - 1], after),
    question_dates: Object.freeze([...c.dates]),
    before_days: before,
    after_days: after,
  })));
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
  const windows = deriveReceiptWindows(dates, filters?.doc_groups, p);
  const subtypeRelaxable = p.doc_subtype_filter === "RELAX_ALWAYS"
    && Array.isArray(filters?.doc_subtypes) && filters.doc_subtypes.length > 0;
  return Object.freeze({
    policy_id: p.id,
    question_dates: dates,
    receipt_windows: windows,
    subtype_relaxable: subtypeRelaxable,
  });
}

// Pass order (earlier = higher priority in the merged pool):
//   window[, window:2, ...]         base filters + one receipt window   group "primary"
//   window_relaxed[, :2, ...]       same, minus doc_subtypes             group "relaxed"
//   base                            base filters as mapped               group "primary"
//   base_relaxed                    base minus doc_subtypes              group "relaxed"
// "primary" passes run until the fixed pool is full; "relaxed" passes ALWAYS
// run (they exist only when a subtype was extracted). Passes whose filter
// object is identical to an earlier one are dropped.
export function buildFilterPasses(filters, plan) {
  const base = buildMetadataFiltersFromConditions(filters ?? {});
  if (!plan) return Object.freeze([Object.freeze({ label: "base", group: "primary", filters: base })]);
  const windows = plan.receipt_windows ?? [];
  const relax = (f) => buildMetadataFiltersFromConditions({ ...f, doc_subtypes: [] });
  const withWindow = (f, w) => buildMetadataFiltersFromConditions({ ...f, receipt_date_from: w.from, receipt_date_to: w.to });
  const suffix = (i) => (i === 0 ? "" : `:${i + 1}`);
  const candidates = [];
  windows.forEach((w, i) => candidates.push([`window${suffix(i)}`, "primary", withWindow(base, w)]));
  if (plan.subtype_relaxable) windows.forEach((w, i) => candidates.push([`window_relaxed${suffix(i)}`, "relaxed", relax(withWindow(base, w))]));
  candidates.push(["base", "primary", base]);
  if (plan.subtype_relaxable) candidates.push(["base_relaxed", "relaxed", relax(base)]);
  const seen = new Set();
  const passes = [];
  for (const [label, group, f] of candidates) {
    const key = JSON.stringify(f);
    if (seen.has(key)) continue;
    seen.add(key);
    passes.push(Object.freeze({ label, group, filters: f }));
  }
  return Object.freeze(passes);
}

// ---------------------------------------------------------------------------
// Ranking of the merged pool (k-independent; the caller slices to k).
// ---------------------------------------------------------------------------

const normText = (t) => String(t ?? "").normalize("NFC").replace(/\s+/g, "");

// items: the merged pool in collection order (best first). Two order-
// preserving deferrals, both OFF by default:
//   dedupeContainedWindows -- an item whose VERIFIED text (via textOf) is
//     entirely inside an already-kept chunk of the same document adds
//     nothing and is deferred behind everything that does. No text -> not
//     provably contained -> never deferred. Node/row provenance is NOT used
//     (different rows of one table share a node_index).
//   perDocCap -- defer beyond N chunks of one document.
// Deferred items are appended, never discarded.
export function orderCandidates(items, { dedupeContainedWindows = false, perDocCap = 0, textOf = null } = {}) {
  const kept = [];
  const deferred = [];
  const keptTextsByDoc = new Map();
  const countByDoc = new Map();
  for (const item of items) {
    const count = countByDoc.get(item.doc_id) ?? 0;
    const text = dedupeContainedWindows && typeof textOf === "function" ? normText(textOf(item.chunk_id)) : "";
    const contained = text.length > 0 && (keptTextsByDoc.get(item.doc_id) ?? []).some((keptText) => keptText.includes(text));
    const capped = perDocCap > 0 && count >= perDocCap;
    if (contained || capped) { deferred.push(item); continue; }
    kept.push(item);
    countByDoc.set(item.doc_id, count + 1);
    if (text.length > 0) {
      const texts = keptTextsByDoc.get(item.doc_id) ?? [];
      texts.push(text);
      keptTextsByDoc.set(item.doc_id, texts);
    }
  }
  return [...kept, ...deferred];
}

// Every `every`-th rank (4, 8, 12, ...) goes to the next not-yet-placed
// relaxed-pass candidate when one exists; all other ranks to the next
// primary candidate; whichever side runs out, the other fills the rest.
// A pure function of the input order -> the same list for every k.
export function interleaveRelaxed(ordered, { every = 0, isRelaxed = () => false } = {}) {
  if (!(Number.isInteger(every) && every > 0)) return [...ordered];
  const primary = ordered.filter((x) => !isRelaxed(x));
  const relaxed = ordered.filter((x) => isRelaxed(x));
  const out = [];
  let pi = 0;
  let ri = 0;
  while (pi < primary.length || ri < relaxed.length) {
    const rank = out.length + 1;
    const takeRelaxed = pi >= primary.length || (rank % every === 0 && ri < relaxed.length);
    out.push(takeRelaxed ? relaxed[ri++] : primary[pi++]);
  }
  return out;
}

// The primary pass a relaxed pass relaxes: window_relaxed[:n] -> window[:n],
// base_relaxed -> base. null for anything else.
export function partnerPassOf(label) {
  if (label === "base_relaxed") return "base";
  const m = /^window_relaxed(:\d+)?$/.exec(String(label ?? ""));
  return m ? `window${m[1] ?? ""}` : null;
}

// Evidence-based promotion of relaxed-only candidates (review round 2).
//   ordered      the pool in priority order (primary items in pass order)
//   top          a relaxed candidate is promotable only if its rank within
//                its OWN relaxed pass is <= top
//   rankIn(item, label)   1-based rank of `item` in pass `label`, Infinity
//                if the pass did not return it
//   passOf(item) the pass label the item was first admitted from
//   primaryOrder primary pass labels in priority order (window, window:2, .., base)
// A promotable candidate r from relaxed pass L (partner P) is inserted
// before the first item of block P (primary items of P, plus items already
// promoted into P) that ranks worse than r in L -- Infinity counts as worse;
// if none, at the end of block P (i.e. before the next lower-priority
// block). It can never move above an item of a higher-priority block. All
// non-promotable relaxed candidates are appended after every primary item,
// in their original order. Pure function of the input -> the same list for
// every k.
export function promoteRelaxed(ordered, { top = 0, rankIn = null, passOf = null, primaryOrder = [], isRelaxed = () => false } = {}) {
  if (!(Number.isInteger(top) && top > 0) || typeof rankIn !== "function" || typeof passOf !== "function") return [...ordered];
  const priorityOf = (label) => { const i = primaryOrder.indexOf(label); return i === -1 ? Infinity : i; };
  const blockOf = (item) => (isRelaxed(item) ? partnerPassOf(passOf(item)) : passOf(item));
  const out = ordered.filter((x) => !isRelaxed(x));
  const relaxed = ordered.filter((x) => isRelaxed(x));
  const promotable = relaxed.filter((r) => rankIn(r, passOf(r)) <= top);
  const rest = relaxed.filter((r) => !(rankIn(r, passOf(r)) <= top));
  for (const r of promotable) {
    const label = passOf(r);
    const prio = priorityOf(partnerPassOf(label));
    const rank = rankIn(r, label);
    let at = out.findIndex((x) => {
      const xp = priorityOf(blockOf(x));
      if (xp > prio) return true;
      if (xp < prio) return false;
      return rankIn(x, label) > rank;
    });
    if (at === -1) at = out.length;
    out.splice(at, 0, r);
  }
  return [...out, ...rest];
}

export function rankCandidates(items, {
  dedupeContainedWindows = false, perDocCap = 0, textOf = null,
  promoteTop = 0, rankIn = null, passOf = null, primaryOrder = [],
  interleaveEvery = 0, isRelaxed = () => false,
} = {}) {
  const ordered = orderCandidates(items, { dedupeContainedWindows, perDocCap, textOf });
  const promoted = promoteRelaxed(ordered, { top: promoteTop, rankIn, passOf, primaryOrder, isRelaxed });
  return interleaveRelaxed(promoted, { every: interleaveEvery, isRelaxed });
}
