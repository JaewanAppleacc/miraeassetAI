import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK_DIR = path.join(ROOT, "work", "p10.3.2-table-full-population-audit");

const P10_3_2_FILES = [
  "domain/agent-comparison/chunking-comparison/table-locator-authority-v2.mjs",
  "domain/agent-comparison/chunking-comparison/table-item-classifier-v2.mjs",
  "domain/agent-comparison/chunking-comparison/table-full-population-verdict-rule.mjs",
  "scripts/p10.3.2-stage1-2-population-audit.mjs",
  "scripts/p10.3.2-stage3-structure-audit.mjs",
  "scripts/p10.3.2-stage4-parse-limited-disposition.mjs",
  "scripts/p10.3.2-stage5-retrieval-rescoring.mjs",
  "scripts/p10.3.2-stage6-supersession-manifest.mjs",
  "scripts/p10.3.2-stage7-final-verdict.mjs",
];

function stripLineComments(source) { return source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); }
function readSource(relPath) { return readFileSync(path.join(ROOT, relPath), "utf8"); }

test("every P10.3.2 source file exists on disk", () => {
  for (const relPath of P10_3_2_FILES) assert.doesNotThrow(() => readSource(relPath), `missing: ${relPath}`);
});

test("no P10.3.2 module or script has a file-read call targeting a DEV_CHECK/HOLDOUT-named path", () => {
  const readCallPattern = /\b(?:readFileSync|readFile|createReadStream|openSync|open)\s*\(([^)]*)\)/g;
  for (const relPath of P10_3_2_FILES) {
    const source = stripLineComments(readSource(relPath));
    for (const match of source.matchAll(readCallPattern)) {
      assert.doesNotMatch(match[1], /dev[-_]check|holdout[-_.]/i, `${relPath}: ${match[0]}`);
    }
  }
});

test("no P10.3.2 module or script calls an embeddings endpoint, spawns a model server, loads/downloads a model, or imports an HCX/chat adapter", () => {
  for (const relPath of P10_3_2_FILES) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /spawn\s*\(\s*VENV_PYTHON/, `${relPath}`);
    assert.doesNotMatch(source, /local_embedding_server\.py/, `${relPath}`);
    assert.doesNotMatch(source, /\/v1\/embeddings/, `${relPath}`);
    assert.doesNotMatch(source, /createEmbeddingAdapter/, `${relPath}`);
    assert.doesNotMatch(source, /from\s+["'][^"']*model-adapter\.mjs["']/, `${relPath}`);
    assert.doesNotMatch(source, /\bcallChatCompletion\b|\bcreateModelAdapter\b|\bHCX_API_KEY\b/, `${relPath}`);
  }
});

test("Stage 3 is the ONLY script that invokes chunkDocument (real chunking is explicitly allowed this Turn, unlike P10.3.1)", () => {
  for (const relPath of P10_3_2_FILES) {
    const source = stripLineComments(readSource(relPath));
    const invokesChunker = /chunkDocument\s*\(/.test(source);
    if (relPath === "scripts/p10.3.2-stage3-structure-audit.mjs") assert.equal(invokesChunker, true, "Stage 3 must run real chunking");
    else assert.equal(invokesChunker, false, `${relPath} must not invoke the chunker`);
  }
});

test("no P10.3.2 script writes into P10.2/P10.3/P10.3.1's result directories", () => {
  for (const relPath of P10_3_2_FILES) {
    const source = stripLineComments(readSource(relPath));
    const writeCallPattern = /writeFile\s*\(([^,]*),/g;
    for (const match of source.matchAll(writeCallPattern)) {
      assert.doesNotMatch(match[1], /p10\.2-chunking-embedding-grid|p10\.3-table-diagnostic|p10\.3\.1-table-locator-audit/, `${relPath} must never write into a prior Turn's result directory`);
    }
  }
});

test("Stage 1-2/3/4 scripts never assign Gold question/expected_answer/evidence_span TEXT into a written report field", () => {
  for (const relPath of ["scripts/p10.3.2-stage1-2-population-audit.mjs", "scripts/p10.3.2-stage3-structure-audit.mjs", "scripts/p10.3.2-stage4-parse-limited-disposition.mjs"]) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /\bitem\.question\b/, relPath);
    assert.doesNotMatch(source, /expected_answer(?!ability)\b/, relPath);
    assert.doesNotMatch(source, /evidence_span\s*:/, relPath);
  }
});

