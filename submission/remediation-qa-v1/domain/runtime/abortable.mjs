// 요청 범위 Timeout/Abort 경계를 위한 공용 AbortSignal 경쟁 유틸리티. "promise를
// AbortSignal과 경쟁시키되 unhandledRejection을 만들지 않고, 늦은 확정이 호출자가 이미
// 행동한 결과를 소급 변경하지 못하게 한다"를 한 곳에서 신중히 구현한다.
//
// 의도적으로 단순 Promise.race가 아니다 — race만으로는 호출자만 기다림을 멈출 뿐, 원
// promise는 계속 돌다 나중에 unhandledRejection을 낼 수 있다. raceAgainstAbort는 같은
// 호출 안에서 promise에 자체 거부 핸들러를 동기적으로 붙이므로, 경쟁에서 진 뒤 계속 도는
// 느린 연산이 unhandled rejection을 만들 수 없다 — 그 결과는 그냥 버려진다.

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
