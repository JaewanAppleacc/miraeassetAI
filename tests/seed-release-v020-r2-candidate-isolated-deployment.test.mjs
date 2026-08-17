// Turn M8 Section 12: proves the REAL, already-built v0.20-r2.candidate
// bundle (domain/releases/bundles/seed-release-v0.20-r2.candidate/ --
// see scripts/build-seed-release-v020-r2-candidate.mjs) is portable, by
// the exact same method tests/seed-release-isolated-deployment-candidate.test.mjs
// already uses for the Turn L2 v0.20 bundle: byte-for-byte copy, unpack
// into an isolated tree alongside an explicit-allowlist source copy,
// boot the real Runtime + HTTP agent server, and serve correctly.
//
// This is a SEPARATE bundle/test pair, not a modification of the
// existing v0.20 candidate test (which stays pointed at the Turn L2
// bundle, untouched this Turn). Same CANDIDATE-tier caveats apply: this
// is not a clean-clone proof (see
// tests/seed-release-isolated-deployment-official-clean-clone.test.mjs
// for that, separately BLOCKED_BY_UNCOMMITTED_SOURCE this Turn).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateAnswerWireResponse } from "../domain/runtime/answer-wire-response.mjs";
import { unpackReleaseBundle } from "../domain/adapters/seed-release-bundle-unpack.mjs";
import { waitForReady, lsofRows, grepForHardcodedPath } from "./lib/isolated-deployment-helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_REVISION = process.env.SEED_V020_CANDIDATE_REVISION === "r2" ? "r2" : "r3";
const PLAN_REVISION = CANDIDATE_REVISION === "r3" ? "v0.13" : "v0.12";
const REAL_BUNDLE_DIR = path.join(ROOT, `domain/releases/bundles/seed-release-v0.20-${CANDIDATE_REVISION}.candidate`);
const PORT = Number(process.env.SEED_ISOLATED_V020R2_CANDIDATE_PORT ?? (CANDIDATE_REVISION === "r3" ? 8804 : 8803));
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

const NODE_MODULES_SUBSET = Object.freeze(["ajv", "ajv-formats", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"]);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const SOURCE_ALLOWLIST_DIRS = Object.freeze(["domain", "scripts"]);
const SOURCE_ALLOWLIST_FILES = Object.freeze(["package.json", "package-lock.json"]);
const SOURCE_EXCLUDE_DIRS = Object.freeze([path.join("domain", "releases", "bundles")]);

async function listAllowlistedFiles() {
  const files = [];
  for (const relFile of SOURCE_ALLOWLIST_FILES) files.push(relFile);
  for (const relDir of SOURCE_ALLOWLIST_DIRS) await collectFilesUnder(path.join(ROOT, relDir), ROOT, files);
  return files;
}

async function collectFilesUnder(absDir, base, out) {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = path.relative(base, abs);
    if (SOURCE_EXCLUDE_DIRS.some((excluded) => rel === excluded || rel.startsWith(`${excluded}${path.sep}`))) continue;
    if (entry.isDirectory()) await collectFilesUnder(abs, base, out);
    else if (entry.isFile()) out.push(rel);
  }
}

async function hashRealBundleEntries() {
  const manifest = JSON.parse(await readFile(path.join(REAL_BUNDLE_DIR, "bundle-manifest.json"), "utf8"));
  const manifestSha256 = sha256(await readFile(path.join(REAL_BUNDLE_DIR, "bundle-manifest.json")));
  const entryHashes = {};
  for (const entry of manifest.entries) {
    const bytes = await readFile(path.join(REAL_BUNDLE_DIR, entry.bundle_path));
    entryHashes[entry.bundle_path] = sha256(bytes);
  }
  return { manifestSha256, entryHashes, manifest };
}

let isolatedRoot; let child; let bundleCopyDir;

test.before(async () => {
  const before = await hashRealBundleEntries();

  const realTmp = await realpath(os.tmpdir());
  isolatedRoot = await mkdtemp(path.join(realTmp, `seed-isolated-v020${CANDIDATE_REVISION}-candidate-`));

  bundleCopyDir = path.join(isolatedRoot, "_bundle_copy", `seed-release-v0.20-${CANDIDATE_REVISION}.candidate`);
  await mkdir(path.dirname(bundleCopyDir), { recursive: true });
  await cp(REAL_BUNDLE_DIR, bundleCopyDir, { recursive: true, dereference: true });
  const afterManifestBytes = await readFile(path.join(bundleCopyDir, "bundle-manifest.json"));
  const afterManifest = JSON.parse(afterManifestBytes.toString("utf8"));
  assert.equal(sha256(afterManifestBytes), before.manifestSha256, "copied bundle-manifest.json sha256 must match the real bundle's");
  for (const entry of afterManifest.entries) {
    const copiedBytes = await readFile(path.join(bundleCopyDir, entry.bundle_path));
    assert.equal(sha256(copiedBytes), before.entryHashes[entry.bundle_path], `copied ${entry.bundle_path} sha256 must match the real bundle's`);
  }

  const files = await listAllowlistedFiles();
  for (const relPath of files) {
    const src = path.join(ROOT, relPath);
    const dest = path.join(isolatedRoot, relPath);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(src, dest, { dereference: true });
  }
  for (const pkg of NODE_MODULES_SUBSET) {
    await cp(path.join(ROOT, "node_modules", pkg), path.join(isolatedRoot, "node_modules", pkg), { recursive: true, dereference: true });
  }

  await unpackReleaseBundle({ bundleDir: bundleCopyDir, destRoot: isolatedRoot });

  child = spawn(process.execPath, [path.join(isolatedRoot, "scripts/start-agent-server-v020-r2-candidate.mjs")], {
    cwd: isolatedRoot,
    env: { PATH: process.env.PATH, PORT: String(PORT), AGENT_HOST: HOST, SEED_V020_CANDIDATE_REVISION: CANDIDATE_REVISION },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrLog = "";
  child.stderr.on("data", (chunk) => { stderrLog += chunk.toString(); });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.error(`isolated v0.20-r2 candidate server exited early (code=${code}, signal=${signal}):\n${stderrLog}`);
  });
  await waitForReady(BASE_URL);
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 5_000); });
  }
  if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true });
});

