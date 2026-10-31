
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import {
  claimDueDeliveries,
  recordDeliveryFailure,
} from "../models/delivery.js";
import { sendDelivery } from "../services/sendDelivery.js";
import { getRetryDecision } from "../services/retryPolicy.js";

let stopping = false;
let running = false;
let wakeSleep = null;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, ms);

    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });
}

export function stopDeliverySender() {
  stopping = true;
  wakeSleep?.();
}

export async function runDeliverySender({
  batchSize = 1,
  leaseSeconds = 60,
  pollIntervalMs = 1000,
  sendDeliveryFn = sendDelivery,
} = {}) {
  if (running) {
    throw new Error("Delivery sender is already running");
  }

  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 1 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    typeof sendDeliveryFn !== "function"
  ) {
    throw new Error("Invalid delivery sender configuration");
  }

  running = true;
  stopping = false;

  const workerId = `delivery-sender-${randomUUID()}`;

  console.log("Delivery sender started:", workerId);

  try {
    while (!stopping) {
      try {
        const deliveries = await claimDueDeliveries(pool, {
          workerId,
          batchSize,
          leaseSeconds,
        });

        for (const delivery of deliveries) {
          if (stopping) break;

          try {
            const result = await sendDeliveryFn({
              deliveryId: delivery.id,
              workerId,
            });

            console.log("Delivery succeeded:", result);
          } catch (error) {
            console.error(
              "Delivery attempt failed:",
              delivery.id,
              error.message,
            );

            // A lost lease means another worker may now own this delivery.
            // Never record a failure using a lease that we no longer own.
            if (error.code === "DELIVERY_LEASE_LOST") {
              console.warn(
                "Skipping failure recording because the delivery lease was lost:",
                delivery.id,
              );
              continue;
            }

            try {
              const decision = getRetryDecision({
                attemptCount: delivery.attempt_count,
                firstAttemptAt: delivery.first_attempt_at,
                error,
                retryAfterMs: error.retryAfterMs ?? null,
              });

              const updated = await recordDeliveryFailure(pool, {
                deliveryId: delivery.id,
                workerId,
                errorMessage:
                  decision.action === "dead"
                    ? `${error.message} (${decision.reason})`
                    : error.message,
                responseStatus: error.statusCode ?? null,
                failureCode: decision.failureCode,
                action: decision.action,
                retryDelayMs:
                  decision.action === "retry"
                    ? decision.delayMs
                    : undefined,
              });

              if (!updated) {
                console.warn(
                  "Failure not recorded: lease expired or ownership changed",
                  delivery.id,
                );
                continue;
              }

              if (updated.status === "dead") {
                console.error("Delivery moved to dead-letter state:", {
                  deliveryId: updated.id,
                  failureCode: updated.failure_code,
                  deadAt: updated.dead_at,
                });
              } else {
                console.log("Delivery scheduled for retry:", {
                  deliveryId: updated.id,
                  nextAttemptAt: updated.next_attempt_at,
                  delayMs: decision.delayMs,
                  failureCode: updated.failure_code,
                });
              }
            } catch (recordError) {
              console.error(
                "Could not record delivery failure; lease recovery may be needed:",
                delivery.id,
                recordError.message,
              );
            }
          }
        }
      } catch (error) {
        if (!stopping) {
          console.error("Delivery sender polling failed:", error.message);
        }
      }

      if (!stopping) {
        await sleep(pollIntervalMs);
      }
    }
  } finally {
    wakeSleep?.();
    running = false;
    console.log("Delivery sender stopped");
  }
}
