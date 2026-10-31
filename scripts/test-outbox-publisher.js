
import { pool } from "../config/db.js";
import {
  connectKafkaProducer,
  disconnectKafkaProducer,
} from "../config/kafka.js";
import { publishOutboxBatch } from "../services/outbox.js";

let connected = false;

try {
  await connectKafkaProducer();
  connected = true;

  const result = await publishOutboxBatch(pool, {
    batchSize: 10,
    leaseSeconds: 30,
  });

  console.log("Outbox publishing result:");
  console.log(result);
} catch (error) {
  console.error("Outbox publisher test failed:", error.message);
  process.exitCode = 1;
} finally {
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
1 Qaz