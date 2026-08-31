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
export class ModelCallError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = "ModelCallError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
