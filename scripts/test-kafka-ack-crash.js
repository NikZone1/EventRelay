
import { pool } from "../config/db.js";
import {
  connectKafkaProducer,
  publishMessage,
  disconnectKafkaProducer,
} from "../config/kafka.js";
import {
  claimOutboxEvents,
  markOutboxPublished,
  releaseOutboxClaim,
} from "../models/outbox.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const crashedPublisher = `crashed-${Date.now()}`;
const recoveryPublisher = `recovery-${Date.now()}`;

let firstClaim;
let recoveryClaim;
let connected = false;
let completed = false;

try {
  const pending = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM outbox_events
     WHERE published_at IS NULL`
  );

  if (pending.rows[0].count !== 1) {
    throw new Error(
      `Expected exactly 1 pending outbox record, found ${pending.rows[0].count}. ` +
      "Use a dedicated test event and ensure no other records are pending."
    );
  }

  await connectKafkaProducer();
  connected = true;

  const firstBatch = await claimOutboxEvents(pool, {
    publisherId: crashedPublisher,
    batchSize: 1,
    leaseSeconds: 2,
  });

  if (firstBatch.length !== 1) {
    throw new Error("Could not claim the test outbox record.");
  }

  firstClaim = firstBatch[0];

  const message = {
    messageVersion: 1,
    eventId: firstClaim.event_id,
    tenantId: firstClaim.tenant_id,
  };

  console.log("Simulating crash after Kafka acknowledgement.");

  await publishMessage({
    key: message.tenantId,
    value: message,
  });

  // Intentionally do NOT mark the record as published.
  console.log("First Kafka publish acknowledged; DB update skipped.");

  await sleep(3000);

  const recoveryBatch = await claimOutboxEvents(pool, {
    publisherId: recoveryPublisher,
    batchSize: 1,
    leaseSeconds: 30,
  });

  recoveryClaim = recoveryBatch.find(
    (row) => String(row.outbox_id) === String(firstClaim.outbox_id)
  );

  if (!recoveryClaim) {
    throw new Error("The expired outbox record was not reclaimed.");
  }

  console.log("Expired lease recovered; publishing the same event again.");

  await publishMessage({
    key: message.tenantId,
    value: message,
  });

  const marked = await markOutboxPublished(pool, {
    outboxId: recoveryClaim.outbox_id,
    publisherId: recoveryPublisher,
  });

  if (!marked) {
    throw new Error("Could not mark the recovered record as published.");
  }

  completed = true;
  console.log("PASS: duplicate publication simulated and outbox marked published.");
  console.log("Event ID:", message.eventId);
} catch (error) {
  console.error("Crash-window test failed:", error.message);
  process.exitCode = 1;
} finally {
  // Release only our own claims if publication did not complete.
  if (!completed) {
    try {
      await pool.query(
        `UPDATE outbox_events
         SET locked_by = NULL, locked_until = NULL
         WHERE locked_by = ANY($1::varchar[])
           AND published_at IS NULL`,
        [[crashedPublisher, recoveryPublisher]]
      );
    } catch (error) {
      console.error("Claim cleanup failed:", error.message);
    }
  }

  if (connected) {
    try {
      await disconnectKafkaProducer();
    } catch (error) {
      console.error("Kafka disconnect failed:", error.message);
      process.exitCode = 1;
    }
  }

  await pool.end();
}
