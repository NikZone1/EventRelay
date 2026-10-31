
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { postWebhook } from "../services/http.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const certDir = path.join(here, "..", "tests", "certs");

const key = fs.readFileSync(path.join(certDir, "localhost-key.pem"));
const cert = fs.readFileSync(path.join(certDir, "localhost-cert.pem"));

const server = https.createServer({ key, cert }, (req, res) => {
  const chunks = [];

  req.on("data", (chunk) => chunks.push(chunk));

  req.on("end", () => {
    if (req.url === "/timeout") {
      // Intentionally leave the response open to trigger the client timeout.
      return;
    }

    if (req.url === "/large") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("x".repeat(70 * 1024));
      return;
    }

    if (req.url === "/500") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("intentional test failure");
      return;
    }

    if (req.url === "/disconnect") {
      req.socket.destroy();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        body: Buffer.concat(chunks).toString("utf8"),
        signature: req.headers["x-eventrelay-signature"],
      }),
    );
  });
});

function testValidator(destination) {
  const parsedUrl = new URL(destination);

  return Promise.resolve({
    parsedUrl,
    hostname: "localhost",
    pinned: {
      address: "127.0.0.1",
      family: 4,
    },
  });
}

async function call(pathname) {
  return postWebhook({
    url: `https://localhost:${server.address().port}${pathname}`,
    body: JSON.stringify({ test: true }),
    timestamp: String(Math.floor(Date.now() / 1000)),
    signature: "a".repeat(64),
    eventId: "test-event",
    deliveryId: "test-delivery",
    validateUrl: testValidator,
    ca: cert,
  });
}

let passed = 0;

function pass(name) {
  passed++;
  console.log(`PASS: ${name}`);
}

async function expectReject(name, operation, pattern) {
  await assert.rejects(operation, pattern);
  pass(name);
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  // 1. A successful HTTPS request.
  const success = await call("/success");

  assert.equal(success.statusCode, 200);

  const successBody = JSON.parse(success.body);

  assert.equal(successBody.method, "POST");
  assert.deepEqual(JSON.parse(successBody.body), { test: true });
  assert.match(successBody.signature, /^v1=a{64}$/);

  pass("Real HTTPS POST succeeds with a trusted test certificate");

  // 2. HTTP 500 is returned by the transport.
  const failure = await call("/500");

  assert.equal(failure.statusCode, 500);
  assert.match(failure.body, /intentional test failure/);

  pass("HTTP 500 response is returned to the caller");

  // 3. Response bodies larger than 64 KiB are rejected.
  await expectReject(
    "Oversized response is rejected",
    () => call("/large"),
    /response exceeded the size limit/i,
  );

  // 4. An interrupted connection rejects instead of hanging.
  await expectReject(
    "Interrupted connection rejects",
    () => call("/disconnect"),
    /socket|hang up|reset|error/i,
  );

  // 5. A server that never responds triggers the timeout.
  await expectReject(
    "Silent server triggers request timeout",
    () => call("/timeout"),
    /timed out/i,
  );

  console.log(`\n${passed}/5 transport integration checks passed.`);
} finally {
  server.closeAllConnections();

  await new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close(resolve);
  });
}
