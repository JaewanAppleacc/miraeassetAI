// Turn P5.2: mirrors tests/reference-vector-retrieval-repository-no-write-sql.test.mjs
// exactly, scoped to the new dedup search repository. This module (unlike
// the loader/grants, which legitimately write) must never contain write or
// DDL SQL -- every statement it issues is a read-only SELECT or WITH...SELECT.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const READ_ONLY_FILE = "domain/postgres/reference-dedup-retrieval-repository.mjs";

const FORBIDDEN_SQL_PATTERNS = Object.freeze([
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+disclosure_reference\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bDROP\s+(TABLE|SCHEMA|ROLE|VIEW|TYPE)\b/i,
  /\bCREATE\s+(TABLE|SCHEMA|ROLE|VIEW|TYPE|TRIGGER|FUNCTION|INDEX)\b/i,
  /\bGRANT\s+/i,
]);

test("Turn P5.2 dedup retrieval repository contains no write or DDL SQL -- every SQL template literal is a SELECT or a read-only WITH...SELECT", async () => {
  const fullText = await readFile(path.join(ROOT, READ_ONLY_FILE), "utf8");
  const text = fullText.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const pattern of FORBIDDEN_SQL_PATTERNS) {
    assert.doesNotMatch(text, pattern, `${READ_ONLY_FILE} must never contain ${pattern} -- this module is read-only`);
  }
  const sqlLiterals = [...text.matchAll(/`([^`]*(?:SELECT|WITH)[^`]*)`/gis)];
  assert.ok(sqlLiterals.length > 0, `${READ_ONLY_FILE}: expected at least one SELECT/WITH statement literal`);
  for (const [, sql] of sqlLiterals) {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/i, `${READ_ONLY_FILE}: every SQL template literal must start with SELECT or WITH (found: ${sql})`);
  }
});
