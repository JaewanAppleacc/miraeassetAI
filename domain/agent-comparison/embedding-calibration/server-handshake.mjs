// Turn P9.2: server identity handshake for a local (or any HTTP_EMBEDDINGS)
// embedding endpoint. Exactly one GET to `server_info_url` runs BEFORE the
// first embedding POST is ever issued -- every failure mode here (missing
// /info, malformed JSON, any field mismatch, not-ready) fails the run
// closed with ZERO embedding POSTs, never a partial/best-effort attempt.
//
// This module never stores the server's raw response body anywhere it
// returns -- only the four verified fields and a SHA256 attestation over
// them (see computeAttestationSha256). A caller wanting to detect
// mid-run drift calls verifyServerIdentity() a SECOND time after the run
// and compares the new attestation SHA to the first.
import { createHash } from "node:crypto";

export class ServerIdentityHandshakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ServerIdentityHandshakeError";
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

// Computed ONLY over the four verified fields -- never over the raw
// response object, which may carry additional server-specific fields this
// module deliberately never inspects, trusts, or persists.
export function computeAttestationSha256({ repositoryId, modelRevision, dimension, maxInputLength }) {
  return sha256Hex({ repository_id: repositoryId, model_revision: modelRevision, dimension, max_input_length: maxInputLength });
}

// Raw fetch + shape check ONLY -- never compares against any "expected"
// value. Used by BOTH verifyServerIdentity (which then applies the
// expected-value comparisons below) and by the post-run drift re-check
// (which must NOT throw a mismatch error just because a value changed --
// a changed value POST-run is exactly the drift signal the caller wants to
// detect by comparing attestation SHAs, not a reason to treat the run as
// having never been validly connected in the first place).
async function fetchServerInfo(serverInfoUrl, fetchImpl, requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(serverInfoUrl, { method: "GET", signal: controller.signal });
    } catch {
      throw new ServerIdentityHandshakeError("SERVER_INFO_UNAVAILABLE", `GET ${new URL(serverInfoUrl).pathname} failed before a response was received`);
    }
    if (!response.ok) {
      throw new ServerIdentityHandshakeError("SERVER_INFO_UNAVAILABLE", `GET /info returned a non-OK HTTP status (${response.status})`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new ServerIdentityHandshakeError("SERVER_INFO_MALFORMED", "/info response body was not valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ServerIdentityHandshakeError("SERVER_INFO_MALFORMED", "/info response body was not a JSON object");
    }
    // Turn P9.3's own /info contract names this field "embedding_dimension"
    // (matching CalibrationConfig's own expected_dimension naming); Turn
    // P9.2's mock server (and any future server) may still send the
    // shorter "dimension" -- both are accepted and normalized to
    // `dimension` internally so every downstream check has one name.
    if (body.dimension === undefined && body.embedding_dimension !== undefined) {
      body.dimension = body.embedding_dimension;
    }
    for (const field of ["repository_id", "model_revision", "dimension", "max_input_length", "ready"]) {
      if (!(field in body)) throw new ServerIdentityHandshakeError("SERVER_INFO_MALFORMED", `/info response is missing required field "${field}" (or its "embedding_dimension" alias)`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// `expected` = { serverInfoUrl, expectedRepositoryId, expectedModelRevision, expectedDimension, expectedMaxInputLength }
// Throws ServerIdentityHandshakeError on ANY mismatch -- the caller (runner.mjs)
// must never issue an embedding POST if this throws. This is the PREFLIGHT
// check (full validation against the pin).
export async function verifyServerIdentity({ serverInfoUrl, expectedRepositoryId, expectedModelRevision, expectedDimension, expectedMaxInputLength, fetchImpl, requestTimeoutMs = 10000 }) {
  const body = await fetchServerInfo(serverInfoUrl, fetchImpl, requestTimeoutMs);
  if (body.repository_id !== expectedRepositoryId) {
    throw new ServerIdentityHandshakeError("SERVER_IDENTITY_MODEL_ID_MISMATCH", `/info repository_id "${body.repository_id}" does not match the pinned "${expectedRepositoryId}"`);
  }
  if (body.model_revision !== expectedModelRevision) {
    throw new ServerIdentityHandshakeError("SERVER_IDENTITY_REVISION_MISMATCH", `/info model_revision does not match the pinned immutable_revision`);
  }
  if (body.dimension !== expectedDimension) {
    throw new ServerIdentityHandshakeError("SERVER_IDENTITY_DIMENSION_MISMATCH", `/info dimension ${body.dimension} does not match the pinned ${expectedDimension}`);
  }
  if (!Number.isInteger(body.max_input_length) || body.max_input_length < expectedMaxInputLength) {
    throw new ServerIdentityHandshakeError("SERVER_IDENTITY_MAX_LENGTH_INSUFFICIENT", `/info max_input_length ${body.max_input_length} is less than the pinned requirement ${expectedMaxInputLength}`);
  }
  if (body.ready !== true) {
    throw new ServerIdentityHandshakeError("SERVER_NOT_READY", "/info reports the server is not ready to serve embeddings");
  }
  return Object.freeze({
    repositoryId: body.repository_id,
    modelRevision: body.model_revision,
    dimension: body.dimension,
    maxInputLength: body.max_input_length,
    attestationSha256: computeAttestationSha256({ repositoryId: body.repository_id, modelRevision: body.model_revision, dimension: body.dimension, maxInputLength: body.max_input_length }),
  });
}

// POST-RUN re-check: re-fetches /info WITHOUT comparing against the
// original pin, and returns its own attestation SHA -- the CALLER compares
// this against the preflight's attestation SHA to detect drift. A fetch
// failure here (server crashed/unreachable after the run) is surfaced as a
// ServerIdentityHandshakeError like any other -- the caller treats "cannot
// re-confirm identity" the same as "identity changed": either way, the
// run's embeddings can no longer be trusted as attributable to the pinned
// model.
export async function fetchServerAttestation({ serverInfoUrl, fetchImpl, requestTimeoutMs = 10000 }) {
  const body = await fetchServerInfo(serverInfoUrl, fetchImpl, requestTimeoutMs);
  return Object.freeze({
    repositoryId: body.repository_id,
    modelRevision: body.model_revision,
    dimension: body.dimension,
    maxInputLength: body.max_input_length,
    attestationSha256: computeAttestationSha256({ repositoryId: body.repository_id, modelRevision: body.model_revision, dimension: body.dimension, maxInputLength: body.max_input_length }),
  });
}
