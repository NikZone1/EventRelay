
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { claimOutboxEvents } from "../models/outbox.js";

const publisherA = `publisher-A-${randomUUID()}`;
const publisherB = `publisher-B-${randomUUID()}`;

let claimsA = [];
let claimsB = [];

try {
  // Both publishers compete for the same pending records.
  [claimsA, claimsB] = await Promise.all([
    claimOutboxEvents(pool, {
      publisherId: publisherA,
      batchSize: 10,
      leaseSeconds: 60,
    }),
    claimOutboxEvents(pool, {
      publisherId: publisherB,
      batchSize: 10,
      leaseSeconds: 60,
    }),
  ]);

  const idsA = claimsA.map((row) => String(row.outbox_id));
  const idsB = claimsB.map((row) => String(row.outbox_id));

  const overlap = idsA.filter((id) => idsB.includes(id));

  console.log("Publisher A claimed:", idsA);
  console.log("Publisher B claimed:", idsB);
  console.log("Overlapping claims:", overlap);

  if (overlap.length > 0) {
    throw new Error("The same outbox record was claimed twice!");
  }

  console.log("PASS: no overlapping claims.");
} catch (error) {
  console.error("Concurrent claim test failed:", error.message);
  process.exitCode = 1;
} finally {
  try {
    // Release only claims owned by these test publishers.
    await pool.query(
      `UPDATE outbox_events
       SET locked_by = NULL, locked_until = NULL
       WHERE locked_by = ANY($1::varchar[])
         AND published_at IS NULL`,
      [[publisherA, publisherB]]
    );
  } catch (error) {
    console.error("Could not release test claims:", error.message);
    process.exitCode = 1;
  }

  await pool.end();
}
