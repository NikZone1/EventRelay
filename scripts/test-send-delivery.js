
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import {
  claimDueDeliveries,
  recordDeliveryFailure,
} from "../models/delivery.js";
import { encryptSecret } from "../services/secret.js";
import { sendDelivery } from "../services/sendDelivery.js";
import { getRetryDecision } from "../services/retryPolicy.js";

let tenantId;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS: ${message}`);
}

async function createTestDelivery(label) {
  const event = await pool.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [
      tenantId,
      randomUUID(),
      `test.${label}`,
      JSON.stringify({ test: true, label }),
      randomUUID(),
    ],
  );

  const endpoint = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      tenantId,
      "https://example.com/controlled-test",
      encryptSecret("controlled-test-secret"),
    ],
  );

  const delivery = await pool.query(
    `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [tenantId, event.rows[0].id, endpoint.rows[0].id],
  );

  return delivery.rows[0].id;
}

async function claimOne(deliveryId, workerId) {
  const claimed = await claimDueDeliveries(pool, {
    workerId,
    batchSize: 10,
    leaseSeconds: 60,
  });

  assert(
    claimed.some((row) => row.id === deliveryId),
    `Delivery ${deliveryId} was claimed`,
  );

  return claimed.find((row) => row.id === deliveryId);
}

async function processFailure({ delivery, workerId, error }) {
  const decision = getRetryDecision({
    attemptCount: delivery.attempt_count,
    firstAttemptAt: delivery.first_attempt_at,
    error,
    retryAfterMs: error.retryAfterMs ?? null,
  });

  const updated = await recordDeliveryFailure(pool, {
    deliveryId: delivery.id,
    workerId,
    errorMessage:
      decision.action === "dead"
        ? `${error.message} (${decision.reason})`
        : error.message,
    responseStatus: error.statusCode ?? null,
    failureCode: decision.failureCode,
    action: decision.action,
    retryDelayMs:
      decision.action === "retry" ? decision.delayMs : undefined,
  });

  return { decision, updated };
}

