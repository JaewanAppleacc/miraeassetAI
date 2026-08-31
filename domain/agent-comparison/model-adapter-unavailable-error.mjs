// Shared error class thrown when a ModelAdapter cannot be constructed at
// all (missing/invalid config, missing API key, an endpoint that fails a
// security check, an unrecognized schema version, etc.) -- extracted out
// of model-adapter.mjs (Turn P11-A) for the same reason model-call-error.mjs
// was: both hcx-model-adapter.mjs and model-adapter.mjs need this exact
// class, and model-adapter.mjs also imports FROM hcx-model-adapter.mjs to
// construct an HCX_CHAT_COMPLETIONS adapter, so the class cannot live in
// either of those two files without creating a circular import.
// model-adapter.mjs re-exports this class so existing
// `import { ModelAdapterUnavailableError } from "./model-adapter.mjs"`
// call sites are unaffected. `.code` is always "MODEL_ADAPTER_UNAVAILABLE"
// (contracts.mjs's MODEL_CALL_ERROR_CODES).
export class ModelAdapterUnavailableError extends Error {
  constructor(reason) {
    super(`model adapter unavailable: ${reason}`);
    this.name = "ModelAdapterUnavailableError";
    this.code = "MODEL_ADAPTER_UNAVAILABLE";
  }
}
