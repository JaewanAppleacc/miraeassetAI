import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--relations") args.relations = argv[++index];
    else if (token === "--semantic-bundles") args.semanticBundles = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const key of ["relations", "semanticBundles", "output"]) {
    if (!args[key]) throw new Error(`Missing required option: ${key}`);
  }
  return args;
}

async function readJsonl(path) {
  const records = [];
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  return records;
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function comparableFact(fact) {
  return fact && fact.value_status === "DISCLOSED" && fact.normalized_value !== null;
}

function valuesMatch(metric, source, target) {
  if (!comparableFact(source) || !comparableFact(target)) return null;
  if (metric === "CONTRACT_AMOUNT") return Number(source.normalized_value) === Number(target.normalized_value);
  return normalizedText(source.normalized_value) === normalizedText(target.normalized_value);
}

function factsByMetric(bundle) {
  return new Map((bundle?.facts ?? []).map((fact) => [fact.metric_code, fact]));
}

function documentIdOf(bundle) {
  return bundle?.facts?.[0]?.source_document_id ?? bundle?.evidence?.[0]?.document_id ?? null;
}

const METRICS = [
  ["CONTRACT_NAME", 0.35, "contract_name"],
  ["CONTRACT_COUNTERPARTY", 0.25, "counterparty"],
  ["CONTRACT_AMOUNT", 0.20, "amount"],
  ["CONTRACT_START_DATE", 0.10, "start_date"],
  ["CONTRACT_END_DATE", 0.10, "end_date"],
];

const args = parseArgs(process.argv.slice(2));
const relations = await readJsonl(args.relations);
const bundles = await readJsonl(args.semanticBundles);
const bundlesByDocument = new Map(bundles.map((bundle) => [documentIdOf(bundle), bundle]));
const outputPath = resolve(args.output);
await mkdir(dirname(outputPath), { recursive: true });
const output = createWriteStream(outputPath, { encoding: "utf8" });
const summary = {
  total_relations: relations.length,
  termination_relations: 0,
  no_manifest_candidates: 0,
  unique_high_confidence_recommendations: 0,
  requires_manual_disambiguation: 0,
  missing_source_facts: 0,
};

for (const relation of relations) {
  if (relation.relation_type !== "TERMINATES") {
    output.write(`${JSON.stringify(relation)}\n`);
    continue;
  }
  summary.termination_relations += 1;
  const sourceFacts = factsByMetric(bundlesByDocument.get(relation.source_document_id));
  if (sourceFacts.size === 0) summary.missing_source_facts += 1;
  const candidates = relation.candidates.map((candidate) => {
    const targetFacts = factsByMetric(bundlesByDocument.get(candidate.target_document_id));
    let score = 0;
    let comparableCount = 0;
    let matchCount = 0;
    const matches = {};
    const evidenceIds = new Set();
    for (const [metric, weight, label] of METRICS) {
      const source = sourceFacts.get(metric);
      const target = targetFacts.get(metric);
      const matched = valuesMatch(metric, source, target);
      matches[label] = matched;
      if (matched !== null) comparableCount += 1;
      if (matched === true) {
        score += weight;
        matchCount += 1;
      }
      for (const evidenceId of [...(source?.evidence_ids ?? []), ...(target?.evidence_ids ?? [])]) {
        evidenceIds.add(evidenceId);
      }
    }
    const contradictions = Object.values(matches).filter((value) => value === false).length;
    return {
      ...candidate,
      identity_score: Number(score.toFixed(4)),
      comparable_field_count: comparableCount,
      matching_field_count: matchCount,
      contradiction_count: contradictions,
      field_matches: matches,
      evidence_ids: [...evidenceIds].sort(),
    };
  }).sort((left, right) =>
    right.identity_score - left.identity_score ||
    left.contradiction_count - right.contradiction_count ||
    right.target_receipt_date.localeCompare(left.target_receipt_date)
  );

  const top = candidates[0] ?? null;
  const second = candidates[1] ?? null;
  const uniqueHighConfidence = Boolean(
    top &&
    top.identity_score >= 0.7 &&
    top.matching_field_count >= 2 &&
    top.contradiction_count <= 1 &&
    (!second || top.identity_score - second.identity_score >= 0.2)
  );
  if (candidates.length === 0) summary.no_manifest_candidates += 1;
  else if (uniqueHighConfidence) summary.unique_high_confidence_recommendations += 1;
  else summary.requires_manual_disambiguation += 1;

  const enriched = {
    ...relation,
    candidates,
    recommended_target_document_id: uniqueHighConfidence ? top.target_document_id : null,
    recommendation_status: candidates.length === 0
      ? "NO_TARGET_IN_MANIFEST_CANDIDATES"
      : uniqueHighConfidence ? "HIGH_CONFIDENCE_REVIEW" : "MANUAL_DISAMBIGUATION_REQUIRED",
    review_status: "PENDING",
    note: candidates.length === 0
      ? "No prior contract disclosure exists in the provided corpus. Review source text before TARGET_OUTSIDE_CORPUS."
      : "Fact-ranked candidates only. A reviewer must confirm at least two identity fields and explicit termination wording before ACCEPTED.",
  };
  output.write(`${JSON.stringify(enriched)}\n`);
}

await new Promise((resolveEnd) => output.end(resolveEnd));
process.stdout.write(`${JSON.stringify({ status: "PASS", output: outputPath, ...summary }, null, 2)}\n`);
