// Turn L2 item 2/3/7 (CANDIDATE tier): proves the REAL, already-built v0.20
// CANDIDATE bundle (domain/releases/bundles/seed-release-v0.20/ -- see
// scripts/build-seed-release-v020-candidate-bundle.mjs) is portable: a
// byte-for-byte copy of it, unpacked in an isolated directory alongside a
// pragmatic copy of the current source tree, boots the real
// configuredSeedRuntime + HTTP agent server and serves correctly.
//
// This test is explicitly CANDIDATE-tier, not a clean-clone proof:
// - It runs against the CURRENT (possibly dirty/uncommitted) working
//   tree via `git ls-files --cached --others --exclude-standard` -- a
//   pragmatic "everything eligible to be tracked" listing, NOT evidence
//   that `git clone` would reproduce this. That claim belongs ONLY to
//   tests/seed-release-isolated-deployment-official-clean-clone.test.mjs,
//   which uses `git archive HEAD` and is BLOCKED_BY_UNCOMMITTED_SOURCE
//   until the relevant implementation files are actually committed.
// - node_modules is a small HAND-PICKED subset (ajv/ajv-formats + their
//   own transitive deps), copied locally -- never `npm install`. This is
//   explicitly a smoke-test convenience (Turn L2 item 4), not a proof
//   that `npm ci` against package.json/package-lock.json succeeds.
// release_eligible is always false for this tier -- see the summary test
// at the bottom.
//
// The bundle itself is NEVER rebuilt here (Turn L2 item 2's fix -- the
// old version of this file called buildReleaseBundle() against
// work/domain-seed directly, which meant the isolated test was proving
// portability of a bundle it had just re-synthesized from the developer's
// own workspace, not the actual candidate artifact anyone would ship).
// This version copies domain/releases/bundles/seed-release-v0.20/
// byte-for-byte and independently re-hashes bundle-manifest.json plus
// every entry's encoded bytes before AND after the copy.
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
const REAL_BUNDLE_DIR = path.join(ROOT, "domain/releases/bundles/seed-release-v0.20");
const PORT = Number(process.env.SEED_ISOLATED_CANDIDATE_PORT ?? 8799);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

