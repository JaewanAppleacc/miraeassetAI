import { createAnswerHandler } from "../../domain/runtime/answer-handler.mjs";
import { configuredSeedRuntime } from "../../domain/runtime/configured-seed-runtime.mjs";

// GET /answer?question_id=...&question=... -- the fixed official route and
// query parameters (organizer API notice). createAnswerHandler already
// returns the official five-string-field wire body (see domain/runtime/
// answer-wire-response.mjs / domain/interfaces/answer-wire-response.schema.json)
// for every status this route ever returns (200/400/503) -- this file does
// no shaping of its own, just JSON.stringify + headers. No authorization
// header is required or checked anywhere in this path.
//
// Lazy Thin Flow A wiring. It serves only the explicitly pinned VERIFIED
// Seed subset; an unknown question/question_id pair or a deployment missing
// those immutable artifacts falls back to the existing honest EARLY_EXIT.
// answer-handler.mjs remains Flow-agnostic.
const handleAnswerRequest = createAnswerHandler({ runner: configuredSeedRuntime.run });

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
