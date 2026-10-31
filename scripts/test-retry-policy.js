
import assert from "node:assert/strict";

import {
  RETRY_POLICY,
  calculateRetryDelayMs,
  classifyDeliveryFailure,
  getRetryDecision,
  parseRetryAfterMs,
} from "../services/retryPolicy.js";

console.log("Testing retry policy...");

// 1. Exponential backoff with deterministic jitter.
assert.equal(calculateRetryDelayMs(1, () => 0), 0);
assert.equal(calculateRetryDelayMs(1, () => 1), 10_000);
assert.equal(calculateRetryDelayMs(2, () => 0.5), 10_000);
assert.equal(calculateRetryDelayMs(3, () => 0.5), 20_000);
assert.equal(
  calculateRetryDelayMs(20, () => 0.5),
  RETRY_POLICY.maxDelayMs / 2,
);

// 2. HTTP error classification.
assert.equal(classifyDeliveryFailure({ statusCode: 408 }).retryable, true);
assert.equal(classifyDeliveryFailure({ statusCode: 425 }).retryable, true);
assert.equal(classifyDeliveryFailure({ statusCode: 429 }).retryable, true);
assert.equal(classifyDeliveryFailure({ statusCode: 503 }).retryable, true);
assert.equal(classifyDeliveryFailure({ statusCode: 400 }).retryable, false);
assert.equal(classifyDeliveryFailure({ statusCode: 409 }).retryable, false);
assert.equal(classifyDeliveryFailure({ statusCode: 404 }).retryable, false);

// 3. Known transient network errors.
assert.equal(classifyDeliveryFailure({ code: "ECONNRESET" }).retryable, true);
assert.equal(classifyDeliveryFailure({ code: "ETIMEDOUT" }).retryable, true);

// 4. Retry-After parsing.
assert.equal(parseRetryAfterMs("30"), 30_000);
assert.equal(parseRetryAfterMs("invalid"), null);
assert.equal(
  parseRetryAfterMs("Thu, 01 Jan 1970 00:00:30 GMT", 0),
  30_000,
);

// 5. Retry a transient error within the retry window.
const retry = getRetryDecision({
  attemptCount: 1,
  firstAttemptAt: new Date(1_000),
  error: { statusCode: 503 },
  nowMs: 2_000,
  random: () => 0.5,
});

assert.deepEqual(retry, {
  action: "retry",
  failureCode: "HTTP_503",
  delayMs: 5_000,
});

// 6. Respect Retry-After when it is longer than the jitter delay.
const retryAfter = getRetryDecision({
  attemptCount: 1,
  firstAttemptAt: new Date(1_000),
  error: { statusCode: 429 },
  retryAfterMs: 30_000,
  nowMs: 2_000,
  random: () => 0.1,
});

assert.equal(retryAfter.action, "retry");
assert.equal(retryAfter.delayMs, 30_000);

// 7. Terminal HTTP errors become dead.
const terminal = getRetryDecision({
  attemptCount: 1,
  firstAttemptAt: new Date(1_000),
  error: { statusCode: 400 },
  nowMs: 2_000,
});

assert.equal(terminal.action, "dead");
assert.equal(terminal.failureCode, "HTTP_400");

// 8. The maximum attempt count is enforced.
const exhausted = getRetryDecision({
  attemptCount: RETRY_POLICY.maxAttempts,
  firstAttemptAt: new Date(1_000),
  error: { statusCode: 503 },
  nowMs: 2_000,
});

assert.equal(exhausted.action, "dead");
assert.equal(exhausted.failureCode, "MAX_ATTEMPTS_EXCEEDED");

// 9. The 24-hour retry window is enforced.
const expired = getRetryDecision({
  attemptCount: 2,
  firstAttemptAt: new Date(0),
  error: { statusCode: 503 },
  nowMs: RETRY_POLICY.maxRetryWindowMs,
});

assert.equal(expired.action, "dead");
assert.equal(expired.failureCode, "RETRY_WINDOW_EXCEEDED");

// 10. Retry is refused if Retry-After exceeds the remaining window.
const tooLate = getRetryDecision({
  attemptCount: 1,
  firstAttemptAt: new Date(0),
  error: { statusCode: 429 },
  retryAfterMs: RETRY_POLICY.maxRetryWindowMs,
  nowMs: 1_000,
});

assert.equal(tooLate.action, "dead");
assert.equal(tooLate.failureCode, "RETRY_WINDOW_EXCEEDED");

// 11. Invalid input is rejected.
assert.throws(() => calculateRetryDelayMs(0), /positive integer/);
assert.throws(
  () =>
    getRetryDecision({
      attemptCount: 1,
      firstAttemptAt: "invalid-date",
      error: { statusCode: 503 },
    }),
  /valid firstAttemptAt/,
);

console.log("All retry-policy tests passed.");


// 12. The retry window boundary is enforced.
const atWindowBoundary = getRetryDecision({
  attemptCount: 2,
  firstAttemptAt: new Date(0),
  error: { statusCode: 503 },
  nowMs: RETRY_POLICY.maxRetryWindowMs,
});

assert.equal(atWindowBoundary.action, "dead");
assert.equal(
  atWindowBoundary.failureCode,
  "RETRY_WINDOW_EXCEEDED",
);

// 13. A retry is rejected if its delay would cross the window boundary.
const nearWindowBoundary = getRetryDecision({
  attemptCount: 1,
  firstAttemptAt: new Date(0),
  error: { statusCode: 503 },
  nowMs: RETRY_POLICY.maxRetryWindowMs - 1_000,
  random: () => 1,
});

assert.equal(nearWindowBoundary.action, "dead");
assert.equal(
  nearWindowBoundary.failureCode,
  "RETRY_WINDOW_EXCEEDED",
);

