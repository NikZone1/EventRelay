
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { replayDeadDelivery } from "../models/delivery.js";

let tenantId;
let deliveryId;
let triggerInstalled = false;

const triggerName = "eventrelay_test_fail_replay_audit";
const functionName = "eventrelay_test_fail_replay_audit_fn";

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

try {
  // Create isolated test records.
  const tenant = await pool.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id`,
    [`replay-rollback-test-${randomUUID()}`],
  );

  tenantId = tenant.rows[0].id;

  const event = await pool.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [tenantId, randomUUID(), "test.replay.rollback", "{}", randomUUID()],
  );

  const endpoint = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      tenantId,
      "https://example.com/replay-rollback-test",
      "test-placeholder",
    ],
  );

  const delivery = await pool.query(
    `INSERT INTO deliveries (
       tenant_id,
       event_id,
       endpoint_id,
       status,
       attempt_count,
       dead_at,
       failure_code,
       last_error
     )
     VALUES ($1, $2, $3, 'dead', 10, NOW(), $4, $5)
     RETURNING id`,
    [
      tenantId,
      event.rows[0].id,
      endpoint.rows[0].id,
      "HTTP_500",
      "Simulated failure before replay",
    ],
  );

  deliveryId = delivery.rows[0].id;

  // Install a temporary trigger that deliberately rejects audit inserts.
  // This trigger is removed in finally.
  await pool.query(
    `CREATE OR REPLACE FUNCTION ${functionName}()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $$
     BEGIN
       RAISE EXCEPTION 'Simulated replay audit insert failure';
     END;
     $$`,
  );

  await pool.query(
    `CREATE TRIGGER ${triggerName}
     BEFORE INSERT ON delivery_replay_audit
     FOR EACH ROW
     EXECUTE FUNCTION ${functionName}()`,
  );

  triggerInstalled = true;

  // Replay must fail because its audit insert is rejected.
  let replayFailed = false;

  try {
    await replayDeadDelivery(pool, {
      tenantId,
      deliveryId,
    });
  } catch (error) {
    replayFailed = true;

    assert(
      error.message.includes("Simulated replay audit insert failure"),
      "Replay fails when the audit insert fails",
    );
  }

  assert(replayFailed, "The injected database failure is propagated");

  // Confirm that the delivery update was rolled back.
  const state = await pool.query(
    `SELECT status, attempt_count, failure_code, last_error
     FROM deliveries
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, deliveryId],
  );

  assert(state.rows.length === 1, "Original delivery still exists");
  assert(state.rows[0].status === "dead", "Delivery remains dead");
  assert(
    Number(state.rows[0].attempt_count) === 10,
    "Original attempt count is preserved",
  );
  assert(
    state.rows[0].failure_code === "HTTP_500",
    "Original failure code is preserved",
  );
  assert(
    state.rows[0].last_error === "Simulated failure before replay",
    "Original error is preserved",
  );

  const audit = await pool.query(
    `SELECT id
     FROM delivery_replay_audit
     WHERE tenant_id = $1 AND delivery_id = $2`,
    [tenantId, deliveryId],
  );

  assert(
    audit.rows.length === 0,
    "Failed audit insert leaves no replay audit record",
  );

  console.log("\nAll replay-rollback tests passed.");
} catch (error) {
  console.error("\nReplay-rollback test failed:", error);
  process.exitCode = 1;
} finally {
  // Remove the temporary trigger before cleaning up test records.
  try {
    await pool.query(
      `DROP TRIGGER IF EXISTS ${triggerName}
       ON delivery_replay_audit`,
    );

    await pool.query(
      `DROP FUNCTION IF EXISTS ${functionName}()`,
    );
  } catch (error) {
    console.error("Temporary trigger cleanup failed:", error.message);
    process.exitCode = 1;
  }

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
      console.error("Test-record cleanup failed:", error.message);
      process.exitCode = 1;
    }
  }

  await pool.end();
}
