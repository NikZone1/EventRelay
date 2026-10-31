# EventRelay

**A reliable, multi-tenant webhook delivery platform built with Node.js, PostgreSQL, and Apache Kafka.**

EventRelay is an event-driven backend system that enables applications to ingest events and reliably deliver them to registered webhook endpoints.

It is designed to handle asynchronous processing, concurrent workers, transient failures, retries, and delivery recovery using a transactional outbox pattern and a PostgreSQL-backed delivery engine.

---

## Features

- **Event Ingestion:** REST API with idempotency support to prevent duplicate event creation.
- **Transactional Outbox:** Ensures events are persisted before being published asynchronously.
- **Asynchronous Processing:** Kafka-based event distribution between ingestion and delivery components.
- **Multi-Tenant Architecture:** Tenant-scoped API authentication and data isolation.
- **Reliable Webhook Delivery:** Lease-based delivery claiming to prevent concurrent processing.
- **Retry Mechanism:** Exponential backoff with full jitter and support for HTTP `Retry-After`.
- **Dead-Letter Handling:** Automatically identifies permanently failed and exhausted deliveries.
- **Manual Replay:** Reprocess dead-letter deliveries with audit history.
- **Webhook Security:** HMAC-SHA256 request signatures and encrypted endpoint secrets.
- **Failure Recovery:** Lease expiration and recovery for interrupted workers.
- **HTTP Security:** HTTPS enforcement, DNS validation, private-network protection, request timeouts, and response-size limits.

---

## System Architecture

EventRelay follows an asynchronous, event-driven architecture that separates event ingestion from webhook delivery.

```text
                 Client Application
                        |
                        v
                   REST API
                        |
                        v
                 Event Ingestion
                        |
                        v
                   PostgreSQL
                   /         \
                  v           v
               Events     Outbox Events
                              |
                              v
                       Outbox Publisher
                              |
                              v
                        Apache Kafka
                              |
                              v
                       Delivery Worker
                              |
                              v
                   Delivery Management
                              |
                              v
                       Delivery Sender
                              |
                              v
                    Webhook Endpoints
                              |
                    +---------+---------+
                    |                   |
                    v                   v
                 Success              Failure
                    |                   |
                    v                   v
                Completed          Retry Policy
                                        |
                              +---------+---------+
                              |                   |
                              v                   v
                           Retry              Dead Letter
                                                  |
                                                  v
                                            Manual Replay
```

### Core Components

| Component | Responsibility |
|---|---|
| REST API | Accepts and validates incoming events |
| PostgreSQL | Stores tenants, API keys, events, endpoints, and deliveries |
| Transactional Outbox | Coordinates reliable database writes and asynchronous publishing |
| Outbox Publisher | Publishes pending outbox events to Kafka |
| Apache Kafka | Distributes events between system components |
| Delivery Worker | Processes consumed events and creates delivery records |
| Delivery Sender | Executes HTTP webhook requests and records outcomes |
| Retry Engine | Determines retry eligibility and schedules subsequent attempts |
| Dead-Letter Handling | Stores deliveries that have exhausted their retry policy |
| Replay Mechanism | Allows authorized reprocessing of dead-letter deliveries |

---

## Technology Stack

| Category | Technologies |
|---|---|
| Runtime | Node.js |
| Backend Framework | Express.js |
| Language | JavaScript (ES Modules) |
| Database | PostgreSQL |
| Database Driver | node-postgres (`pg`) |
| Message Broker | Apache Kafka |
| Kafka Client | KafkaJS |
| Database Migrations | node-pg-migrate |
| Security | HMAC-SHA256, API key authentication, encrypted secrets |
| Infrastructure | Docker |

---

## Getting Started

### Prerequisites

Install the following before setting up the project:

