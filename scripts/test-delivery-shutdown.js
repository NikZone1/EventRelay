
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { encryptSecret } from "../services/secret.js";
import { sendDelivery } from "../services/sendDelivery.js";
import {
  runDeliverySender,
  stopDeliverySender,
} from "../workers/deliverySender.js";

let tenantId;
let deliveryId;
let releaseRequest;
let workerPromise;
let workerFinished = false;
let shuttingDown = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

try {
  // Keep the test isolated from unrelated due deliveries.
  const existing = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM deliveries d
    WHERE (
      (d.status IN ('pending', 'retrying') AND d.next_attempt_at <= NOW())
      OR (d.status = 'processing' AND d.locked_until <= NOW())
    )
    AND EXISTS (
      SELECT 1 FROM endpoints ep
      WHERE ep.id = d.endpoint_id
        AND ep.tenant_id = d.tenant_id
        AND ep.status = 'active'
        AND ep.secret_encrypted LIKE 'v1:%:%:%'
    )
  `);

  if (existing.rows[0].count > 0) {
    throw new Error(
      "Eligible deliveries already exist. Stop workers and resolve or defer them before this test.",
    );
  }

  const tenant = await pool.query(
    `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
    [`shutdown-test-${randomUUID()}`],
  );
  tenantId = tenant.rows[0].id;

  const event = await pool.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, '{}'::jsonb, $4)
     RETURNING id`,
    [tenantId, randomUUID(), "test.shutdown", randomUUID()],
  );

  const endpoint = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      tenantId,
      "https://example.com/shutdown-test",
      encryptSecret("shutdown-test-secret"),
    ],
  );

  const delivery = await pool.query(
    `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, event.rows[0].id, endpoint.rows[0].id],
  );
  deliveryId = delivery.rows[0].id;

  const requestStarted = deferred();
  const finishRequest = deferred();
  releaseRequest = finishRequest.resolve;

  workerPromise = runDeliverySender({
    batchSize: 1,
    leaseSeconds: 60,
    pollIntervalMs: 100,
    sendDeliveryFn: ({ deliveryId: claimedId, workerId }) =>
      sendDelivery({
        deliveryId: claimedId,
        workerId,
        httpPost: async () => {
          requestStarted.resolve();
          await finishRequest.promise;
          return { statusCode: 200, body: "controlled response" };
        },
      }),
  });

  workerPromise.then(() => {
    workerFinished = true;
  });

  // Fail instead of hanging forever if the worker never starts the request.
  await Promise.race([
    requestStarted.promise,
    sleep(5000).then(() => {
      throw new Error("Timed out waiting for the delivery request to start");
    }),
  ]);

  console.log("Controlled delivery request is in flight.");

  stopDeliverySender();
  shuttingDown = true;

  await sleep(150);

  assert(
    !workerFinished,
    "Shutdown waits while the delivery request is in flight",
  );

  // Let the simulated remote response arrive.
  releaseRequest();

  await workerPromise;

  assert(
    workerFinished,
    "Sender exits after the in-flight request finishes",
  );

  const saved = await pool.query(
    `SELECT status, response_status, locked_by, locked_until
     FROM deliveries WHERE id = $1`,
    [deliveryId],
  );

  assert(
    saved.rows[0]?.status === "succeeded",
    "In-flight delivery success is persisted during shutdown",
  );

  assert(
    saved.rows[0]?.response_status === 200 &&
      saved.rows[0]?.locked_by === null &&
      saved.rows[0]?.locked_until === null,
    "Response status is stored and the lease is cleared",
  );

  console.log("\nAll in-flight shutdown tests passed.");
} catch (error) {
  console.error("\nIn-flight shutdown test failed:", error);
  process.exitCode = 1;
} finally {
  // Prevent a failed assertion from leaving the controlled request hanging.
  if (shuttingDown) releaseRequest?.();

  if (workerPromise && !workerFinished) {
    stopDeliverySender();
    releaseRequest?.();
    await workerPromise.catch((error) => {
      console.error("Worker cleanup failed:", error.message);
      process.exitCode = 1;
    });
  }

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
