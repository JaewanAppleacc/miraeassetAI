#!/usr/bin/env node
// Turn P11-D: executes the bounded real comparison of the two HCX-005
// structured-output candidates (Native v3 Function Calling vs
// OpenAI-compatible response_format=json_schema) and writes the single
// report artifact (interfaces/hcx-structured-protocol-comparison-report.schema.json).
// Fails closed (0 real calls to either candidate) whenever HCX_API_KEY /
// HCX_ENDPOINT_URL / HCX_MODEL_ID are not all present.
//
// Intended to run EXACTLY ONCE per CLAUDE.md Turn P11-D section F -- this
// script itself does not loop or self-invoke; re-running it manually
// performs a second real comparison, which section G rule 6 forbids within
// the same Turn.
//
// Never prints a secret value, a raw prompt, or a raw provider response
// body to stdout.
//
// Usage: node scripts/run-hcx-structured-protocol-comparison.mjs [--out <dir>]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadStructuredProtocolConfig } from "../domain/agent-comparison/hcx-structured-protocol/config.mjs";
import { runStructuredProtocolComparison } from "../domain/agent-comparison/hcx-structured-protocol/runner.mjs";
import { buildComparisonReport } from "../domain/agent-comparison/hcx-structured-protocol/artifacts.mjs";
import { validateComparisonReport } from "../domain/agent-comparison/hcx-structured-protocol/contracts.mjs";

function parseArgs(argv) {
  const out = { outDir: "domain/agent-comparison/hcx-structured-protocol/reports" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out.outDir = argv[i + 1];
  }
  return out;
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const loaded = loadStructuredProtocolConfig();

  console.log(`HCX structured protocol comparison: ready=${loaded.ready}${loaded.ready ? "" : ` missing=[${loaded.missing.join(", ")}]`}`);

  const runResult = await runStructuredProtocolComparison(loaded);
  const report = buildComparisonReport(loaded, runResult, { runId: loaded.redacted.run_id, createdAt: new Date().toISOString() });

  const schemaErrors = validateComparisonReport(report);
  if (schemaErrors.length > 0) {
    console.error("HCX structured protocol comparison: report failed schema validation:");
    for (const error of schemaErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  if (report.security_attestation.overall_status !== "PASS") {
    console.error("HCX structured protocol comparison: security attestation FAILED -- refusing to write the report.");
    for (const check of report.security_attestation.checks) if (!check.passed) console.error(`  - ${check.check_name}: ${check.detail}`);
    process.exitCode = 1;
    return;
  }

  const resolvedOutDir = path.resolve(process.cwd(), outDir);
  await mkdir(resolvedOutDir, { recursive: true });
  await writeFile(path.join(resolvedOutDir, "hcx-structured-protocol-comparison-report.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`HCX structured protocol comparison: selection status=${report.selection.status} selected=${report.selection.selected_candidate ?? "none"}`);
  console.log(`HCX structured protocol comparison: total_requests_attempted=${report.total_requests_attempted}`);
  console.log(`HCX structured protocol comparison: report written to ${resolvedOutDir}`);
}

main().catch((error) => {
  console.error(`HCX structured protocol comparison: unexpected failure: ${error?.name ?? "Error"}`);
  process.exitCode = 1;
});
