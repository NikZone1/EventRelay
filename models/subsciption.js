
export async function createSubscription(
  db,
  { tenantId, endpointId, eventType },
) {
  const result = await db.query(
    `INSERT INTO subscriptions (tenant_id, endpoint_id, event_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint_id, event_type) DO NOTHING
     RETURNING id, tenant_id, endpoint_id, event_type, created_at`,
    [tenantId, endpointId, eventType],
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

  // Return the existing subscription for an idempotent result.
  const existing = await db.query(
    `SELECT id, tenant_id, endpoint_id, event_type, created_at
     FROM subscriptions
     WHERE tenant_id = $1
       AND endpoint_id = $2
       AND event_type = $3`,
    [tenantId, endpointId, eventType],
  );

  return existing.rows[0] ?? null;
}

export async function findSubscriptionsByEventType(
  db,
  tenantId,
  eventType,
) {
  const result = await db.query(
    `SELECT id, tenant_id, endpoint_id, event_type
     FROM subscriptions
     WHERE tenant_id = $1 AND event_type = $2
     ORDER BY endpoint_id`,
    [tenantId, eventType],
  );

  return result.rows;
}

export async function deleteSubscription(
  db,
  { tenantId, endpointId, eventType },
) {
  const result = await db.query(
    `DELETE FROM subscriptions
     WHERE tenant_id = $1
       AND endpoint_id = $2
       AND event_type = $3
     RETURNING id`,
    [tenantId, endpointId, eventType],
  );

  return result.rowCount > 0;
}
