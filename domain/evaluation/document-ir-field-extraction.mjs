// Turn N4.5.1: pure, read-only field extraction over the RAW canonical
// DocumentIR table shape (work/a-document-ir/source/*.jsonl -- doc_id /
// nodes[].normalized_rows). No filesystem access here -- callers load
// records via domain/adapters/document-ir-raw-source-loader.mjs and pass
// the parsed record in. No document id, company name, or specific value is
// hardcoded anywhere in this file -- every rule here is a STRUCTURAL
// convention of DART "정정" (correction) / "as-is" disclosure tables:
//   - a table row (label, value) or (category, category, value) or
//     (category, subfield, value) describes ONE field of the document's
//     current/as-declared state
//   - a table whose own header row is exactly ['정정항목','정정전','정정후']
//     (DART's own fixed column headers for a correction-item table) marks
//     every row AFTER it as (label, before-value, after-value)
//   - a "※ 관련공시" row's value is a concatenation of one or more
//     "YYYY-MM-DD <report name>" entries with no separator between them

// Strips a leading "N. "/bullet/dash and collapses all internal
// whitespace, so "5. 계약기간" and "계약기간" (or "- 체결계약명" and
// "체결계약명") normalize to the identical label string. Deliberately
// does NOT fuzz-merge otherwise-different labels (e.g. never strips
// interior characters), per the "계약금액과 기타자금을 연결하지 않는다"
// requirement -- two labels normalize equal only if their real text
// (numbering/whitespace aside) is equal.
export function normalizeFieldLabel(raw) {
  return String(raw ?? "")
    .replace(/^[-\s]*\d+\.\s*/, "")
    .replace(/^[-\s]+/, "")
    .replace(/\s+/g, "")
    .trim();
}

const CORRECTION_TABLE_HEADER = ["정정항목", "정정전", "정정후"];

function rowEquals(row, expected) {
  return Array.isArray(row) && row.length === expected.length && row.every((cell, i) => cell === expected[i]);
}

// Collapses ADJACENT equal cells (from either end inward is unnecessary --
// a single left-to-right adjacent-dedup pass is sufficient and general):
// (label,label,value) -> (label,value); (label,value,value) -> (label,value);
// (a,a,b,b) -> (a,b); (category,subfield,value) is untouched (no adjacent
// pair equal) -> stays length 3.
function collapseAdjacentDuplicates(cells) {
  const out = [];
  for (const cell of cells) {
    if (out.length > 0 && out[out.length - 1] === cell) continue;
    out.push(cell);
  }
  return out;
}

// Extracts every field this table's rows describe, node-locator-tagged.
// `afterCorrectionHeader` rows (following the fixed 정정항목/정정전/정정후
// marker) are emitted as `kind: "correction_pair"` with before/after;
// every other row is emitted as `kind: "plain_value"` via the generic
// adjacent-dedup collapse. Rows this module cannot confidently interpret
// (post-collapse length outside 2..3) are skipped, never guessed.
export function extractTableFields(node) {
  if (!node || node.kind !== "table" || !Array.isArray(node.normalized_rows)) return [];
  const fields = [];
  let afterHeader = false;
  node.normalized_rows.forEach((row, rowIndex) => {
    const locator = `${node.node_id}#row=${rowIndex}`;
    if (rowEquals(row, CORRECTION_TABLE_HEADER)) {
      afterHeader = true;
      return;
    }
    if (afterHeader) {
      if (row.length === 3) {
        fields.push({ kind: "correction_pair", fieldLabelRaw: row[0], fieldLabel: normalizeFieldLabel(row[0]), before: row[1], after: row[2], locator });
      }
      return;
    }
    const collapsed = collapseAdjacentDuplicates(row);
    if (collapsed.length === 2) {
      fields.push({ kind: "plain_value", fieldLabelRaw: collapsed[0], fieldLabel: normalizeFieldLabel(collapsed[0]), value: collapsed[1], locator });
    } else if (collapsed.length === 3) {
      const label = normalizeFieldLabel(collapsed[0]) + normalizeFieldLabel(collapsed[1]);
      fields.push({ kind: "plain_value", fieldLabelRaw: `${collapsed[0]}${collapsed[1]}`, fieldLabel: label, value: collapsed[2], locator });
    }
    // length 1 or >=4 after collapse: not a recognized shape -- skipped.
  });
  return fields;
}

