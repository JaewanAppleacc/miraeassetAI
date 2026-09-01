#!/usr/bin/env node
// Turn P10.3.2 / Stage 6: writes a supersession manifest. Does NOT delete
// or modify any P10.3/P10.3.1 result file -- those stay as historical
// record. This manifest is the pointer that says which numbers are now
// canonical.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3.2-table-full-population-audit");

function gitBlobSha(relPath) {
  try {
    return execFileSync("git", ["rev-parse", `HEAD:${relPath}`], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function readJson(p) { return JSON.parse(await readFile(p, "utf8")); }

async function main() {
  const inventory = await readJson(path.join(OUT_DIR, "corrected-table-item-inventory.v0.2.json"));
  const structure = await readJson(path.join(OUT_DIR, "full-population-table-structure-report.v0.2.json"));
  const p103Structure = await readJson(path.join(ROOT, "work/p10.3-table-diagnostic/table-structure-preservation-report.v0.1.json"));

  const fixedNew = structure.strategies.find((s) => s.chunking_config_id === "fixed-token-512-o64.v0.1.0");
  const sectionNew = structure.strategies.find((s) => s.chunking_config_id === "section-aware-flat-512-o64.v0.1.0");
  const fixedOld = p103Structure.strategies.find((s) => s.chunking_config_id === "fixed-token-512-o64.v0.1.0");
  const sectionOld = p103Structure.strategies.find((s) => s.chunking_config_id === "section-aware-flat-512-o64.v0.1.0");

  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    superseded_artifacts: [
      { path: "work/p10.3-table-diagnostic/table-item-inventory.v0.1.json", note: "NOT modified or deleted -- kept as historical record", status: "SUPERSEDED_BY_CORRECTED_FULL_POPULATION_AUDIT" },
      { path: "work/p10.3-table-diagnostic/table-structure-preservation-report.v0.1.json", note: "NOT modified or deleted", status: "SUPERSEDED_BY_CORRECTED_FULL_POPULATION_AUDIT" },
      { path: "work/p10.3-table-diagnostic/table-retrieval-metrics-by-combination.v0.1.json", note: "NOT modified or deleted", status: "SUPERSEDED_BY_CORRECTED_FULL_POPULATION_AUDIT" },
      { path: "work/p10.3-table-diagnostic/table-chunking-final-verdict.v0.1.json", note: "NOT modified or deleted", status: "SUPERSEDED_BY_CORRECTED_FULL_POPULATION_AUDIT" },
      { path: "work/p10.3.1-table-locator-audit/table-locator-root-cause-audit.v0.1.json", note: "NOT modified or deleted -- P10.3.1's within-sample audit remains valid for the 45-item subset it covered; superseded only in the sense that the full-population numbers below now supersede it as the canonical reference point", status: "SUPERSEDED_BY_CORRECTED_FULL_POPULATION_AUDIT" },
    ],
    superseded_artifact_git_blob_shas: {
      "work/p10.3-table-diagnostic/table-item-inventory.v0.1.json": gitBlobSha("work/p10.3-table-diagnostic/table-item-inventory.v0.1.json"),
      "work/p10.3-table-diagnostic/table-structure-preservation-report.v0.1.json": gitBlobSha("work/p10.3-table-diagnostic/table-structure-preservation-report.v0.1.json"),
      "work/p10.3-table-diagnostic/table-retrieval-metrics-by-combination.v0.1.json": gitBlobSha("work/p10.3-table-diagnostic/table-retrieval-metrics-by-combination.v0.1.json"),
      "work/p10.3-table-diagnostic/table-chunking-final-verdict.v0.1.json": gitBlobSha("work/p10.3-table-diagnostic/table-chunking-final-verdict.v0.1.json"),
      "work/p10.3.1-table-locator-audit/table-locator-root-cause-audit.v0.1.json": gitBlobSha("work/p10.3.1-table-locator-audit/table-locator-root-cause-audit.v0.1.json"),
    },
    supersession_reason: "LOCATOR_PARSER_SKIPPED_CELL_QUALIFIED_FORMAT",
    supersession_reason_detail: "P10.3's resolver (table-evidence-resolver.mjs's findNodeById) only matched source_locator against a real DocumentIR node_id via exact string equality, which only the NODE_ONLY_COLON shape (docId::relPath::nodeId, 79/345 = 22.9% of all Gold sources) satisfies. The CELL_QUALIFIED shape (docId/relPath#node=N&row=R&col=C, 260/345 = 75.4%, the MOST authoritative locator Gold provides) and NODE_ONLY_HASH (6/345) were silently misclassified as non-table/unresolvable.",
    old_population: { table_evaluation_item_count: 49, table_kind_source_count: 75, source: "work/p10.3-table-diagnostic/table-item-inventory.v0.1.json" },
    corrected_population: { table_evaluation_item_count: inventory.table_evaluation_item_count, table_kind_source_count: inventory.unique_table_source_count, source: "work/p10.3.2-table-full-population-audit/corrected-table-item-inventory.v0.2.json" },
    retained_from_p10_3: [
      "The DIRECTION of P10.3's finding (Fixed has more critical violations than Section) -- confirmed, not reversed, at full population scale.",
      "P10.3.1's per-cell audit methodology (authority-respecting locator resolution, root-cause attribution) -- reused and extended, not redesigned.",
      "The underlying chunker.mjs strategies and configs (fixed-token-512-o64.v0.1.0, section-aware-flat-512-o64.v0.1.0) -- unchanged.",
    ],
    discarded_or_recomputed: [
      "P10.3's 49-item/75-source population is superseded as the canonical reference by the corrected 92-item/339-source population.",
      `P10.3's reported critical violation counts (Fixed ${fixedOld.critical_violation_count}, Section ${sectionOld.critical_violation_count}) are superseded by the full-population counts (Fixed ${fixedNew.critical_violation_count}, Section ${sectionNew.critical_violation_count}).`,
      "P10.3's table Recall@10 figures (computed over 49 items) are superseded by corrected-table-retrieval-metrics.v0.2.json (92 items).",
    ],
    canonical_artifact_paths: [
      "work/p10.3.2-table-full-population-audit/corrected-table-item-inventory.v0.2.json",
      "work/p10.3.2-table-full-population-audit/corrected-table-locator-resolution-report.v0.2.json",
      "work/p10.3.2-table-full-population-audit/full-population-table-structure-report.v0.2.json",
      "work/p10.3.2-table-full-population-audit/full-population-critical-violations.v0.2.json",
      "work/p10.3.2-table-full-population-audit/parse-limited-source-disposition.v0.1.json",
      "work/p10.3.2-table-full-population-audit/corrected-table-retrieval-metrics.v0.2.json",
      "work/p10.3.2-table-full-population-audit/table-full-population-final-verdict.v0.2.json",
    ],
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "p10-3-supersession-manifest.v0.1.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ old_population: manifest.old_population, corrected_population: manifest.corrected_population }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3.2-stage6-supersession-manifest] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
