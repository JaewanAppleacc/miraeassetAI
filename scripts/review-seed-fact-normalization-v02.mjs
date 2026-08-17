import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSeedCanonicalDocumentIrStore } from "../domain/adapters/seed-canonical-document-ir-store.mjs";
import { createSeedEvidenceArtifactStore } from "../domain/adapters/seed-evidence-artifact-store.mjs";

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWED_AT = "2026-08-13T03:30:00.000Z";
const PATHS = Object.freeze({
  queue: "work/domain-seed/seed-fact-normalization-v0.2.review-queue.jsonl",
  canonicalManifest: "domain/releases/seed-release.v0.11.manifest.json",
  evidence: "work/domain-seed/seed-evidence-verified.v0.4.jsonl",
  evidenceManifest: "work/domain-seed/seed-evidence-verified.v0.4.manifest.json",
  decision: "work/domain-seed/seed-fact-normalization-v0.2.owner-decision.jsonl",
  audit: "work/domain-seed/seed-fact-normalization-v0.2.independent-audit.jsonl",
  report: "work/domain-seed/seed-fact-normalization-v0.2.independent-review.md",
});
const parseJsonl = (text) => text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const compact = (value) => value.replace(/\s/g, "");

export async function reviewSeedFactNormalizationV02({ root = rootDefault, paths = PATHS, writeOutputs = true, reviewedAt = REVIEWED_AT } = {}) {
  const p = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
  const queue = parseJsonl(await readFile(p.queue, "utf8"));
  if (queue.length !== 16) throw new Error("expected 16 normalization review items");
  const [documents, evidenceStore] = await Promise.all([
    createSeedCanonicalDocumentIrStore(p.canonicalManifest),
    createSeedEvidenceArtifactStore({ evidencePath: p.evidence, manifestPath: p.evidenceManifest }),
  ]);
  const audit = [];
  for (const item of queue) {
    if (item.evidence_ids.length !== 1) throw new Error(`${item.fact_id}: expected one direct Evidence`);
    const envelope = await evidenceStore.getEvidence(item.evidence_ids[0]);
    const evidence = envelope?.record;
    const document = await documents.getDocument(item.source_document_id);
    const block = document?.blocks?.find((candidate) => candidate.source_locator === evidence?.source_locator);
    const cells = block?.table?.raw_rows?.flat() ?? [];
    const valueCell = cells.find((cell) => cell.text === item.raw_value_text);
    const labelCell = cells.find((cell) => compact(cell.text ?? "").includes(compact(item.raw_label)));
    const nearbyUnitBlocks = (document?.blocks ?? []).filter((candidate) =>
      candidate.file_id === evidence?.file_id && Math.abs(candidate.ordinal - block?.ordinal) <= 15 && JSON.stringify(candidate).includes(item.raw_unit_text),
    ).sort((a, b) => Math.abs(a.ordinal - block.ordinal) - Math.abs(b.ordinal - block.ordinal));
    const unitBlock = nearbyUnitBlocks[0];
    const exactMath = Number.isSafeInteger(item.proposed_normalized_value_krw) &&
      item.previous_normalized_value * item.previous_scale === item.proposed_normalized_value_krw;
    const checks = {
      evidence_resolves: Boolean(evidence && block),
      document_matches: evidence?.document_id === item.source_document_id,
      value_cell_exact: Boolean(valueCell),
      label_same_row_block: Boolean(labelCell),
      disclosed_unit_nearby: Boolean(unitBlock),
      raw_unit_scale_match: (item.raw_unit_text === "천원" && item.previous_scale === 1_000) || (item.raw_unit_text === "백만원" && item.previous_scale === 1_000_000),
      exact_safe_integer_math: exactMath,
    };
    audit.push({
      fact_id: item.fact_id, evidence_id: item.evidence_ids[0], document_id: item.source_document_id,
      source_locator: evidence?.source_locator ?? null, value_cell: valueCell?.text ?? null,
      label_cell: labelCell?.text ?? null, unit_locator: unitBlock?.source_locator ?? null,
      unit_distance: unitBlock ? Math.abs(unitBlock.ordinal - block.ordinal) : null,
      previous_normalized_value: item.previous_normalized_value, previous_scale: item.previous_scale,
      proposed_normalized_value_krw: item.proposed_normalized_value_krw, checks,
      disposition: Object.values(checks).every(Boolean) ? "APPROVE" : "REJECT",
    });
  }
  const decisions = audit.map((item) => ({
    fact_id: item.fact_id, disposition: item.disposition,
    proposed_normalized_value_krw: item.proposed_normalized_value_krw,
    reviewer: "CODEX_OWNER_DIRECTED_CANONICAL_REVIEW", decided_at: reviewedAt,
    note: item.disposition === "APPROVE" ? `원문 값·라벨·${item.previous_scale === 1_000 ? "천원" : "백만원"} 단위 및 정수 곱셈 확인` : "독립 검증 실패",
  }));
  const approved = decisions.filter((item) => item.disposition === "APPROVE").length;
  const report = `# Seed Fact normalization v0.2 independent review\n\n- Review method: canonical DocumentIR + VERIFIED Evidence independent re-resolution\n- Reviewer: CODEX_OWNER_DIRECTED_CANONICAL_REVIEW\n- Items: 16\n- APPROVE: ${approved}\n- REJECT: ${16 - approved}\n- Human second reviewer: NOT_PERFORMED (owner chose no delegation)\n- Promotion allowed: ${approved === 16 ? "YES" : "NO"}\n`;
  if (writeOutputs) {
    await mkdir(path.dirname(p.decision), { recursive: true });
    await Promise.all([writeFile(p.decision, jsonl(decisions)), writeFile(p.audit, jsonl(audit)), writeFile(p.report, report)]);
  }
  return Object.freeze({ audit, decisions, report, approved });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await reviewSeedFactNormalizationV02();
  console.log(JSON.stringify({ reviewed: result.decisions.length, approved: result.approved }));
}
