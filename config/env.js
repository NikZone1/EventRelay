import "dotenv/config";

export const env = {
  port: Number(process.env.PORT) || 3000,

  db: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 5432,
    name: process.env.DB_NAME || "eventrelay",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD,
  },

  kafka: {
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092")
      .split(",")
      .map((broker) => broker.trim()),
    topic: process.env.KAFKA_TOPIC || "eventrelay.events",
  },

  webhookEncryptionKey: process.env.WEBHOOK_ENCRYPTION_KEY,
  
};
