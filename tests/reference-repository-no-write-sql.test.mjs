// Turn N2 item 4 ("읽기 전용 경계"): a static text check that the two new
// read-only Repository/Adapter modules never contain write or DDL SQL
// keywords. migration (002_reference_release.sql) and the loader
// (reference-release-loader.mjs / reference-release-contract.mjs) are
// explicitly EXEMPT -- they legitimately write -- this check is scoped only
// to the files this Turn adds.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const READ_ONLY_FILES = Object.freeze([
  "domain/postgres/reference-repository.mjs",
  "domain/postgres/reference-runtime-adapters.mjs",
]);

// Matched as SQL keywords at a statement boundary (start-of-string or
// preceded by whitespace/quote/backtick), case-insensitive -- avoids
// false positives on ordinary English prose containing these words inside
// comments (e.g. this file's own header above uses "write"/"DDL" but never
// as a SQL keyword token).
const FORBIDDEN_SQL_PATTERNS = Object.freeze([
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+disclosure_reference\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bDROP\s+(TABLE|SCHEMA|ROLE|VIEW|TYPE)\b/i,
  /\bCREATE\s+(TABLE|SCHEMA|ROLE|VIEW|TYPE|TRIGGER|FUNCTION|INDEX)\b/i,
  /\bGRANT\s+/i,
]);

test("Turn N2 read-only Repository/Adapter modules contain no write or DDL SQL", async () => {
  for (const relativePath of READ_ONLY_FILES) {
    const fullText = await readFile(path.join(ROOT, relativePath), "utf8");
    // Scanned with `//` comment lines stripped -- this file's OWN header
    // comments name the forbidden keywords in prose (documenting the
    // invariant), which must not itself trip the check. Only actual code
    // (including every SQL template literal, which is real code, never a
    // comment) is scanned for the forbidden keywords.
    const text = fullText.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    for (const pattern of FORBIDDEN_SQL_PATTERNS) {
      assert.doesNotMatch(text, pattern, `${relativePath} must never contain ${pattern} -- this module is read-only`);
    }
    // reference-repository.mjs is the only file that issues SQL directly;
    // reference-runtime-adapters.mjs only ever calls repository methods, so
    // it legitimately contains zero SQL template literals of its own.
    // Every SQL statement it (or any read-only module) issues must be a
    // SELECT.
    const sqlLiterals = [...text.matchAll(/`([^`]*SELECT[^`]*)`/gis)];
    if (relativePath.endsWith("reference-repository.mjs")) {
      assert.ok(sqlLiterals.length > 0, `${relativePath}: expected at least one SELECT statement literal`);
    }
    for (const [, sql] of sqlLiterals) {
      assert.match(sql.trim(), /^SELECT\b/i, `${relativePath}: every SQL template literal must start with SELECT (found: ${sql})`);
    }
  }
});
