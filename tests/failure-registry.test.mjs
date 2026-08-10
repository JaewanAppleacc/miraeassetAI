import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { REJECTION_CODES } from "../domain/runtime/agent-runtime.mjs";

// Guards the 3-tier failure code architecture documented in
// agent-runtime.mjs above REJECTION_CODES. Unlike importing a hand-picked
// list of *_CODES arrays (which only re-checks modules someone remembered
// to wire up), this scans domain/runtime/*.mjs itself for every exported
// array whose name ends in `_CODES` — a new sibling module is discovered
// automatically, so forgetting to merge its codes into REJECTION_CODES is
// a real, self-updating test failure rather than a silent gap.
//
// `REJECTION_CODES` itself is excluded from the discovered set: it is the
// union output, not a per-service source array.

const RUNTIME_DIR = fileURLToPath(new URL("../domain/runtime/", import.meta.url));

async function discoverCodeSources() {
  const files = readdirSync(RUNTIME_DIR).filter((name) => name.endsWith(".mjs"));
  const sources = [];
  for (const file of files) {
    const moduleUrl = pathToFileURL(`${RUNTIME_DIR}${file}`).href;
    const exported = await import(moduleUrl);
    for (const [name, value] of Object.entries(exported)) {
      if (name === "REJECTION_CODES") continue;
      if (!name.endsWith("_CODES")) continue;
      if (!Array.isArray(value)) continue;
      sources.push({ file, name, codes: value });
    }
  }
  return sources;
}

test("REJECTION_CODES is frozen", () => {
  assert.equal(Object.isFrozen(REJECTION_CODES), true);
});

test("at least the known code-source modules are discovered (sanity check on the scan itself)", async () => {
  const sources = await discoverCodeSources();
  const labels = sources.map((s) => `${s.file}:${s.name}`);
  for (const expected of [
    "agent-runtime.mjs:LOCAL_REJECTION_CODES",
    "citation-validator.mjs:CITATION_CODES",
    "fact-store.mjs:FACT_STORE_CODES",
    "policy-guard.mjs:POLICY_GUARD_CODES",
  ]) {
    assert.ok(labels.includes(expected), `expected to discover ${expected}, found: ${labels.join(", ")}`);
  }
});

test("every individual *_CODES source array has no internal duplicates (checked on the original array, before any Set dedup)", async () => {
  const sources = await discoverCodeSources();
  for (const { file, name, codes } of sources) {
    assert.equal(new Set(codes).size, codes.length, `${file}:${name} has a duplicate entry: ${JSON.stringify(codes)}`);
  }
});

// A handful of codes are deliberately reused across sibling *_CODES
// modules for the SAME meaning in a different subsystem — e.g. Evidence
// and Fact both have their own "not VERIFIED" boundary check, and naming
// both UNVERIFIED_DATA_FORBIDDEN is intentional, documented reuse (see the
// 3-tier architecture comment above REJECTION_CODES in agent-runtime.mjs),
// not a bug. Anything NOT on this list that still collides across modules
// is a suspected accidental conflict and fails the test below.
const ALLOWED_CROSS_MODULE_REUSE = new Set([
  "UNVERIFIED_DATA_FORBIDDEN", // citation-validator.mjs (Evidence) + fact-store.mjs (Fact): both mean "verification_status !== VERIFIED"
]);

test("no code name is reused across two different *_CODES source modules, except the documented, intentional reuse in ALLOWED_CROSS_MODULE_REUSE", async () => {
  const sources = await discoverCodeSources();
  const owners = new Map(); // code -> [ "file:name", ... ]
  for (const { file, name, codes } of sources) {
    for (const code of codes) {
      const label = `${file}:${name}`;
      const existing = owners.get(code) ?? [];
      owners.set(code, [...existing, label]);
    }
  }
  const collisions = [...owners.entries()].filter(
    ([code, labels]) => labels.length > 1 && !ALLOWED_CROSS_MODULE_REUSE.has(code),
  );
  assert.deepEqual(collisions, [], `unexpected code(s) reused across modules: ${JSON.stringify(collisions)}`);
});

test("ALLOWED_CROSS_MODULE_REUSE does not list a code that turns out to be unique to one module (an allowlist entry that is no longer needed)", async () => {
  const sources = await discoverCodeSources();
  const owners = new Map();
  for (const { file, name, codes } of sources) {
    for (const code of codes) {
      const existing = owners.get(code) ?? [];
      owners.set(code, [...existing, `${file}:${name}`]);
    }
  }
  for (const code of ALLOWED_CROSS_MODULE_REUSE) {
    const labels = owners.get(code) ?? [];
    assert.ok(labels.length > 1, `${code} is allowlisted as cross-module reuse but only appears in: ${JSON.stringify(labels)}`);
  }
});

test("REJECTION_CODES is exactly the union of every discovered *_CODES source array — nothing missing, nothing extra", async () => {
  const sources = await discoverCodeSources();
  const expectedUnion = new Set(sources.flatMap((s) => s.codes));
  const actualUnion = new Set(REJECTION_CODES);

  const missingFromRejectionCodes = [...expectedUnion].filter((code) => !actualUnion.has(code));
  const extraInRejectionCodes = [...actualUnion].filter((code) => !expectedUnion.has(code));

  assert.deepEqual(missingFromRejectionCodes, [], "a source module's code(s) never made it into REJECTION_CODES");
  assert.deepEqual(extraInRejectionCodes, [], "REJECTION_CODES contains code(s) no discovered source module declares");
});

test("REJECTION_CODES is a non-empty array of non-empty strings", () => {
  assert.ok(Array.isArray(REJECTION_CODES));
  assert.ok(REJECTION_CODES.length > 0);
  for (const code of REJECTION_CODES) {
    assert.equal(typeof code, "string");
    assert.ok(code.length > 0);
  }
});
