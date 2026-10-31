
import { createHmac } from "node:crypto";
import { pool } from "../config/db.js";
import { decryptSecret } from "./secret.js";
import { postWebhook } from "./http.js";
import { completeDelivery } from "../models/delivery.js";
import { parseRetryAfterMs } from "./retryPolicy.js";

export async function sendDelivery({
  deliveryId,
  workerId,
  httpPost = postWebhook,
}) {
  const result = await pool.query(
    `SELECT
       d.id AS delivery_id,
       d.tenant_id,
       d.event_id,
       d.endpoint_id,
       d.locked_by,
       d.locked_until,
       e.event_type,
       e.payload,
       e.created_at AS event_created_at,
       ep.url,
       ep.secret_encrypted
     FROM deliveries d
     JOIN events e
       ON e.id = d.event_id
      AND e.tenant_id = d.tenant_id
     JOIN endpoints ep
       ON ep.id = d.endpoint_id
      AND ep.tenant_id = d.tenant_id
     WHERE d.id = $1
       AND d.status = 'processing'
       AND d.locked_by = $2
       AND d.locked_until > NOW()
       AND ep.status = 'active'`,
    [deliveryId, workerId],
  );

  if (result.rows.length === 0) {
    const error = new Error(
      "Delivery is unavailable or its lease was lost",
    );
    error.code = "DELIVERY_LEASE_LOST";
    throw error;
  }

  const row = result.rows[0];

  let secret;

  try {
    secret = decryptSecret(row.secret_encrypted);
  } catch (cause) {
    const error = new Error("Webhook secret could not be decrypted", {
      cause,
    });
    error.code = "WEBHOOK_SECRET_INVALID";
    throw error;
  }

  const body = JSON.stringify({
    id: row.event_id,
    type: row.event_type,
    data: row.payload,
    createdAt: row.event_created_at,
  });

  const timestamp = String(Math.floor(Date.now() / 1000));

  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");

  let response;

  try {
    response = await httpPost({
      url: row.url,
      body,
      timestamp,
      signature,
      eventId: row.event_id,
      deliveryId: row.delivery_id,
    });
  } catch (cause) {
    // Preserve transport error codes for retry classification.
    if (!cause.code) {
      cause.code = "WEBHOOK_TRANSPORT_ERROR";
    }

    throw cause;
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = new Error(`Webhook returned HTTP ${response.statusCode}`);

    error.statusCode = response.statusCode;
    error.failureCode = `HTTP_${response.statusCode}`;

    const retryAfterHeader = response.headers?.["retry-after"];
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);

    if (retryAfterMs !== null) {
      error.retryAfterMs = retryAfterMs;
    }

    throw error;
  }

  const completed = await completeDelivery(pool, {
    deliveryId,
    workerId,
    responseStatus: response.statusCode,
    responseBody: response.body,
  });

  if (!completed) {
    const error = new Error(
      "Webhook succeeded, but the delivery lease was lost before completion",
    );
    error.code = "DELIVERY_LEASE_LOST";
    throw error;
  }

  return {
    deliveryId,
    status: completed.status,
    responseStatus: response.statusCode,
  };
}
