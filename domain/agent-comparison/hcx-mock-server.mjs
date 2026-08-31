// Local, loopback-only mock HTTP server that speaks HCX Chat Completions
// v3's own request/response envelope (see hcx-model-adapter.mjs), used
// ONLY by this Turn's own tests/scripts -- never imported by app/,
// production wiring, or any register-*-variant.mjs. Turn P11-A section F.
//
// The server ALWAYS binds to 127.0.0.1 (never 0.0.0.0 or a real interface)
// -- createHcxMockServer never accepts a `host` override, by design, so it
// can never accidentally listen on a non-loopback address.
//
// Scenario selection is by REQUEST PATH, not by request body content or a
// special header: a caller picks a scenario by pointing ModelConfig's
// endpoint_url at that path (e.g. `${server.url}/scenarios/http-429`).
// This keeps the mock server fully decoupled from the real adapter's own
// request-building code -- it never has to parse or understand what the
// adapter sent, only which path it was called on (except where the
// scenario is explicitly about echoing back caller-supplied ids, which
// still comes from the mock's OWN fixed fixture, never from the request
// body).
//
// SECURITY: the server never logs the Authorization header, request body,
// or response body to stdout/stderr; `lastRequestHeaders`/`lastRequestBody`
// below exist ONLY as an in-memory, test-only introspection point a test
// may read directly (never persisted, never part of any manifest/telemetry
// this Turn builds) to assert non-exposure elsewhere in the system.
import http from "node:http";

const SCENARIO_PATHS = Object.freeze([
  "normal",
  "empty-text",
  "malformed",
  "unauthorized-evidence",
  "tampered-number",
  "tampered-date",
  "tampered-corp-code",
  "http-401",
  "http-403",
  "http-429",
  "http-500",
  "timeout",
  "abort",
]);

function structuredEnvelope({ answer, usedFactIds = [], usedEvidenceIds = [] }) {
  return {
    status: { code: "20000", message: "OK" },
    result: {
      message: { role: "assistant", content: JSON.stringify({ answer, used_fact_ids: usedFactIds, used_evidence_ids: usedEvidenceIds }) },
      stopReason: "stop_before",
      usage: { promptTokens: 42, completionTokens: 7 },
    },
  };
}

function writeJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(payload);
}

// authorizedFactId/authorizedEvidenceId: the ONLY ids a well-behaved
// "normal" response ever claims -- a caller building a full 4-agent smoke
// against a real grounded Fact passes its own ids in so the "normal"
// scenario actually passes citation-binding downstream; scenarios that are
// deliberately adversarial (unauthorized-evidence/tampered-*) intentionally
// ignore these and emit their own fixed bad values instead.
export function createHcxMockServer({ authorizedFactId = "fact_mock_authorized", authorizedEvidenceId = "evidence_mock_authorized", groundedAnswerText = "매출액은 1,000,000,000원입니다." } = {}) {
  let lastRequestHeaders = null;
  let lastRequestBody = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      lastRequestHeaders = { ...req.headers };
      lastRequestBody = rawBody;

      const scenario = (req.url ?? "/").replace(/^\/scenarios\//, "").replace(/^\//, "");

      switch (scenario) {
        case "normal":
          return writeJson(res, 200, structuredEnvelope({ answer: groundedAnswerText, usedFactIds: [authorizedFactId], usedEvidenceIds: [authorizedEvidenceId] }));
        case "empty-text":
          return writeJson(res, 200, structuredEnvelope({ answer: "" }));
        case "malformed":
          res.writeHead(200, { "content-type": "application/json" });
          return res.end("{ this is not valid json");
        case "unauthorized-evidence":
          return writeJson(res, 200, structuredEnvelope({ answer: groundedAnswerText, usedFactIds: [authorizedFactId], usedEvidenceIds: ["evidence_never_authorized_for_this_request"] }));
        case "tampered-number":
          return writeJson(res, 200, structuredEnvelope({ answer: "매출액은 9,999,999,999원입니다.", usedFactIds: [authorizedFactId], usedEvidenceIds: [authorizedEvidenceId] }));
        case "tampered-date":
          return writeJson(res, 200, structuredEnvelope({ answer: "매출액은 2099년 12월 31일 기준입니다.", usedFactIds: [authorizedFactId], usedEvidenceIds: [authorizedEvidenceId] }));
        case "tampered-corp-code":
          return writeJson(res, 200, structuredEnvelope({ answer: "회사 코드 99999999에 대한 답변입니다.", usedFactIds: [authorizedFactId], usedEvidenceIds: [authorizedEvidenceId] }));
        case "http-401":
          return writeJson(res, 401, { status: { code: "40100", message: "Unauthorized" } });
        case "http-403":
          return writeJson(res, 403, { status: { code: "40300", message: "Forbidden" } });
        case "http-429":
          return writeJson(res, 429, { status: { code: "42900", message: "Too Many Requests" } });
        case "http-500":
          return writeJson(res, 500, { status: { code: "50000", message: "Internal Server Error" } });
        case "timeout":
        case "abort":
          // Deliberately never responds -- the caller's own AbortController
          // (internal timeout for "timeout", an externally-supplied
          // request.signal for "abort") is what ends the request. The
          // connection is left open until the client aborts it; nothing
          // further is written to `res`.
          return undefined;
        default:
          return writeJson(res, 404, { status: { code: "40400", message: "unknown mock scenario" } });
      }
    });
  });

  return {
    SCENARIO_PATHS,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const { port } = server.address();
      return `http://127.0.0.1:${port}`;
    },
    urlFor(baseUrl, scenario) {
      return `${baseUrl}/scenarios/${scenario}`;
    },
    // Test-only introspection -- never used by hcx-model-adapter.mjs or any
    // manifest/telemetry builder, only by this Turn's own non-exposure
    // assertions (e.g. "the adapter's thrown error never contains the raw
    // Authorization header value").
    getLastRequestHeaders() {
      return lastRequestHeaders;
    },
    getLastRequestBody() {
      return lastRequestBody;
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
