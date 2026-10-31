const response = await fetch(
  "http://localhost:3000/api/eventRelay/v1/events",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.EVENTRELAY_API_KEY}`,
      "Idempotency-Key": `oversized-${Date.now()}`,
    },
    body: JSON.stringify({
      eventType: "test.large_payload",
      payload: {
        data: "x".repeat(300 * 1024),
      },
    }),
  }
);

console.log("Status:", response.status);
console.log("Response:", await response.text());

