import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const P10_3_FILES = [
  "domain/agent-comparison/chunking-comparison/table-evidence-resolver.mjs",
  "domain/agent-comparison/chunking-comparison/table-item-classifier.mjs",
  "domain/agent-comparison/chunking-comparison/table-structure-preservation.mjs",
  "domain/agent-comparison/chunking-comparison/table-chunking-interaction.mjs",
  "domain/agent-comparison/chunking-comparison/table-chunking-verdict-rule.mjs",
  "scripts/p10.3-table-verify-start-conditions.mjs",
  "scripts/p10.3-stage1-table-item-classification.mjs",
  "scripts/p10.3-stage2-structure-preservation.mjs",
  "scripts/p10.3-stage3-table-retrieval-rescoring.mjs",
  "scripts/p10.3-stage4-5-interaction-and-verdict.mjs",
];

function stripLineComments(source) {
  return source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

function readSource(relPath) {
  return readFileSync(path.join(ROOT, relPath), "utf8");
}

test("every P10.3 source file listed by this suite actually exists on disk", () => {
  for (const relPath of P10_3_FILES) assert.doesNotThrow(() => readSource(relPath), `missing: ${relPath}`);
});

test("no P10.3 module or script has a file-read call targeting a DEV_CHECK/HOLDOUT-named path", () => {
  const readCallPattern = /\b(?:readFileSync|readFile|createReadStream|openSync|open)\s*\(([^)]*)\)/g;
  for (const relPath of P10_3_FILES) {
    const source = stripLineComments(readSource(relPath));
    for (const match of source.matchAll(readCallPattern)) {
      assert.doesNotMatch(match[1], /dev[-_]check|holdout[-_.]/i, `${relPath} reads a file whose path references DEV_CHECK/HOLDOUT: ${match[0]}`);
    }
  }
});

test("no P10.3 module or script imports a chat/completion (HCX) model adapter, or generates an Agent answer", () => {
  for (const relPath of P10_3_FILES) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /from\s+["'][^"']*model-adapter\.mjs["']/, `${relPath} must never import a chat/completion model adapter`);
    assert.doesNotMatch(source, /\bcallChatCompletion\b|\bcreateModelAdapter\b|\bHCX_API_KEY\b|\bcreateChatAdapter\b/, `${relPath} must never call an HCX/chat-completion adapter`);
  }
});

test("no P10.3 module or script spawns a model server or calls an embeddings endpoint -- zero new embedding calls guaranteed structurally", () => {
  for (const relPath of P10_3_FILES) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /spawn\s*\(\s*VENV_PYTHON/, `${relPath} must never spawn a local embedding server`);
    assert.doesNotMatch(source, /local_embedding_server\.py/, `${relPath} must never reference the embedding server script`);
    assert.doesNotMatch(source, /\/v1\/embeddings/, `${relPath} must never call an embeddings endpoint`);
    assert.doesNotMatch(source, /createEmbeddingAdapter/, `${relPath} must never construct an embedding adapter`);
  }
});

test("Stage 3 (retrieval rescoring) declares zero new embedding calls and zero new model servers in its own written output", () => {
  const source = readSource("scripts/p10.3-stage3-table-retrieval-rescoring.mjs");
  assert.match(source, /new_embedding_calls:\s*0/);
  assert.match(source, /new_model_servers_spawned:\s*0/);
});

test("Stage 3 script fails closed to TABLE_DIAGNOSTIC_INCONCLUSIVE (never fabricates a winner) when P10.2's 6 combinations are incomplete", () => {
  const source = readSource("scripts/p10.3-stage3-table-retrieval-rescoring.mjs");
  assert.match(source, /combinations_completed\s*!==\s*6/);
  assert.match(source, /TABLE_DIAGNOSTIC_INCONCLUSIVE/);
});

test("Stage 3 script fails closed when P10.2's per-item result files are missing, before reading anything else", () => {
  const source = readSource("scripts/p10.3-stage3-table-retrieval-rescoring.mjs");
  const existsCheck = source.indexOf("existsSync(stage2ResultsPath)");
  const readCall = source.indexOf("JSON.parse(await readFile(stage2ResultsPath");
  assert.ok(existsCheck !== -1 && readCall !== -1 && existsCheck < readCall);
});

test("Stage 1/2 scripts never assign Gold question/expected_answer/evidence_span TEXT into a written report field", () => {
  // `source.evidence_span` as a plain function ARGUMENT to the resolver
  // (resolveTableCell(node, source.evidence_span)) is legitimate -- the
  // text is consumed transiently for matching, never persisted. What must
  // never happen is evidence_span being assigned AS AN OBJECT-LITERAL
  // FIELD (`evidence_span: ...`), which is the actual "written into
  // output" risk pattern.
  for (const relPath of ["scripts/p10.3-stage1-table-item-classification.mjs", "scripts/p10.3-stage2-structure-preservation.mjs"]) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /\bitem\.question\b/, `${relPath} must never read item.question`);
    assert.doesNotMatch(source, /expected_answer(?!ability)\b/, `${relPath} must never reference expected_answer`);
    assert.doesNotMatch(source, /evidence_span\s*:/, `${relPath} must never assign evidence_span as an object field`);
  }
});

test("table-item-classifier.mjs never destructures or forwards item.question/item.expected_answer", () => {
  const source = stripLineComments(readSource("domain/agent-comparison/chunking-comparison/table-item-classifier.mjs"));
  assert.doesNotMatch(source, /\bitem\.question\b/);
  assert.doesNotMatch(source, /\bitem\.expected_answer\b/);
});

test("Stage 4-5 orchestrator never writes to a path under the P10.2 worktree (read-only reference, P10.2 worktree modification forbidden)", () => {
  for (const relPath of P10_3_FILES) {
    const source = stripLineComments(readSource(relPath));
    const writeCallPattern = /writeFile\s*\(([^,]*),/g;
    for (const match of source.matchAll(writeCallPattern)) {
      assert.doesNotMatch(match[1], /agent-chunking-embedding-grid-v01/, `${relPath} must never write into the P10.2 worktree`);
    }
  }
});

test("Stage 2 never reads or writes a hierarchical chunking_config_id (P10.1.1's elimination stays respected)", () => {
  const source = stripLineComments(readSource("scripts/p10.3-stage2-structure-preservation.mjs"));
  assert.match(source, /NON_HIERARCHICAL_STRATEGIES/);
  assert.match(source, /strategy_name\s*!==\s*"document-type-hierarchical-parent-child"/);
});

test("the verdict rule module never approves FIXED_512_TABLE_SAFE as a default/fallback branch (every path is an explicit criterion check)", () => {
  const source = stripLineComments(readSource("domain/agent-comparison/chunking-comparison/table-chunking-verdict-rule.mjs"));
  // the LAST reachable branch before the function ends must be INCONCLUSIVE,
  // never FIXED_SAFE -- i.e. uncertainty never silently resolves to Fixed.
  const lastReturnIndex = source.lastIndexOf("return {");
  const finalSlice = source.slice(lastReturnIndex);
  assert.match(finalSlice, /TABLE_VERDICT\.INCONCLUSIVE/);
});
