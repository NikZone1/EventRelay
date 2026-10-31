
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import {
  claimDueDeliveries,
  recordDeliveryFailure,
} from "../models/delivery.js";
import { encryptSecret } from "../services/secret.js";

let tenantId;

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

try {
  const tenant = await pool.query(
    `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
    [`delivery-failure-test-${randomUUID()}`],
  );
  tenantId = tenant.rows[0].id;

  const event = await pool.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [tenantId, randomUUID(), "test.failure", "{}", "failure-test-hash"],
  );

  const endpoint = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      tenantId,
      "https://example.com/failure-test",
      encryptSecret("delivery-failure-test-secret"),
    ],
  );

  const delivery = await pool.query(
    `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, event.rows[0].id, endpoint.rows[0].id],
  );

  const deliveryId = delivery.rows[0].id;
  const workerId = `failure-worker-${randomUUID()}`;

  const claimed = await claimDueDeliveries(pool, {
    workerId,
    batchSize: 1,
    leaseSeconds: 60,
  });

  assert(
    claimed.some((row) => row.id === deliveryId),
    "Test delivery can be claimed",
  );

  const failed = await recordDeliveryFailure(pool, {
    deliveryId,
    workerId,
    errorMessage: "Simulated HTTP 500",
    responseStatus: 500,
    retryDelaySeconds: 60,
  });

  assert(failed?.status === "retrying", "Failure schedules a retry");
  assert(
    Number(failed?.response_status) === 500,
    "HTTP status is recorded",
  );

  const state = await pool.query(
    `SELECT status, locked_by, locked_until, processing_started_at,
            next_attempt_at > NOW() AS retry_is_future
     FROM deliveries WHERE id = $1`,
    [deliveryId],
  );

  const row = state.rows[0];

  assert(row.locked_by === null, "Worker ownership is cleared");
  assert(row.locked_until === null, "Lease is cleared");
  assert(row.processing_started_at === null, "Processing timestamp is cleared");
  assert(row.retry_is_future === true, "Retry is scheduled in the future");

  console.log("\nAll delivery-failure tests passed.");
} catch (error) {
  console.error("\nDelivery-failure test failed:", error);
  process.exitCode = 1;
} finally {
  if (tenantId) {
    try {
      await pool.query(`DELETE FROM deliveries WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM endpoints WHERE tenant_id = $1`, [tenantId]);
      await pool.query(
        `DELETE FROM outbox_events
         WHERE event_id IN (SELECT id FROM events WHERE tenant_id = $1)`,
        [tenantId],
      );
      await pool.query(`DELETE FROM events WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    } catch (error) {
      console.error("Cleanup failed:", error.message);
      process.exitCode = 1;
    }
  }

  await pool.end();
}
