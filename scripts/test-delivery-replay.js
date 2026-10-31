
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { replayDeadDelivery } from "../models/delivery.js";

let tenantId;
let otherTenantId;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS: ${message}`);
}

async function createDeliveryForTenant(id, status = "dead") {
  const event = await pool.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [id, randomUUID(), "test.replay", "{}", randomUUID()],
  );

  const endpoint = await pool.query(
    `INSERT INTO endpoints
       (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      id,
      "https://example.com/replay-test",
      "test-encrypted-secret",
    ],
  );

  const delivery = await pool.query(
    `INSERT INTO deliveries (
       tenant_id,
       event_id,
       endpoint_id,
       status,
       attempt_count,
       first_attempt_at,
       dead_at,
       failure_code,
       last_error
     )
     VALUES (
       $1, $2, $3, $4::varchar, 10,
       NOW() - INTERVAL '25 hours',
       CASE WHEN $4::varchar = 'dead' THEN NOW() ELSE NULL END,
       CASE WHEN $4::varchar = 'dead' THEN 'HTTP_500' ELSE NULL END,
       CASE WHEN $4::varchar = 'dead' THEN 'Simulated failure' ELSE NULL END
     )
     RETURNING id`,
    [id, event.rows[0].id, endpoint.rows[0].id, status],
  );

  return delivery.rows[0].id;
}

try {
  // Create two isolated tenants for the replay and security tests.
  const tenant = await pool.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id`,
    [`delivery-replay-test-${randomUUID()}`],
  );

  tenantId = tenant.rows[0].id;

  const otherTenant = await pool.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id`,
    [`delivery-replay-other-tenant-${randomUUID()}`],
  );

  otherTenantId = otherTenant.rows[0].id;

  // 1. Replay a dead delivery.
  const deadDeliveryId = await createDeliveryForTenant(tenantId);

  const replay = await replayDeadDelivery(pool, {
    tenantId,
    deliveryId: deadDeliveryId,
  });

  assert(
    replay.outcome === "replayed",
    "Dead delivery can be replayed",
  );

  assert(
    replay.delivery.status === "retrying",
    "Replayed delivery returns to retrying",
  );

  assert(
    Number(replay.delivery.attempt_count) === 0,
    "Replay receives a fresh attempt budget",
  );

  // 2. Verify the delivery state after replay.
  const state = await pool.query(
    `SELECT
       status,
       dead_at,
       failure_code,
       last_error,
       first_attempt_at,
       next_attempt_at <= NOW() AS due_now
     FROM deliveries
     WHERE tenant_id = $1
       AND id = $2`,
    [tenantId, deadDeliveryId],
  );

  const replayedState = state.rows[0];

  assert(
    replayedState.dead_at === null,
    "Dead timestamp is cleared",
  );

  assert(
    replayedState.failure_code === null,
    "Current failure code is cleared",
  );

  assert(
    replayedState.last_error === null,
    "Current error is cleared",
  );

  assert(
    replayedState.first_attempt_at === null,
    "Retry window resets",
  );

  assert(
    replayedState.due_now === true,
    "Replayed delivery is immediately due",
  );

  // 3. Verify that the original failure remains in the audit trail.
  const audit = await pool.query(
    `SELECT
       previous_failure_code,
       previous_error,
       previous_attempt_count
     FROM delivery_replay_audit
     WHERE tenant_id = $1
       AND delivery_id = $2`,
    [tenantId, deadDeliveryId],
  );

  assert(
    audit.rows.length === 1,
    "Replay creates one audit record",
  );

  assert(
    audit.rows[0].previous_failure_code === "HTTP_500",
    "Audit preserves the previous failure code",
  );

  assert(
    audit.rows[0].previous_error === "Simulated failure",
    "Audit preserves the previous error",
  );

  assert(
    Number(audit.rows[0].previous_attempt_count) === 10,
    "Audit preserves the previous attempt count",
  );

  // 4. A replay should not be accepted while the delivery is retrying.
  const secondReplay = await replayDeadDelivery(pool, {
    tenantId,
    deliveryId: deadDeliveryId,
  });

  assert(
    secondReplay.outcome === "not_replayable",
    "A delivery cannot be replayed again while retrying",
  );

  // 5. Another tenant must not be able to access this delivery.
  const crossTenantReplay = await replayDeadDelivery(pool, {
    tenantId: otherTenantId,
    deliveryId: deadDeliveryId,
  });

  assert(
    crossTenantReplay.outcome === "not_found",
    "Another tenant cannot replay this delivery",
  );

  // 6. A pending delivery is not eligible for manual replay.
  const activeDeliveryId = await createDeliveryForTenant(
    tenantId,
    "pending",
  );

  const activeReplay = await replayDeadDelivery(pool, {
    tenantId,
    deliveryId: activeDeliveryId,
  });

  assert(
    activeReplay.outcome === "not_replayable",
    "A pending delivery cannot be replayed",
  );

  // 7. Unknown delivery IDs should return not_found.
  const missingReplay = await replayDeadDelivery(pool, {
    tenantId,
    deliveryId: randomUUID(),
  });

  assert(
    missingReplay.outcome === "not_found",
    "Unknown delivery IDs return not_found",
  );

  console.log("\nAll delivery-replay tests passed.");
} catch (error) {
  console.error("\nDelivery-replay test failed:", error);
  process.exitCode = 1;
} finally {
  // Clean up test records for both tenants.
  for (const id of [tenantId, otherTenantId].filter(Boolean)) {
    try {
      await pool.query(
        `DELETE FROM delivery_replay_audit
         WHERE tenant_id = $1`,
        [id],
      );

      await pool.query(
        `DELETE FROM deliveries
         WHERE tenant_id = $1`,
        [id],
      );

      await pool.query(
        `DELETE FROM endpoints
         WHERE tenant_id = $1`,
        [id],
      );

      await pool.query(
        `DELETE FROM outbox_events
         WHERE event_id IN (
           SELECT id
           FROM events
           WHERE tenant_id = $1
         )`,
        [id],
      );

      await pool.query(
        `DELETE FROM events
         WHERE tenant_id = $1`,
        [id],
      );

      await pool.query(
        `DELETE FROM tenants
         WHERE id = $1`,
        [id],
      );
    } catch (error) {
      console.error("Cleanup failed:", error.message);
      process.exitCode = 1;
    }
  }

  await pool.end();
}