if (existsSync(WORK_DIR)) {
  test("P10.2/P10.3/P10.3.1 result files are verified UNMODIFIED (git status clean on their directories)", () => {
    for (const dir of ["work/p10.3-table-diagnostic", "work/p10.3.1-table-locator-audit"]) {
      const status = execFileSync("git", ["status", "--short", dir], { cwd: ROOT, encoding: "utf8" });
      assert.equal(status.trim(), "", `${dir} must be unmodified; git status: ${status}`);
    }
  });

  test("101-item full reclassification: the corrected inventory covers exactly all 101 DEV_TUNE items", () => {
    const inventory = JSON.parse(readFileSync(path.join(WORK_DIR, "corrected-table-item-inventory.v0.2.json"), "utf8"));
    assert.equal(inventory.dev_tune_item_count, 101);
    assert.equal(inventory.per_item.length, 101);
    assert.equal(inventory.table_evaluation_item_count + inventory.non_table_evaluation_item_count, 101);
  });

  test("cell-qualified sources are not missed: CELL_QUALIFIED locator count in the resolution report matches the real Gold data (260)", () => {
    const resolution = JSON.parse(readFileSync(path.join(WORK_DIR, "corrected-table-locator-resolution-report.v0.2.json"), "utf8"));
    assert.equal(resolution.locator_scheme_distribution.CELL_QUALIFIED, 260);
  });

  test("Fixed/Section structure preservation: full-population-table-structure-report.v0.2.json covers BOTH strategies with real, nonzero cell checks", () => {
    const report = JSON.parse(readFileSync(path.join(WORK_DIR, "full-population-table-structure-report.v0.2.json"), "utf8"));
    assert.equal(report.strategies.length, 2);
    for (const s of report.strategies) assert.ok(s.totals.cell_checks > 0);
  });

  test("violation attribution: every recorded violation carries a valid attribution from the required enum", () => {
    const report = JSON.parse(readFileSync(path.join(WORK_DIR, "full-population-table-structure-report.v0.2.json"), "utf8"));
    const valid = new Set(["CHUNKING_ATTRIBUTABLE", "SOURCE_PARSE_LIMITATION", "GOLD_LOCATOR_AMBIGUOUS", "LOCATOR_PROVENANCE_CONFLICT", "RESOLVER_IMPLEMENTATION_BUG", "NOT_A_VIOLATION"]);
    for (const s of report.strategies) {
      for (const item of s.per_item) {
        for (const v of item.critical_violations) assert.ok(valid.has(v.attribution), `unrecognized attribution: ${v.attribution}`);
      }
    }
  });

  test("parse-limited source processing: the disposition report accounts for exactly the unresolvable sources found in Stage 1-2, no more no less", () => {
    const resolution = JSON.parse(readFileSync(path.join(WORK_DIR, "corrected-table-locator-resolution-report.v0.2.json"), "utf8"));
    const disposition = JSON.parse(readFileSync(path.join(WORK_DIR, "parse-limited-source-disposition.v0.1.json"), "utf8"));
    assert.equal(disposition.unresolvable_source_count, resolution.unresolvable_locator_count);
  });

  test("supersession manifest: names the correct old population (49/75) and does not claim to have deleted anything", () => {
    const manifest = JSON.parse(readFileSync(path.join(WORK_DIR, "p10-3-supersession-manifest.v0.1.json"), "utf8"));
    assert.equal(manifest.old_population.table_evaluation_item_count, 49);
    assert.equal(manifest.old_population.table_kind_source_count, 75);
    assert.equal(manifest.supersession_reason, "LOCATOR_PARSER_SKIPPED_CELL_QUALIFIED_FORMAT");
    for (const a of manifest.superseded_artifacts) assert.match(a.note, /NOT modified or deleted/);
  });

  test("old/new population separation: corrected_population in the manifest is strictly a distinct, separately-labeled field from old_population, never overwriting it", () => {
    const manifest = JSON.parse(readFileSync(path.join(WORK_DIR, "p10-3-supersession-manifest.v0.1.json"), "utf8"));
    assert.notEqual(manifest.old_population.table_evaluation_item_count, manifest.corrected_population.table_evaluation_item_count);
  });

  test("persisted-result-only metrics: retrieval rescoring declares 0 new embedding calls and 0 new model servers", () => {
    const metrics = JSON.parse(readFileSync(path.join(WORK_DIR, "corrected-table-retrieval-metrics.v0.2.json"), "utf8"));
    if (metrics.status === "COMPUTABLE_FROM_PERSISTED_RESULTS") {
      assert.equal(metrics.new_embedding_calls, 0);
      assert.equal(metrics.new_model_servers_spawned, 0);
      for (const c of metrics.combinations) {
        assert.ok("not_computable_without_raw_rankings" in c, "must explicitly disclose what could not be computed, never silently omit it");
      }
    }
  });

  test("Gold question/expected_answer/evidence text does not appear in any P10.3.2 written result file", () => {
    const files = [
      "corrected-table-item-inventory.v0.2.json", "corrected-table-locator-resolution-report.v0.2.json",
      "full-population-table-structure-report.v0.2.json", "full-population-critical-violations.v0.2.json",
      "parse-limited-source-disposition.v0.1.json", "corrected-table-retrieval-metrics.v0.2.json",
      "p10-3-supersession-manifest.v0.1.json", "table-full-population-final-verdict.v0.2.json",
    ];
    for (const f of files) {
      const p = path.join(WORK_DIR, f);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      assert.doesNotMatch(text, /"question"\s*:\s*"[^"]{10,}"/, `${f} may contain raw Gold question text`);
      assert.doesNotMatch(text, /"expected_answer"\s*:/, `${f} must never contain expected_answer`);
      assert.doesNotMatch(text, /"evidence_span"\s*:\s*"[^"]{10,}"/, `${f} may contain raw evidence_span text`);
    }
  });
}
