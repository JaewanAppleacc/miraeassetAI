#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runHarness } from "../domain/evaluation-harness/harness-runner.mjs";

const configPath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("Usage: node scripts/run-evaluation-harness.mjs <config.json>");
  process.exit(2);
}

try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const base = process.cwd();
  for (const key of ["gold_path", "result_path", "summary_path", "ledger_path", "lifecycle_path"]) {
    if (config[key]) config[key] = resolve(base, config[key]);
  }
  // Secret headers are read only from environment variables named
  // <headers_env_prefix><HEADER_NAME> (underscores become dashes), never
  // from a literal `headers` block in the config file itself — the config
  // file is not a safe place to store credentials, and this keeps them out
  // of any copy of the config that gets checked in or logged.
  const prefix = config.headers_env_prefix;
  if (prefix) {
    config.headers = Object.fromEntries(
      Object.entries(process.env)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length).replaceAll("_", "-"), value])
    );
  }
  const { summary } = await runHarness(config);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
