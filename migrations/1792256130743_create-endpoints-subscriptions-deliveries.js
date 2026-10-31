
export const shorthands = undefined;

export const up = (pgm) => {
  // Registered webhook destinations.
  pgm.createTable("endpoints", {
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
    url: {
      type: "text",
      notNull: true,
    },
    secret_encrypted: {
      type: "text",
      notNull: true,
    },
    status: {
      type: "varchar(20)",
      notNull: true,
      default: "active",
      check: "status IN ('active', 'disabled')",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("endpoints", "endpoints_tenant_id_id_unique", {
    unique: ["tenant_id", "id"],
  });

  pgm.createIndex("endpoints", ["tenant_id", "status"], {
    name: "endpoints_tenant_status_idx",
  });

  // Event types each endpoint subscribes to.
  pgm.createTable("subscriptions", {
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
    endpoint_id: {
      type: "uuid",
      notNull: true,
    },
    event_type: {
      type: "varchar(255)",
      notNull: true,
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createConstraint(
    "subscriptions",
    "subscriptions_endpoint_tenant_fk",
    {
      foreignKeys: {
        columns: ["tenant_id", "endpoint_id"],
        references: "endpoints(tenant_id, id)",
        onDelete: "CASCADE",
      },
    },
  );

  pgm.addConstraint("subscriptions", "subscriptions_endpoint_event_unique", {
    unique: ["endpoint_id", "event_type"],
  });

  pgm.createIndex("subscriptions", ["tenant_id", "event_type"], {
    name: "subscriptions_tenant_event_type_idx",
  });

  // Required for the composite foreign key from deliveries to events.
  pgm.addConstraint("events", "events_tenant_id_id_unique", {
    unique: ["tenant_id", "id"],
  });

  // One logical delivery per event and endpoint.
  pgm.createTable("deliveries", {
    id: {
      type: "uuid",
      primaryKey: true,
      notNull: true,
      default: pgm.func("gen_random_uuid()"),
    },
    tenant_id: {
      type: "uuid",
      notNull: true,
    },
    event_id: {
      type: "uuid",
      notNull: true,
    },
    endpoint_id: {
      type: "uuid",
      notNull: true,
    },
    status: {
      type: "varchar(20)",
      notNull: true,
      default: "pending",
      check:
        "status IN ('pending', 'processing', 'succeeded', 'retrying', 'dead')",
    },
    attempt_count: {
      type: "integer",
      notNull: true,
      default: 0,
      check: "attempt_count >= 0",
    },
    next_attempt_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    response_status: {
      type: "integer",
    },
    last_error: {
      type: "text",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    completed_at: {
      type: "timestamptz",
    },
  });

  pgm.createConstraint("deliveries", "deliveries_event_tenant_fk", {
    foreignKeys: {
      columns: ["tenant_id", "event_id"],
      references: "events(tenant_id, id)",
      onDelete: "RESTRICT",
    },
  });

  pgm.createConstraint("deliveries", "deliveries_endpoint_tenant_fk", {
    foreignKeys: {
      columns: ["tenant_id", "endpoint_id"],
      references: "endpoints(tenant_id, id)",
      onDelete: "RESTRICT",
    },
  });

  pgm.addConstraint("deliveries", "deliveries_event_endpoint_unique", {
    unique: ["event_id", "endpoint_id"],
  });

  pgm.createIndex("deliveries", ["status", "next_attempt_at"], {
    name: "deliveries_pending_schedule_idx",
    where: "status IN ('pending', 'retrying')",
  });

  pgm.createIndex("deliveries", ["tenant_id", "created_at"], {
    name: "deliveries_tenant_created_at_idx",
  });
};

export const down = (pgm) => {
  pgm.dropTable("deliveries");
  pgm.dropTable("subscriptions");
  pgm.dropTable("endpoints");
  pgm.dropConstraint("events", "events_tenant_id_id_unique");
};
