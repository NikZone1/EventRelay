
export const up = (pgm) => {
  pgm.createTable("events", {
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
    idempotency_key: {
      type: "varchar(255)",
      notNull: true,
    },
    event_type: {
      type: "varchar(255)",
      notNull: true,
    },
    payload: {
      type: "jsonb",
      notNull: true,
    },
    request_hash: {
      type: "varchar(64)",
      notNull: true,
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("events", "events_tenant_idempotency_key_unique", {
    unique: ["tenant_id", "idempotency_key"],
  });

  pgm.createIndex("events", ["tenant_id", "created_at"], {
    name: "events_tenant_created_at_idx",
  });

  pgm.createTable("outbox_events", {
    id: {
      type: "bigint",
      primaryKey: true,
      notNull: true,
    },
    event_id: {
      type: "uuid",
      notNull: true,
      references: "events(id)",
      onDelete: "RESTRICT",
      unique: true,
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    published_at: {
      type: "timestamptz",
    },
    attempts: {
      type: "integer",
      notNull: true,
      default: 0,
    },
    last_error: {
      type: "text",
    },
  });

  pgm.sql(`
    CREATE SEQUENCE outbox_events_id_seq
      AS bigint
      OWNED BY outbox_events.id
  `);

  pgm.alterColumn("outbox_events", "id", {
    default: pgm.func("nextval('outbox_events_id_seq')"),
  });

  pgm.createIndex(
    "outbox_events",
    ["created_at"],
    {
      name: "outbox_events_unpublished_idx",
      where: "published_at IS NULL",
    }
  );
};

export const down = (pgm) => {
  pgm.dropTable("outbox_events");
  pgm.dropTable("events");
  pgm.sql("DROP SEQUENCE IF EXISTS outbox_events_id_seq");
};
