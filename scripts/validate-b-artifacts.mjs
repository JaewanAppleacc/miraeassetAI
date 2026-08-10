#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const corpusRoot = resolve(process.argv[2] ?? process.env.DISCLOSURE_CORPUS_ROOT ?? "");
const queuePath = resolve(process.argv[3] ?? "work/domain-seed/evaluation-authoring-queue.jsonl");
if (!existsSync(resolve(corpusRoot, "manifest.jsonl")) || !existsSync(queuePath)) {
  console.error("Usage: node scripts/validate-b-artifacts.mjs <corpus-root> [authoring-queue]");
  process.exit(2);
}

const errors = [];
const manifest = readFileSync(resolve(corpusRoot, "manifest.jsonl"), "utf8")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const documentIds = new Set(manifest.map((row) => row.doc_id));
const queue = readFileSync(queuePath, "utf8")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const relationPath = resolve("work/domain-seed/relation-review-queue.jsonl");
const relations = existsSync(relationPath)
  ? readFileSync(relationPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const parseCoveragePath = resolve("work/domain-seed/document-parse-coverage.jsonl");
const parseFailedDocumentIds = existsSync(parseCoveragePath)
  ? new Set(readFileSync(parseCoveragePath, "utf8")
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      .filter((record) => record.state === "PARSE_FAILED")
      .map((record) => record.document_id))
  : new Set();
const allocation = JSON.parse(readFileSync(resolve("domain/evaluation/authoring-allocation.json"), "utf8"));
const ontology = JSON.parse(readFileSync(resolve("domain/facts/metric-ontology.v0.1.json"), "utf8"));

const metricCodes = new Set();
for (const [index, metric] of ontology.metrics.entries()) {
  if (!/^[A-Z][A-Z0-9_]+$/.test(metric.metric_code ?? "")) errors.push(`metric[${index}] invalid metric_code`);
  if (metricCodes.has(metric.metric_code)) errors.push(`duplicate metric_code: ${metric.metric_code}`);
  metricCodes.add(metric.metric_code);
  if (!Array.isArray(metric.doc_groups) || metric.doc_groups.length === 0) errors.push(`${metric.metric_code} has no doc_groups`);
  if (!Array.isArray(metric.required_dimensions)) errors.push(`${metric.metric_code} has no required_dimensions`);
  if (!Array.isArray(metric.source_label_aliases) || metric.source_label_aliases.length === 0) errors.push(`${metric.metric_code} has no source aliases`);
}

const assignmentIds = new Set();
const groupSplits = new Map();
const anchorSplits = new Map();
const chainSplits = new Map();
const counts = { by_split: {}, by_bucket: {} };
const criticalBySplit = {};
for (const [index, item] of queue.entries()) {
  if (assignmentIds.has(item.assignment_id)) errors.push(`duplicate assignment_id: ${item.assignment_id}`);
  assignmentIds.add(item.assignment_id);
  if (!item.question_draft || !item.evaluation_group_id) errors.push(`queue[${index}] lacks question/group`);
  if (item.gold_status !== "NOT_STARTED") errors.push(`${item.assignment_id} must not pretend to be Gold`);
  const blockedAnchors = (item.anchor_document_ids ?? []).filter((documentId) => parseFailedDocumentIds.has(documentId));
  if (blockedAnchors.length > 0) {
    if (item.authoring_status !== "PARSE_BLOCKED") errors.push(`${item.assignment_id} must be PARSE_BLOCKED`);
    if (!item.tags?.includes("parse_blocked")) errors.push(`${item.assignment_id} lacks parse_blocked tag`);
    if (JSON.stringify(item.parse_blocked_document_ids ?? []) !== JSON.stringify(blockedAnchors)) {
      errors.push(`${item.assignment_id} has stale parse_blocked_document_ids`);
    }
  }
  const hasAnchors = (item.anchor_document_ids?.length ?? 0) > 0;
  const hasKnownChains = (item.known_chain_ids?.length ?? 0) > 0;
  if (hasAnchors && !hasKnownChains && item.split_lock_status !== "PROVISIONAL_UNTIL_CHAIN_CLOSURE") {
    errors.push(`${item.assignment_id} anchored split must remain provisional until chain closure`);
  }
  if (hasAnchors && !item.split_dependencies?.includes("RELATION_CHAIN_CLOSURE")) {
    errors.push(`${item.assignment_id} lacks relation chain split dependency`);
  }
  if (!hasAnchors && item.split_lock_status !== "LOCKED_BY_COVERAGE") {
    errors.push(`${item.assignment_id} anchorless coverage question has invalid split lock`);
  }
  for (const documentId of item.anchor_document_ids ?? []) {
    if (!documentIds.has(documentId)) errors.push(`${item.assignment_id} unknown anchor: ${documentId}`);
    const splits = anchorSplits.get(documentId) ?? new Set();
    splits.add(item.planned_split);
    anchorSplits.set(documentId, splits);
  }
  for (const chainId of item.known_chain_ids ?? []) {
    const splits = chainSplits.get(chainId) ?? new Set();
    splits.add(item.planned_split);
    chainSplits.set(chainId, splits);
  }
  if (hasKnownChains && item.split_lock_status !== "LOCKED_BY_CHAIN") {
    errors.push(`${item.assignment_id} has chain IDs but split was not locked by chain`);
  }
  const splits = groupSplits.get(item.evaluation_group_id) ?? new Set();
  splits.add(item.planned_split);
  groupSplits.set(item.evaluation_group_id, splits);
  counts.by_split[item.planned_split] = (counts.by_split[item.planned_split] ?? 0) + 1;
  counts.by_bucket[item.bucket] = (counts.by_bucket[item.bucket] ?? 0) + 1;
  const critical = criticalBySplit[item.planned_split] ?? {};
  for (const tag of item.tags ?? []) critical[tag] = (critical[tag] ?? 0) + 1;
  criticalBySplit[item.planned_split] = critical;
}
for (const [group, splits] of groupSplits) {
  if (splits.size > 1) errors.push(`${group} leaks across splits: ${[...splits].join(",")}`);
}
for (const [documentId, splits] of anchorSplits) {
  if (splits.size > 1) errors.push(`${documentId} anchor leaks across splits: ${[...splits].join(",")}`);
}
for (const [chainId, splits] of chainSplits) {
  if (splits.size > 1) errors.push(`${chainId} leaks across splits: ${[...splits].join(",")}`);
}

if (relations.length > 0) {
  const amends = relations.filter((relation) => relation.relation_type === "AMENDS");
  const terminations = relations.filter((relation) => relation.relation_type === "TERMINATES");
  const exchangeExplicit = amends.filter((relation) => relation.doc_group === "exchange" && relation.explicit_reference);
  if (amends.length !== 1004) errors.push(`AMENDS count ${amends.length}, expected 1004`);
  if (terminations.length !== 20) errors.push(`TERMINATES count ${terminations.length}, expected 20`);
  if (terminations.every((relation) => relation.candidates.length === 0)) {
    errors.push("all TERMINATES candidates are empty; check contract subtype normalization");
  }
  if (terminations.some((relation) => !relation.recommendation_status)) {
    errors.push("TERMINATES Fact-ranking status is missing");
  }
  if (exchangeExplicit.length !== 631) {
    errors.push(`exchange explicit correction references ${exchangeExplicit.length}, expected 631`);
  }
}

if (queue.length !== allocation.initial_queue_targets.total) {
  errors.push(`queue size ${queue.length}, expected ${allocation.initial_queue_targets.total}`);
}
for (const [split, expected] of Object.entries(allocation.initial_queue_targets.by_split)) {
  if (counts.by_split[split] !== expected) errors.push(`${split} count ${counts.by_split[split]}, expected ${expected}`);
}
for (const [bucket, expected] of Object.entries(allocation.initial_queue_targets.by_bucket)) {
  if (counts.by_bucket[bucket] !== expected) errors.push(`${bucket} count ${counts.by_bucket[bucket]}, expected ${expected}`);
}
for (const split of Object.keys(allocation.initial_queue_targets.by_split)) {
  for (const tag of ["correction_chain", "termination", "zero_document", "facility_investment", "cross_company"]) {
    if (!criticalBySplit[split]?.[tag]) errors.push(`${split} has no ${tag} critical slice`);
  }
}

for (const schemaPath of [
  "domain/interfaces/document-ir.schema.json",
  "domain/interfaces/semantic-bundle.schema.json",
  "domain/interfaces/evaluation-usage-event.schema.json",
  "domain/interfaces/fact-coverage-snapshot.schema.json",
  "domain/interfaces/experiment-run.schema.json",
  "domain/evaluation/evaluation-gold.v0.2.schema.json",
]) {
  const schema = JSON.parse(readFileSync(resolve(schemaPath), "utf8"));
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") errors.push(`${schemaPath} is not draft 2020-12`);
  if (!schema.$id || !schema.title) errors.push(`${schemaPath} lacks id/title`);
}

if (errors.length) {
  console.error(JSON.stringify({ status: "FAIL", errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  status: "PASS",
  metrics: ontology.metrics.length,
  authoring_assignments: queue.length,
  critical_by_split: criticalBySplit,
  ...counts,
}, null, 2));
