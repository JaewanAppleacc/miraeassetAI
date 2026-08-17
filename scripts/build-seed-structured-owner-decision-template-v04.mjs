// Builds the per-item Owner decision TEMPLATE for the 82-slot v0.4
// structured review packet. Read-only over existing Candidate/VERIFIED
// artifacts and prior Owner decision artifacts -- writes only new,
// clearly-versioned template outputs. Never mutates any input, never sets
// owner_disposition to anything but PENDING, never promotes anything to
// VERIFIED. A human (Owner) fills in owner_disposition/reviewer/reviewed_at/
// notes afterward, out of band -- only APPROVE/FIX_REQUIRED/REJECT values
// they write are ever treated as a final decision.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_AT = new Date().toISOString();

const INPUT_PATHS = {
  reviewPacket: "work/domain-seed/seed-structured-review-packet.v0.4.jsonl",
  factsCandidatesV04: "work/domain-seed/seed-facts-candidates.v0.4.jsonl",
  coverageCandidatesV04: "work/domain-seed/seed-fact-coverage-candidates.v0.4.json",
  goldV16: "work/domain-seed/seed-gold-promotion-candidates.v0.16.jsonl",
  evidenceVerifiedV05: "work/domain-seed/seed-evidence-verified.v0.5.jsonl",
  evidenceCandidateV06Delta: "work/domain-seed/seed-evidence-candidates.v0.6.delta.jsonl",
  factsVerifiedV03: "work/domain-seed/seed-facts-verified.v0.3.jsonl",
  coverageVerifiedV03: "work/domain-seed/seed-fact-coverage-verified.v0.3.json",
  priorOwnerDecisionV01: "work/domain-seed/seed-structured-owner-decision.v0.1.json",
  priorNormalizationDecisionV02: "work/domain-seed/seed-fact-normalization-v0.2.owner-decision.jsonl",
};

const OUTPUT_PATHS = {
  templateJsonl: "work/domain-seed/seed-structured-owner-decision-template.v0.4.jsonl",
  checklistMd: "work/domain-seed/seed-structured-owner-decision-template.v0.4.checklist.md",
  manifest: "work/domain-seed/seed-structured-owner-decision-template.v0.4.manifest.json",
};

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readTextAbs(relPath) {
  return readFile(path.join(REPO, relPath), "utf8");
}

