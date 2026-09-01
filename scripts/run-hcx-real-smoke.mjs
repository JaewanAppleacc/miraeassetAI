#!/usr/bin/env node
// Turn P11-B: executes the bounded real HyperCLOVA X protocol smoke and
// writes the four required artifacts. Fails closed (0 real calls) whenever
// HCX_API_KEY / HCX_ENDPOINT_URL / HCX_MODEL_ID are not all present in the
// environment. Never prints a secret value; never prints a raw prompt or
// raw provider response body to stdout.
//
// Usage: node scripts/run-hcx-real-smoke.mjs [--out <dir>]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadHcxRealSmokeConfig } from "../domain/agent-comparison/hcx-real-smoke/config.mjs";
import { runHcxRealSmoke } from "../domain/agent-comparison/hcx-real-smoke/runner.mjs";
import { buildAllArtifacts } from "../domain/agent-comparison/hcx-real-smoke/artifacts.mjs";
import {
  validateHcxRealSmokeConfig, validateHcxRealSmokeResult,
  validateHcxRealSmokeSecurityAttestation, validateHcxRealSmokeGateStatus,
} from "../domain/agent-comparison/hcx-real-smoke/contracts.mjs";

function parseArgs(argv) {
  const out = { outDir: "domain/agent-comparison/hcx-real-smoke/reports" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out.outDir = argv[i + 1];
  }
  return out;
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const loaded = loadHcxRealSmokeConfig();

  console.log(`HCX real smoke: ready=${loaded.ready}${loaded.ready ? "" : ` missing=[${loaded.missing.join(", ")}]`}`);

  const runResult = await runHcxRealSmoke(loaded);
  const { configArtifact, resultArtifact, gateStatusArtifact, securityAttestation } = buildAllArtifacts(loaded, runResult);

  const schemaErrors = [
    ...validateHcxRealSmokeConfig(configArtifact).map((e) => `config: ${e}`),
    ...validateHcxRealSmokeResult(resultArtifact).map((e) => `result: ${e}`),
    ...validateHcxRealSmokeGateStatus(gateStatusArtifact).map((e) => `gate-status: ${e}`),
    ...validateHcxRealSmokeSecurityAttestation(securityAttestation).map((e) => `security-attestation: ${e}`),
  ];
  if (schemaErrors.length > 0) {
    console.error("HCX real smoke: one or more artifacts failed schema validation:");
    for (const error of schemaErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  if (securityAttestation.overall_status !== "PASS") {
    console.error("HCX real smoke: security attestation FAILED -- refusing to write artifacts.");
    for (const check of securityAttestation.checks) if (!check.passed) console.error(`  - ${check.check_name}: ${check.detail}`);
    process.exitCode = 1;
    return;
  }

  const resolvedOutDir = path.resolve(process.cwd(), outDir);
  await mkdir(resolvedOutDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(resolvedOutDir, "hcx-real-smoke-config.redacted.v0.1.json"), `${JSON.stringify(configArtifact, null, 2)}\n`, "utf8"),
    writeFile(path.join(resolvedOutDir, "hcx-real-smoke-result.v0.1.json"), `${JSON.stringify(resultArtifact, null, 2)}\n`, "utf8"),
    writeFile(path.join(resolvedOutDir, "hcx-real-smoke-security-attestation.v0.1.json"), `${JSON.stringify(securityAttestation, null, 2)}\n`, "utf8"),
    writeFile(path.join(resolvedOutDir, "hcx-real-smoke-gate-status.v0.1.json"), `${JSON.stringify(gateStatusArtifact, null, 2)}\n`, "utf8"),
  ]);

  console.log(`HCX real smoke: gate_status=${gateStatusArtifact.gate_status}`);
  console.log(`HCX real smoke: requests_attempted=${resultArtifact.requests_attempted} succeeded=${resultArtifact.requests_succeeded} failed=${resultArtifact.requests_failed} retries=${resultArtifact.retries_performed}`);
  console.log(`HCX real smoke: artifacts written to ${resolvedOutDir}`);
}

main().catch((error) => {
  // Never print error.message raw if it might carry secret-adjacent detail
  // -- this top-level catch is only for genuinely unexpected bugs in this
  // script itself (every real HCX call failure is already caught and
  // reported safely inside runner.mjs).
  console.error(`HCX real smoke: unexpected failure: ${error?.name ?? "Error"}`);
  process.exitCode = 1;
});
