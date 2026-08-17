import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import {
  buildPdfPageNodes,
  mapCTolerantNode,
  overlaySha256,
  recommendReviewAction,
  summarizeRecoveryCandidate,
} from "../domain/recovery/parse-recovery.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--a-document-ir") args.aDocumentIr = argv[++index];
    else if (token === "--parse-audit") args.parseAudit = argv[++index];
    else if (token === "--c-zip") args.cZip = argv[++index];
    else if (token === "--corpus-root") args.corpusRoot = argv[++index];
    else if (token === "--manifest") args.manifest = argv[++index];
    else if (token === "--output-dir") args.outputDir = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const key of ["aDocumentIr", "parseAudit", "cZip", "corpusRoot", "manifest", "outputDir"]) {
    if (!args[key]) throw new Error(`Missing required argument: ${key}`);
  }
  return args;
}

async function readJsonl(path) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

async function readTargetDocuments(path, targetIds) {
  const rows = new Map();
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (targetIds.has(row.doc_id)) rows.set(row.doc_id, row);
    if (rows.size === targetIds.size) break;
  }
  return rows;
}

function readCDocument(zipPath, documentId) {
  const group = documentId.split("_", 1)[0];
  const entry = `document_ir/${group}/${documentId}.json.gz`;
  const compressed = execFileSync("unzip", ["-p", resolve(zipPath), entry], {
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(gunzipSync(compressed).toString("utf8"));
}

function failedRelPaths(document) {
  return [...new Set((document.warnings ?? [])
    .filter((warning) => warning.code === "parse_failed")
    .map((warning) => basename(warning.rel_path)))];
}

function aNodesForFiles(document, relPaths) {
  const wanted = new Set(relPaths);
  return (document.nodes ?? []).filter((node) => {
    const sourcePath = basename(node?.source?.rel_path ?? "");
    if (wanted.has(sourcePath)) return true;
    return [...wanted].some((path) => String(node.node_id ?? "").includes(`::${path}::`));
  });
}

function cNodesForFiles(document, relPaths) {
  const wanted = new Set(relPaths);
  return (document.nodes ?? []).filter((node) => wanted.has(basename(node?.source?.rel_path ?? "")));
}

function findCorpusFile(corpusRoot, fileName) {
  const result = execFileSync("find", [resolve(corpusRoot), "-type", "f", "-name", fileName, "-print", "-quit"], {
    encoding: "utf8",
  }).trim();
  if (!result) throw new Error(`Corpus file not found: ${fileName}`);
  return result;
}

function pdftotextVersion() {
  try {
    return execFileSync("pdftotext", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .trim()
      .split("\n")[0] || "unknown";
  } catch (error) {
    const stderr = String(error.stderr ?? "").trim();
    return stderr.split("\n")[0] || "unknown";
  }
}

function extractPdfText(pdfPath) {
  return execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function buildOverlay({ audit, document, method, recoveryNodes, relPaths }) {
  const metrics = summarizeRecoveryCandidate({
    aNodes: aNodesForFiles(document, relPaths),
    recoveryNodes,
  });
  const withoutHash = {
    schema_version: "0.1.0",
    document_id: document.doc_id,
    source_corpus_snapshot_id: document.corpus_snapshot_id,
    canonical_parser_version: document.parser_version,
    recovery_method: method,
    review_status: recommendReviewAction(method, metrics),
    failed_source_files: relPaths,
    metrics,
    nodes: recoveryNodes,
  };
  return { ...withoutHash, overlay_sha256: overlaySha256(withoutHash), audit };
}

const args = parseArgs(process.argv.slice(2));
const audits = await readJsonl(args.parseAudit);
const targets = audits.filter((audit) =>
  audit.source_parse_tier === "fallback" || audit.coverage_reason_code === "PDF_VIEWER_EMPTY_NO_TABLES");
const targetIds = new Set(targets.map((audit) => audit.document_id));
const documents = await readTargetDocuments(args.aDocumentIr, targetIds);
if (documents.size !== targetIds.size) {
  throw new Error(`A DocumentIR target mismatch: expected ${targetIds.size}, found ${documents.size}`);
}
const manifests = await readJsonl(args.manifest);
const manifestById = new Map(manifests.map((row) => [row.doc_id, row]));
const outputDir = resolve(args.outputDir);
await mkdir(outputDir, { recursive: true });
const overlayPath = resolve(outputDir, "parse-recovery-overlay.candidate.jsonl");
const queuePath = resolve(outputDir, "parse-recovery-review-queue.jsonl");
const overlayStream = createWriteStream(overlayPath, { encoding: "utf8" });
const queueStream = createWriteStream(queuePath, { encoding: "utf8" });
const summary = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  canonical_document_count: audits.length,
  target_document_count: targets.length,
  fallback_target_count: targets.filter((row) => row.source_parse_tier === "fallback").length,
  pdf_target_count: targets.filter((row) => row.coverage_reason_code === "PDF_VIEWER_EMPTY_NO_TABLES").length,
  by_method: {},
  by_review_status: {},
  documents: [],
};
const pdfVersion = pdftotextVersion();

for (const audit of targets) {
  const document = documents.get(audit.document_id);
  const failedFiles = failedRelPaths(document);
  let method;
  let recoveryFiles;
  let recoveryNodes;

  if (audit.coverage_reason_code === "PDF_VIEWER_EMPTY_NO_TABLES") {
    method = "PDF_TEXT_LAYER";
    const manifest = manifestById.get(document.doc_id);
    if (!manifest) throw new Error(`Manifest row missing: ${document.doc_id}`);
    const pdfRelPath = document.source_files.find((file) => file.content_format === "pdf")?.rel_path;
    if (!pdfRelPath) throw new Error(`PDF source missing: ${document.doc_id}`);
    const pdfPath = findCorpusFile(args.corpusRoot, basename(pdfRelPath));
    const text = extractPdfText(pdfPath);
    recoveryFiles = [basename(pdfRelPath)];
    recoveryNodes = buildPdfPageNodes(document.doc_id, basename(pdfRelPath), text, pdfVersion);
  } else {
    method = "C_TOLERANT_XML";
    const cDocument = readCDocument(args.cZip, document.doc_id);
    recoveryFiles = failedFiles;
    recoveryNodes = cNodesForFiles(cDocument, recoveryFiles)
      .map((node) => mapCTolerantNode(document.doc_id, node, cDocument.parser));
  }

  const built = buildOverlay({ audit, document, method, recoveryNodes, relPaths: recoveryFiles });
  const { audit: ignoredAudit, ...overlay } = built;
  if (!overlayStream.write(`${JSON.stringify(overlay)}\n`)) {
    await new Promise((resolveDrain) => overlayStream.once("drain", resolveDrain));
  }
  const queueRecord = {
    document_id: document.doc_id,
    recovery_method: method,
    review_status: overlay.review_status,
    failed_source_files: recoveryFiles,
    metrics: overlay.metrics,
    overlay_sha256: overlay.overlay_sha256,
    reviewer_decision: "PENDING",
    reviewer_notes: null,
  };
  if (!queueStream.write(`${JSON.stringify(queueRecord)}\n`)) {
    await new Promise((resolveDrain) => queueStream.once("drain", resolveDrain));
  }
  summary.by_method[method] = (summary.by_method[method] ?? 0) + 1;
  summary.by_review_status[overlay.review_status] = (summary.by_review_status[overlay.review_status] ?? 0) + 1;
  summary.documents.push(queueRecord);
}

await Promise.all([
  new Promise((resolveEnd) => overlayStream.end(resolveEnd)),
  new Promise((resolveEnd) => queueStream.end(resolveEnd)),
]);
await writeFile(resolve(outputDir, "parse-recovery-report.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  overlay: overlayPath,
  review_queue: queuePath,
  report: resolve(outputDir, "parse-recovery-report.json"),
  targets: targets.length,
  by_method: summary.by_method,
  by_review_status: summary.by_review_status,
}, null, 2)}\n`);
