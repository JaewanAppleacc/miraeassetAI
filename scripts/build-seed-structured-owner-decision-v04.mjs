// Finalizes the v0.4 structured review packet's Owner decision. Reads the
// PENDING template (never mutated) and the Owner's actual verbal approval
// (hardcoded below, from this session's conversation -- there is no other
// out-of-band decision channel yet) and writes a NEW, separately-versioned
// final decision JSONL + manifest + human-readable approval report. Never
// touches the template, never touches any Candidate/VERIFIED artifact,
// never promotes anything -- promotion is a separate, later script that
// requires this decision to show zero PENDING/FIX_REQUIRED/REJECT first.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWED_AT = new Date().toISOString();
const REVIEWER = "최재완";

const TEMPLATE_JSONL = "work/domain-seed/seed-structured-owner-decision-template.v0.4.jsonl";
const TEMPLATE_MANIFEST = "work/domain-seed/seed-structured-owner-decision-template.v0.4.manifest.json";

const OUT_JSONL = "work/domain-seed/seed-structured-owner-decision.v0.4.jsonl";
const OUT_MANIFEST = "work/domain-seed/seed-structured-owner-decision.v0.4.manifest.json";
const OUT_REPORT = "work/domain-seed/seed-structured-owner-decision.v0.4.approval-report.md";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
async function sha256OfFile(relPath) {
  return sha256(await readFile(path.join(REPO, relPath)));
}
async function readJsonl(relPath) {
  const text = await readFile(path.join(REPO, relPath), "utf8");
  return text.trim().split("\n").map((l) => JSON.parse(l));
}
function jsonl(records) {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

const NOTES_CARRIED_FORWARD =
  "이전 승인 승계 + 기계 불변 검사(이전 decision artifact SHA 불변, v0.3 대비 slot fact_ids/evidence_ids 불변, "
  + "fact 값 필드 불변)를 근거로 승인. Owner: 최재완.";

const NOTES_NEW_OR_CHANGED =
  "이번 세션의 원문(canonical DocumentIR raw table cell) 및 Candidate Fact/Evidence 독립 대조를 근거로 승인. Owner: 최재완.";

// The one Owner-flagged non-blocking note, attached only to the one item it
// concerns (latest_package_terms) -- never applied to any other item.
const NON_BLOCKING_NOTE_PACKAGE_TERMS =
  " 비차단 참고: 현재 evidence locator는 node=1까지만 지정되어 있음(quoted_text 자체는 정정후(5,564) 값과 정확히 일치함이 "
  + "이번 세션에 확인됨). 추후 node=1&row=7&col=2로 셀 단위까지 강화 가능 -- 이번 승인을 막는 사유 아님.";

async function main() {
  const templateItems = await readJsonl(TEMPLATE_JSONL);
  if (templateItems.length !== 82) throw new Error(`expected 82 template items, found ${templateItems.length}`);
  if (!templateItems.every((i) => i.owner_disposition === "PENDING")) {
    throw new Error("template no longer shows all-PENDING -- refusing to finalize against a mutated template");
  }

  const finalItems = templateItems.map((item) => {
    const isCarriedForward = item.category === "CARRIED_FORWARD_CANDIDATE";
    let notes = isCarriedForward ? NOTES_CARRIED_FORWARD : NOTES_NEW_OR_CHANGED;
    if (item.slot_key === "question_seed_v07_22::latest_package_terms") notes += NON_BLOCKING_NOTE_PACKAGE_TERMS;
    return {
      ...item,
      owner_disposition: "APPROVE",
      reviewer: REVIEWER,
      reviewed_at: REVIEWED_AT,
      notes,
    };
  });

  const categoryCounts = finalItems.reduce((acc, i) => {
    acc[i.category] = (acc[i.category] ?? 0) + 1;
    return acc;
  }, {});
  if (categoryCounts.CARRIED_FORWARD_CANDIDATE !== 69 || categoryCounts.NEW_Q3_Q22 !== 10 || categoryCounts.LINKAGE_CHANGED !== 3) {
    throw new Error(`unexpected category distribution: ${JSON.stringify(categoryCounts)}`);
  }
  const allApproved = finalItems.every((i) => i.owner_disposition === "APPROVE");
  if (!allApproved) throw new Error("not all 82 items are APPROVE -- refusing to write a final decision");

  await writeFile(path.join(REPO, OUT_JSONL), jsonl(finalItems), "utf8");

  const outputBytes = await readFile(path.join(REPO, OUT_JSONL));
  const manifest = {
    schema_version: "0.1.0",
    decision_id: "seed-structured-owner-decision-v0.4",
    status: "APPROVED",
    approved_by: REVIEWER,
    approved_at: REVIEWED_AT,
    scope: "82건 v0.4 structured review packet 항목 단위 승인 (Fact v0.4 Candidate 67건, Coverage v0.4 Candidate 82 slot에 대응). "
      + "safeguard: 이전 v0.1 결정의 NO_Q3_Q22는 이번 결정으로 명시적으로 대체됨 -- Q3(4건)·Q22 신규/변경(9건)이 이번 승인 범위에 포함됨.",
    template_source: {
      path: TEMPLATE_JSONL,
      sha256: await sha256OfFile(TEMPLATE_JSONL),
      manifest_path: TEMPLATE_MANIFEST,
      manifest_sha256: await sha256OfFile(TEMPLATE_MANIFEST),
    },
    decision_output: {
      path: OUT_JSONL,
      sha256: sha256(outputBytes),
      record_count: finalItems.length,
    },
    category_counts: categoryCounts,
    disposition_distribution: finalItems.reduce((acc, i) => {
      acc[i.owner_disposition] = (acc[i.owner_disposition] ?? 0) + 1;
      return acc;
    }, {}),
    invariants: {
      total_items: 82,
      all_approve: allApproved,
      any_pending_or_fix_required_or_reject: finalItems.some((i) => i.owner_disposition !== "APPROVE"),
      no_template_modified: true,
      no_candidate_or_verified_artifact_modified: true,
      no_promotion_performed_by_this_script: true,
    },
  };
  await writeFile(path.join(REPO, OUT_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const lines = [];
  lines.push("# Seed Structured Owner Decision v0.4 — Approval Report");
  lines.push("");
  lines.push(`- Owner: ${REVIEWER}`);
  lines.push(`- 승인 시각: ${REVIEWED_AT}`);
  lines.push(`- 결과: 82/82 APPROVE (PENDING/FIX_REQUIRED/REJECT 0건)`);
  lines.push(`- 근거 원본: \`${TEMPLATE_JSONL}\` (sha256 \`${manifest.template_source.sha256}\`)`);
  lines.push(`- 이 결정 산출물: \`${OUT_JSONL}\` (sha256 \`${manifest.decision_output.sha256}\`)`);
  lines.push("");
  lines.push("## 분포");
  lines.push("");
  lines.push(`- CARRIED_FORWARD_CANDIDATE: ${categoryCounts.CARRIED_FORWARD_CANDIDATE}건 — 이전 승인 승계 + 기계 불변 검사 근거`);
  lines.push(`- NEW_Q3_Q22: ${categoryCounts.NEW_Q3_Q22}건 — 이번 세션 원문 독립 대조 근거`);
  lines.push(`- LINKAGE_CHANGED: ${categoryCounts.LINKAGE_CHANGED}건 — 이번 세션 원문 독립 대조 근거`);
  lines.push("");
  lines.push("## 비차단 참고 사항");
  lines.push("");
  lines.push(`- \`question_seed_v07_22::latest_package_terms\`: ${NON_BLOCKING_NOTE_PACKAGE_TERMS.trim()}`);
  lines.push("");
  lines.push("## 이 결정이 여는 것 / 열지 않는 것");
  lines.push("");
  lines.push("- 이 문서는 82개 review packet 항목에 대한 Owner 승인 기록이다. Fact/Coverage/Evidence/Gold를 VERIFIED로");
  lines.push("  승격하거나 Runtime을 재배선하지 않는다 — 그것은 이 승인을 입력으로 삼는 별도 promotion 스크립트의 역할이다.");
  lines.push("- promotion 스크립트는 이 파일이 82/82 APPROVE인지 실행 시점에 다시 검증하며, 하나라도 아니면 중단한다.");
  lines.push("");
  await writeFile(path.join(REPO, OUT_REPORT), lines.join("\n"), "utf8");

  console.log(JSON.stringify({
    total: finalItems.length,
    category_counts: categoryCounts,
    all_approve: allApproved,
    outputs: [OUT_JSONL, OUT_MANIFEST, OUT_REPORT],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
