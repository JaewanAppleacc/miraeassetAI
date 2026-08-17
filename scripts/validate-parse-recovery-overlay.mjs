#!/usr/bin/env node

import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import { overlaySha256 } from "../domain/recovery/parse-recovery.mjs";

const [inputPath = "work/parse-recovery/parse-recovery-overlay.candidate.jsonl"] = process.argv.slice(2);
const schema = JSON.parse(readFileSync("domain/interfaces/parse-recovery-overlay.schema.json", "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validate = ajv.compile(schema);
const lines = createInterface({ input: createReadStream(resolve(inputPath)), crlfDelay: Infinity });
const documentIds = new Set();
const recoveryNodeIds = new Set();
let count = 0;

for await (const line of lines) {
  if (!line.trim()) continue;
  count += 1;
  const record = JSON.parse(line);
  if (!validate(record)) {
    throw new Error(`Schema failure at line ${count}: ${JSON.stringify(validate.errors)}`);
  }
  if (documentIds.has(record.document_id)) {
    throw new Error(`Duplicate recovery document: ${record.document_id}`);
  }
  documentIds.add(record.document_id);
  const { overlay_sha256: recordedHash, ...withoutHash } = record;
  if (overlaySha256(withoutHash) !== recordedHash) {
    throw new Error(`Overlay hash mismatch: ${record.document_id}`);
  }
  for (const node of record.nodes) {
    if (recoveryNodeIds.has(node.recovery_node_id)) {
      throw new Error(`Duplicate recovery node ID: ${node.recovery_node_id}`);
    }
    recoveryNodeIds.add(node.recovery_node_id);
    if (node.document_id !== record.document_id) {
      throw new Error(`Recovery node document mismatch: ${node.recovery_node_id}`);
    }
  }
}

if (count !== 81) throw new Error(`Expected 81 recovery documents, found ${count}`);
process.stdout.write(`${JSON.stringify({
  status: "PASS",
  documents: count,
  unique_recovery_nodes: recoveryNodeIds.size,
}, null, 2)}\n`);
