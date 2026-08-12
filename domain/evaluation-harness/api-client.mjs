// Real HTTP client for the deployed Agent's GET /answer. Deliberately never
// imports any Agent-internal module — the whole point of a blackbox
// Harness is that it can only see what a real caller sees.
export async function requestAnswer(config, question) {
  const url = new URL(config.answer_path, config.base_url);
  url.searchParams.set(config.question_parameter, question);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout_ms);
  const started = Date.now();
  try {
    const response = await fetch(url, { method: "GET", headers: config.headers ?? {}, signal: controller.signal });
    const raw = await response.text();
    let body = null;
    let parseError = null;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      parseError = error.message;
    }
    return { httpStatus: response.status, latencyMs: Date.now() - started, raw, body, parseError, timedOut: false, transportError: null };
  } catch (error) {
    const timedOut = error.name === "AbortError";
    return {
      httpStatus: null,
      latencyMs: Date.now() - started,
      raw: "",
      body: null,
      parseError: null,
      timedOut,
      // Never include the caught error's full message verbatim — a fetch
      // TypeError can embed the request URL (which carries the question as
      // a query parameter) or, depending on the underlying cause, other
      // connection detail. Only a fixed, generic classification is safe to
      // surface here; harness-runner.mjs's safeError() redaction is a
      // second, independent layer on top of this, not a substitute for it.
      transportError: timedOut ? "request timed out" : "request failed (connection error)",
    };
  } finally {
    clearTimeout(timer);
  }
}
