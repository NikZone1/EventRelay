
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumns("deliveries", {
    first_attempt_at: {
      type: "timestamptz",
    },
    dead_at: {
      type: "timestamptz",
    },
    failure_code: {
      type: "varchar(100)",
    },
  });

  // Supports querying deliveries that have exhausted their retry budget.
  pgm.createIndex("deliveries", ["tenant_id", "dead_at"], {
    name: "deliveries_dead_letter_idx",
    where: "status = 'dead'",
  });
};

export const down = (pgm) => {
  pgm.dropIndex("deliveries", ["tenant_id", "dead_at"], {
    name: "deliveries_dead_letter_idx",
  });

  pgm.dropColumns("deliveries", [
    "first_attempt_at",
    "dead_at",
    "failure_code",
  ]);
};
