
import { validateWebhookUrl } from "../services/http.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS: ${message}`);
}

async function expectRejected(url, description) {
  try {
    await validateWebhookUrl(url);
  } catch {
    console.log(`PASS: ${description}`);
    return;
  }

  throw new Error(`FAIL: ${description} — URL was accepted`);
}

async function main() {
  console.log("\n--- Webhook URL security tests ---");

  await expectRejected(
    "http://example.com/webhook",
    "Plain HTTP is rejected",
  );

  await expectRejected(
    "https://127.0.0.1/webhook",
    "IPv4 loopback is rejected",
  );

  await expectRejected(
    "https://10.0.0.1/webhook",
    "Private IPv4 is rejected",
  );

  await expectRejected(
    "https://192.168.1.10/webhook",
    "Private LAN IPv4 is rejected",
  );

  await expectRejected(
    "https://169.254.169.254/latest/meta-data/",
    "Link-local metadata IP is rejected",
  );

  await expectRejected(
    "https://[::1]/webhook",
    "IPv6 loopback is rejected",
  );

  await expectRejected(
    "https://user:password@example.com/webhook",
    "Embedded credentials are rejected",
  );

  await expectRejected(
    "https://example.com:8443/webhook",
    "Non-standard HTTPS port is rejected",
  );

  await expectRejected(
    "not-a-valid-url",
    "Malformed URL is rejected",
  );

  await expectRejected(
    "https://localhost/webhook",
    "Localhost is rejected",
  );

  console.log("\nAll HTTP URL security tests passed.");
}

main().catch((error) => {
  console.error("\nHTTP security test failed:", error.message);
  process.exitCode = 1;
});

