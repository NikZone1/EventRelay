
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { claimOutboxEvents } from "../models/outbox.js";

const publisherId = `test-publisher-${randomUUID()}`;

try {
  const claimed = await claimOutboxEvents(pool, {
    publisherId,
    batchSize: 5,
    leaseSeconds: 30,
  });

  console.log(`Publisher: ${publisherId}`);
  console.log(`Claimed ${claimed.length} outbox record(s).`);
  console.table(claimed);

  // This is a claim-only test. Release the test claims so
  // existing events remain available for the real publisher.
  if (claimed.length > 0) {
    const ids = claimed.map((row) => row.outbox_id);

    await pool.query(
      `UPDATE outbox_events
       SET locked_by = NULL, locked_until = NULL
       WHERE id = ANY($1::bigint[])
         AND locked_by = $2
         AND published_at IS NULL`,
      [ids, publisherId]
    );

    console.log("Test claims released.");
  }
} catch (error) {
  console.error("Outbox claim test failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
