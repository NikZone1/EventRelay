
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import {
  claimDueDeliveries,
  completeDelivery,
} from "../models/delivery.js";
import { encryptSecret } from "../services/secret.js";

const workerA = `test-worker-a-${randomUUID()}`;
const workerB = `test-worker-b-${randomUUID()}`;
const recoveryWorker = `test-recovery-${randomUUID()}`;

let tenantId;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS: ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // 1. Create an isolated tenant.
  const tenantResult = await pool.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id`,
    [`delivery-claim-test-${randomUUID()}`],
  );

  tenantId = tenantResult.rows[0].id;

  // 2. Create the event used by the concurrency test.
  const eventResult = await pool.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [tenantId, randomUUID(), "test.claim", "{}", "claim-test-hash"],
  );

  const eventId = eventResult.rows[0].id;

  // 3. Create an endpoint with an encrypted test secret.
  const endpointResult = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      tenantId,
      "https://example.com/claim-test",
      encryptSecret("delivery-claims-test-secret"),
    ],
  );

  const endpointId = endpointResult.rows[0].id;

  // 4. Create the concurrency-test delivery.
  const deliveryResult = await pool.query(
    `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [tenantId, eventId, endpointId],
  );

  const deliveryId = deliveryResult.rows[0].id;

  // 5. Two workers attempt to claim concurrently.
  const [claimedA, claimedB] = await Promise.all([
    claimDueDeliveries(pool, {
      workerId: workerA,
      batchSize: 1,
      leaseSeconds: 60,
    }),
    claimDueDeliveries(pool, {
      workerId: workerB,
      batchSize: 1,
      leaseSeconds: 60,
    }),
  ]);

  const targetClaimedByA = claimedA.some((row) => row.id === deliveryId);
  const targetClaimedByB = claimedB.some((row) => row.id === deliveryId);

  assert(
    targetClaimedByA !== targetClaimedByB,
    "Concurrent workers cannot claim the same delivery",
  );

  const ownerWorkerId = targetClaimedByA ? workerA : workerB;
  const otherWorkerId = targetClaimedByA ? workerB : workerA;

  // 6. The current owner can complete the delivery.
  const completed = await completeDelivery(pool, {
    deliveryId,
    workerId: ownerWorkerId,
    responseStatus: 200,
    responseBody: "test response",
  });

  assert(
    completed?.status === "succeeded",
    "Current lease owner can complete",
  );

  // 7. Another worker cannot complete it again.
  const lateCompletion = await completeDelivery(pool, {
    deliveryId,
    workerId: otherWorkerId,
    responseStatus: 200,
    responseBody: "late response",
  });

  assert(
    lateCompletion === null,
    "A different worker cannot complete the delivery",
  );

  // 8. Create a separate event for lease-recovery testing.
  // The unique (event_id, endpoint_id) constraint remains intact.
  const recoveryEventResult = await pool.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [tenantId, randomUUID(), "test.lease-recovery", "{}", "recovery-test-hash"],
  );

  const recoveryEventId = recoveryEventResult.rows[0].id;

  const recoveryDeliveryResult = await pool.query(
    `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [tenantId, recoveryEventId, endpointId],
  );

  const recoveryDeliveryId = recoveryDeliveryResult.rows[0].id;

  // 9. Worker A claims the recovery delivery with a 2-second lease.
  const firstClaim = await claimDueDeliveries(pool, {
    workerId: workerA,
    batchSize: 10,
    leaseSeconds: 2,
  });

  assert(
    firstClaim.some((row) => row.id === recoveryDeliveryId),
    "Worker A claims the recovery-test delivery",
  );

  // Simulate a crashed worker: do not complete or release the lease.
  await sleep(3000);

  // 10. Worker B should reclaim the delivery after expiry.
  const recovered = await claimDueDeliveries(pool, {
    workerId: recoveryWorker,
    batchSize: 10,
    leaseSeconds: 30,
  });

  assert(
    recovered.some((row) => row.id === recoveryDeliveryId),
    "Worker B reclaims the delivery after lease expiry",
  );

  // 11. The old owner must not be able to complete after recovery.
  const staleCompletion = await completeDelivery(pool, {
    deliveryId: recoveryDeliveryId,
    workerId: workerA,
    responseStatus: 200,
    responseBody: "stale worker response",
  });

  assert(
    staleCompletion === null,
    "Expired lease owner cannot complete after recovery",
  );

  console.log("\nAll delivery-claim and lease-recovery tests passed.");
} catch (error) {
  console.error("\nDelivery-claim test failed:", error);
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
