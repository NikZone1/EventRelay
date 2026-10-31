
import { Kafka, logLevel } from "kafkajs";
import { env } from "./env.js";

const kafka = new Kafka({
  clientId: "eventrelay-api",
  brokers: env.kafka.brokers,
  logLevel: logLevel.ERROR,
});

const producer = kafka.producer();

let isConnected = false;

export async function connectKafkaProducer() {
  if (isConnected) return;

  await producer.connect();
  isConnected = true;

  console.log("Kafka producer connected");
}

export async function publishMessage({
  topic = env.kafka.topic,
  key,
  value,
}) {
  if (!isConnected) {
    throw new Error("Kafka producer is not connected");
  }

  return producer.send({
    topic,
    messages: [
      {
        key,
        value: JSON.stringify(value),
      },
    ],
  });
}

export async function disconnectKafkaProducer() {
  if (!isConnected) return;

  try {
    await producer.disconnect();
  } finally {
    isConnected = false;
  }
}
