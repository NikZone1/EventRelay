import { ingestEvent } from "../services/event.js";

export async function createEvent(req, res) {
  try {
    const idempotencyKey = req.get("Idempotency-Key");
    const { eventType, payload } = req.body ?? {};

    const result = await ingestEvent({
      tenantId: req.auth.tenantId,
      idempotencyKey,
      eventType,
      payload,
    });

    if (result.conflict) {
      return res.status(409).json({
        error: {
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "This idempotency key was already used with a different request.",
        },
      });
    }

    return res.status(result.created ? 201 : 200).json({
      data: result.event,
      idempotentReplay: !result.created,
    });
  } catch (error) {
    if (
      error.message === "A valid Idempotency-Key header is required" ||
      error.message === "A valid eventType is required" ||
      error.message === "payload must be a JSON object or array" ||
      error.message === "Payload must be a JSON object"
    ) {
      return res.status(400).json({
        error: {
          code: "INVALID_EVENT_REQUEST",
          message: error.message,
        },
      });
    }

    console.error("Event ingestion failed:", error.message);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred.",
      },
    });
  }
}



import { replayDeadDelivery } from "../models/delivery.js";
import { pool } from "../config/db.js";

export async function replayDelivery(req, res) {
  try {
    const result = await replayDeadDelivery(pool, {
      tenantId: req.auth.tenantId,
      deliveryId: req.params.deliveryId,
    });

    if (result.outcome === "not_found") {
      return res.status(404).json({
        error: {
          code: "DELIVERY_NOT_FOUND",
          message: "Delivery not found.",
        },
      });
    }

    if (result.outcome === "not_replayable") {
      return res.status(409).json({
        error: {
          code: "DELIVERY_NOT_REPLAYABLE",
          message: "Only dead deliveries can be replayed.",
        },
      });
    }

    return res.status(202).json({
      data: result.delivery,
      message: "Delivery queued for replay.",
    });
  } catch (error) {
    console.error("Delivery replay failed:", error.message);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred.",
      },
    });
  }
}
