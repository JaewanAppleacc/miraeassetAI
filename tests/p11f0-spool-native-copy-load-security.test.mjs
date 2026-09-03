// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section H/P: regression tests for
// three findings from an automated security review of the native-COPY
// loader -- path traversal / command injection via a manifest-supplied
// shard filename, and credential exposure via passing DATABASE_URL as a
// bare psql CLI argument (visible to any local user via `ps`/`ps aux`).
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeShardFilename, SAFE_SHARD_FILENAME, parsePgConnectionParts,
} from "../scripts/p11f0-spool-native-copy-load.mjs";

test("assertSafeShardFilename accepts well-formed canonical/chunk shard filenames", () => {
  assert.doesNotThrow(() => assertSafeShardFilename("canonical-000000.copy"));
  assert.doesNotThrow(() => assertSafeShardFilename("chunk-000265.copy"));
});

test("assertSafeShardFilename rejects path traversal (../) -- a manifest cannot point outside the spool directory", () => {
  assert.throws(() => assertSafeShardFilename("../../../etc/passwd"), /UNSAFE_SHARD_FILENAME/);
  assert.throws(() => assertSafeShardFilename("canonical-000000.copy/../../secret"), /UNSAFE_SHARD_FILENAME/);
  assert.throws(() => assertSafeShardFilename("/etc/passwd"), /UNSAFE_SHARD_FILENAME/);
});

test("assertSafeShardFilename rejects a filename containing a single quote or backslash -- cannot break out of the psql \\copy ... FROM '<path>' literal", () => {
  assert.throws(() => assertSafeShardFilename("canonical-000000.copy'; DROP TABLE x; --"), /UNSAFE_SHARD_FILENAME/);
  assert.throws(() => assertSafeShardFilename("canonical-000000.copy\\'; \\! rm -rf /"), /UNSAFE_SHARD_FILENAME/);
});

test("assertSafeShardFilename rejects anything not matching the exact <canonical|chunk>-NNNNNN.copy shape", () => {
  assert.throws(() => assertSafeShardFilename(""));
  assert.throws(() => assertSafeShardFilename("canonical-1.copy")); // wrong digit count
  assert.throws(() => assertSafeShardFilename("other-000000.copy")); // wrong prefix
  assert.throws(() => assertSafeShardFilename("canonical-000000.txt")); // wrong extension
});

test("SAFE_SHARD_FILENAME pattern is anchored (^...$), not just a substring match", () => {
  assert.equal(SAFE_SHARD_FILENAME.test("xcanonical-000000.copy"), false);
  assert.equal(SAFE_SHARD_FILENAME.test("canonical-000000.copyx"), false);
});

test("parsePgConnectionParts extracts host/port/user/database and separates out the password", () => {
  const parts = parsePgConnectionParts("postgresql://myuser:s3cret@127.0.0.1:55329/p11f0_scratch");
  assert.equal(parts.host, "127.0.0.1");
  assert.equal(parts.port, "55329");
  assert.equal(parts.user, "myuser");
  assert.equal(parts.password, "s3cret");
  assert.equal(parts.database, "p11f0_scratch");
});

test("parsePgConnectionParts handles a connection string with no password (trust/peer auth) without throwing", () => {
  const parts = parsePgConnectionParts("postgresql://jaewan@localhost:5432/scratch_repro");
  assert.equal(parts.user, "jaewan");
  assert.equal(parts.password, undefined);
});

test("parsePgConnectionParts URL-decodes a password containing special characters", () => {
  const parts = parsePgConnectionParts("postgresql://user:p%40ss%2Fw0rd@host:5432/db");
  assert.equal(parts.password, "p@ss/w0rd");
});

test("parsePgConnectionParts rejects a non-postgresql:// scheme", () => {
  assert.throws(() => parsePgConnectionParts("mysql://user:pass@host:3306/db"), /postgresql:\/\//);
});
