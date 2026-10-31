
import { randomUUID } from "node:crypto";
import {
  claimOutboxEvents,
  markOutboxPublished,
  releaseOutboxClaim,
} from "../models/outbox.js";
import { publishMessage } from "../config/kafka.js";

export async function publishOutboxBatch(
  db,
  { batchSize = 10, leaseSeconds = 30 } = {}
) {
  const publisherId = `publisher-${randomUUID()}`;

  const records = await claimOutboxEvents(db, {
    publisherId,
    batchSize,
    leaseSeconds,
  });

  let published = 0;
  let failed = 0;
  let claimLost = 0;

  for (const record of records) {
    try {
      await publishMessage({
        key: record.tenant_id,
        value: {
          messageVersion: 1,
          eventId: record.event_id,
          tenantId: record.tenant_id,
        },
      });

      const marked = await markOutboxPublished(db, {
        outboxId: record.outbox_id,
        publisherId,
      });

      if (!marked) {
        claimLost += 1;
        console.error(
          `Kafka accepted event ${record.event_id}, but the outbox claim was lost before marking it published. It may be published again.`
        );
        continue;
      }

      published += 1;
    } catch (error) {
      failed += 1;

      try {
        await releaseOutboxClaim(db, {
          outboxId: record.outbox_id,
          publisherId,
          error: error.message,
        });
      } catch (releaseError) {
        console.error(
          `Failed to release outbox record ${record.outbox_id}:`,
          releaseError.message
        );
      }

      console.error(
        `Failed to publish outbox record ${record.outbox_id}:`,
        error.message
      );
    }
  }

  return {
    claimed: records.length,
    published,
    failed,
    claimLost,
  };
}
