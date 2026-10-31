
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumn("outbox_events", {
    locked_by: {
      type: "varchar(255)",
    },
    locked_until: {
      type: "timestamptz",
    },
  });

  pgm.createIndex(
    "outbox_events",
    ["locked_until", "created_at"],
    {
      name: "outbox_events_claim_idx",
      where: "published_at IS NULL",
    }
  );
};

export const down = (pgm) => {
  pgm.dropIndex("outbox_events", ["locked_until", "created_at"], {
    name: "outbox_events_claim_idx",
  });

  pgm.dropColumns("outbox_events", ["locked_by", "locked_until"]);
};
