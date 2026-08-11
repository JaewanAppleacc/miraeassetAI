// Shared AbortSignal racing utility for the request-scoped Timeout/Abort
// boundary (GET /answer -> Runtime Host -> SharedServices). A single,
// careful implementation lives here instead of being duplicated at every
// layer that needs "race a promise against an AbortSignal without ever
// producing an unhandledRejection, and without letting a late settlement
// retroactively change anything the caller already acted on".
//
// This is deliberately NOT a bare `Promise.race([promise, timeoutPromise])`
// — that alone would only make the CALLER stop waiting; the original
// `promise` would still be running unobserved in the background, able to
// throw an unhandledRejection later, and any code awaiting IT DIRECTLY
// elsewhere would still hang. raceAgainstAbort always attaches its own
// rejection handler to `promise` synchronously (in this same call), so a
// slow underlying operation that keeps running after losing the race can
// never produce an unhandled rejection — its eventual result is simply
// discarded.

export class RequestAbortedError extends Error {
  constructor(reason) {
    super(`request aborted: ${reason}`);
    this.name = "RequestAbortedError";
    this.reason = reason; // "TIMEOUT" | "CLIENT_DISCONNECT" | "ABORTED"
  }
}

// A signal's `.reason` (set via `controller.abort(reason)`) is used, when
// it is a RequestAbortedError this module itself produced, to recover WHY
// a signal aborted. Any other caller-supplied signal (one aborted without
// a recognizable reason, e.g. a bare `new AbortController().abort()`)
// reports the generic "ABORTED" cause.
export function abortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof RequestAbortedError) return reason.reason;
  return "ABORTED";
}

// Resolves/rejects with `valueOrPromise`'s own outcome if it settles
// before `signal` aborts, or rejects with a RequestAbortedError the
// instant `signal` aborts — whichever happens first. No `signal`
// (undefined) means "never aborts".
//
// `valueOrPromise` is normalized via Promise.resolve() up front — a
// caller does not have to know or check in advance whether what it's
// racing is a real Promise, a thenable, or a plain synchronous value.
// Without this, a plain sync value (or any non-Promise thenable) reaching
// the `.then()` calls below would throw "promise.then is not a function"
// instead of racing cleanly — Promise.resolve() already handles all three
// cases correctly (and is a no-op — returns the same reference — when
// `valueOrPromise` is already a native Promise).
export function raceAgainstAbort(valueOrPromise, signal) {
  const promise = Promise.resolve(valueOrPromise);
  if (!signal) return promise;

  if (signal.aborted) {
    // Still observe `promise` even though we're not going to wait for it —
    // it may already be running and could reject later.
    promise.then(
      () => {},
      () => {},
    );
    return Promise.reject(new RequestAbortedError(abortReason(signal)));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new RequestAbortedError(abortReason(signal)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        // Lost the race — `promise` settled, but only after abort already
        // rejected this one. Discard the value; never resolve/reject twice.
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