// Extracts every field across every table node in the document.
export function extractDocumentFields(documentIrRecord) {
  const fields = [];
  for (const node of documentIrRecord?.nodes ?? []) {
    fields.push(...extractTableFields(node));
  }
  return fields;
}

// Splits a "※ 관련공시" cell's concatenated text into individual
// (date, reportNameGuess) entries. Pure text-shape parsing -- looks only
// for the literal YYYY-MM-DD pattern, never a specific date or company.
export function parseRelatedDisclosuresText(text) {
  if (!text || text === "-") return [];
  const re = /(\d{4}-\d{2}-\d{2})([^]*?)(?=\d{4}-\d{2}-\d{2}|$)/g;
  const entries = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const reportNameGuess = match[2].trim();
    entries.push({ date: match[1], reportNameGuess: reportNameGuess || null });
    if (match.index === re.lastIndex) re.lastIndex += 1; // guard against a zero-width match looping forever
  }
  return entries;
}

// The fixed set of stable field categories this Turn's continuity check
// looks for, matched by (normalized-label === / .includes()) rules chosen
// to be specific enough never to cross-match an unrelated field (e.g.
// CONTRACT_AMOUNT's 'includes' check can never match a 기타자금 label,
// since that string never contains the substring 계약금액; CONTRACT_
// PERIOD_END/START require the exact concatenated label so an unrelated
// '유보기한종료일'-shaped field is never treated as a contract period).
export const FIELD_CATEGORIES = Object.freeze({
  CONTRACT_NAME: (label) => label === "계약명" || label.includes("체결계약명"),
  COUNTERPARTY: (label) => label.includes("계약상대"),
  CONTRACT_AMOUNT: (label) => label.includes("계약금액"),
  CONTRACT_PERIOD_END: (label) => label === "계약기간종료일",
  CONTRACT_PERIOD_START: (label) => label === "계약기간시작일",
});

export function classifyFieldCategory(normalizedLabel) {
  for (const [category, predicate] of Object.entries(FIELD_CATEGORIES)) {
    if (predicate(normalizedLabel)) return category;
  }
  return null;
}

function normalizeComparableValue(raw, category) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "" || trimmed === "-") return null;
  if (category === "CONTRACT_AMOUNT") return trimmed.replace(/,/g, "");
  return trimmed;
}

// Returns { byCategory: Map<category, { value, locator, kind }> } for a
// document's fields, preferring a correction_pair's "after" value (the
// CURRENT/effective value once that document's own correction is applied)
// over a plain_value row when both exist for the same category.
export function indexFieldsByCategory(fields) {
  const byCategory = new Map();
  for (const field of fields) {
    const category = classifyFieldCategory(field.fieldLabel);
    if (!category) continue;
    const currentValue = field.kind === "correction_pair" ? field.after : field.value;
    const normalized = normalizeComparableValue(currentValue, category);
    if (normalized == null) continue;
    const existing = byCategory.get(category);
    // A correction_pair's after-value wins over a plain_value if both are present.
    if (!existing || (field.kind === "correction_pair" && existing.kind !== "correction_pair")) {
      byCategory.set(category, { value: normalized, rawValue: currentValue, locator: field.locator, kind: field.kind });
    }
  }
  return byCategory;
}

