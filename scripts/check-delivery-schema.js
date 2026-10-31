
import { pool } from "../config/db.js";

try {
  const result = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'deliveries'
      AND column_name IN (
        'first_attempt_at',
        'dead_at',
        'failure_code'
      )
    ORDER BY column_name
  `);

  console.log("\n--- Milestone 7 migration verification ---");
  console.table(result.rows);

  if (result.rows.length !== 3) {
    throw new Error("Expected all three retry-policy columns.");
  }

  const index = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'deliveries'
      AND indexname = 'deliveries_dead_letter_idx'
  `);

  console.log("\n--- Dead-letter index verification ---");
  console.table(index.rows);

  if (index.rows.length !== 1) {
    throw new Error("Dead-letter index is missing.");
  }

  console.log("\nMigration verification passed.");
} catch (error) {
  console.error("Verification failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
