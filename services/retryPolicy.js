
export const RETRY_POLICY = Object.freeze({
  maxAttempts: 10,
  maxRetryWindowMs: 24 * 60 * 60 * 1000,
  baseDelayMs: 10 * 1000,
  maxDelayMs: 60 * 60 * 1000,
});

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

const TERMINAL_ERROR_CODES = new Set([
  "WEBHOOK_SECRET_INVALID",
  "WEBHOOK_URL_INVALID",
  "WEBHOOK_URL_BLOCKED",
]);

const RETRYABLE_NETWORK_CODES = new Set([
  "WEBHOOK_TRANSPORT_ERROR",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

export function classifyDeliveryFailure(error) {
  const statusCode = Number(error?.statusCode);

  if (TERMINAL_ERROR_CODES.has(error?.code)) {
    return {
      retryable: false,
      failureCode: error.code,
    };
  }

  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    if (RETRYABLE_HTTP_STATUSES.has(statusCode)) {
      return {
        retryable: true,
        failureCode: `HTTP_${statusCode}`,
      };
    }

    return {
      retryable: false,
      failureCode: `HTTP_${statusCode}`,
    };
  }

  if (Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599) {
    return {
      retryable: true,
      failureCode: `HTTP_${statusCode}`,
    };
  }

  if (RETRYABLE_NETWORK_CODES.has(error?.code)) {
    return {
      retryable: true,
      failureCode: error.code,
    };
  }

  // Unknown errors remain terminal to avoid retrying programming errors
  // or malformed internal state indefinitely.
  return {
    retryable: false,
    failureCode: error?.code || "UNCLASSIFIED_ERROR",
  };
}

export function calculateRetryDelayMs(attemptCount, random = Math.random) {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error("attemptCount must be a positive integer");
  }

  if (typeof random !== "function") {
    throw new Error("random must be a function");
  }

  const exponentialCap = Math.min(
    RETRY_POLICY.baseDelayMs * 2 ** (attemptCount - 1),
    RETRY_POLICY.maxDelayMs,
  );

  const randomValue = random();

  if (
    !Number.isFinite(randomValue) ||
    randomValue < 0 ||
    randomValue > 1
  ) {
    throw new Error("random must return a number between 0 and 1");
  }

  // Full jitter: random delay between zero and the exponential cap.
  return Math.min(
    Math.floor(randomValue * exponentialCap),
    exponentialCap,
  );
}

export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const trimmed = String(value).trim();

  // Retry-After may specify a delay in seconds.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);

    if (!Number.isSafeInteger(seconds)) {
      return null;
    }

    const delayMs = seconds * 1000;

    return Number.isSafeInteger(delayMs) ? delayMs : null;
  }

  // Or it may specify an HTTP date.
  const retryAtMs = Date.parse(trimmed);

  if (!Number.isFinite(retryAtMs)) {
    return null;
  }

  return Math.max(0, retryAtMs - nowMs);
}

export function getRetryDecision({
  attemptCount,
  firstAttemptAt,
  error,
  retryAfterMs = null,
  nowMs = Date.now(),
  random = Math.random,
}) {
  const classification = classifyDeliveryFailure(error);

  if (!classification.retryable) {
    return {
      action: "dead",
      failureCode: classification.failureCode,
      reason: "NON_RETRYABLE_FAILURE",
    };
  }

  if (attemptCount >= RETRY_POLICY.maxAttempts) {
    return {
      action: "dead",
      failureCode: "MAX_ATTEMPTS_EXCEEDED",
      reason: "MAX_ATTEMPTS_EXCEEDED",
    };
  }

  const firstAttemptMs = new Date(firstAttemptAt).getTime();

  if (!Number.isFinite(firstAttemptMs)) {
    throw new Error("A valid firstAttemptAt is required");
  }

  const elapsedMs = nowMs - firstAttemptMs;
  const remainingWindowMs =
    RETRY_POLICY.maxRetryWindowMs - elapsedMs;

  if (remainingWindowMs <= 0) {
    return {
      action: "dead",
      failureCode: "RETRY_WINDOW_EXCEEDED",
      reason: "RETRY_WINDOW_EXCEEDED",
    };
  }

  const jitterDelayMs = calculateRetryDelayMs(attemptCount, random);

  const validRetryAfter =
    Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
      ? retryAfterMs
      : null;

  const requestedDelayMs =
    validRetryAfter === null
      ? jitterDelayMs
      : Math.max(jitterDelayMs, validRetryAfter);

  if (requestedDelayMs >= remainingWindowMs) {
    return {
      action: "dead",
      failureCode: "RETRY_WINDOW_EXCEEDED",
      reason: "RETRY_WINDOW_EXCEEDED",
    };
  }

  return {
    action: "retry",
    failureCode: classification.failureCode,
    delayMs: requestedDelayMs,
  };
}
