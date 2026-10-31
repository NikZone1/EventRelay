
export async function createTenant(db, name) {
  const result = await db.query(
    `INSERT INTO tenants (name)
     VALUES ($1)
     RETURNING id, name, status, created_at`,
    [name]
  );

  return result.rows[0];
}
