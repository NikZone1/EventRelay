
import {
  connectKafkaProducer,
  publishMessage,
  disconnectKafkaProducer,
} from "../config/kafka.js";

try {
  await connectKafkaProducer();

  const message = {
    messageVersion: 1,
    eventId: "test-event-001",
    tenantId: "test-tenant-001",
  };

  const result = await publishMessage({
    key: message.tenantId,
    value: message,
  });

  console.log("Message published successfully");
  console.log("Broker result:", result);
} catch (error) {
  console.error("Kafka producer test failed:", error.message);
  process.exitCode = 1;
} finally {
  await disconnectKafkaProducer();
}