- [Node.js](https://nodejs.org/)
- [PostgreSQL](https://www.postgresql.org/)
- [Docker](https://www.docker.com/)
- [Git](https://git-scm.com/)

A running Kafka broker is also required for asynchronous event processing.

### 1. Clone the Repository

```bash
git clone <repository-url>
cd EventRelay
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root using `.env.example` as a reference.

```env
PORT=3000

DB_HOST=localhost
DB_PORT=5432
DB_NAME=eventrelay
DB_USER=postgres
DB_PASSWORD=your_password

DATABASE_URL=

KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC=eventrelay.events

WEBHOOK_ENCRYPTION_KEY=your_encryption_key
```

Update the configuration according to your local PostgreSQL and Kafka setup.

**Security:** Never commit `.env` files, database credentials, API keys, or encryption keys to version control.

### 4. Run Database Migrations

Ensure PostgreSQL is running and the `eventrelay` database exists.

```bash
npm run migrate:up
```

### 5. Start the Application

Start the API server:

```bash
npm run dev
```

Start the delivery worker:

```bash
npm run worker:delivery
```

Start the delivery sender:

```bash
npm run worker:delivery-sender
```

Ensure PostgreSQL and Kafka are running before starting the application components.

---

## API Overview

**Base URL**

```text
http://localhost:3000/api/eventRelay
```

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Application health check |
| POST | `/v1/events` | Ingest a new event |
| POST | `/v1/events/deliveries/:deliveryId/replay` | Replay a dead-letter delivery |

### Authentication

Protected endpoints require API key authentication through the Bearer token scheme.

```http
Authorization: Bearer YOUR_API_KEY
```

### Event Ingestion

```http
POST /api/eventRelay/v1/events
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY
```

Example request:

```json
{
  "idempotencyKey": "order-123-created",
  "eventType": "order.created",
  "payload": {
    "orderId": "123",
    "amount": 2499,
    "currency": "INR"
  }
}
```

The API validates the request, persists the event, and creates an outbox record for asynchronous processing.

---

## Reliability and Failure Handling

EventRelay uses **at-least-once processing semantics** to handle failures across distributed components.

### Transactional Outbox

Events and their corresponding outbox records are persisted together in a database transaction. This prevents events from being lost when the application encounters failures between database writes and message publishing.

### Idempotency

Idempotency keys prevent duplicate event creation when clients retry ingestion requests.

### Concurrent Delivery Processing

Database-backed leases and row-level locking ensure that multiple workers cannot simultaneously claim the same delivery.

### Retry Policy

Transient failures are retried using exponential backoff with full jitter.

The retry policy includes:

- Maximum of 10 total attempts.
- Maximum retry window of 24 hours.
- Base backoff of 10 seconds.
- Maximum backoff of 1 hour.
- Support for HTTP `Retry-After` headers.
- Automatic dead-letter transition when retry limits are exhausted.

### Dead-Letter Replay

Dead-letter deliveries can be manually replayed through an authenticated API endpoint.

Replay operations:
- Enforce tenant isolation.
- Reset the delivery retry budget.
- Preserve previous failure details.
- Create an audit record for each replay.

### Webhook Security

Webhook requests use HMAC-SHA256 signatures generated from the timestamp and request body.

Endpoint secrets are encrypted at rest. URL validation and network restrictions help prevent requests to private or otherwise prohibited destinations.

---

## Testing

EventRelay includes automated test scripts covering security, event processing, delivery execution, retry policies, and failure recovery.

Run individual test scripts using:

```bash
node scripts/test-secret.js
node scripts/test-webhook-signature.js
node scripts/test-http-security.js
node scripts/test-http-transport.js
node scripts/test-delivery.js
node scripts/test-delivery-claims.js
node scripts/test-delivery-failure.js
node scripts/test-send-delivery.js
node scripts/test-endpoint-secret-filter.js
node scripts/test-delivery-shutdown.js
node scripts/test-retry-policy.js
node scripts/test-delivery-replay.js
node scripts/test-delivery-replay-rollback.js
node scripts/test-delivery-replay-api.js
node scripts/test-delivery-exhaustion.js
```

The test suite covers:

- Secret encryption and signature verification.
- Webhook URL validation and HTTP transport behavior.
- Event-to-delivery processing.
- Concurrent claims and lease recovery.
- Retry scheduling and exhaustion.
- Dead-letter replay and audit rollback.
- Tenant isolation and API authentication.
- Graceful handling of in-flight delivery requests.

---

## Project Structure

```text
EventRelay/
├── config/          # Environment, database and Kafka configuration
├── controllers/     # HTTP request handlers
├── middleware/      # Authentication and request middleware
├── migrations/      # PostgreSQL schema migrations
├── models/          # Database queries and data access
├── routes/          # API route definitions
├── scripts/         # Worker runners and test scripts
├── services/        # Business logic and delivery services
├── workers/         # Background processing workers
├── tests/           # Additional test resources
├── app.js            # Express application setup
├── server.js         # Application entry point
├── package.json
└── .env.example
```

---

## Engineering Concepts

EventRelay demonstrates practical backend and distributed systems concepts:

- Event-driven architecture.
- Transactional outbox pattern.
- Asynchronous processing with Kafka.
- Multi-tenant application design.
- Database transactions and row-level locking.
- Idempotency and at-least-once delivery.
- Distributed worker coordination.
- Retry strategies and dead-letter queues.
- Failure recovery and graceful shutdown.
- Webhook authentication and SSRF protection.

---

**EventRelay — Reliable event delivery for distributed applications.**