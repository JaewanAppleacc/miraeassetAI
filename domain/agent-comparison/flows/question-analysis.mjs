// Step 1-2 of the Structured-first Agent (질문 분석 -> 회사/기간/지표/사건 조건
// 생성). Deliberately generic: no company name, question_id, or expected
// answer is hardcoded anywhere in this file. Metric matching reads the
// EXISTING, frozen metric ontology (domain/facts/metric-ontology.v0.1.json)
// -- this consumes that ontology, it does not author a new one.
//
// `hints` (all optional) let a caller/AgentInput extension supply an
// already-resolved condition directly (e.g. from a company resolver that
// exists elsewhere in the codebase, or from a future Planner variant) --
// when present, a hint always takes precedence over this file's own
// heuristic extraction for that one field. Everything not supplied via a
// hint is derived from the raw question text only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ONTOLOGY_PATH = path.resolve(HERE, "../../facts/metric-ontology.v0.1.json");

let cachedOntology = null;
let cachedOntologyPath = null;

export function loadMetricOntology(ontologyPath = DEFAULT_ONTOLOGY_PATH) {
  if (cachedOntology && cachedOntologyPath === ontologyPath) return cachedOntology;
  const raw = JSON.parse(readFileSync(ontologyPath, "utf8"));
  cachedOntology = Object.freeze(raw.metrics ?? []);
  cachedOntologyPath = ontologyPath;
  return cachedOntology;
}

const CORP_CODE_PATTERN = /\b\d{8}\b/g;
const ISO_DATE_PATTERN = /\b\d{4}[-.]\d{2}[-.]\d{2}\b/g;
const KOREAN_YEAR_PATTERN = /\b(\d{4})\s*년/g;

function extractCorpCodes(question) {
  return [...new Set([...(question.matchAll(CORP_CODE_PATTERN) ?? [])].map((m) => m[0]))];
}

function normalizeIsoDate(token) {
  return token.replaceAll(".", "-");
}

function extractDates(question) {
  const dates = [...(question.matchAll(ISO_DATE_PATTERN) ?? [])].map((m) => normalizeIsoDate(m[0]));
  const years = [...(question.matchAll(KOREAN_YEAR_PATTERN) ?? [])].map((m) => `${m[1]}-01-01`);
  return [...new Set([...dates, ...years])].sort();
}

function extractMetricCodes(question, ontology) {
  const found = [];
  for (const metric of ontology) {
    const labels = [metric.metric_name_ko, ...(metric.source_label_aliases ?? [])].filter(Boolean);
    if (labels.some((label) => question.includes(label))) found.push(metric.metric_code);
  }
  return [...new Set(found)];
}

const SCOPE_KEYWORDS = Object.freeze([
  ["연결", "CONSOLIDATED"],
  ["별도", "SEPARATE"],
]);

function extractScopeFilter(question) {
  return [...new Set(SCOPE_KEYWORDS.filter(([keyword]) => question.includes(keyword)).map(([, scope]) => scope))];
}

export function analyzeQuestion(input, { ontology = loadMetricOntology(), hints = input?.hints ?? {} } = {}) {
  const question = typeof input?.question === "string" ? input.question : "";
  const dates = extractDates(question);
  return Object.freeze({
    corp_codes: hints.corp_codes ?? extractCorpCodes(question),
    metric_codes: hints.metric_codes ?? extractMetricCodes(question, ontology),
    event_types: hints.event_types ?? [],
    document_ids: hints.document_ids ?? [],
    period_filter: hints.period_filter ?? {
      start: dates[0] ?? null,
      end: dates[dates.length - 1] ?? null,
      period_types: [],
    },
    scope_filter: hints.scope_filter ?? extractScopeFilter(question),
  });
}
