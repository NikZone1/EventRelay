import { Kafka, logLevel } from "kafkajs";
import { env } from "../config/env.js";
import { pool } from "../config/db.js";
import { createDeliveriesForEvent } from "../services/delivery.js";

const kafka = new Kafka({
  clientId: "eventrelay-delivery-worker",
  brokers: env.kafka.brokers,
  logLevel: logLevel.ERROR,
});

const consumer = kafka.consumer({
  groupId: "eventrelay-delivery-workers-v2",
});

let connected = false;
let stopping = false;

export async function runDeliveryWorker() {
  if (connected) {
    throw new Error("Delivery worker is already running");
  }

  stopping = false;

  await consumer.connect();
  connected = true;

  try {
    await consumer.subscribe({
      topic: env.kafka.topic,
      fromBeginning: false,
    });

    console.log("Delivery worker subscribed to", env.kafka.topic);

    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        if (stopping) return;

        let payload;

        try {
          payload = JSON.parse(message.value?.toString() ?? "");
        } catch {
          throw new Error("Invalid JSON in Kafka message");
        }

        const { messageVersion, eventId, tenantId } = payload;

        if (
          messageVersion !== 1 ||
          typeof eventId !== "string" ||
          typeof tenantId !== "string"
        ) {
          throw new Error("Invalid EventRelay Kafka message");
        }

        // Durable PostgreSQL processing happens before offset commit.
        const result = await createDeliveriesForEvent({
          tenantId,
          eventId,
        });

        console.log("Event processed:", result);

        // Commit the next offset only after PostgreSQL commits.
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString(),
          },
        ]);
      },
    });
  } catch (error) {
    await consumer.disconnect().catch(() => {});
    connected = false;
    throw error;
  }
}

export async function stopDeliveryWorker() {
  stopping = true;

  if (connected) {
    await consumer.stop();
    await consumer.disconnect();
    connected = false;
  }

  await pool.end();
  console.log("Delivery worker stopped");
}
