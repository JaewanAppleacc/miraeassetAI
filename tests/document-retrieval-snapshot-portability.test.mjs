import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPortableRelativePath, PortabilityError } from "../domain/agent-comparison/retrieval/document-snapshot/contracts.mjs";
import { buildDocumentRetrievalSnapshot, SnapshotBuildError } from "../domain/agent-comparison/retrieval/document-snapshot/build-snapshot.mjs";

test("assertPortableRelativePath rejects absolute unix paths", () => {
  assert.throws(() => assertPortableRelativePath("/etc/passwd"), PortabilityError);
});

test("assertPortableRelativePath rejects windows drive-letter absolute paths", () => {
  assert.throws(() => assertPortableRelativePath("C:\\Windows\\System32"), PortabilityError);
});

test("assertPortableRelativePath rejects '..' segments", () => {
  assert.throws(() => assertPortableRelativePath("a/../../etc/passwd"), PortabilityError);
  assert.throws(() => assertPortableRelativePath("../sibling"), PortabilityError);
});

test("assertPortableRelativePath rejects home-directory references", () => {
  assert.throws(() => assertPortableRelativePath("~/secrets.txt"), PortabilityError);
});

test("assertPortableRelativePath accepts an ordinary relative path", () => {
  assert.equal(assertPortableRelativePath("periodic_20250101000001/file.xml#node=0"), "periodic_20250101000001/file.xml#node=0");
});

test("assertPortableRelativePath rejects empty/non-string input", () => {
  assert.throws(() => assertPortableRelativePath(""), PortabilityError);
  assert.throws(() => assertPortableRelativePath(null), PortabilityError);
});

// End-to-end: a raw record whose source_files[].rel_path is an absolute
// path (a malicious or malformed A-side parser output) must fail-closed
// the WHOLE build, and must leave zero final artifacts behind -- proving
// the portability guard is wired into build-snapshot.mjs, not just
// available as an unused helper.
test("build-snapshot fails closed on a non-portable path and leaves zero final files", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "p5-portability-"));
  try {
    await mkdir(join(scratch, "source"), { recursive: true });
    const record = {
      doc_id: "exchange_20250101000099",
      schema_version: "1.0", parser_version: "1.0.0", corpus_snapshot_id: "snap_test",
      source_files: [{ rel_path: "/etc/passwd", is_attachment: false, content_format: "kind_html", content_sha256: "0".repeat(64), declared_encoding: "utf-8", actual_encoding_used: "utf-8" }],
      nodes: [{ kind: "paragraph", node_id: "exchange_20250101000099::etc::n0", section_hierarchy: [], source: { rel_path: "/etc/passwd", order_index: 0 }, text: "some text here" }],
      warnings: [], parse_quality: { tier: "structured" },
    };
    const jsonl = `${JSON.stringify(record)}\n`;
    await writeFile(join(scratch, "source/exchange.jsonl"), jsonl);
    await writeFile(join(scratch, "source/holding.jsonl"), "");
    await writeFile(join(scratch, "source/major.jsonl"), "");
    await writeFile(join(scratch, "source/periodic-001.jsonl"), "");
    const sha256 = (await import("node:crypto")).createHash("sha256").update(jsonl).digest("hex");
    await writeFile(join(scratch, "inventory.json"), JSON.stringify({
      files: [
        { file_name: "exchange.jsonl", bytes: jsonl.length, lines: 1, sha256 },
        { file_name: "holding.jsonl", bytes: 0, lines: 0, sha256: (await import("node:crypto")).createHash("sha256").update("").digest("hex") },
        { file_name: "major.jsonl", bytes: 0, lines: 0, sha256: (await import("node:crypto")).createHash("sha256").update("").digest("hex") },
        { file_name: "periodic-001.jsonl", bytes: 0, lines: 0, sha256: (await import("node:crypto")).createHash("sha256").update("").digest("hex") },
      ],
    }));
    await writeFile(join(scratch, "manifest.jsonl"), `${JSON.stringify({ doc_id: "exchange_20250101000099", corp_code: "00000009", doc_group: "exchange", doc_subtype: "test", report_nm: "test", is_correction: false, rcept_no: "20250101000099", rcept_dt: "20250101", base_year: null, base_month: null })}\n`);

    await assert.rejects(
      () => buildDocumentRetrievalSnapshot({
        inventoryPath: join(scratch, "inventory.json"),
        sourceDir: join(scratch, "source"),
        manifestPath: join(scratch, "manifest.jsonl"),
        outputDir: join(scratch, "output"),
      }),
      /portable|absolute/i,
    );

    // The writer's mkdir(dirname(...)) may leave an empty output directory
    // behind, but no FINAL artifact filename (and no leftover .tmp-* file)
    // may exist in it -- a failed build must never leave a partial or
    // misleadingly-complete snapshot on disk.
    const { readdir } = await import("node:fs/promises");
    let entries = [];
    try {
      entries = await readdir(join(scratch, "output"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.deepEqual(entries, [], `expected zero files in the output dir after a failed build, found: ${JSON.stringify(entries)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// Symlink/path-escape defense: even though this Turn's real sourceDir is
// itself reached through a symlink (work/a-document-ir/source ->
// Downloads/..., a deliberate local convenience, never committed), no path
// VALUE this module ever writes into a snapshot artifact may itself point
// through a symlink to outside the corpus root. This test constructs a
// rel_path that traverses a symlink pointing outside the source directory
// and confirms assertPortableRelativePath's ".." rejection also covers the
// traversal segment a symlink-escape attempt would need.
test("a rel_path attempting to traverse out of the source root via '..' is rejected even if a symlink exists at that name", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "p5-symlink-escape-"));
  try {
    const outsideDir = join(scratch, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.xml"), "secret");
    await mkdir(join(scratch, "source"), { recursive: true });
    await symlink(outsideDir, join(scratch, "source", "escape-link"));

    assert.throws(() => assertPortableRelativePath("escape-link/../../outside/secret.xml"), PortabilityError);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
