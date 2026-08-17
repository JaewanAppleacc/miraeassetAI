// Deterministic gzip encode/decode for bundling large canonical artifacts
// (e.g. Canonical DocumentIR shards) without introducing non-reproducible
// bytes into a release bundle. Node's zlib.gzipSync already writes MTIME=0
// and no FNAME/FCOMMENT by default (verified empirically -- see this
// module's test file), so gzipDeterministic() below is a thin, fixed-level
// wrapper plus a defensive runtime assertion on the header bytes -- if a
// future Node/zlib version ever started embedding a real timestamp or
// filename, this would fail loudly instead of silently producing
// non-reproducible bundle bytes.
//
// gunzipSafe() is the paired decompression-bomb defense (Turn K item D):
// callers MUST supply explicit maxEncodedBytes/maxDecodedBytes/
// maxCompressionRatio -- there is no "unbounded" default. Decompression
// itself is capped via zlib's own maxOutputLength (throws before ever
// allocating an over-limit buffer, not after). Multi-member concatenation
// is REJECTED by default (allowConcatenatedGzipMembers = false): this
// module encodes with a single fixed level, so re-compressing the
// decoded output at that same level must reproduce the exact original
// encoded bytes if-and-only-if the input was one well-formed member with
// no trailing garbage -- any mismatch (extra member, trailing bytes,
// different level/header) is rejected. This reuses gzipDeterministic's
// own determinism rather than hand-parsing the gzip container.
import { gzipSync, gunzipSync } from "node:zlib";

const DEFAULT_LEVEL = 9;
const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;

function assertDeterministicHeader(encoded) {
  if (encoded.length < 10 || encoded[0] !== GZIP_ID1 || encoded[1] !== GZIP_ID2) {
    throw new Error("gzipDeterministic: output is not a valid gzip member (bad magic bytes)");
  }
  const flg = encoded[3];
  if (flg !== 0) {
    throw new Error(`gzipDeterministic: expected FLG=0 (no FNAME/FCOMMENT/FEXTRA/FHCRC), got ${flg} -- zlib behavior may have changed`);
  }
  const mtimeBytes = encoded.subarray(4, 8);
  if (!mtimeBytes.every((b) => b === 0)) {
    throw new Error(`gzipDeterministic: expected MTIME=0 in gzip header, got ${mtimeBytes.toString("hex")} -- zlib behavior may have changed`);
  }
}

// Buffer -> Buffer. Same input + same level ALWAYS produces byte-identical
// output (see tests/deterministic-gzip.test.mjs's two-independent-tempdir
// proof) -- level is fixed at DEFAULT_LEVEL unless a caller explicitly
// overrides it, and any caller that does must keep that same level for
// both encode and any later gunzipSafe() strict-single-member check.
export function gzipDeterministic(buffer, { level = DEFAULT_LEVEL } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error("gzipDeterministic: input must be a Buffer");
  const encoded = gzipSync(buffer, { level });
  assertDeterministicHeader(encoded);
  return encoded;
}

// Buffer -> { decoded: Buffer, encoded_bytes, decoded_bytes, compression_ratio, record_count? }.
// Fails closed (throws) on any bound violation, invalid gzip, or (default)
// multi-member/trailing-garbage input. Never allocates a decoded buffer
// larger than maxDecodedBytes -- zlib.gunzipSync's own maxOutputLength
// enforces this DURING decompression, not as an after-the-fact check.
export function gunzipSafe(encoded, {
  maxEncodedBytes,
  maxDecodedBytes,
  maxCompressionRatio,
  maxRecordCount,
  recordSeparator,
  allowConcatenatedGzipMembers = false,
  level = DEFAULT_LEVEL,
} = {}) {
  if (!Buffer.isBuffer(encoded)) throw new Error("gunzipSafe: input must be a Buffer");
  for (const [name, value] of Object.entries({ maxEncodedBytes, maxDecodedBytes, maxCompressionRatio })) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`gunzipSafe: options.${name} is required and must be a positive finite number`);
    }
  }
  if (encoded.length === 0) throw new Error("gunzipSafe: encoded input is empty");
  if (encoded.length > maxEncodedBytes) {
    throw new Error(`gunzipSafe: encoded size ${encoded.length} exceeds maxEncodedBytes ${maxEncodedBytes}`);
  }
  if (encoded[0] !== GZIP_ID1 || encoded[1] !== GZIP_ID2) {
    throw new Error("gunzipSafe: input is not a gzip member (bad magic bytes)");
  }

  let decoded;
  try {
    // maxOutputLength caps allocation DURING decompression -- a
    // high-compression-ratio "zip bomb" is rejected before its full
    // decoded size is ever materialized in memory.
    decoded = gunzipSync(encoded, { maxOutputLength: maxDecodedBytes });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`gunzipSafe: decoded size exceeds maxDecodedBytes ${maxDecodedBytes}`);
    }
    throw new Error(`gunzipSafe: invalid gzip input (${error.message})`);
  }

  if (decoded.length > maxDecodedBytes) {
    throw new Error(`gunzipSafe: decoded size ${decoded.length} exceeds maxDecodedBytes ${maxDecodedBytes}`);
  }
  const compressionRatio = decoded.length / encoded.length;
  if (compressionRatio > maxCompressionRatio) {
    throw new Error(`gunzipSafe: compression ratio ${compressionRatio.toFixed(1)} exceeds maxCompressionRatio ${maxCompressionRatio}`);
  }

  if (!allowConcatenatedGzipMembers) {
    // Our own encoder is deterministic at a fixed level: recompressing the
    // FULL decoded output must reproduce byte-identical encoded bytes
    // if-and-only-if `encoded` was exactly one well-formed member with no
    // trailing garbage and no additional concatenated member. gunzipSync
    // above already silently concatenated any further members into
    // `decoded` (RFC 1952 behavior) -- this check is what turns that
    // silent leniency back into a fail-closed rejection by default.
    const recompressed = gzipDeterministic(decoded, { level });
    if (!recompressed.equals(encoded)) {
      throw new Error(
        "gunzipSafe: input is not exactly one well-formed gzip member at the expected compression level " +
          "(concatenated members or trailing bytes are rejected unless allowConcatenatedGzipMembers is true)",
      );
    }
  }

  const result = { decoded, encoded_bytes: encoded.length, decoded_bytes: decoded.length, compression_ratio: compressionRatio };
  if (typeof recordSeparator === "string" && recordSeparator !== "") {
    const recordCount = decoded.toString("utf8").split(recordSeparator).filter((line) => line.trim() !== "").length;
    if (typeof maxRecordCount === "number" && recordCount > maxRecordCount) {
      throw new Error(`gunzipSafe: record_count ${recordCount} exceeds maxRecordCount ${maxRecordCount}`);
    }
    result.record_count = recordCount;
  }
  return Object.freeze(result);
}
