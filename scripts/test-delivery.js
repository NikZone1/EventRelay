
import { randomUUID, createHash } from "node:crypto";
import { pool } from "../config/db.js";
import { createDeliveriesForEvent } from "../services/delivery.js";

const testId = randomUUID();
const tenantName = `delivery-test-${testId}`;
const eventType = `test.delivery.${testId}`;
const noMatchEventType = `test.no-match.${testId}`;

let tenantId;
let endpointId;
let eventId;
let noMatchEventId;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS: ${message}`);
}

async function createTestEvent(db, tenantId, eventType, suffix) {
  const idempotencyKey = `${testId}-${suffix}`;
  const payload = { testId, scenario: suffix };
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ eventType, payload }))
    .digest("hex");

  const result = await db.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [tenantId, idempotencyKey, eventType, JSON.stringify(payload), requestHash],
  );

  return result.rows[0].id;
}

async function cleanup() {
  if (!tenantId) return;

  // Remove only records created by this test.
  await pool.query(
    `DELETE FROM deliveries WHERE tenant_id = $1`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM subscriptions WHERE tenant_id = $1`,
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
  await pool.query(`DELETE FROM events WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

try {
  // Create isolated test data.
  const tenantResult = await pool.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id`,
    [tenantName],
  );
  tenantId = tenantResult.rows[0].id;

  eventId = await createTestEvent(pool, tenantId, eventType, "matching");
  noMatchEventId = await createTestEvent(
    pool,
    tenantId,
    noMatchEventType,
    "no-match",
  );

  const endpointResult = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      tenantId,
      "https://example.com/eventrelay-delivery-test",
      "test-only-placeholder-not-a-real-secret",
    ],
  );
  endpointId = endpointResult.rows[0].id;

  await pool.query(
    `INSERT INTO subscriptions (tenant_id, endpoint_id, event_type)
     VALUES ($1, $2, $3)`,
    [tenantId, endpointId, eventType],
  );

  console.log("\n--- Delivery engine tests ---");

  // Test 1: A matching subscription creates one delivery.
  const first = await createDeliveriesForEvent({ tenantId, eventId });

  assert(first.matchedEndpoints === 1, "Matching endpoint is found");
  assert(first.created === 1, "First processing creates one delivery");
  assert(first.alreadyExisted === 0, "First processing finds no duplicate");

  // Test 2: Reprocessing the same event must not duplicate delivery.
  const second = await createDeliveriesForEvent({ tenantId, eventId });

  assert(second.created === 0, "Reprocessing creates no duplicate");
  assert(second.alreadyExisted === 1, "Existing delivery is recognized");

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM deliveries
     WHERE tenant_id = $1 AND event_id = $2 AND endpoint_id = $3`,
    [tenantId, eventId, endpointId],
  );

  assert(
    countResult.rows[0].count === 1,
    "Exactly one delivery exists for the event and endpoint",
  );

  // Test 3: An event without a matching subscription creates no delivery.
  const noMatch = await createDeliveriesForEvent({
    tenantId,
    eventId: noMatchEventId,
  });

  assert(noMatch.matchedEndpoints === 0, "No-match event finds no endpoints");
  assert(noMatch.created === 0, "No-match event creates no deliveries");

  console.log("\nAll delivery engine tests passed.");
} catch (error) {
  console.error("\nDelivery engine test failed:", error);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error("Test cleanup failed:", cleanupError.message);
    process.exitCode = 1;
  }

  await pool.end();
}
