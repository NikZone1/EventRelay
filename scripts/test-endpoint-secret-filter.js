
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { claimDueDeliveries } from "../models/delivery.js";
import { encryptSecret } from "../services/secret.js";

let tenantId;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS: ${message}`);
}

try {
  // Avoid claiming unrelated due deliveries during this test.
  const existing = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM deliveries d
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
    AND EXISTS (
      SELECT 1
      FROM endpoints ep
      WHERE ep.id = d.endpoint_id
        AND ep.tenant_id = d.tenant_id
        AND ep.status = 'active'
        AND ep.secret_encrypted LIKE 'v1:%:%:%'
    )
  `);

  if (existing.rows[0].count > 0) {
    throw new Error(
      "There are already eligible deliveries in the database. " +
      "Stop workers and resolve or defer those deliveries before running this test.",
    );
  }

  // Create an isolated tenant.
  const tenant = await pool.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id`,
    [`endpoint-filter-test-${randomUUID()}`],
  );

  tenantId = tenant.rows[0].id;

  // Create two independent events.
  const eventIds = [];

  for (const eventType of [
    "test.disabled-endpoint",
    "test.invalid-secret",
  ]) {
    const result = await pool.query(
      `INSERT INTO events
         (tenant_id, idempotency_key, event_type, payload, request_hash)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)
       RETURNING id`,
      [tenantId, randomUUID(), eventType, randomUUID()],
    );

    eventIds.push(result.rows[0].id);
  }

  // Endpoint 1: disabled, with a valid encrypted secret.
  const disabledEndpoint = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted, status)
     VALUES ($1, $2, $3, 'disabled')
     RETURNING id`,
    [
      tenantId,
      "https://example.com/disabled-filter-test",
      encryptSecret("disabled-endpoint-test-secret"),
    ],
  );

  // Endpoint 2: active, but its secret is not encrypted.
  const invalidEndpoint = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id`,
    [
      tenantId,
      "https://example.com/invalid-secret-filter-test",
      "TEST_ONLY_NOT_ENCRYPTED",
    ],
  );

  const disabledDelivery = await pool.query(
    `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [tenantId, eventIds[0], disabledEndpoint.rows[0].id],
  );

  const invalidSecretDelivery = await pool.query(
    `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [tenantId, eventIds[1], invalidEndpoint.rows[0].id],
  );

  const excludedIds = new Set([
    disabledDelivery.rows[0].id,
    invalidSecretDelivery.rows[0].id,
  ]);

  // The claim query should exclude both test deliveries.
  const claimed = await claimDueDeliveries(pool, {
    workerId: `endpoint-filter-test-${randomUUID()}`,
    batchSize: 10,
    leaseSeconds: 30,
  });

  assert(
    !claimed.some((delivery) => excludedIds.has(delivery.id)),
    "Disabled endpoints and plaintext placeholder secrets are not claimable",
  );

  const states = await pool.query(
    `SELECT id, status, locked_by
     FROM deliveries
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[...excludedIds]],
  );

  assert(
    states.rows.length === 2 &&
      states.rows.every(
        (row) => row.status === "pending" && row.locked_by === null,
      ),
    "Excluded deliveries remain pending and unclaimed",
  );

  console.log("\nAll endpoint-filter tests passed.");
} catch (error) {
  console.error("\nEndpoint-filter test failed:", error);
  process.exitCode = 1;
} finally {
  if (tenantId) {
    try {
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
