// Turn M3 item 2: a mechanical inventory of the ENTIRE current VERIFIED
// structured ontology -- every metric_code, value_type, period_type/
// scope/unit combination, Event type/status, Event attributes key,
// Relation type, and the real ID-generation contract already in use.
// This is read-only over the canonical VERIFIED artifacts (pinned by the
// SAME artifact_set_id/manifest the Runtime itself trusts) -- it writes
// no structured data, only an audit report. Every downstream Candidate-
// authoring decision this Turn must be justified against THIS inventory,
// never against a single question's own wording.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRUCTURED_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_JSON_PATH = path.join(OUT_DIR, "seed-response-structured-gap-ontology-audit.v0.1.json");
const OUT_MD_PATH = path.join(OUT_DIR, "seed-response-structured-gap-ontology-audit.v0.1.md");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().length ? text.trim().split("\n").map((l) => JSON.parse(l)) : []; }
function unique(values) { return [...new Set(values)]; }
function countBy(items, fn) {
  const map = new Map();
  for (const item of items) {
    const key = fn(item);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

async function loadManifestArtifact(manifest, role) {
  const entry = manifest.artifacts.find((a) => a.role === role);
  if (!entry) throw new Error(`AUDIT_BLOCKED: manifest has no artifact with role ${role}`);
  const fullPath = path.join(REPO, entry.path);
  const bytes = await readFile(fullPath);
  const actualSha = sha256(bytes);
  if (actualSha !== entry.sha256) {
    throw new Error(`AUDIT_BLOCKED: ${entry.path} sha256 mismatch (manifest pins ${entry.sha256}, actual ${actualSha})`);
  }
  return { path: entry.path, sha256: actualSha, records: jsonl(bytes.toString("utf8")) };
}

function idShape(id) {
  if (typeof id !== "string") return String(id);
  const m = id.match(/^([a-z_]+)_([0-9a-f]+)$/);
  if (!m) return id;
  return `${m[1]}_[${m[2].length}-hex]`;
}

async function main() {
  const manifestBytes = await readFile(STRUCTURED_MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));

  const facts = await loadManifestArtifact(manifest, "VERIFIED_FACT");
  const events = await loadManifestArtifact(manifest, "VERIFIED_EVENT");
  const relations = await loadManifestArtifact(manifest, "VERIFIED_RELATION");
  const evidence = await loadManifestArtifact(manifest, "VERIFIED_EVIDENCE");
  const chains = await loadManifestArtifact(manifest, "CHAIN_MANIFEST");

  // metric_code -> distinct (raw_label, value_type, unit, period_type,
  // scope) combinations actually observed, so a future Candidate can be
  // judged "reuses an existing meaning" only against REAL prior usage.
  const metricProfiles = new Map();
  for (const f of facts.records) {
    const key = f.metric_code;
    const list = metricProfiles.get(key) ?? [];
    list.push({
      fact_id: f.fact_id, raw_label: f.raw_label, value_type: f.value_type, unit: f.unit,
      period_type: f.period_type, scope: f.scope, value_status: f.value_status,
      corp_code: f.corp_code, source_document_id: f.source_document_id,
    });
    metricProfiles.set(key, list);
  }

  const eventAttributeKeys = unique(events.records.flatMap((e) => Object.keys(e.attributes ?? {})));
  const factAttributeKeys = unique(facts.records.flatMap((f) => Object.keys(f.attributes ?? {})));

  const eventTypeStatusPairs = countBy(events.records, (e) => `${e.event_type} | ${e.event_status}`);
  const relationTypeCounts = countBy(relations.records, (r) => r.relation_type);

  // Facts that already carry a non-null event_id -- the existing
  // Fact<->Event linkage convention (never invent a new linkage shape).
  const factsWithEventId = facts.records.filter((f) => f.event_id !== null).length;

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    input_artifacts: {
      structured_manifest_path: "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json",
      structured_manifest_sha256: sha256(manifestBytes),
      artifact_set_id: manifest.artifact_set_id,
      corpus_snapshot_id: manifest.corpus_snapshot_id,
      fact_coverage_snapshot_id: manifest.fact_coverage_snapshot_id,
      facts: { path: facts.path, sha256: facts.sha256, record_count: facts.records.length },
      events: { path: events.path, sha256: events.sha256, record_count: events.records.length },
      relations: { path: relations.path, sha256: relations.sha256, record_count: relations.records.length },
      evidence: { path: evidence.path, sha256: evidence.sha256, record_count: evidence.records.length },
      chains: { path: chains.path, sha256: chains.sha256, record_count: chains.records.length },
    },
    id_generation_contract: {
      note: "domain/contracts.mjs `ids` -- every ID below is a DETERMINISTIC sha256-derived value (never random), stable across re-runs from the same content.",
      fact_id_shape: idShape(facts.records[0]?.fact_id) ?? "fact_[24-hex]",
      event_id_shape: idShape(events.records[0]?.event_id) ?? "event_[24-hex]",
      evidence_id_shape: idShape(evidence.records[0]?.evidence_id) ?? "evidence_[24-hex]",
      chain_id_shape: idShape(chains.records[0]?.chain_id ?? events.records[0]?.chain_id) ?? "chain_[24-hex]",
      generators: {
        fact: "ids.fact(subjectId, metricCode, periodKey, scope, versionId) -- domain/contracts.mjs",
        event: "ids.event(corpCode, eventType, chainId) -- domain/contracts.mjs",
        evidence: "ids.evidence(documentId, sourceLocator, quoteHash) -- domain/contracts.mjs",
      },
    },
    metric_code_inventory: [...metricProfiles.entries()].map(([metric_code, occurrences]) => ({
      metric_code,
      occurrence_count: occurrences.length,
      distinct_raw_labels: unique(occurrences.map((o) => o.raw_label)),
      distinct_value_types: unique(occurrences.map((o) => o.value_type)),
      distinct_units: unique(occurrences.map((o) => o.unit)),
      distinct_period_types: unique(occurrences.map((o) => o.period_type)),
      distinct_scopes: unique(occurrences.map((o) => o.scope)),
      distinct_value_statuses: unique(occurrences.map((o) => o.value_status)),
      sample_fact_ids: occurrences.slice(0, 3).map((o) => o.fact_id),
    })).sort((a, b) => a.metric_code.localeCompare(b.metric_code)),
    value_type_distribution: countBy(facts.records, (f) => f.value_type),
    value_status_distribution: countBy(facts.records, (f) => f.value_status),
    value_certainty_distribution: countBy(facts.records, (f) => f.value_certainty),
    scope_distribution: countBy(facts.records, (f) => f.scope),
    period_type_distribution: countBy(facts.records, (f) => f.period_type),
    unit_distribution: countBy(facts.records, (f) => f.unit ?? "(null)"),
    fact_attribute_keys: factAttributeKeys,
    facts_with_event_id_linkage: factsWithEventId,
    facts_without_event_id_linkage: facts.records.length - factsWithEventId,
    event_type_status_pairs: eventTypeStatusPairs,
    event_attribute_keys: eventAttributeKeys,
    relation_type_distribution: relationTypeCounts,
    relation_type_closed_enum: ["AMENDS", "TERMINATES", "CONFIRMS", "SAME_EVENT_AS"],
    // Turn M3 item 2: the 10-item gap classification the ontology
    // inventory above was built to support. Every REUSE_* row cites the
    // real, corpus-observed metric_code (never invented) and the new
    // Candidate artifact that closes it; every ONTOLOGY_PROPOSAL_REQUIRED
    // row cites the concrete blocking reason (never "ran out of time").
    gap_classification: [
      {
        item: "Q07", category: "NOT_ACTUALLY_REQUIRED",
        reasoning: "The 3 needed narrative elements (5-product launch completion, EU authorization, per-item info limit) were ALL already present as VERIFIED Fact/Evidence data selected by Plan v0.6 -- the gap was purely a Composer rendering gap, closed generically by Turn M3's renderProductLifecycleConclusion + renderNarrativeSourceSentences (never Q07-specific). No new structured data needed.",
        closed_by: "domain/flows/synthesis/response-composer.mjs (PRODUCT_LIFECYCLE_CONCLUSION, NARRATIVE_SOURCE_DISCLOSURE capabilities)",
      },
      {
        item: "Q19", category: "NOT_ACTUALLY_REQUIRED",
        reasoning: "The CONTRACT_STATUS Fact's own raw_label already encodes the FROM->TO transition ('LOI -> 본계약 전환') -- a Composer rendering gap, closed generically by Turn M3's renderFactLevelLifecycleTransition (any *_STATUS metric_code with an arrow-shaped raw_label, never LOI-specific).",
        closed_by: "domain/flows/synthesis/response-composer.mjs (FACT_LEVEL_LIFECYCLE_TRANSITION capability)",
      },
      {
        item: "Q21", category: "NOT_ACTUALLY_REQUIRED",
        reasoning: "The indirect-confirmation Evidence quote (citing the 2024-03-12 extension disclosure) was already VERIFIED and loaded -- a Composer rendering gap, closed generically by Turn M3's renderIndirectConfirmationSentences (any Evidence matching the real DART 'YYYY년 MM월 DD일 공시한' cross-reference phrasing, never Q21-specific).",
        closed_by: "domain/flows/synthesis/response-composer.mjs (INDIRECT_CONFIRMATION_ATTRIBUTION capability)",
      },
      {
        item: "Q08", category: "REUSE_EXISTING_RECORD",
        reasoning: "fact_e5ad6617ee0e6287fb222ce3 (already VERIFIED, already selected by Plan v0.6's acquisition_retirement_status slot) has a raw_value_text that ALREADY contains the full 2025-02-18 decision / 2025-02-20 completion narrative -- purely a Composer rendering gap (the narrative was being discarded in favor of the short naturalized enum label). Closed by NARRATIVE_SOURCE_DISCLOSURE.",
        closed_by: "domain/flows/synthesis/response-composer.mjs (NARRATIVE_SOURCE_DISCLOSURE capability) -- no new Fact/Evidence needed.",
      },
      {
        item: "Q18", category: "REUSE_EXISTING_RECORD",
        reasoning: "fact_4597ff14b5448794ef892877 and fact_4b5dc7b1e4bb34969ad7a51e (both already VERIFIED, already selected by Plan v0.6) have raw_value_text containing the initial (69,809주/2,816,793,150원) and corrected (54,495주/40,350원) values verbatim -- purely a Composer rendering gap.",
        closed_by: "domain/flows/synthesis/response-composer.mjs (NARRATIVE_SOURCE_DISCLOSURE capability) -- no new Fact/Evidence needed.",
      },
      {
        item: "Q09 (counterparty)", category: "REUSE_EXISTING_ONTOLOGY_NEW_RECORD",
        reasoning: "CONTRACT_COUNTERPARTY is a real, already-used metric_code (Q24's counterparty pair). evidence_4bb201438fab0e23e64ec747 (NH투자증권, already VERIFIED) had no corresponding Fact.",
        closed_by: "scripts/build-seed-structured-gap-fact-batch-m3.mjs -> seed-facts-candidates.v0.8.delta.jsonl (fact_74a2b743fee3b410295be924)",
      },
      {
        item: "Q09 (trust contract amount + termination reason + retired-share count)", category: "REUSE_EXISTING_RECORD",
        reasoning: "fact_ae59c05c37847e6d6cdbf143 (500,000,000,000원), fact_42f0a6ea3935a97e95a66b06 (해지 사유), fact_ae09fd5e300fe1c1d27502ab (10,347,131주 소각) are all already VERIFIED, already selected -- their raw_value_text already states these values; a Composer rendering gap only.",
        closed_by: "domain/flows/synthesis/response-composer.mjs (NARRATIVE_SOURCE_DISCLOSURE capability) -- no new Fact/Evidence needed.",
      },
      {
        item: "Q09 (예정수량 9,861,932주 -- planned trust-acquisition share count)", category: "ONTOLOGY_PROPOSAL_REQUIRED",
        reasoning: "No existing metric_code safely represents 'shares planned for TRUST-CONTRACT acquisition' -- DISPOSAL_SHARES exists but means the OPPOSITE direction (disposal, not acquisition), so reusing it would misrepresent the value's meaning. evidence_b673a282e3406174077c7456 (9,861,932, VERIFIED) has no safe existing role to attach to.",
        proposed_new_token: "ACQUISITION_PLANNED_SHARES (or a corp-neutral 'PLANNED_SHARES' + a role attribute distinguishing acquisition/disposal)",
        reusable_elsewhere: "Yes -- any trust-contract or tender-offer acquisition disclosure that states a planned vs. actual share count would reuse this, not just this one company.",
        migration_impact: "Additive only (new metric_code token); no existing Fact's meaning changes. Requires Owner approval + a minor version bump on the informal metric_code vocabulary (JSON Schema itself is pattern-typed, not enum-closed, so no formal schema migration is required, only project-policy sign-off).",
      },
      {
        item: "Q17 (temporal-role contract amount, both companies)", category: "REUSE_EXISTING_ONTOLOGY_NEW_RECORD",
        reasoning: "LATEST_CONTRACT_AMOUNT is a real, already-used metric_code (Q22's temporal-latest role). evidence_3164630d0f878e59572b470e (samsung heavy, 114,800,000,000, already VERIFIED, linked_slot_name 'samsung_heavy_correction') and evidence_e8aa546f991c7e0f7af17099 (hyosung, 291,204,288,000, already VERIFIED, linked_slot_name 'hyosung_original') both represent the latest known contract amount before each company's termination -- had no corresponding Fact.",
        closed_by: "scripts/build-seed-structured-gap-fact-batch-m3.mjs -> seed-facts-candidates.v0.8.delta.jsonl (fact_4b6f458e85adfadde708e185, fact_de335e5b27723ca5daac5b63). Sandbox-verified: once promoted, thin-structured-flow.mjs's EXISTING generic Turn M2 item 6A match-check loop finds this pair automatically (no new Runtime code needed) and both companies show a MATCH (0 difference) against their real TERMINATION_AMOUNT.",
      },
      {
        item: "Q06 (investment purpose + target asset, both investments)", category: "ONTOLOGY_PROPOSAL_REQUIRED",
        reasoning: "No existing metric_code represents 'investment purpose' or 'investment target asset'. The needed text ('건조 효율성 증대'/'6,500ton급 Floating Crane', '생산량 증대'/'Floating Dock 확장') exists as real VERIFIED Evidence (already cited in the answer) but attaching it to INVESTMENT_AMOUNT via a heuristic same-document grouping was judged too risky to build safely as a Runtime rule this Turn (a wrong grouping would misattribute one investment's purpose to the other).",
        proposed_new_token: "INVESTMENT_PURPOSE, INVESTMENT_TARGET_ASSET (both TEXT value_type, same-document linkage to the paired INVESTMENT_AMOUNT Fact via source_document_id)",
        reusable_elsewhere: "Yes -- any CAPEX/investment-decision disclosure that states a purpose/target alongside an amount would reuse these tokens.",
        migration_impact: "Additive only. Requires Owner approval + explicit same-document-linkage authoring guidance so two investments in one question are never cross-attributed.",
      },
      {
        item: "Q20 (2024-11-29 correction-reason disclosure)", category: "ONTOLOGY_PROPOSAL_REQUIRED",
        reasoning: "evidence_fb63f3d8238a3177b7ecef68 ('변경계약 체결 지연으로 인한 계약종료일 정정', already VERIFIED, exact match to the Owner note) has no accompanying NEW date/amount value of its own in the same document (the actual corrected values were disclosed 6 days later, 2024-12-05, in a DIFFERENT document) -- attaching this reason text to the EXISTING CONTRACT_PERIOD_END Fact (value_type DATE) would misuse that metric's established value_type, and attaching it to the wrong document's Fact would misattribute provenance. The already-established generic `attributes.reason` key convention needs a Fact of its own to attach to; this correction-reason disclosure doesn't carry one.",
        proposed_new_token: "A generic CORRECTION_REASON metric_code (TEXT value_type, standalone -- explicitly for a correction-announcement document that doesn't itself carry the corrected terminal value)",
        reusable_elsewhere: "Yes -- reasons are a common shape across contract-period/contract-amount corrections project-wide, not specific to this company.",
        migration_impact: "Additive only. Requires Owner approval; low risk since it never overlaps an existing metric_code's meaning.",
      },
    ],
    schema_note: {
      metric_code: "pattern-typed (^[A-Z][A-Z0-9_]+$), NOT a closed JSON-schema enum -- but this Turn's Hard Gate treats the REAL observed set above as the effective closed vocabulary; no new token added without an ONTOLOGY_PROPOSAL_REQUIRED entry.",
      event_type_and_status: "pattern-typed, same Hard Gate treatment as metric_code.",
      relation_type: "TRUE closed JSON-schema enum -- AMENDS/TERMINATES/CONFIRMS/SAME_EVENT_AS only, no exceptions possible without a schema version bump.",
    },
  };

  await writeFile(OUT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(OUT_MD_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    metric_code_count: report.metric_code_inventory.length,
    event_type_status_pair_count: report.event_type_status_pairs.length,
    relation_type_count: report.relation_type_distribution.length,
    event_attribute_keys: report.event_attribute_keys,
    fact_attribute_keys: report.fact_attribute_keys,
  }, null, 2));
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Seed Structured Ontology Audit v0.1");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push("## Input artifacts (pinned)");
  lines.push("");
  lines.push("| role | path | sha256 | records |");
  lines.push("|---|---|---|---|");
  for (const [role, info] of Object.entries(report.input_artifacts)) {
    if (typeof info !== "object" || !info.path) continue;
    lines.push(`| ${role} | ${info.path} | \`${info.sha256.slice(0, 16)}…\` | ${info.record_count} |`);
  }
  lines.push("");
  lines.push("## metric_code inventory (all real, corpus-observed)");
  lines.push("");
  lines.push("| metric_code | count | value_types | units | period_types | scopes | value_statuses |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const m of report.metric_code_inventory) {
    lines.push(`| ${m.metric_code} | ${m.occurrence_count} | ${m.distinct_value_types.join(",")} | ${m.distinct_units.filter(Boolean).join(",") || "-"} | ${m.distinct_period_types.join(",")} | ${m.distinct_scopes.join(",")} | ${m.distinct_value_statuses.join(",")} |`);
  }
  lines.push("");
  lines.push("## Event type x status pairs (real, corpus-observed)");
  lines.push("");
  lines.push("| event_type | event_status | count |");
  lines.push("|---|---|---|");
  for (const e of report.event_type_status_pairs) {
    const [t, s] = e.value.split(" | ");
    lines.push(`| ${t} | ${s} | ${e.count} |`);
  }
  lines.push("");
  lines.push(`## Event attributes keys observed: ${report.event_attribute_keys.join(", ") || "(none beyond review_provenance)"}`);
  lines.push("");
  lines.push(`## Fact attributes keys observed: ${report.fact_attribute_keys.join(", ") || "(none beyond review_provenance)"}`);
  lines.push("");
  lines.push("## Relation types (closed schema enum)");
  lines.push("");
  lines.push("| relation_type | count |");
  lines.push("|---|---|");
  for (const r of report.relation_type_distribution) lines.push(`| ${r.value} | ${r.count} |`);
  lines.push("");
  lines.push(`Fact<->Event linkage: ${report.facts_with_event_id_linkage} facts carry event_id, ${report.facts_without_event_id_linkage} carry event_id=null.`);
  lines.push("");
  lines.push("## Turn M3 gap classification (10 items)");
  lines.push("");
  for (const g of report.gap_classification) {
    lines.push(`### ${g.item} -- ${g.category}`);
    lines.push("");
    lines.push(g.reasoning);
    if (g.closed_by) lines.push(`\n**Closed by:** ${g.closed_by}`);
    if (g.proposed_new_token) lines.push(`\n**Proposed new token:** ${g.proposed_new_token}`);
    if (g.reusable_elsewhere) lines.push(`\n**Reusable elsewhere:** ${g.reusable_elsewhere}`);
    if (g.migration_impact) lines.push(`\n**Migration impact:** ${g.migration_impact}`);
    lines.push("");
  }
  lines.push("## ID generation contract");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.id_generation_contract, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n") + "\n";
}

main().catch((error) => { console.error(error.message); process.exit(1); });
