
import { publishOutboxBatch } from "../services/outbox.js";

let stopping = false;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function stopOutboxPublisher() {
  stopping = true;
}

export async function runOutboxPublisher({
  db,
  batchSize = 10,
  leaseSeconds = 30,
  pollIntervalMs = 1000,
}) {
  stopping = false;

  console.log("Outbox publisher worker started");

  while (!stopping) {
    try {
      const result = await publishOutboxBatch(db, {
        batchSize,
        leaseSeconds,
      });

      if (result.claimed > 0) {
        console.log("Outbox batch processed:", result);
      }
    } catch (error) {
      console.error("Outbox polling failed:", error.message);
    }

    if (!stopping) {
      await sleep(pollIntervalMs);
    }
  }

  console.log("Outbox publisher worker stopped");
}
