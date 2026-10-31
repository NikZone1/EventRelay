
import { pool } from "../config/db.js";
import {
  runDeliverySender,
  stopDeliverySender,
} from "../workers/deliverySender.js";

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log(`Received ${signal}. Stopping delivery sender...`);
  stopDeliverySender();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

try {
  await runDeliverySender();
} catch (error) {
  console.error("Delivery sender failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
  console.log("Delivery sender shut down");
}
