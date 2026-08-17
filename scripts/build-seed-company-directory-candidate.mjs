// Builds a minimal, CANDIDATE-only Runtime artifact
// (seed-company-directory.v0.1.candidate.jsonl) from
// work/domain-seed/companies.jsonl (read-only input, never modified).
// Each output record carries ONLY {corp_code, corp_name, listed_name} --
// the source file's much larger `universe_payload` (market cap, sector
// counts, listing metadata, ...) is deliberately NOT copied into the
// Runtime artifact, since none of it is needed to resolve a corp_code to
// a human-readable label and copying it would widen this artifact's
// blast radius for no benefit.
//
// SNAPSHOT LINEAGE: companies.jsonl has no companion manifest of its own,
// but work/domain-seed/corpus-snapshot.json is written by the exact same
// script run (scripts/build-domain-seed.mjs, adjacent writeFileSync/
// writeJsonl calls) and its corpus_snapshot_id ("corpus_04750795e1a2d5c3")
// matches the corpus_snapshot_id already pinned in
// seed-thin-flow-plans.v0.6.manifest.json / v0.7.candidate.manifest.json
// -- so this is real, checkable lineage evidence, not a guess. If that
// corpus-snapshot.json file were ever missing/inconsistent, this script
// would need to fail with a blocker rather than assume a snapshot id.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANIES_PATH = path.join(REPO, "work/domain-seed/companies.jsonl");
const CORPUS_SNAPSHOT_PATH = path.join(REPO, "work/domain-seed/corpus-snapshot.json");
const OUT_ARTIFACT_PATH = path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl");
const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json");
const OUT_REPORT_PATH = path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export async function buildSeedCompanyDirectoryCandidate({ writeOutputs = true } = {}) {
  const [companiesBytes, corpusSnapshotBytes] = await Promise.all([readFile(COMPANIES_PATH), readFile(CORPUS_SNAPSHOT_PATH)]);
  const corpusSnapshot = JSON.parse(corpusSnapshotBytes.toString("utf8"));
  if (typeof corpusSnapshot.corpus_snapshot_id !== "string" || corpusSnapshot.corpus_snapshot_id === "") {
    throw new Error("BLOCKER: corpus-snapshot.json has no usable corpus_snapshot_id -- refusing to guess Company Directory snapshot lineage");
  }

  const rawLines = companiesBytes.toString("utf8").trim().split("\n");
  const records = [];
  const corpCodes = new Set();
  for (const [lineIndex, line] of rawLines.entries()) {
    const row = JSON.parse(line);
    if (!/^\d{8}$/.test(row.corp_code)) throw new Error(`companies.jsonl:${lineIndex + 1}: invalid corp_code`);
    if (typeof row.corp_name !== "string" || row.corp_name.trim() === "") throw new Error(`companies.jsonl:${lineIndex + 1}: invalid corp_name`);
    if (typeof row.listed_name !== "string" || row.listed_name.trim() === "") throw new Error(`companies.jsonl:${lineIndex + 1}: invalid listed_name`);
    if (corpCodes.has(row.corp_code)) throw new Error(`companies.jsonl:${lineIndex + 1}: duplicate corp_code ${row.corp_code}`);
    corpCodes.add(row.corp_code);
    records.push({ corp_code: row.corp_code, corp_name: row.corp_name.trim(), listed_name: row.listed_name.trim() });
  }

  const artifactText = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const artifactBytes = Buffer.from(artifactText, "utf8");
  const sortedCorpCodes = [...corpCodes].sort();
  const manifest = {
    schema_version: "0.1.0",
    artifact: "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl",
    artifact_sha256: sha256(artifactBytes),
    record_count: records.length,
    corp_code_set_sha256: sha256(Buffer.from(sortedCorpCodes.join(","), "utf8")),
    source_companies_path: "work/domain-seed/companies.jsonl",
    source_companies_sha256: sha256(companiesBytes),
    corpus_snapshot_id: corpusSnapshot.corpus_snapshot_id,
    source_corpus_snapshot_path: "work/domain-seed/corpus-snapshot.json",
    source_corpus_snapshot_sha256: sha256(corpusSnapshotBytes),
    generated_at: new Date().toISOString(),
    status: "CANDIDATE",
  };

  const report = {
    generated_at: manifest.generated_at,
    record_count: records.length,
    corpus_snapshot_id: manifest.corpus_snapshot_id,
    source_companies_sha256: manifest.source_companies_sha256,
    output_artifact_sha256: manifest.artifact_sha256,
    sample_records: records.slice(0, 3),
  };

  if (writeOutputs) {
    await writeFile(OUT_ARTIFACT_PATH, artifactText, "utf8");
    await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return { artifactText, manifest, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { manifest, report } = await buildSeedCompanyDirectoryCandidate({ writeOutputs: true });
  console.log(JSON.stringify({ manifest, report }, null, 2));
}
