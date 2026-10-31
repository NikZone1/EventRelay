
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { claimOutboxEvents } from "../models/outbox.js";

const crashedPublisher = `crashed-${randomUUID()}`;
const recoveryPublisher = `recovery-${randomUUID()}`;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let firstClaim = [];
let recoveredClaim = [];

try {
  // Simulate a publisher claiming a record and then crashing.
  firstClaim = await claimOutboxEvents(pool, {
    publisherId: crashedPublisher,
    batchSize: 1,
    leaseSeconds: 2,
  });

  if (firstClaim.length === 0) {
    console.log("No pending outbox records available for testing.");
  } else {
    const original = firstClaim[0];

    console.log("Initial claim:", original);

    // Simulate the crashed publisher never releasing its lease.
    await sleep(3000);

    recoveredClaim = await claimOutboxEvents(pool, {
      publisherId: recoveryPublisher,
      batchSize: 1,
      leaseSeconds: 30,
    });

    const recovered = recoveredClaim.find(
      (row) => String(row.outbox_id) === String(original.outbox_id)
    );

    if (!recovered) {
      throw new Error(
        `Outbox record ${original.outbox_id} was not recovered`
      );
    }

    console.log("Recovered claim:", recovered);
    console.log("PASS: expired lease was recovered.");
  }
} catch (error) {
  console.error("Recovery test failed:", error.message);
  process.exitCode = 1;
} finally {
  try {
    await pool.query(
      `UPDATE outbox_events
       SET locked_by = NULL, locked_until = NULL
       WHERE locked_by = ANY($1::varchar[])
         AND published_at IS NULL`,
      [[crashedPublisher, recoveryPublisher]]
    );

    console.log("Test claims released.");
  } catch (error) {
    console.error("Claim cleanup failed:", error.message);
    process.exitCode = 1;
  }

  await pool.end();
}
