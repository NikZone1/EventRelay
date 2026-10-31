
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";

const DNS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function withTimeout(promise, timeoutMs, message) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function isPublicIp(address) {
  if (!ipaddr.isValid(address)) return false;

  return ipaddr.process(address).range() === "unicast";
}

async function resolvePublicAddress(hostname) {
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      const error = new Error("Webhook destination IP is not public");
      error.code = "WEBHOOK_URL_BLOCKED";
      throw error;
    }

    return {
      address: hostname,
      family: net.isIP(hostname),
    };
  }

  let addresses;

  try {
    addresses = await withTimeout(
      dns.lookup(hostname, {
        all: true,
        verbatim: true,
      }),
      DNS_TIMEOUT_MS,
      "Webhook DNS lookup timed out",
    );
  } catch (cause) {
    const timedOut = cause.code === "ETIMEDOUT";

    const error = new Error(
      timedOut
        ? "Webhook DNS lookup timed out"
        : "Webhook hostname lookup failed",
      { cause },
    );

    error.code = timedOut
      ? "ETIMEDOUT"
      : cause.code || "EAI_AGAIN";

    throw error;
  }

  if (addresses.length === 0) {
    const error = new Error("Webhook hostname did not resolve");
    error.code = "ENOTFOUND";
    throw error;
  }

  if (addresses.some(({ address }) => !isPublicIp(address))) {
    const error = new Error(
      "Webhook hostname resolves to a non-public IP",
    );
    error.code = "WEBHOOK_URL_BLOCKED";
    throw error;
  }

  return addresses.find(({ family }) => family === 4) ?? addresses[0];
}

export async function validateWebhookUrl(destination) {
  let parsedUrl;

  try {
    parsedUrl = new URL(destination);
  } catch {
    const error = new Error("Invalid webhook URL");
    error.code = "WEBHOOK_URL_INVALID";
    throw error;
  }

  if (
    parsedUrl.protocol !== "https:" ||
    !parsedUrl.hostname ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    const error = new Error(
      "Webhook URL must be HTTPS without embedded credentials",
    );
    error.code = "WEBHOOK_URL_INVALID";
    throw error;
  }

  if (parsedUrl.port && parsedUrl.port !== "443") {
    const error = new Error(
      "Only the standard HTTPS port 443 is allowed",
    );
    error.code = "WEBHOOK_URL_INVALID";
    throw error;
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "");
  const pinned = await resolvePublicAddress(hostname);

  return { parsedUrl, hostname, pinned };
}

export async function postWebhook({
  url: destination,
  body,
  timestamp,
  signature,
  eventId,
  deliveryId,
  validateUrl = validateWebhookUrl,
  ca,
}) {
  const { parsedUrl, hostname, pinned } = await validateUrl(destination);

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseBytes = 0;
    const chunks = [];

    const finish = (error, result) => {
      if (settled) return;
      settled = true;

      if (error) reject(error);
      else resolve(result);
    };

    const request = https.request(
      {
        protocol: "https:",
        hostname,
        port: Number(parsedUrl.port || 443),
        method: "POST",
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-EventRelay-Event-Id": eventId,
          "X-EventRelay-Delivery-Id": deliveryId,
          "X-EventRelay-Timestamp": timestamp,
          "X-EventRelay-Signature": `v1=${signature}`,
        },
        timeout: REQUEST_TIMEOUT_MS,
        agent: false,
        servername: net.isIP(hostname) ? undefined : hostname,
        ...(ca ? { ca } : {}),
        lookup: (_hostname, options, callback) => {
          if (options?.all) {
            callback(null, [
              {
                address: pinned.address,
                family: pinned.family,
              },
            ]);
            return;
          }

          callback(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        response.on("data", (chunk) => {
          responseBytes += chunk.length;

          if (responseBytes > MAX_RESPONSE_BYTES) {
            const error = new Error(
              "Webhook response exceeded the size limit",
            );
            error.code = "WEBHOOK_RESPONSE_TOO_LARGE";
            request.destroy(error);
            return;
          }

          chunks.push(chunk);
        });

        response.on("error", (error) => finish(error));

        response.on("end", () => {
          finish(null, {
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", (error) => finish(error));

    request.on("timeout", () => {
      const error = new Error("Webhook request timed out");
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });

    request.end(body);
  });
}
