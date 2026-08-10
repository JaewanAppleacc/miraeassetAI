import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const args = {
    input: "work/domain-seed/exchange-contract.semantic-bundles.candidate.jsonl",
    terminationPackets: "work/domain-seed/termination-review-packets.jsonl",
    outputDir: "work/semantic-handoff",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") args.input = argv[++index];
    else if (token === "--termination-packets") args.terminationPackets = argv[++index];
    else if (token === "--output-dir") args.outputDir = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

async function readJsonl(path) {
  const records = [];
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  return records;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function gitText(args, fallback = null) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function documentId(bundle) {
  return bundle.facts[0]?.source_document_id ?? bundle.evidence[0]?.document_id ?? null;
}

function hasFact(bundle, predicate) {
  return bundle.facts.some(predicate);
}

function findFirst(bundles, used, predicate) {
  return bundles.find((bundle) => !used.has(documentId(bundle)) && predicate(bundle));
}

const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(args.input);
const outputDir = resolve(args.outputDir);
const bundles = await readJsonl(inputPath);
const packets = await readJsonl(args.terminationPackets);
const bundleByDocument = new Map(bundles.map((bundle) => [documentId(bundle), bundle]));
const used = new Set();
const selected = [];

function add(reason, bundle) {
  if (!bundle) throw new Error(`No representative bundle found for ${reason}`);
  const id = documentId(bundle);
  if (used.has(id)) return;
  used.add(id);
  selected.push({ reason, bundle });
}

add("PLANNED_VALUE", findFirst(bundles, used, (bundle) =>
  hasFact(bundle, (fact) => fact.value_certainty === "PLANNED") &&
  !hasFact(bundle, (fact) => fact.attributes?.source_is_correction)));
add("CORRECTION_AND_PLANNED", findFirst(bundles, used, (bundle) =>
  hasFact(bundle, (fact) => fact.value_certainty === "PLANNED") &&
  hasFact(bundle, (fact) => fact.attributes?.source_is_correction)));
add("WITHHELD_VALUE", findFirst(bundles, used, (bundle) =>
  hasFact(bundle, (fact) => fact.value_status === "WITHHELD") &&
  !hasFact(bundle, (fact) => fact.attributes?.source_is_correction)));
add("CORRECTION_AND_WITHHELD", findFirst(bundles, used, (bundle) =>
  hasFact(bundle, (fact) => fact.value_status === "WITHHELD") &&
  hasFact(bundle, (fact) => fact.attributes?.source_is_correction)));
add("STANDARD_DISCLOSED", findFirst(bundles, used, (bundle) =>
  hasFact(bundle, (fact) => fact.metric_code === "CONTRACT_AMOUNT" && fact.value_status === "DISCLOSED") &&
  !hasFact(bundle, (fact) => fact.value_status === "WITHHELD") &&
  !hasFact(bundle, (fact) => fact.value_certainty === "PLANNED") &&
  !hasFact(bundle, (fact) => fact.attributes?.source_is_correction)));

const readyPacket = packets.find((packet) => packet.machine_status === "READY_FOR_HUMAN_REVIEW") ?? packets[0];
if (readyPacket) {
  add("TERMINATION_SOURCE_CANDIDATE", bundleByDocument.get(readyPacket.source_document.document_id));
  add("TERMINATION_TARGET_CANDIDATE", bundleByDocument.get(readyPacket.recommended_target_document.document_id));
}

await mkdir(outputDir, { recursive: true });
const outputPath = join(outputDir, "semantic-bundle.candidate.sample.jsonl");
await writeFile(outputPath, `${selected.map(({ bundle }) => JSON.stringify(bundle)).join("\n")}\n`);

const copies = [
  ["domain/interfaces/semantic-bundle.schema.json", "semantic-bundle.schema.json"],
  ["domain/interfaces/examples/semantic-bundle.example.json", "semantic-bundle.contract-example.json"],
  ["domain/interfaces/fact-coverage-snapshot.schema.json", "fact-coverage-snapshot.schema.json"],
  ["domain/evaluation/evaluation-gold.v0.2.schema.json", "evaluation-gold.v0.2.schema.json"],
  ["domain/interfaces/b-to-c-mvp-contract.v0.1.json", "b-to-c-mvp-contract.v0.1.json"],
  ["domain/interfaces/C_SEMANTIC_HANDOFF.md", "README.md"],
  ["domain/postgres/001_core.sql", "001_core.sql"],
];
for (const [source, target] of copies) await copyFile(resolve(source), join(outputDir, target));

const facts = selected.flatMap(({ bundle }) => bundle.facts);
const evidence = selected.flatMap(({ bundle }) => bundle.evidence);
const sourceFacts = bundles.flatMap((bundle) => bundle.facts);
const sourceEvidence = bundles.flatMap((bundle) => bundle.evidence);
const countBy = (records, field) => records.reduce((counts, record) => {
  const key = record[field] ?? "NULL";
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
const manifest = {
  handoff_version: "0.1.0",
  corpus_snapshot_id: selected[0]?.bundle.corpus_snapshot_id ?? null,
  producer_code: {
    repository: gitText(["config", "--get", "remote.origin.url"]),
    branch: gitText(["branch", "--show-current"]),
    git_head: gitText(["rev-parse", "HEAD"]),
    worktree_state: gitText(["status", "--porcelain", "--", "domain/facts/extract-exchange-contract.mjs", "scripts/extract-exchange-contract-facts.mjs"], "") === ""
      ? "CLEAN_FOR_RELEVANT_FILES"
      : "UNCOMMITTED_RELEVANT_FILES",
    extractor_file_sha256: await sha256(resolve("domain/facts/extract-exchange-contract.mjs")),
    extraction_runner_file_sha256: await sha256(resolve("scripts/extract-exchange-contract-facts.mjs")),
    source_bundle_producer: selected[0]?.bundle.producer ?? null,
  },
  intended_use: "C_LOADER_DB_MIGRATION_AND_SANDBOX_ONLY",
  official_runtime_eligible: false,
  required_verification_status_for_official_use: "VERIFIED",
  source_artifact: {
    path: args.input,
    sha256: await sha256(inputPath),
    bundle_count: bundles.length,
    fact_count: sourceFacts.length,
    event_count: bundles.reduce((sum, bundle) => sum + bundle.events.length, 0),
    relation_count: bundles.reduce((sum, bundle) => sum + bundle.relations.length, 0),
    evidence_count: sourceEvidence.length,
    fact_verification_statuses: countBy(sourceFacts, "verification_status"),
    fact_value_statuses: countBy(sourceFacts, "value_status"),
  },
  sample_artifact: {
    file_name: basename(outputPath),
    sha256: await sha256(outputPath),
    bundle_count: selected.length,
    fact_count: facts.length,
    event_count: selected.reduce((sum, item) => sum + item.bundle.events.length, 0),
    relation_count: selected.reduce((sum, item) => sum + item.bundle.relations.length, 0),
    evidence_count: evidence.length,
    verification_statuses: [...new Set([...facts, ...evidence].map((record) => record.verification_status))].sort(),
    selections: selected.map(({ reason, bundle }) => ({ reason, document_id: documentId(bundle) })),
  },
  contracts: [],
};
for (const [, target] of copies) {
  manifest.contracts.push({ file_name: target, sha256: await sha256(join(outputDir, target)) });
}
await writeFile(join(outputDir, "semantic-handoff-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
