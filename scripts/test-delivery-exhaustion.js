
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { claimDueDeliveries } from "../models/delivery.js";
import { encryptSecret } from "../services/secret.js";

let tenantId;

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

async function createDelivery({
  tenantId,
  endpointId,
  status = "pending",
  attemptCount = 0,
  firstAttemptSql = "NULL",
}) {
  const event = await pool.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [
      tenantId,
      randomUUID(),
      "test.exhaustion",
      "{}",
      randomUUID(),
    ],
  );

  // firstAttemptSql is selected only from fixed test constants below.
  const result = await pool.query(
    `INSERT INTO deliveries (
       tenant_id,
       event_id,
       endpoint_id,
       status,
       attempt_count,
       first_attempt_at,
       next_attempt_at
     )
     VALUES (
       $1, $2, $3, $4::varchar, $5,
       ${firstAttemptSql},
       NOW() - INTERVAL '1 minute'
     )
     RETURNING id`,
    [
      tenantId,
      event.rows[0].id,
      endpointId,
      status,
      attemptCount,
    ],
  );

  return result.rows[0].id;
}

try {
  const tenant = await pool.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id`,
    [`delivery-exhaustion-test-${randomUUID()}`],
  );

  tenantId = tenant.rows[0].id;

  const endpoint = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      tenantId,
      "https://example.com/exhaustion-test",
      encryptSecret("delivery-exhaustion-test-secret"),
    ],
  );

  const endpointId = endpoint.rows[0].id;

  // Delivery A: the maximum number of attempts has already been reached.
  const maxAttemptsId = await createDelivery({
    tenantId,
    endpointId,
    attemptCount: 10,
  });

  // Delivery B: the retry window expired more than 24 hours ago.
  const expiredWindowId = await createDelivery({
    tenantId,
    endpointId,
    attemptCount: 2,
    firstAttemptSql: "NOW() - INTERVAL '25 hours'",
  });

  // Delivery C: a normal due delivery should remain claimable.
  const normalDeliveryId = await createDelivery({
    tenantId,
    endpointId,
    attemptCount: 0,
  });

  const workerId = `exhaustion-worker-${randomUUID()}`;

  const claimed = await claimDueDeliveries(pool, {
    workerId,
    batchSize: 10,
    leaseSeconds: 60,
  });

  const claimedIds = new Set(claimed.map((delivery) => delivery.id));

  assert(
    !claimedIds.has(maxAttemptsId),
    "Exhausted-attempt delivery is not claimed",
  );

  assert(
    !claimedIds.has(expiredWindowId),
    "Expired-window delivery is not claimed",
  );

  assert(
    claimedIds.has(normalDeliveryId),
    "Normal due delivery remains claimable",
  );

  const state = await pool.query(
    `SELECT
       id,
       status,
       failure_code,
       dead_at IS NOT NULL AS has_dead_at,
       locked_by
     FROM deliveries
     WHERE tenant_id = $1
       AND id = ANY($2::uuid[])`,
    [tenantId, [maxAttemptsId, expiredWindowId, normalDeliveryId]],
  );

  const byId = new Map(state.rows.map((row) => [row.id, row]));

  assert(
    byId.get(maxAttemptsId)?.status === "dead",
    "Maximum-attempt delivery becomes dead",
  );

  assert(
    byId.get(maxAttemptsId)?.failure_code === "MAX_ATTEMPTS_EXCEEDED",
    "Maximum-attempt failure reason is recorded",
  );

  assert(
    byId.get(maxAttemptsId)?.has_dead_at === true,
    "Maximum-attempt delivery receives a dead timestamp",
  );

  assert(
    byId.get(expiredWindowId)?.status === "dead",
    "Expired-window delivery becomes dead",
  );

  assert(
    byId.get(expiredWindowId)?.failure_code === "RETRY_WINDOW_EXCEEDED",
    "Retry-window failure reason is recorded",
  );

  assert(
    byId.get(expiredWindowId)?.has_dead_at === true,
    "Expired-window delivery receives a dead timestamp",
  );

  assert(
    byId.get(normalDeliveryId)?.status === "processing",
    "Normal delivery enters processing",
  );

  assert(
    byId.get(normalDeliveryId)?.locked_by === workerId,
    "Normal delivery receives the worker lease",
  );

  console.log("\nAll delivery-exhaustion tests passed.");
} catch (error) {
  console.error("\nDelivery-exhaustion test failed:", error);
  process.exitCode = 1;
} finally {
  if (tenantId) {
    try {
      await pool.query(
        `DELETE FROM delivery_replay_audit WHERE tenant_id = $1`,
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
