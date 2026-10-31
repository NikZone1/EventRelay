
import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook({ secret, timestamp, body }) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
}

export function verifyWebhookSignature({
  secret,
  timestamp,
  body,
  signature,
  toleranceSeconds = 300,
}) {
  if (
    typeof secret !== "string" ||
    typeof timestamp !== "string" ||
    typeof body !== "string" ||
    typeof signature !== "string"
  ) {
    return false;
  }

  if (!/^\d+$/.test(timestamp)) {
    return false;
  }

  const timestampSeconds = Number(timestamp);

  if (!Number.isSafeInteger(timestampSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return false;
  }

  const expected = Buffer.from(
    signWebhook({ secret, timestamp, body }),
    "hex",
  );

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const supplied = Buffer.from(signature, "hex");

  return (
    expected.length === supplied.length &&
    timingSafeEqual(expected, supplied)
  );
}
