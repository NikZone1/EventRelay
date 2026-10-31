
export async function claimOutboxEvents(
  db,
  { publisherId, batchSize = 10, leaseSeconds = 30 }
) {
  if (!publisherId) {
    throw new Error("publisherId is required");
  }

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("batchSize must be an integer between 1 and 100");
  }

  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("leaseSeconds must be a positive integer");
  }

  const query = `
    WITH candidates AS (
      SELECT id
      FROM outbox_events
      WHERE published_at IS NULL
        AND (
          locked_until IS NULL
          OR locked_until <= NOW()
        )
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    ),
    claimed AS (
      UPDATE outbox_events AS outbox
      SET
        locked_by = $2,
        locked_until = NOW() + ($3 * INTERVAL '1 second'),
        attempts = outbox.attempts + 1
      FROM candidates
      WHERE outbox.id = candidates.id
      RETURNING
        outbox.id AS outbox_id,
        outbox.event_id,
        outbox.attempts,
        outbox.locked_until
    )
    SELECT
      claimed.outbox_id,
      claimed.event_id,
      claimed.attempts,
      claimed.locked_until,
      events.tenant_id
    FROM claimed
    JOIN events ON events.id = claimed.event_id
    ORDER BY claimed.outbox_id;
  `;

  const result = await db.query(query, [
    batchSize,
    publisherId,
    leaseSeconds,
  ]);

  return result.rows;
}



export async function markOutboxPublished(
  db,
  { outboxId, publisherId }
) {
  const result = await db.query(
    `UPDATE outbox_events
     SET published_at = NOW(),
         locked_by = NULL,
         locked_until = NULL,
         last_error = NULL
     WHERE id = $1
       AND locked_by = $2
       AND locked_until > NOW()
       AND published_at IS NULL
     RETURNING id`,
    [outboxId, publisherId]
  );

  return result.rowCount === 1;
}

export async function releaseOutboxClaim(
  db,
  { outboxId, publisherId, error }
) {
  await db.query(
    `UPDATE outbox_events
     SET locked_by = NULL,
         locked_until = NULL,
         last_error = $3
     WHERE id = $1
       AND locked_by = $2
       AND published_at IS NULL`,
    [outboxId, publisherId, String(error).slice(0, 2000)]
  );
}
