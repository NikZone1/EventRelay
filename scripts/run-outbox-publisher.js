
import { pool } from "../config/db.js";
import {
  connectKafkaProducer,
  disconnectKafkaProducer,
} from "../config/kafka.js";
import {
  runOutboxPublisher,
  stopOutboxPublisher,
} from "../workers/outbox.js";

let shuttingDown = false;
let workerPromise;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}. Shutting down gracefully...`);

  stopOutboxPublisher();

  try {
    if (workerPromise) {
      await workerPromise;
    }
  } finally {
    try {
      await disconnectKafkaProducer();
    } catch (error) {
      console.error("Kafka disconnect failed:", error.message);
      process.exitCode = 1;
    }

    try {
      await pool.end();
    } catch (error) {
      console.error("Database shutdown failed:", error.message);
      process.exitCode = 1;
    }
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await connectKafkaProducer();

  workerPromise = runOutboxPublisher({
    db: pool,
    batchSize: 10,
    leaseSeconds: 30,
    pollIntervalMs: 1000,
  });

  await workerPromise;
} catch (error) {
  console.error("Outbox worker failed to start:", error.message);
  process.exitCode = 1;
  await shutdown("startup failure");
}
