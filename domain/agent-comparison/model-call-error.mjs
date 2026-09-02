// Shared error class for a FAILED ModelAdapter.generate() call, extracted
// out of model-adapter.mjs (Turn P11-A) so both the generic HTTP_CHAT_COMPLETIONS
// adapter and the HCX-specific one (hcx-model-adapter.mjs) -- and the
// response-parsing helper both share (structured-answer-parsing.mjs) --
// can throw/import the exact same class without a circular import between
// model-adapter.mjs and hcx-model-adapter.mjs. model-adapter.mjs re-exports
// this class from its own module so existing `import { ModelCallError }
// from "./model-adapter.mjs"` call sites are unaffected.
//
// `.code` is always one of contracts.mjs's MODEL_CALL_ERROR_CODES.
// `.message` is always a fixed, generic string -- never the raw provider
// response body, a raw transport exception message, or an API key. A
// caller that wants more detail for its OWN debugging may pass `cause`
// (never surfaced in `.message`, and never logged by this module either).
//
// `diagnostics` (Turn P11-C, optional, additive): a plain object of
// non-sensitive, structural classification fields ONLY (e.g.
// outer_envelope_class, assistant_content_class, assistant_content_length,
// http_status, content_type_mime, finish_reason) -- never the raw
// prompt/response body, a header value, or a secret. Callers that don't
// pass it (every existing call site) see `.diagnostics === null`, exactly
// as before this field existed.
export class ModelCallError extends Error {
  constructor(code, message, { cause, diagnostics } = {}) {
    super(message);
    this.name = "ModelCallError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    this.diagnostics = diagnostics ?? null;
  }
}
