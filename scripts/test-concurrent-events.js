
const baseUrl = "http://localhost:3000/api/eventRelay/v1/events";
const apiKey = process.env.EVENTRELAY_API_KEY;

if (!apiKey) {
  throw new Error("Set EVENTRELAY_API_KEY before running this test.");
}

const idempotencyKey = `concurrent-test-${Date.now()}`;

const body = {
  eventType: "order.created",
  payload: {
    orderId: "concurrent-order-001",
    amount: 499,
  },
};

async function sendRequest(index) {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  return {
    request: index,
    status: response.status,
    result,
  };
}

const results = await Promise.all(
  Array.from({ length: 10 }, (_, index) => sendRequest(index + 1))
);

console.table(
  results.map(({ request, status, result }) => ({
    request,
    status,
    eventId: result.event?.id ?? result.eventId ?? "",
    replay: result.idempotentReplay ?? "",
  }))
);

console.log("Idempotency key:", idempotencyKey);



