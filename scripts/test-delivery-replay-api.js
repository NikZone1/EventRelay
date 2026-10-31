
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import app from "../app.js";
import { pool } from "../config/db.js";

let server;
let tenantIds = [];

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

async function createTestTenant(label) {
  const tenantResult = await pool.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id`,
    [`replay-api-${label}-${randomUUID()}`],
  );

  const tenantId = tenantResult.rows[0].id;
  tenantIds.push(tenantId);

  const secret = `er_test_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(secret).digest("hex");
  const keyPrefix = secret.slice(0, 12);

  await pool.query(
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, "Replay API integration test", keyPrefix, keyHash],
  );

  return { tenantId, secret };
}

async function createDelivery(tenantId, status) {
  const eventResult = await pool.query(
    `INSERT INTO events
       (tenant_id, idempotency_key, event_type, payload, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [tenantId, randomUUID(), "test.replay.api", "{}", randomUUID()],
  );

  // The replay API does not send the webhook during this test.
  const endpointResult = await pool.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [tenantId, "https://example.com/replay-api-test", "test-placeholder"],
  );

  const deliveryResult = await pool.query(
    `INSERT INTO deliveries (
       tenant_id, event_id, endpoint_id, status, attempt_count,
       first_attempt_at, dead_at, failure_code, last_error
     )
     VALUES (
       $1, $2, $3, $4::varchar, 10,
       NOW() - INTERVAL '25 hours',
       CASE WHEN $4::varchar = 'dead' THEN NOW() ELSE NULL END,
       CASE WHEN $4::varchar = 'dead' THEN 'HTTP_500' ELSE NULL END,
       CASE WHEN $4::varchar = 'dead' THEN 'Simulated failure' ELSE NULL END
     )
     RETURNING id`,
    [tenantId, eventResult.rows[0].id, endpointResult.rows[0].id, status],
  );

  return deliveryResult.rows[0].id;
}

async function requestReplay(port, deliveryId, apiKey) {
  const headers = {};

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return fetch(
    `http://127.0.0.1:${port}/api/eventRelay/v1/events/deliveries/${deliveryId}/replay`,
    { method: "POST", headers },
  );
}

try {
  const firstTenant = await createTestTenant("first");
  const secondTenant = await createTestTenant("second");

  server = createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = address.port;

  // 1. Missing authentication.
  const unauthenticated = await requestReplay(
    port,
    randomUUID(),
    null,
  );

  assert(
    unauthenticated.status === 401,
    "Replay route rejects missing authentication",
  );

  // 2. Successful replay by the owning tenant.
  const deadDeliveryId = await createDelivery(
    firstTenant.tenantId,
    "dead",
  );

  const successfulReplay = await requestReplay(
    port,
    deadDeliveryId,
    firstTenant.secret,
  );

  assert(
    successfulReplay.status === 202,
    "Authenticated tenant can replay a dead delivery",
  );

  const successBody = await successfulReplay.json();

  assert(
    successBody.data?.status === "retrying",
    "Replay API returns the updated delivery state",
  );

  // 3. A different tenant cannot replay the delivery.
  const crossTenant = await requestReplay(
    port,
    deadDeliveryId,
    secondTenant.secret,
  );

  assert(
    crossTenant.status === 404,
    "Cross-tenant replay returns not found",
  );

  // 4. A non-dead delivery cannot be replayed.
  const pendingDeliveryId = await createDelivery(
    firstTenant.tenantId,
    "pending",
  );

  const pendingReplay = await requestReplay(
    port,
    pendingDeliveryId,
    firstTenant.secret,
  );

  assert(
    pendingReplay.status === 409,
    "Replay API rejects a pending delivery",
  );

  // 5. Unknown delivery ID.
  const missingDelivery = await requestReplay(
    port,
    randomUUID(),
    firstTenant.secret,
  );

  assert(
    missingDelivery.status === 404,
    "Replay API returns not found for an unknown delivery",
  );

  console.log("\nAll delivery-replay API tests passed.");
} catch (error) {
  console.error("\nDelivery-replay API test failed:", error);
  process.exitCode = 1;
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  for (const tenantId of tenantIds) {
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
        `DELETE FROM api_keys WHERE tenant_id = $1`,
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
