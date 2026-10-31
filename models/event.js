
export async function findEventByIdempotencyKey(
  db,
  tenantId,
  idempotencyKey
) {
  const result = await db.query(
    `SELECT id, tenant_id, idempotency_key, event_type,
            payload, request_hash, created_at
     FROM events
     WHERE tenant_id = $1
       AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );

  return result.rows[0] ?? null;
}

export async function createEvent(db, {
  tenantId,
  idempotencyKey,
  eventType,
  payload,
  requestHash,
}) {
  const result = await db.query(
    `INSERT INTO events (
       tenant_id,
       idempotency_key,
       event_type,
       payload,
       request_hash
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id, tenant_id, event_type, payload, created_at`,
    [tenantId, idempotencyKey, eventType, payload, requestHash]
  );

  return result.rows[0] ?? null;
}

export async function createOutboxEvent(db, eventId) {
  await db.query(
    `INSERT INTO outbox_events (event_id)
     VALUES ($1)`,
    [eventId]
  );
}