// The source document's "before" state per category (only meaningful for
// correction_pair rows -- a source document with no correction table for a
// category has no "before" value to compare).
export function indexSourceBeforeByCategory(fields) {
  const byCategory = new Map();
  for (const field of fields) {
    if (field.kind !== "correction_pair") continue;
    const category = classifyFieldCategory(field.fieldLabel);
    if (!category) continue;
    const normalized = normalizeComparableValue(field.before, category);
    if (normalized == null) continue;
    if (!byCategory.has(category)) byCategory.set(category, { value: normalized, rawValue: field.before, locator: field.locator, kind: field.kind });
  }
  return byCategory;
}

// Compares a source document's BEFORE state against a candidate document's
// CURRENT/effective state, category by category. Returns one entry per
// category where both sides have a value AND the normalized values are
// exactly equal -- never a fuzzy/partial match, and never across two
// DIFFERENT categories.
// `field.locator` is already a fully-qualified locator ("<node_id>#row=N",
// and node_id itself is "<doc_id>::<rel_path>::nN") -- it is used verbatim,
// never re-prefixed with a doc_id (that would duplicate it).
export function findContinuitySignals({ sourceBeforeByCategory, candidateCurrentByCategory }) {
  const signals = [];
  for (const [category, sourceEntry] of sourceBeforeByCategory) {
    const candidateEntry = candidateCurrentByCategory.get(category);
    if (!candidateEntry) continue;
    if (sourceEntry.value !== candidateEntry.value) continue;
    signals.push({
      category,
      source_field_label: category,
      source_before_value: sourceEntry.rawValue,
      source_locator: sourceEntry.locator,
      candidate_field_label: category,
      candidate_after_value: candidateEntry.rawValue,
      candidate_locator: candidateEntry.locator,
      normalized_comparison_value: sourceEntry.value,
    });
  }
  return signals;
}

// A SEPARATE signal kind from findContinuitySignals: an "identity match"
// compares the source document's OWN CURRENT/as-declared fields against
// the candidate's CURRENT/effective fields (not before-vs-after), looking
// for the two named same-event combinations from Turn N4.5.1 Section 6:
// contract name + counterparty both equal, or contract name + amount both
// equal. Never a single-field match alone (name-only or amount-only is not
// specific enough to claim identity), and never a cross-category
// comparison (name is only ever compared against name).
export function findIdentitySignals({ sourceCurrentByCategory, candidateCurrentByCategory }) {
  const signals = [];
  const nameMatches = valuesMatch(sourceCurrentByCategory, candidateCurrentByCategory, "CONTRACT_NAME");
  if (nameMatches) {
    const counterpartyMatches = valuesMatch(sourceCurrentByCategory, candidateCurrentByCategory, "COUNTERPARTY");
    if (counterpartyMatches) {
      signals.push(buildIdentitySignal("CONTRACT_NAME_AND_COUNTERPARTY", ["CONTRACT_NAME", "COUNTERPARTY"], sourceCurrentByCategory, candidateCurrentByCategory));
    }
    const amountMatches = valuesMatch(sourceCurrentByCategory, candidateCurrentByCategory, "CONTRACT_AMOUNT");
    if (amountMatches) {
      signals.push(buildIdentitySignal("CONTRACT_NAME_AND_AMOUNT", ["CONTRACT_NAME", "CONTRACT_AMOUNT"], sourceCurrentByCategory, candidateCurrentByCategory));
    }
  }
  return signals;
}

function valuesMatch(sourceMap, candidateMap, category) {
  const s = sourceMap.get(category);
  const c = candidateMap.get(category);
  return Boolean(s && c && s.value === c.value);
}

function buildIdentitySignal(kind, categories, sourceMap, candidateMap) {
  return {
    identity_kind: kind,
    fields: categories.map((category) => ({
      category,
      source_value: sourceMap.get(category).rawValue,
      source_locator: sourceMap.get(category).locator,
      candidate_value: candidateMap.get(category).rawValue,
      candidate_locator: candidateMap.get(category).locator,
    })),
  };
}
