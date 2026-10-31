
import { pool } from "../config/db.js";

export async function createDeliveriesForEvent({ tenantId, eventId }) {
  const db = await pool.connect();

  try {
    await db.query("BEGIN");

    // PostgreSQL is the canonical source of event data.
    const eventResult = await db.query(
      `SELECT id, tenant_id, event_type
       FROM events
       WHERE id = $1 AND tenant_id = $2`,
      [eventId, tenantId],
    );

    if (eventResult.rows.length === 0) {
      throw new Error("Event not found for the specified tenant");
    }

    const event = eventResult.rows[0];

    // Find matching subscriptions only for active endpoints
    // belonging to this tenant.
    const endpointResult = await db.query(
      `SELECT e.id AS endpoint_id
       FROM subscriptions s
       INNER JOIN endpoints e
         ON e.tenant_id = s.tenant_id
        AND e.id = s.endpoint_id
       WHERE s.tenant_id = $1
         AND s.event_type = $2
         AND e.status = 'active'
       ORDER BY e.id`,
      [tenantId, event.event_type],
    );

    let created = 0;
    let alreadyExisted = 0;

    for (const row of endpointResult.rows) {
      const deliveryResult = await db.query(
        `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id, endpoint_id) DO NOTHING
         RETURNING id`,
        [tenantId, eventId, row.endpoint_id],
      );

      if (deliveryResult.rowCount > 0) {
        created++;
      } else {
        alreadyExisted++;
      }
    }

    await db.query("COMMIT");

    return {
      eventId,
      matchedEndpoints: endpointResult.rows.length,
      created,
      alreadyExisted,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