const NODE_MODULES_SUBSET = Object.freeze(["ajv", "ajv-formats", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"]);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// Explicit source allowlist (Turn L2 item 3A: "명시적인 source allowlist")
// -- NOT `git ls-files`. Two independent reasons this is the right tool
// here, not just a style preference: (1) `git ls-files --cached --others
// --exclude-standard` is exactly the pattern Turn L2 item 3 says must
// never be treated as "git clone reproduction" evidence -- an explicit
// allowlist makes that distinction structural, not just a comment; (2) a
// git-eligible-files listing is NOT scoped to this project at all -- this
// workspace happens to contain an unrelated, non-gitignored scratch
// directory ("무제 폴더 2/", including a nested git repository under it)
// that has nothing to do with the Disclosure Analyst runtime, and a
// blanket git-ls-files copy would pull it in. The allowlist below is
// exactly what scripts/start-agent-server.mjs transitively needs:
// domain/ (Runtime Host + Shared Services + generated ajv validators),
// scripts/ (the entry point itself), and the two root manifest files.
// domain/releases/bundles/ is deliberately EXCLUDED here -- the bundle
// arrives exclusively via the byte-for-byte bundle copy + unpack steps
// below, never via this generic source copy.
const SOURCE_ALLOWLIST_DIRS = Object.freeze(["domain", "scripts"]);
const SOURCE_ALLOWLIST_FILES = Object.freeze(["package.json", "package-lock.json"]);
const SOURCE_EXCLUDE_DIRS = Object.freeze([path.join("domain", "releases", "bundles")]);

async function listAllowlistedFiles() {
  const files = [];
  for (const relFile of SOURCE_ALLOWLIST_FILES) {
    files.push(relFile);
  }
  for (const relDir of SOURCE_ALLOWLIST_DIRS) {
    await collectFilesUnder(path.join(ROOT, relDir), ROOT, files);
  }
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
  // 0. The real candidate bundle must already exist -- this test never
  // builds it (see scripts/build-seed-release-v020-candidate-bundle.mjs).
  const before = await hashRealBundleEntries();

  const realTmp = await realpath(os.tmpdir());
  isolatedRoot = await mkdtemp(path.join(realTmp, "seed-isolated-candidate-"));

  // 1. Byte-for-byte copy of the REAL bundle (never re-derived) into a
  // staging location inside the isolated root, then re-hash the COPY and
  // compare against the pre-copy hashes -- this is the explicit
  // before/after integrity proof Turn L2 item 2 requires.
  bundleCopyDir = path.join(isolatedRoot, "_bundle_copy", "seed-release-v0.20");
  await mkdir(path.dirname(bundleCopyDir), { recursive: true });
  await cp(REAL_BUNDLE_DIR, bundleCopyDir, { recursive: true, dereference: true });
  const afterManifestBytes = await readFile(path.join(bundleCopyDir, "bundle-manifest.json"));
  const afterManifest = JSON.parse(afterManifestBytes.toString("utf8"));
  assert.equal(sha256(afterManifestBytes), before.manifestSha256, "copied bundle-manifest.json sha256 must match the real bundle's");
  for (const entry of afterManifest.entries) {
    const copiedBytes = await readFile(path.join(bundleCopyDir, entry.bundle_path));
    assert.equal(sha256(copiedBytes), before.entryHashes[entry.bundle_path], `copied ${entry.bundle_path} sha256 must match the real bundle's`);
  }

  // 2. Explicit-allowlist source copy (NOT a clean-clone proof -- see
  // this file's header) + a small node_modules subset (never `npm install`).
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

  // 3. Unpack the COPIED bundle (not the original) into the isolated
  // tree at its original relative paths -- this is the ONLY source of
  // every work/domain-seed/* file the isolated tree ends up with (step 2
  // copies zero files under work/, which is gitignored).
  await unpackReleaseBundle({ bundleDir: bundleCopyDir, destRoot: isolatedRoot });

  // 4. Spawn the v0.2 config-injection server (scripts/start-agent-server-v020-candidate.mjs
  // -- see that file's header for why this is NOT scripts/start-agent-server.mjs:
  // the production singleton still hardcodes v0.1 Company Directory paths,
  // and this bundle ships only v0.2). cwd=isolated tree, no SEED_* env
  // vars except SEED_RUNTIME_ROOT is intentionally left UNSET so the
  // script's own cwd-relative default resolves it to the isolated root.
  child = spawn(process.execPath, [path.join(isolatedRoot, "scripts/start-agent-server-v020-candidate.mjs")], {
    cwd: isolatedRoot,
    env: { PATH: process.env.PATH, PORT: String(PORT), AGENT_HOST: HOST },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrLog = "";
  child.stderr.on("data", (chunk) => { stderrLog += chunk.toString(); });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.error(`isolated candidate server exited early (code=${code}, signal=${signal}):\n${stderrLog}`);
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

test("this bundle contains v0.2 Company Directory artifacts (v0.1 is audit history only, not used here)", async () => {
  const manifest = JSON.parse(await readFile(path.join(REAL_BUNDLE_DIR, "bundle-manifest.json"), "utf8"));
  const companyEntry = manifest.entries.find((e) => e.role === "COMPANY_DIRECTORY");
  assert.ok(companyEntry, "expected a COMPANY_DIRECTORY entry in the bundle");
  assert.match(companyEntry.source_path, /seed-company-directory\.v0\.2\.approved\.jsonl$/);
});

test("GET /ready succeeds from the isolated candidate deployment", async () => {
  const response = await fetch(`${BASE_URL}/ready`);
  assert.equal(response.status, 200);
});

test("GET /answer for a real Seed question passes the Wire contract from the isolated candidate deployment", async () => {
  const gold = (await readFile(path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const record = gold.find((r) => r.question_id === "question_seed_v07_13");
  const url = new URL("/answer", BASE_URL);
  url.searchParams.set("question_id", record.question_id);
  url.searchParams.set("question", record.question);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  const wire = await response.json();
  assert.deepEqual(validateAnswerWireResponse(wire), []);
  assert.equal(wire.question_id, record.question_id);
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
