#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKET_ID_RE = /^u-[0-9a-f]{12}$/;
const FORBIDDEN_KEYS = new Set(["arm", "rank", "score", "winner", "candidate"]);

function findForbiddenKey(value, at = "$") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenKey(value[i], `${at}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) return `${at}.${key}`;
    const found = findForbiddenKey(child, `${at}.${key}`);
    if (found) return found;
  }
  return null;
}

export async function buildAlternateNodePopulation(unresolvedDir) {
  const names = (await readdir(unresolvedDir))
    .filter((name) => /^u-[0-9a-f]{12}\.json$/.test(name))
    .sort();
  const selected = [];
  const combined = createHash("sha256");

  for (const name of names) {
    const bytes = await readFile(path.join(unresolvedDir, name));
    let packet;
    try {
      packet = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`INVALID_PACKET_JSON:${name}:${error.message}`);
    }
    if (packet.reason !== "duplicate_evidence_different_node") continue;
    const packetId = name.slice(0, -5);
    if (packet.packet_id !== packetId || !PACKET_ID_RE.test(packetId)) {
      throw new Error(`PACKET_ID_MISMATCH:${name}`);
    }
    const forbidden = findForbiddenKey(packet);
    if (forbidden) throw new Error(`ARM_BLINDNESS_VIOLATION:${name}:${forbidden}`);
    combined.update(bytes);
    selected.push({
      packet_id: packetId,
      packet_sha256: createHash("sha256").update(bytes).digest("hex"),
      classification: "UNKNOWN",
      sensitivity_outcome: "PENDING_REVIEW",
      critical: false,
      owner_confirmed: false,
      note: "",
    });
  }

  if (selected.length === 0) throw new Error("EMPTY_ALTERNATE_NODE_POPULATION");
  return {
    schema_version: "fourarm.alternate-node-sensitivity-review-template.v1",
    reason: "duplicate_evidence_different_node",
    population_scope: "ALL_A_B_C_D_FULL_BATCH",
    packet_count: selected.length,
    packet_combined_sha256: combined.digest("hex"),
    owner_confirmed: false,
    resolutions: selected,
  };
}

async function main() {
  const [unresolvedDir, outputPath] = process.argv.slice(2);
  if (!unresolvedDir || !outputPath) {
    throw new Error("USAGE: p11f0-fourarm-alternate-node-population.mjs <unresolved-dir> <output-json>");
  }
  const output = await buildAlternateNodePopulation(path.resolve(unresolvedDir));
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(path.resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    packet_count: output.packet_count,
    packet_combined_sha256: output.packet_combined_sha256,
    output_path: path.resolve(outputPath),
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`[alternate-node-population] FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
