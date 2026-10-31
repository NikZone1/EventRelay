
import { randomBytes } from "node:crypto";
import {
  signWebhook,
  verifyWebhookSignature,
} from "../services/webhook.js";

const secret = randomBytes(32).toString("hex");
const timestamp = String(Math.floor(Date.now() / 1000));

const body = JSON.stringify({
  id: "evt_test_001",
  type: "order.created",
  data: { orderId: "order-123", amount: 499 },
});

const signature = signWebhook({ secret, timestamp, body });

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS: ${message}`);
}

assert(
  verifyWebhookSignature({ secret, timestamp, body, signature }),
  "Valid signature is accepted",
);

assert(
  !verifyWebhookSignature({
    secret,
    timestamp,
    body: `${body} `,
    signature,
  }),
  "Modified body is rejected",
);

assert(
  !verifyWebhookSignature({
    secret,
    timestamp: String(Number(timestamp) - 600),
    body,
    signature,
  }),
  "Expired timestamp is rejected",
);

assert(
  !verifyWebhookSignature({
    secret,
    timestamp,
    body,
    signature: "invalid",
  }),
  "Malformed signature is rejected",
);

console.log("\nAll webhook signature tests passed.");
