#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOwnerReviewFullText } from "../domain/agent-comparison/four-arm-ac/four-arm-owner-review-fulltext-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_DIR = path.join(ROOT, "work/bd_handoff/owner_review_v2");
const SCORER_DIR = path.join(ROOT, "work/bd_handoff/scorer/results/fourarm/unresolved");
const VIEW_DIR = path.join(ROOT, "work/bd_handoff/scoring_view");
const TEMPLATE = path.join(ROOT, "domain/agent-comparison/four-arm-ac/official/unresolved-review-template-v2.json");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const readJsonl = async (file) => (await readFile(file, "utf8"))
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

const template = await readJson(TEMPLATE);
const reviews = await readJson(path.join(REVIEW_DIR, "packets_review_v2.json"));
const frozenPackets = {};
for (const [packetId] of template) frozenPackets[packetId] = await readJson(path.join(SCORER_DIR, `${packetId}.json`));
const hydratedRows = [
  ...await readJsonl(path.join(VIEW_DIR, "A.scoring_view.jsonl")),
  ...await readJsonl(path.join(VIEW_DIR, "C.scoring_view.jsonl")),
];

console.log(JSON.stringify(verifyOwnerReviewFullText({ template, frozenPackets, reviews, hydratedRows }), null, 2));