test("bundle copy integrity was already proven in test.before (bundle-manifest + every encoded artifact sha256 match before/after copy)", () => {
  assert.ok(bundleCopyDir, "bundleCopyDir must have been set during setup");
});

test(`this bundle carries clean Plan ${PLAN_REVISION} on the v0.6 clean lineage`, async () => {
  const manifest = JSON.parse(await readFile(path.join(REAL_BUNDLE_DIR, "bundle-manifest.json"), "utf8"));
  const planEntry = manifest.entries.find((e) => e.role === "THIN_PLAN");
  assert.ok(planEntry, "expected a THIN_PLAN entry in the bundle");
  assert.equal(planEntry.source_path, `work/domain-seed/seed-thin-flow-plans.${PLAN_REVISION}.clean.candidate.jsonl`);
});

test("this bundle carries structured-artifacts v0.7 (Fact v0.8/Coverage v0.7/Evidence v0.9/merged Owner decision v0.10)", async () => {
  const manifest = JSON.parse(await readFile(path.join(REAL_BUNDLE_DIR, "bundle-manifest.json"), "utf8"));
  assert.equal(manifest.approved_revision, "seed-structured-artifacts-v0.7");
  const ownerDecisionEntry = manifest.entries.find((e) => e.role === "OWNER_DECISION");
  assert.match(ownerDecisionEntry.source_path, /seed-structured-owner-decision\.v0\.10\.jsonl$/);
});

test(`GET /ready succeeds from the isolated v0.20-${CANDIDATE_REVISION} candidate deployment`, async () => {
  const response = await fetch(`${BASE_URL}/ready`);
  assert.equal(response.status, 200);
});

test("GET /answer for Q18 (information_limits) passes the Wire contract and never claims 2,198,873,250 as 발행총액", async () => {
  const gold = (await readFile(path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const record = gold.find((r) => r.question_id === "question_seed_v07_18");
  const url = new URL("/answer", BASE_URL);
  url.searchParams.set("question_id", record.question_id);
  url.searchParams.set("question", record.question);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  const wire = await response.json();
  assert.deepEqual(validateAnswerWireResponse(wire), []);
  assert.equal(wire.question_id, record.question_id);
  assert.ok(wire.answer.includes("발행총액은 원문에서 직접 공시된 항목으로 확인되지 않습니다"));
  assert.doesNotMatch(wire.answer, /2,198,873,250\s*원(은|이)?\s*발행총액/);
});

test("all 25 Gold questions are served from the isolated bundle as schema-valid, non-empty Wire responses", async () => {
  const gold = (await readFile(path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(gold.length, 25);
  for (const record of gold) {
    const url = new URL("/answer", BASE_URL);
    url.searchParams.set("question_id", record.question_id);
    url.searchParams.set("question", record.question);
    const response = await fetch(url);
    assert.equal(response.status, 200, `${record.question_id}: HTTP status`);
    const wire = await response.json();
    assert.deepEqual(validateAnswerWireResponse(wire), [], `${record.question_id}: Wire schema`);
    assert.equal(wire.question_id, record.question_id);
    assert.equal(wire.question, record.question);
    assert.ok(wire.answer.trim().length > 0, `${record.question_id}: answer must be non-empty`);
  }
});

test("lsof: the isolated server's cwd is the isolated root (not the real workspace), and no still-open file descriptor resolves inside the real workspace", async () => {
  const rows = await lsofRows(child.pid);
  const cwdRow = rows.find((r) => r.fd === "cwd");
  assert.ok(cwdRow);
  assert.equal(cwdRow.name, isolatedRoot);
  assert.notEqual(cwdRow.name, ROOT);
  const leaks = rows.filter((r) => r.name.startsWith(`${ROOT}/`) || r.name === ROOT);
  assert.deepEqual(leaks, [], `isolated server has file(s) open inside the real workspace: ${JSON.stringify(leaks)}`);
});

test("static proof: no copied source file inside the isolated tree contains a hardcoded reference to the real workspace's absolute path", async () => {
  const matches = await grepForHardcodedPath(isolatedRoot, ROOT);
  assert.deepEqual(matches, []);
});

test("SUMMARY: this tier reports release_eligible=false and is NOT a clean-clone (git archive/clone) proof", () => {
  const summary = { tier: "CANDIDATE", release_eligible: false, clean_clone_verified: false };
  assert.equal(summary.release_eligible, false);
  assert.equal(summary.clean_clone_verified, false);
});
