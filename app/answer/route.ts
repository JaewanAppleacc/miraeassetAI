import { createAnswerHandler } from "../../domain/runtime/answer-handler.mjs";
import { createNoFlowConnectedRunner } from "../../domain/runtime/no-flow-connected-runner.mjs";

// GET /answer?question_id=...&question=... -- the fixed official route and
// query parameters (organizer API notice). createAnswerHandler already
// returns the official five-string-field wire body (see domain/runtime/
// answer-wire-response.mjs / domain/interfaces/answer-wire-response.schema.json)
// for every status this route ever returns (200/400/503) -- this file does
// no shaping of its own, just JSON.stringify + headers. No authorization
// header is required or checked anywhere in this path.
//
// The only piece of Flow wiring in this file: no real AgentFlow exists yet
// (CLAUDE.md section 19), so the fail-closed placeholder runner is used.
// Swapping in a real Flow later only means passing a different `runner`
// here — domain/runtime/answer-handler.mjs itself never imports or knows
// about any specific Flow.
const handleAnswerRequest = createAnswerHandler({ runner: createNoFlowConnectedRunner() });

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // request.signal fires when the client disconnects — createAnswerHandler
  // combines it with its own internal deadline timer into one per-request
  // AbortController, so either cause closes the same request scope.
  const { status, body } = await handleAnswerRequest(url.searchParams, { signal: request.signal });
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
