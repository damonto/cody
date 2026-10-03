/** Snapshot-only SQL test double for routing tests; persistence is tested with real SQL. */
export function snapshotDatabase(read) {
  let version = 0;
  let last;
  const snapshots = new Map();
  function prepare(sql, values = []) {
    return {
      bind: (...values) => prepare(sql, values),
      async first() {
        if (sql.includes("FROM config_meta")) {
          const value = await read();
          const raw = typeof value === "string" ? value : JSON.stringify(value);
          if (raw !== last) {
            last = raw;
            version++;
            const config = JSON.parse(raw);
            for (const price of config.model_prices ?? [])
              price.version_id ??= crypto.randomUUID();
            snapshots.set(version, JSON.stringify(config));
          }
          return { version, maintenance: 0, updated_at: 0 };
        }
        if (sql.includes("FROM config_snapshots"))
          return { version: values[0], config_json: snapshots.get(values[0]) };
        throw new Error(`Unexpected fixture query: ${sql}`);
      },
    };
  }
  return { prepare };
}
