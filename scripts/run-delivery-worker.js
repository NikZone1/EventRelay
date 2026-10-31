
import { runDeliveryWorker, stopDeliveryWorker } from "../workers/delivery.js";

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}. Shutting down delivery worker...`);

  try {
    await stopDeliveryWorker();
    process.exitCode = 0;
  } catch (error) {
    console.error("Delivery worker shutdown failed:", error.message);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

runDeliveryWorker().catch(async (error) => {
  console.error("Delivery worker failed:", error);
  await shutdown("startup failure");
  process.exitCode = 1;
});