async function readJsonl(relPath) {
  const text = await readTextAbs(relPath);
  return text.trim().length ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

async function readJson(relPath) {
  return JSON.parse(await readTextAbs(relPath));
}

async function sha256OfFile(relPath) {
  return sha256(await readFile(path.join(REPO, relPath)));
}

function jsonl(records) {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// Deep, order-insensitive equality for the small subset of value fields we
// diff -- arrays are compared as sets when they hold only strings (fact_ids/
// evidence_ids), everything else by strict equality after JSON round-trip
// (covers null/number/string/boolean uniformly).
function arraysEqualAsSets(a, b) {
  const as = new Set(a ?? []);
  const bs = new Set(b ?? []);
  if (as.size !== bs.size) return false;
  for (const v of as) if (!bs.has(v)) return false;
  return true;
}

function valuesEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function main() {
  const [
    reviewPacket, factsV04, coverageV04Doc, goldV16, evidenceV05, evidenceV06Delta,
    factsV03, coverageV03Doc, priorOwnerDecisionV01, priorNormalizationDecisionV02,
  ] = await Promise.all([
    readJsonl(INPUT_PATHS.reviewPacket),
    readJsonl(INPUT_PATHS.factsCandidatesV04),
    readJson(INPUT_PATHS.coverageCandidatesV04),
    readJsonl(INPUT_PATHS.goldV16),
    readJsonl(INPUT_PATHS.evidenceVerifiedV05),
    readJsonl(INPUT_PATHS.evidenceCandidateV06Delta),
    readJsonl(INPUT_PATHS.factsVerifiedV03),
    readJson(INPUT_PATHS.coverageVerifiedV03),
    readJson(INPUT_PATHS.priorOwnerDecisionV01),
    readJsonl(INPUT_PATHS.priorNormalizationDecisionV02),
  ]);

  if (reviewPacket.length !== 82) throw new Error(`expected 82 review packet items, found ${reviewPacket.length}`);

  const factsByIdV04 = new Map(factsV04.map((f) => [f.fact_id, f]));
  const factsByIdV03 = new Map(factsV03.map((f) => [f.fact_id, f]));
  const coverageSlotsV04ByKey = new Map(coverageV04Doc.slots.map((s) => [s.slot_key, s]));
  const coverageSlotsV03ByKey = new Map(coverageV03Doc.slots.map((s) => [s.slot_key, s]));
  const evidenceById = new Map([...evidenceV05, ...evidenceV06Delta].map((e) => [e.evidence_id, e]));
  const normalizationDecisionByFactId = new Map(priorNormalizationDecisionV02.map((d) => [d.fact_id, d]));

  const goldEvidenceIdsQ3Q22 = new Set(
    goldV16
      .filter((g) => ["question_seed_v07_03", "question_seed_v07_22"].includes(g.question_id))
      .flatMap((g) => g.extensions?.evidence_ids ?? []),
  );

  // verification_status is deliberately EXCLUDED: v0.4 uniformly
  // re-labels every carried-forward fact VERIFIED -> CANDIDATE as part of
  // the re-review classification itself (see build-v016.mjs) -- that is
  // the expected, universal reason this decision template exists at all,
  // not a content drift signal. This checks the underlying FACT VALUE only.
  const FACT_VALUE_FIELDS = [
    "metric_code", "value_type", "value_status", "value_certainty", "raw_value_text", "raw_unit_text",
    "normalized_value", "unit", "currency", "scale", "scope", "period_type", "period_start", "period_end",
    "as_of_date", "evidence_ids",
  ];

  function diffFactValueFields(factV03, factV04) {
    const diffs = [];
    for (const field of FACT_VALUE_FIELDS) {
      const a = factV03[field];
      const b = factV04[field];
      const equal = field === "evidence_ids" ? arraysEqualAsSets(a, b) : valuesEqual(a, b);
      if (!equal) diffs.push({ field, v0_3: a ?? null, v0_4_candidate: b ?? null });
    }
    return diffs;
  }

  function resolveEvidenceDetail(evidenceId) {
    const record = evidenceById.get(evidenceId);
    if (!record) {
      return { evidence_id: evidenceId, found: false, note: "combined VERIFIED(v0.5)+CANDIDATE(v0.6 delta) evidence set에서 해석 실패" };
    }
    return {
      evidence_id: record.evidence_id,
      found: true,
      document_id: record.document_id,
      source_locator: record.source_locator,
      quoted_text: record.quoted_text,
      quote_sha256: record.quote_sha256,
      verification_status: record.verification_status,
      linked_in_gold_v0_16_q3_q22: goldEvidenceIdsQ3Q22.has(record.evidence_id),
    };
  }

  function resolveFactDetail(factId, factsById) {
    const record = factsById.get(factId);
    if (!record) return { fact_id: factId, found: false };
    return {
      fact_id: record.fact_id,
      found: true,
      corp_code: record.corp_code,
      source_document_id: record.source_document_id,
      metric_code: record.metric_code,
      raw_label: record.raw_label,
      value_type: record.value_type,
      value_status: record.value_status,
      value_certainty: record.value_certainty,
      raw_value_text: record.raw_value_text,
      raw_unit_text: record.raw_unit_text,
      normalized_value: record.normalized_value,
      unit: record.unit,
      scale: record.scale,
      period_start: record.period_start,
      period_end: record.period_end,
      as_of_date: record.as_of_date,
      verification_status: record.verification_status,
      evidence_ids: record.evidence_ids,
    };
  }

  // Every prior_decision_artifacts[].path this packet cites, hashed exactly
  // once now (not once per review item) -- reused for every carried-forward
  // item's machine check.
  const priorArtifactPaths = new Set();
  for (const item of reviewPacket) {
    for (const ref of item.prior_approval?.prior_decision_artifacts ?? []) priorArtifactPaths.add(ref.path);
  }
  const priorArtifactActualSha256 = new Map(
    await Promise.all([...priorArtifactPaths].map(async (p) => [p, await sha256OfFile(p)])),
  );

  const templateItems = reviewPacket.map((item) => {
    const coverageSlot = coverageSlotsV04ByKey.get(item.slot_key);
    const facts = item.fact_ids.map((id) => resolveFactDetail(id, factsByIdV04));
    const evidence = item.evidence_ids.map(resolveEvidenceDetail);

    const base = {
      review_item_id: item.review_item_id,
      slot_key: item.slot_key,
      category: item.category,
      artifact_path: item.artifact_path,
      artifact_sha256: item.artifact_sha256,
      fact_ids: item.fact_ids,
      evidence_ids: item.evidence_ids,
      coverage_slot: coverageSlot
        ? {
            metric_code: coverageSlot.metric_code, corp_code: coverageSlot.corp_code, period_key: coverageSlot.period_key,
            scope: coverageSlot.scope, candidate_status: coverageSlot.candidate_status,
            verification_status: coverageSlot.verification_status, reason_code: coverageSlot.reason_code ?? null,
          }
        : { found: false },
      facts,
      evidence,
      claude_recommended_verdict: item.claude_recommended_verdict,
      claude_review_basis: item.claude_review_basis,
      prior_approval: item.prior_approval,
    };

    if (item.category === "CARRIED_FORWARD_CANDIDATE") {
      const priorShaChecks = (item.prior_approval?.prior_decision_artifacts ?? []).map((ref) => {
        const actual = priorArtifactActualSha256.get(ref.path);
        return { path: ref.path, decision_id: ref.decision_id, recorded_sha256: ref.sha256, actual_sha256_now: actual, sha256_unchanged: actual === ref.sha256 };
      });

      const v03Slot = coverageSlotsV03ByKey.get(item.slot_key);
      const linkageCheck = v03Slot
        ? {
            slot_found_in_v0_3: true,
            fact_ids_unchanged: arraysEqualAsSets(v03Slot.fact_ids, coverageSlot?.fact_ids),
            evidence_ids_unchanged: arraysEqualAsSets(v03Slot.evidence_ids, coverageSlot?.evidence_ids),
            v0_3_coverage_state: v03Slot.coverage_state ?? null,
          }
        : { slot_found_in_v0_3: false, fact_ids_unchanged: false, evidence_ids_unchanged: false };

      const factValueChecks = item.fact_ids.map((factId) => {
        const v03Fact = factsByIdV03.get(factId);
        const v04Fact = factsByIdV04.get(factId);
        if (!v03Fact || !v04Fact) return { fact_id: factId, found_in_both: false };
        const diffs = diffFactValueFields(v03Fact, v04Fact);
        return { fact_id: factId, found_in_both: true, value_fields_unchanged: diffs.length === 0, diffs };
      });

      const normalizationRefs = item.fact_ids
        .map((id) => normalizationDecisionByFactId.get(id))
        .filter(Boolean)
        .map((d) => ({ fact_id: d.fact_id, reviewer: d.reviewer ?? null, review_method: d.review_method ?? null, disposition: d.owner_disposition ?? d.disposition ?? null }));

      const allChecksPassed =
        priorShaChecks.every((c) => c.sha256_unchanged)
        && linkageCheck.slot_found_in_v0_3 && linkageCheck.fact_ids_unchanged && linkageCheck.evidence_ids_unchanged
        && factValueChecks.every((c) => c.found_in_both && c.value_fields_unchanged);

      base.machine_check = {
        applicable: true,
        prior_decision_sha256: priorShaChecks,
        linkage_unchanged_vs_v0_3: linkageCheck,
        fact_value_unchanged_vs_v0_3: factValueChecks,
        prior_fact_normalization_decisions: normalizationRefs,
        all_checks_passed: allChecksPassed,
        summary: allChecksPassed
          ? "기계 확인 통과: 이전 승인 decision artifact SHA 불변, v0.3 대비 slot fact_ids/evidence_ids 불변, fact 값 필드 불변."
          : "기계 확인 실패 항목 있음 -- 아래 상세 필드를 직접 확인할 것.",
      };
    } else {
      base.human_review_packet = {
        instructions:
          "아래 evidence 각각의 quoted_text가 source_locator가 가리키는 원문 위치에 실제로 존재하는지, "
          + "그리고 facts[].normalized_value/raw_value_text가 evidence의 원문 내용과 일치하는지 직접 대조할 것. "
          + "claude_review_basis는 참고 정보이며 최종 판단의 대체물이 아니다.",
        expected_values: facts.map((f) => ({
          fact_id: f.fact_id, metric_code: f.metric_code, raw_value_text: f.raw_value_text,
          normalized_value: f.normalized_value, unit: f.unit,
        })),
        evidence_to_review: evidence,
      };
    }

    return {
      ...base,
      owner_disposition: "PENDING",
      reviewer: null,
      reviewed_at: null,
      notes: null,
    };
  });

  const categoryCounts = templateItems.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] ?? 0) + 1;
    return acc;
  }, {});
  const machineCheckAllPassedCount = templateItems.filter((i) => i.category === "CARRIED_FORWARD_CANDIDATE" && i.machine_check.all_checks_passed).length;
  const machineCheckFailedCount = categoryCounts.CARRIED_FORWARD_CANDIDATE - machineCheckAllPassedCount;

  await writeFile(path.join(REPO, OUTPUT_PATHS.templateJsonl), jsonl(templateItems), "utf8");

  // --- Markdown checklist ---------------------------------------------
  const lines = [];
  lines.push("# Seed Structured Owner Decision Template v0.4 (82 items)");
  lines.push("");
  lines.push(`생성: ${GENERATED_AT}`);
  lines.push("");
  lines.push(
    "이 문서는 사람이 직접 검토하기 위한 체크리스트다. 최종 승인 근거는 "
    + `\`${OUTPUT_PATHS.templateJsonl}\`이며, 이 Markdown은 그 JSON을 읽기 쉽게 정리한 사본이다. `
    + "이 문서를 수정해도 최종 결정으로 인정되지 않는다 -- Owner는 JSON 파일의 `owner_disposition` 필드에 "
    + "`APPROVE` / `FIX_REQUIRED` / `REJECT` 중 하나를 직접 기록해야 하며, `PENDING`으로 남은 항목은 "
    + "미결정으로 취급한다.",
  );
  lines.push("");
  lines.push("## 요약");
  lines.push("");
  lines.push(`- 전체 항목: ${templateItems.length}`);
  lines.push(`- CARRIED_FORWARD_CANDIDATE: ${categoryCounts.CARRIED_FORWARD_CANDIDATE} (기계 확인 통과 ${machineCheckAllPassedCount}, 실패/확인 필요 ${machineCheckFailedCount})`);
  lines.push(`- NEW_Q3_Q22: ${categoryCounts.NEW_Q3_Q22 ?? 0} (사람 확인 필수)`);
  lines.push(`- LINKAGE_CHANGED: ${categoryCounts.LINKAGE_CHANGED ?? 0} (사람 확인 필수)`);
  lines.push(`- 초기 owner_disposition: 전 항목 \`PENDING\` (사용자가 직접 채우기 전까지 최종 결과 아님)`);
  lines.push("");

  lines.push("## Part A — CARRIED_FORWARD_CANDIDATE (69건, 기계 확인 결과)");
  lines.push("");
  lines.push("| slot_key | fact_id(s) | 기계 확인 | owner_disposition |");
  lines.push("|---|---|---|---|");
  for (const item of templateItems.filter((i) => i.category === "CARRIED_FORWARD_CANDIDATE")) {
    const status = item.machine_check.all_checks_passed ? "✅ PASS" : "⚠️ 확인 필요";
    lines.push(`| \`${item.slot_key}\` | ${item.fact_ids.join(", ")} | ${status} | PENDING |`);
  }
  lines.push("");
  const flaggedCarriedForward = templateItems.filter((i) => i.category === "CARRIED_FORWARD_CANDIDATE" && !i.machine_check.all_checks_passed);
  if (flaggedCarriedForward.length) {
    lines.push("### ⚠️ 기계 확인에서 불일치가 발견된 CARRIED_FORWARD_CANDIDATE 항목");
    lines.push("");
    for (const item of flaggedCarriedForward) {
      lines.push(`#### \`${item.slot_key}\` (${item.review_item_id})`);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(item.machine_check, null, 2));
      lines.push("```");
      lines.push("");
    }
  } else {
    lines.push("_불일치 없음 -- 69건 전체 기계 확인 통과._");
    lines.push("");
  }

  lines.push("## Part B — NEW_Q3_Q22 (10건) + LINKAGE_CHANGED (3건): 사람 확인 필수");
  lines.push("");
  for (const item of templateItems.filter((i) => i.category !== "CARRIED_FORWARD_CANDIDATE")) {
    lines.push(`### [${item.category}] \`${item.slot_key}\` (${item.review_item_id})`);
    lines.push("");
    lines.push(`- Claude 권고: **${item.claude_recommended_verdict}** — ${item.claude_review_basis}`);
    lines.push("");
    lines.push("**기대값 (facts):**");
    lines.push("");
    lines.push("| fact_id | metric_code | raw_value_text | normalized_value | unit |");
    lines.push("|---|---|---|---|---|");
    for (const f of item.human_review_packet.expected_values) {
      lines.push(`| ${f.fact_id} | ${f.metric_code} | ${JSON.stringify(f.raw_value_text)} | ${JSON.stringify(f.normalized_value)} | ${f.unit ?? "-"} |`);
    }
    lines.push("");
    lines.push(`**원문 evidence (${item.human_review_packet.evidence_to_review.length}건):**`);
    lines.push("");
    for (const e of item.human_review_packet.evidence_to_review) {
      if (!e.found) {
        lines.push(`- ⚠️ \`${e.evidence_id}\`: ${e.note}`);
        continue;
      }
      lines.push(`- \`${e.evidence_id}\` — \`${e.document_id}\` @ \`${e.source_locator}\``);
      lines.push(`  > ${e.quoted_text.replaceAll("\n", " ")}`);
    }
    lines.push("");
    lines.push("owner_disposition: `PENDING` | reviewer: ____ | reviewed_at: ____ | notes: ____");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  await writeFile(path.join(REPO, OUTPUT_PATHS.checklistMd), lines.join("\n"), "utf8");

  // --- Manifest: pins every input and both generated outputs' own SHA-256 --
  const templateJsonlBytes = await readFile(path.join(REPO, OUTPUT_PATHS.templateJsonl));
  const checklistMdBytes = await readFile(path.join(REPO, OUTPUT_PATHS.checklistMd));

  const inputHashes = {};
  for (const [key, relPath] of Object.entries(INPUT_PATHS)) inputHashes[key] = { path: relPath, sha256: await sha256OfFile(relPath) };

  const manifest = {
    schema_version: "0.1.0",
    artifact_id: "seed-structured-owner-decision-template-v0.4",
    generated_at: GENERATED_AT,
    purpose:
      "82개 v0.4 structured review packet 항목에 대한 Owner decision TEMPLATE. "
      + "owner_disposition은 전 항목 PENDING이며, 사용자가 APPROVE/FIX_REQUIRED/REJECT를 "
      + "직접 기록하기 전까지 어떤 항목도 최종 결정이나 VERIFIED 승격 근거로 사용하지 않는다.",
    inputs: inputHashes,
    outputs: {
      template_jsonl: { path: OUTPUT_PATHS.templateJsonl, sha256: sha256(templateJsonlBytes), record_count: templateItems.length },
      checklist_md: { path: OUTPUT_PATHS.checklistMd, sha256: sha256(checklistMdBytes) },
    },
    category_counts: categoryCounts,
    carried_forward_machine_check: {
      total: categoryCounts.CARRIED_FORWARD_CANDIDATE,
      all_checks_passed: machineCheckAllPassedCount,
      needs_owner_attention: machineCheckFailedCount,
    },
    invariants: {
      total_items: 82,
      owner_disposition_all_pending: templateItems.every((i) => i.owner_disposition === "PENDING"),
      no_source_file_modified: true,
      no_promotion_performed: true,
    },
  };
  await writeFile(path.join(REPO, OUTPUT_PATHS.manifest), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({
    total: templateItems.length,
    category_counts: categoryCounts,
    carried_forward_machine_check_passed: machineCheckAllPassedCount,
    carried_forward_machine_check_needs_attention: machineCheckFailedCount,
    outputs: Object.values(OUTPUT_PATHS),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
