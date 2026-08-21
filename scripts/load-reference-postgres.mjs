import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyReferenceReleaseMigration, importReferenceRelease } from "../domain/postgres/reference-release-loader.mjs";

const { Client } = pg;
// Resolved from this file's own location, never process.cwd() -- so
// `node scripts/load-reference-postgres.mjs` behaves identically no
// matter which directory the caller happens to invoke it from.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function loadSeedV020ReferenceDatabase({ connectionString = process.env.DATABASE_URL } = {}) {
  if (typeof connectionString !== "string" || connectionString === "") {
    throw new Error("DATABASE_URL is required; no implicit local or production database is selected");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await applyReferenceReleaseMigration({ client, root });
    return await importReferenceRelease({
      client,
      root,
      bundleDir: path.join(root, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
      bundleManifestPath: path.join(root, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
      finalManifestPath: path.join(root, "domain/releases/seed-release.v0.20.manifest.json"),
      finalDecisionPath: path.join(root, "domain/releases/seed-release.v0.20.decision.json"),
      expectedReleaseId: "seed-release-v0.20",
      expectedApprovedRevision: "seed-structured-artifacts-v0.7",
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  loadSeedV020ReferenceDatabase()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify({ status: "FAILED", error: error.message }, null, 2));
      process.exitCode = 1;
    });
}
