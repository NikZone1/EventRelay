
import { pool } from "../config/db.js";

export async function createEndpoint(
  db,
  { tenantId, url, secretEncrypted },
) {
  const result = await db.query(
    `INSERT INTO endpoints (tenant_id, url, secret_encrypted)
     VALUES ($1, $2, $3)
     RETURNING id, tenant_id, url, status, created_at, updated_at`,
    [tenantId, url, secretEncrypted],
  );

  return result.rows[0];
}

export async function findEndpointById(db, tenantId, endpointId) {
  const result = await db.query(
    `SELECT id, tenant_id, url, status, created_at, updated_at
     FROM endpoints
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, endpointId],
  );

  return result.rows[0] ?? null;
}

export async function findActiveEndpointsForEvent(
  db,
  tenantId,
  eventType,
) {
  const result = await db.query(
    `SELECT e.id, e.tenant_id, e.url, e.secret_encrypted
     FROM endpoints e
     INNER JOIN subscriptions s
       ON s.tenant_id = e.tenant_id
      AND s.endpoint_id = e.id
     WHERE s.tenant_id = $1
       AND s.event_type = $2
       AND e.status = 'active'
     ORDER BY e.id`,
    [tenantId, eventType],
  );

  return result.rows;
}
