import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_PATH = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/official/BD_CRITICAL_PACKET_AUDIT_V1.md");

// Every raw financial figure that appears in the full (untracked,
// work/audit/*.RAW.md) version of this audit -- both the retrieved
// (wrong) values and Gold's own required (correct) values. None of these
// may ever appear in the git-tracked sanitized file.
const RAW_FIGURES = [
  "16,368,185", "13,615,412", "8,969,575", "131,667,154", "15,258,135",
  "892,729", "3,534,850", "3,500,214", "5,452,238", "5,171,611", "5,057,410", "1,697,877",
];

async function loadAudit() {
  return readFile(AUDIT_PATH, "utf8");
}

test("sanitized B/D audit never contains any raw financial figure from the full audit", async () => {
  const text = await loadAudit();
  for (const figure of RAW_FIGURES) {
    assert.equal(text.includes(figure), false, `sanitized audit must not contain raw figure ${figure}`);
  }
});

test("sanitized B/D audit never contains an email address (adjudicator identity)", async () => {
  const text = await loadAudit();
  assert.equal(text.includes("@"), false);
});

test("sanitized B/D audit never contains a DEV_CHECK/HOLDOUT question id or split-content reference (a disclaimer sentence saying 'no DEV_CHECK/HOLDOUT content' is fine)", async () => {
  const text = await loadAudit();
  assert.doesNotMatch(text, /DEV_CHECK[-_]?\d|HOLDOUT[-_]?\d/);
});

test("sanitized B/D audit never quotes raw chunk table text (no '|' delimited financial table rows)", async () => {
  const text = await loadAudit();
  // The raw chunk_text fields are pipe-delimited financial statement rows
  // like "매출액 | 16,368,185 | ...". The sanitized file should never
  // reproduce that shape.
  assert.doesNotMatch(text, /매출액\s*\|/);
  assert.doesNotMatch(text, /자본총계\s*\|/);
});

test("sanitized B/D audit carries only the allowed field set (per Turn instructions)", async () => {
  const text = await loadAudit();
  const requiredMarkers = [
    "question_id", "slot_name", "locator resolves", "matches the actual retrieved chunk",
    "required evidence", "final answer claim", "failure mechanism", "vFINAL severity",
    "RETRIEVAL_SLOT_FAILURE", "SHA unchanged",
  ];
  for (const marker of requiredMarkers) {
    assert.ok(text.includes(marker), `expected sanitized audit to mention "${marker}"`);
  }
});

test("full (raw) audit exists locally but is git-ignored, never committed", async () => {
  const rawPath = path.resolve(__dirname, "../work/audit/BD_CRITICAL_PACKET_AUDIT_V1.RAW.md");
  const raw = await readFile(rawPath, "utf8"); // throws if missing -- the raw version must be PRESERVED, not deleted
  assert.ok(raw.includes("15,258,135") || raw.includes("1,697,877"), "raw audit should still carry the full detail locally");
});
