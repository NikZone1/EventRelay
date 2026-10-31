
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumns("deliveries", {
    locked_by: {
      type: "varchar(255)",
    },
    locked_until: {
      type: "timestamptz",
    },
    processing_started_at: {
      type: "timestamptz",
    },
    response_body: {
      type: "text",
    },
  });

  // Supports recovering deliveries whose processing lease expired.
  pgm.createIndex(
    "deliveries",
    ["locked_until", "next_attempt_at"],
    {
      name: "deliveries_lease_recovery_idx",
      where: "status = 'processing'",
    },
  );
};

export const down = (pgm) => {
  pgm.dropIndex("deliveries", ["locked_until", "next_attempt_at"], {
    name: "deliveries_lease_recovery_idx",
  });

  pgm.dropColumns("deliveries", [
    "locked_by",
    "locked_until",
    "processing_started_at",
    "response_body",
  ]);
};
