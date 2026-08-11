import assert from "node:assert/strict";
import test from "node:test";
import { abortReason, raceAgainstAbort, RequestAbortedError } from "../domain/runtime/abortable.mjs";

test("raceAgainstAbort returns the promise unchanged when no signal is given", async () => {
  const value = await raceAgainstAbort(Promise.resolve("ok"), undefined);
  assert.equal(value, "ok");
});

test("raceAgainstAbort resolves with the promise's own value if it settles before abort", async () => {
  const controller = new AbortController();
  const value = await raceAgainstAbort(Promise.resolve("done"), controller.signal);
  assert.equal(value, "done");
});

test("raceAgainstAbort rejects with RequestAbortedError once the signal aborts before the promise settles", async () => {
  const controller = new AbortController();
  const never = new Promise(() => {});
  const racePromise = raceAgainstAbort(never, controller.signal);
  controller.abort();
  await assert.rejects(() => racePromise, (error) => error instanceof RequestAbortedError);
});

test("raceAgainstAbort rejects immediately if the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => raceAgainstAbort(new Promise(() => {}), controller.signal), RequestAbortedError);
});

test("a late resolve after the abort race has already settled is discarded, not surfaced", async () => {
  const controller = new AbortController();
  let release;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  const racePromise = raceAgainstAbort(late, controller.signal);
  controller.abort();
  await assert.rejects(() => racePromise, RequestAbortedError);
  release("late value");
  await new Promise((resolve) => setTimeout(resolve, 10));
  // no assertion needed beyond "did not throw" — the point is this doesn't
  // resurface anywhere or crash the process.
});

test("a late reject after the abort race has already settled does not produce an unhandledRejection", async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const controller = new AbortController();
    let reject;
    const late = new Promise((_, r) => {
      reject = r;
    });
    const racePromise = raceAgainstAbort(late, controller.signal);
    controller.abort();
    await assert.rejects(() => racePromise, RequestAbortedError);
    reject(new Error("late underlying failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
  assert.deepEqual(unhandled, []);
});

test("an already-settled (already rejecting) promise racing an already-aborted signal still only ever produces one observed rejection path", async () => {
  const controller = new AbortController();
  const alreadyRejecting = Promise.reject(new Error("boom"));
  const racePromise = raceAgainstAbort(alreadyRejecting, controller.signal);
  controller.abort();
  // Either outcome (the real rejection or the abort rejection) is
  // acceptable here — what matters is it never throws synchronously and
  // never produces an unhandledRejection from the original promise.
  await assert.rejects(() => racePromise);
});

test("abortReason reports TIMEOUT/CLIENT_DISCONNECT for a RequestAbortedError reason, and ABORTED otherwise", () => {
  const timeoutController = new AbortController();
  timeoutController.abort(new RequestAbortedError("TIMEOUT"));
  assert.equal(abortReason(timeoutController.signal), "TIMEOUT");

  const disconnectController = new AbortController();
  disconnectController.abort(new RequestAbortedError("CLIENT_DISCONNECT"));
  assert.equal(abortReason(disconnectController.signal), "CLIENT_DISCONNECT");

  const bareController = new AbortController();
  bareController.abort();
  assert.equal(abortReason(bareController.signal), "ABORTED");

  const customReasonController = new AbortController();
  customReasonController.abort(new Error("some other reason"));
  assert.equal(abortReason(customReasonController.signal), "ABORTED");
});

test("raceAgainstAbort's rejection carries the same reason abortReason() would report", async () => {
  const controller = new AbortController();
  const racePromise = raceAgainstAbort(new Promise(() => {}), controller.signal);
  controller.abort(new RequestAbortedError("TIMEOUT"));
  await assert.rejects(() => racePromise, (error) => error instanceof RequestAbortedError && error.reason === "TIMEOUT");
});

test("multiple concurrent raceAgainstAbort calls against independent signals do not affect each other", async () => {
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const raceA = raceAgainstAbort(new Promise(() => {}), controllerA.signal);
  const raceB = raceAgainstAbort(Promise.resolve("b-result"), controllerB.signal);
  controllerA.abort();
  await assert.rejects(() => raceA, RequestAbortedError);
  assert.equal(await raceB, "b-result");
});

// --- input normalization: a plain synchronous value, or any non-Promise
//     thenable, must never crash raceAgainstAbort with "promise.then is
//     not a function" — Promise.resolve() normalizes all three shapes
//     (native Promise, thenable, plain value) up front. --------------------

test("a plain synchronous value (not a Promise at all) racing with no signal resolves normally", async () => {
  const value = await raceAgainstAbort(42, undefined);
  assert.equal(value, 42);
});

test("a plain synchronous value racing against a signal that never aborts resolves normally", async () => {
  const controller = new AbortController();
  const value = await raceAgainstAbort("plain string result", controller.signal);
  assert.equal(value, "plain string result");
});

test("a plain synchronous value racing against an ALREADY-aborted signal rejects with RequestAbortedError, not a TypeError about .then", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => raceAgainstAbort({ not: "a promise" }, controller.signal), RequestAbortedError);
});

test("a plain synchronous value racing against a signal that aborts mid-race rejects with RequestAbortedError", async () => {
  const controller = new AbortController();
  const racePromise = raceAgainstAbort(0, controller.signal);
  controller.abort();
  await assert.rejects(() => racePromise, RequestAbortedError);
});

test("a non-Promise thenable is handled correctly (resolves normally, no signal)", async () => {
  const thenable = { then: (resolve) => resolve("thenable value") };
  const value = await raceAgainstAbort(thenable, undefined);
  assert.equal(value, "thenable value");
});

test("a non-Promise thenable races correctly against a signal that has not aborted", async () => {
  const controller = new AbortController();
  const thenable = { then: (resolve) => resolve("thenable value") };
  const value = await raceAgainstAbort(thenable, controller.signal);
  assert.equal(value, "thenable value");
});

test("a non-Promise thenable that rejects late (after an already-aborted signal loses the value) does not produce an unhandledRejection", async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const controller = new AbortController();
    controller.abort();
    let rejectThenable;
    const thenable = {
      then: (_resolve, reject) => {
        rejectThenable = reject;
      },
    };
    await assert.rejects(() => raceAgainstAbort(thenable, controller.signal), RequestAbortedError);
    rejectThenable(new Error("late thenable failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
  assert.deepEqual(unhandled, []);
});
