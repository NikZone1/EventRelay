
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable("delivery_replay_audit", {
    id: {
      type: "uuid",
      primaryKey: true,
      notNull: true,
      default: pgm.func("gen_random_uuid()"),
    },
    tenant_id: {
      type: "uuid",
      notNull: true,
      references: "tenants(id)",
      onDelete: "RESTRICT",
    },
    delivery_id: {
      type: "uuid",
      notNull: true,
      references: "deliveries(id)",
      onDelete: "RESTRICT",
    },
    previous_failure_code: {
      type: "varchar(100)",
    },
    previous_error: {
      type: "text",
    },
    previous_attempt_count: {
      type: "integer",
      notNull: true,
    },
    replayed_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createIndex(
    "delivery_replay_audit",
    ["tenant_id", "delivery_id", "replayed_at"],
    {
      name: "delivery_replay_audit_tenant_delivery_idx",
    },
  );
};

export const down = (pgm) => {
  pgm.dropTable("delivery_replay_audit");
};
