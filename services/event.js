import { createHash } from "node:crypto";
import { pool } from "../config/db.js";
import {
  findEventByIdempotencyKey,
  createEvent,
  createOutboxEvent,
} from "../models/event.js";

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function hashRequest(eventType, payload) {
  return createHash("sha256")
    .update(stableJson({ eventType, payload }))
    .digest("hex");
}

export async function ingestEvent({
  tenantId,
  idempotencyKey,
  eventType,
  payload,
}) {
  if (
    typeof idempotencyKey !== "string" ||
    !idempotencyKey.trim() ||
    idempotencyKey.length > 255
  ) {
    throw new Error("A valid Idempotency-Key header is required");
  }

  if (
    typeof eventType !== "string" ||
    !eventType.trim() ||
    eventType.length > 255
  ) {
    throw new Error("A valid eventType is required");
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("Payload must be a JSON object");
  }

  const key = idempotencyKey.trim();
  const type = eventType.trim();
  const requestHash = hashRequest(type, payload);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await findEventByIdempotencyKey(client, tenantId, key);

    if (existing) {
      await client.query("COMMIT");

      if (existing.request_hash !== requestHash) {
        return {
          conflict: true,
        };
      }

      return {
        created: false,
        event: existing,
      };
    }

    const event = await createEvent(client, {
      tenantId,
      idempotencyKey: key,
      eventType: type,
      payload,
      requestHash,
    });

    if (!event) {
      // Another concurrent request may have inserted the same key.
      const concurrent = await findEventByIdempotencyKey(client, tenantId, key);

      await client.query("COMMIT");

      if (!concurrent || concurrent.request_hash !== requestHash) {
        return { conflict: true };
      }

      return {
        created: false,
        event: concurrent,
      };
    }

    await createOutboxEvent(client, event.id);
    await client.query("COMMIT");

    return {
      created: true,
      event,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