try {
  const tenant = await pool.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id`,
    [`send-delivery-test-${randomUUID()}`],
  );

  tenantId = tenant.rows[0].id;

  // Test A: simulated HTTP 200.
  const successId = await createTestDelivery("success");
  const successWorker = `success-worker-${randomUUID()}`;

  await claimOne(successId, successWorker);

  let successRequest;

  const successResult = await sendDelivery({
    deliveryId: successId,
    workerId: successWorker,
    httpPost: async (request) => {
      successRequest = request;

      return {
        statusCode: 200,
        body: "controlled success",
      };
    },
  });

  assert(
    successResult.status === "succeeded",
    "HTTP 200 marks the delivery succeeded",
  );

  assert(
    successRequest.url === "https://example.com/controlled-test",
    "Sender passes the configured endpoint to the transport",
  );

  assert(
    successRequest.signature.length === 64,
    "Sender generates an HMAC-SHA256 signature",
  );

  const successState = await pool.query(
    `SELECT status, response_status, response_body,
            locked_by, locked_until, processing_started_at
     FROM deliveries
     WHERE id = $1`,
    [successId],
  );

  const succeeded = successState.rows[0];

  assert(succeeded.status === "succeeded", "Success persists in PostgreSQL");
  assert(
    Number(succeeded.response_status) === 200,
    "Successful HTTP status is stored",
  );
  assert(
    succeeded.response_body === "controlled success",
    "Successful response body is stored",
  );
  assert(
    succeeded.locked_by === null &&
      succeeded.locked_until === null &&
      succeeded.processing_started_at === null,
    "Success clears the delivery lease",
  );

  // Test B: simulated HTTP 500, using the real retry policy.
  const failureId = await createTestDelivery("failure");
  const failureWorker = `failure-worker-${randomUUID()}`;
  const failureClaim = await claimOne(failureId, failureWorker);

  let caughtError;

  try {
    await sendDelivery({
      deliveryId: failureId,
      workerId: failureWorker,
      httpPost: async () => ({
        statusCode: 500,
        headers: {},
        body: "controlled failure",
      }),
    });
  } catch (error) {
    caughtError = error;
  }

  assert(
    caughtError?.statusCode === 500,
    "HTTP 500 is surfaced with its response status",
  );

  const { decision: failureDecision, updated: failed } =
    await processFailure({
      delivery: failureClaim,
      workerId: failureWorker,
      error: caughtError,
    });

  assert(
    failureDecision.action === "retry",
    "Retry policy classifies HTTP 500 as retryable",
  );
  assert(
    failed?.status === "retrying",
    "HTTP 500 transitions the delivery to retrying",
  );

  const failureState = await pool.query(
    `SELECT status, response_status, last_error, next_attempt_at,
            next_attempt_at > NOW() AS retry_is_future,
            locked_by, locked_until, processing_started_at
     FROM deliveries
     WHERE id = $1`,
    [failureId],
  );

  const retrying = failureState.rows[0];

  assert(
    Number(retrying.response_status) === 500,
    "Failed HTTP status is stored",
  );
  assert(
    retrying.last_error.includes("500"),
    "Failure reason is stored",
  );
  assert(
    retrying.retry_is_future === true,
    "Retry is scheduled in the future",
  );
  assert(
    retrying.locked_by === null &&
      retrying.locked_until === null &&
      retrying.processing_started_at === null,
    "Failure clears the delivery lease",
  );

  // Test C: HTTP 429 with Retry-After: 30.
  const rateLimitId = await createTestDelivery("retry-after");
  const rateLimitWorker = `retry-after-worker-${randomUUID()}`;
  const rateLimitClaim = await claimOne(rateLimitId, rateLimitWorker);

  let rateLimitError;

  try {
    await sendDelivery({
      deliveryId: rateLimitId,
      workerId: rateLimitWorker,
      httpPost: async () => ({
        statusCode: 429,
        headers: { "retry-after": "30" },
        body: "rate limited",
      }),
    });
  } catch (error) {
    rateLimitError = error;
  }

  assert(
    rateLimitError?.statusCode === 429,
    "HTTP 429 is surfaced with its response status",
  );

  assert(
    rateLimitError?.retryAfterMs === 30_000,
    "Retry-After header is parsed as 30 seconds",
  );

  const { decision: rateLimitDecision, updated: rateLimitUpdated } =
    await processFailure({
      delivery: rateLimitClaim,
      workerId: rateLimitWorker,
      error: rateLimitError,
    });

  assert(
    rateLimitDecision.action === "retry",
    "Retry policy classifies HTTP 429 as retryable",
  );

  assert(
    rateLimitDecision.delayMs === 30_000,
    "Retry policy honors Retry-After: 30",
  );

  assert(
    rateLimitUpdated?.status === "retrying",
    "HTTP 429 transitions the delivery to retrying",
  );

  const rateLimitState = await pool.query(
    `SELECT status, response_status, failure_code,
            next_attempt_at,
            EXTRACT(EPOCH FROM (next_attempt_at - NOW())) * 1000
              AS retry_delay_ms,
            locked_by, locked_until, processing_started_at
     FROM deliveries
     WHERE id = $1`,
    [rateLimitId],
  );

  const rateLimited = rateLimitState.rows[0];
  const actualDelayMs = Number(rateLimited.retry_delay_ms);

  assert(
    Number(rateLimited.response_status) === 429,
    "HTTP 429 status is persisted",
  );

  assert(
    typeof rateLimited.failure_code === "string" &&
      rateLimited.failure_code.length > 0,
    "Retry failure code is persisted",
  );

  assert(
    actualDelayMs > 25_000 && actualDelayMs <= 30_000,
    `Persisted retry delay is approximately 30 seconds (${Math.round(actualDelayMs)} ms)`,
  );

  assert(
    rateLimited.locked_by === null &&
      rateLimited.locked_until === null &&
      rateLimited.processing_started_at === null,
    "HTTP 429 failure clears the delivery lease",
  );

  console.log("\nAll controlled delivery tests passed.");
} catch (error) {
  console.error("\nControlled delivery test failed:", error);
  process.exitCode = 1;
} finally {
  if (tenantId) {
    try {
      await pool.query(
        `DELETE FROM delivery_replay_audit
         WHERE tenant_id = $1`,
        [tenantId],
      );
      await pool.query(
        `DELETE FROM deliveries WHERE tenant_id = $1`,
        [tenantId],
      );
      await pool.query(
        `DELETE FROM endpoints WHERE tenant_id = $1`,
        [tenantId],
      );
      await pool.query(
        `DELETE FROM outbox_events
         WHERE event_id IN (
           SELECT id FROM events WHERE tenant_id = $1
         )`,
        [tenantId],
      );
      await pool.query(
        `DELETE FROM events WHERE tenant_id = $1`,
        [tenantId],
      );
      await pool.query(
        `DELETE FROM tenants WHERE id = $1`,
        [tenantId],
      );
    } catch (error) {
      console.error("Cleanup failed:", error.message);
      process.exitCode = 1;
    }
  }

  await pool.end();
}
