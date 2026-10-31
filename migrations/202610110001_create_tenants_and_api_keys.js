
export const up = (pgm) => {
  // Organizations using EventRelay
  pgm.createTable("tenants", {
    id: {
      type: "uuid",
      primaryKey: true,
      notNull: true,
      default: pgm.func("gen_random_uuid()"),
    },
    name: {
      type: "text",
      notNull: true,
    },
    status: {
      type: "text",
      notNull: true,
      default: "active",
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

  pgm.addConstraint("tenants", "tenants_status_check", {
    check: "status IN ('active', 'suspended')",
  });

  // Credentials used by producers to authenticate
  pgm.createTable("api_keys", {
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
    name: {
      type: "text",
      notNull: true,
    },
    key_prefix: {
      type: "text",
      notNull: true,
    },
    key_hash: {
      type: "varchar(64)",
      notNull: true,
      unique: true,
    },
    last_used_at: {
      type: "timestamptz",
    },
    expires_at: {
      type: "timestamptz",
    },
    revoked_at: {
      type: "timestamptz",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createIndex("api_keys", "tenant_id", {
    name: "api_keys_tenant_id_idx",
  });
};

export const down = (pgm) => {
  pgm.dropTable("api_keys");
  pgm.dropTable("tenants");
};
