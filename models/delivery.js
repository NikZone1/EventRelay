
const MAX_DELIVERY_ATTEMPTS = 10;
const MAX_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function createDelivery(
  db,
  { tenantId, eventId, endpointId },
) {
  const result = await db.query(
    `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id, endpoint_id) DO NOTHING
     RETURNING id, tenant_id, event_id, endpoint_id, status,
               attempt_count, next_attempt_at, created_at`,
    [tenantId, eventId, endpointId],
  );

  if (result.rows.length > 0) {
    return { delivery: result.rows[0], created: true };
  }

  const existing = await db.query(
    `SELECT id, tenant_id, event_id, endpoint_id, status,
            attempt_count, next_attempt_at, created_at
     FROM deliveries
     WHERE event_id = $1 AND endpoint_id = $2`,
    [eventId, endpointId],
  );

  return {
    delivery: existing.rows[0] ?? null,
    created: false,
  };
}

export async function findDeliveryById(db, tenantId, deliveryId) {
  const result = await db.query(
    `SELECT id, tenant_id, event_id, endpoint_id,
            status, attempt_count, next_attempt_at,
            response_status, last_error, failure_code,
            first_attempt_at, dead_at,
            created_at, updated_at, completed_at
     FROM deliveries
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, deliveryId],
  );

  return result.rows[0] ?? null;
}

export async function claimDueDeliveries(
  db,
  { workerId, batchSize = 10, leaseSeconds = 60 },
) {
  if (!workerId || workerId.length > 255) {
    throw new Error("A valid workerId is required");
  }

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("batchSize must be an integer between 1 and 100");
  }

  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("leaseSeconds must be a positive integer");
  }

  // Recover exhausted deliveries before claiming more work.
  // An actively leased delivery must not be modified by another worker.
  await db.query(
    `UPDATE deliveries
     SET status = 'dead',
         dead_at = COALESCE(dead_at, NOW()),
         failure_code = CASE
           WHEN attempt_count >= $1
             THEN 'MAX_ATTEMPTS_EXCEEDED'
           ELSE 'RETRY_WINDOW_EXCEEDED'
         END,
         last_error = CASE
           WHEN attempt_count >= $1
             THEN 'Maximum delivery attempts exceeded'
           ELSE 'Delivery retry window expired'
         END,
         updated_at = NOW(),
         locked_by = NULL,
         locked_until = NULL,
         processing_started_at = NULL
     WHERE (
       status IN ('pending', 'retrying')
       OR (
         status = 'processing'
         AND locked_until <= NOW()
       )
     )
       AND (
         attempt_count >= $1
         OR (
           first_attempt_at IS NOT NULL
           AND first_attempt_at <=
             NOW() - ($2 * INTERVAL '1 millisecond')
         )
       )`,
    [MAX_DELIVERY_ATTEMPTS, MAX_RETRY_WINDOW_MS],
  );

  const result = await db.query(
    `WITH candidates AS (
       SELECT d.id
       FROM deliveries AS d
       WHERE (
         (
           d.status IN ('pending', 'retrying')
           AND d.next_attempt_at <= NOW()
         )
         OR (
           d.status = 'processing'
           AND d.locked_until <= NOW()
         )
       )
       AND d.attempt_count < $4
       AND (
         d.first_attempt_at IS NULL
         OR d.first_attempt_at >
           NOW() - ($5 * INTERVAL '1 millisecond')
       )
       AND EXISTS (
         SELECT 1
         FROM endpoints AS ep
         WHERE ep.id = d.endpoint_id
           AND ep.tenant_id = d.tenant_id
           AND ep.status = 'active'
           AND ep.secret_encrypted LIKE 'v1:%:%:%'
       )
       ORDER BY d.next_attempt_at, d.created_at, d.id
       FOR UPDATE OF d SKIP LOCKED
       LIMIT $1
     )
     UPDATE deliveries AS d
     SET status = 'processing',
         locked_by = $2,
         locked_until = NOW() + ($3 * INTERVAL '1 second'),
         processing_started_at = NOW(),
         first_attempt_at = COALESCE(d.first_attempt_at, NOW()),
         attempt_count = d.attempt_count + 1,
         updated_at = NOW()
     FROM candidates
     WHERE d.id = candidates.id
     RETURNING
       d.id,
       d.tenant_id,
       d.event_id,
       d.endpoint_id,
       d.status,
       d.attempt_count,
       d.first_attempt_at,
       d.locked_until`,
    [
      batchSize,
      workerId,
      leaseSeconds,
      MAX_DELIVERY_ATTEMPTS,
      MAX_RETRY_WINDOW_MS,
    ],
  );

  return result.rows;
}

export async function completeDelivery(
  db,
  { deliveryId, workerId, responseStatus, responseBody },
) {
  const result = await db.query(
    `UPDATE deliveries
     SET status = 'succeeded',
         response_status = $3,
         response_body = $4,
         last_error = NULL,
         failure_code = NULL,
         completed_at = NOW(),
         updated_at = NOW(),
         locked_by = NULL,
         locked_until = NULL,
         processing_started_at = NULL
     WHERE id = $1
       AND status = 'processing'
       AND locked_by = $2
       AND locked_until > NOW()
     RETURNING id, status, response_status, completed_at`,
    [
      deliveryId,
      workerId,
      responseStatus,
      responseBody ?? null,
    ],
  );

  return result.rows[0] ?? null;
}

export async function recordDeliveryFailure(
  db,
  {
    deliveryId,
    workerId,
    errorMessage,
    responseStatus = null,
    failureCode = "UNCLASSIFIED_ERROR",
    action = "retry",
    retryDelayMs,
    retryDelaySeconds,
  },
) {
  if (!["retry", "dead"].includes(action)) {
    throw new Error("action must be 'retry' or 'dead'");
  }

  // retryDelayMs is preferred. retryDelaySeconds remains supported
  // for existing callers and tests.
  let delayMs = retryDelayMs;

  if (delayMs === undefined && retryDelaySeconds !== undefined) {
    delayMs = retryDelaySeconds * 1000;
  }

  if (delayMs === undefined) {
    delayMs = 60_000;
  }

  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error("retry delay must be a non-negative safe integer");
  }

  if (typeof failureCode !== "string" || !failureCode.trim()) {
    throw new Error("A valid failureCode is required");
  }

  const result = await db.query(
    `UPDATE deliveries
     SET status = $3,
         response_status = $4,
         last_error = $5,
         failure_code = $6,
         dead_at = CASE
           WHEN $3::varchar = 'dead'
             THEN COALESCE(dead_at, NOW())
           ELSE NULL
         END,
         next_attempt_at = CASE
           WHEN $3::varchar = 'retrying'
             THEN NOW() + ($7 * INTERVAL '1 millisecond')
           ELSE next_attempt_at
         END,
         updated_at = NOW(),
         locked_by = NULL,
         locked_until = NULL,
         processing_started_at = NULL
     WHERE id = $1
       AND status = 'processing'
       AND locked_by = $2
       AND locked_until > NOW()
     RETURNING
       id,
       status,
       response_status,
       next_attempt_at,
       first_attempt_at,
       dead_at,
       failure_code`,
    [
      deliveryId,
      workerId,
      action === "dead" ? "dead" : "retrying",
      responseStatus,
      String(errorMessage ?? "Delivery failed").slice(0, 2000),
      failureCode.slice(0, 100),
      delayMs,
    ],
  );

  return result.rows[0] ?? null;
}



export async function replayDeadDelivery(
  db,
  { tenantId, deliveryId },
) {
  if (
    !tenantId ||
    typeof tenantId !== "string" ||
    !deliveryId ||
    typeof deliveryId !== "string"
  ) {
    throw new Error("Valid tenantId and deliveryId are required");
  }

  // A Pool exposes connect(); a checked-out pg Client does not.
  const isPool = typeof db.connect === "function";
  const client = isPool ? await db.connect() : db;
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const result = await client.query(
      `SELECT
         id,
         tenant_id,
         status,
         attempt_count,
         failure_code,
         last_error
       FROM deliveries
       WHERE tenant_id = $1
         AND id = $2
       FOR UPDATE`,
      [tenantId, deliveryId],
    );

    const delivery = result.rows[0];

    if (!delivery) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return { outcome: "not_found" };
    }

    if (delivery.status !== "dead") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return {
        outcome: "not_replayable",
        status: delivery.status,
      };
    }

    await client.query(
      `INSERT INTO delivery_replay_audit (
         tenant_id,
         delivery_id,
         previous_failure_code,
         previous_error,
         previous_attempt_count
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        deliveryId,
        delivery.failure_code,
        delivery.last_error,
        delivery.attempt_count,
      ],
    );

    const updated = await client.query(
      `UPDATE deliveries
       SET status = 'retrying',
           attempt_count = 0,
           first_attempt_at = NULL,
           dead_at = NULL,
           failure_code = NULL,
           last_error = NULL,
           response_status = NULL,
           response_body = NULL,
           completed_at = NULL,
           next_attempt_at = NOW(),
           updated_at = NOW(),
           locked_by = NULL,
           locked_until = NULL,
           processing_started_at = NULL
       WHERE tenant_id = $1
         AND id = $2
         AND status = 'dead'
       RETURNING
         id,
         tenant_id,
         status,
         attempt_count,
         next_attempt_at`,
      [tenantId, deliveryId],
    );

    if (updated.rows.length !== 1) {
      throw new Error("Delivery state changed during replay");
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      outcome: "replayed",
      delivery: updated.rows[0],
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    throw error;
  } finally {
    if (isPool) {
      client.release();
    }
  }
}
