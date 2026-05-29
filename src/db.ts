import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";

const isRailwayRuntime =
  Boolean(process.env.RAILWAY_ENVIRONMENT) || Boolean(process.env.RAILWAY_PROJECT_ID);

const databaseUrl =
  isRailwayRuntime && process.env.DATABASE_URL_PRIVATE
    ? process.env.DATABASE_URL_PRIVATE
    : process.env.DATABASE_URL;

const ssl =
  process.env.PGSSLMODE === "require"
    ? { rejectUnauthorized: false }
    : process.env.NODE_ENV === "production" && !isRailwayRuntime
      ? { rejectUnauthorized: false }
      : undefined;

const poolConfig: PoolConfig = {
  connectionString: databaseUrl,
  ssl,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  // 10s default: proactively close idle connections before proxies/firewalls
  // drop them (the stalled scanner ticks every 60s, so 30s was too long).
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_TIMEOUT_MS ?? 10000),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONNECTION_TIMEOUT_MS ?? 5000),
};

export const db = new Pool(poolConfig);

// Railway's proxy silently drops idle connections. Without this handler, the
// unhandled 'error' event kills the Node process when an idle client errors.
db.on("error", (err) => {
  console.warn("[pg pool] idle client error:", err.message);
});

export function assertDatabaseConfigured(): void {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to connect to PostgreSQL/pgvector");
  }
}

function isStaleConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message ?? "";
  const code = (err as { code?: string }).code ?? "";
  return (
    msg.includes("Connection terminated") ||
    msg.includes("connection terminated") ||
    msg.includes("Client has encountered a connection error") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EADDRNOTAVAIL") ||
    msg.includes("ECONNREFUSED") ||
    code === "ECONNRESET" ||
    code === "EADDRNOTAVAIL" ||
    code === "ECONNREFUSED"
  );
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  assertDatabaseConfigured();
  try {
    return await db.query<T>(text, params);
  } catch (err) {
    if (isStaleConnectionError(err)) {
      // Give the pool a moment to discard the dead client before retrying,
      // otherwise the retry may grab the same broken connection.
      await new Promise((r) => setTimeout(r, 150));
      return await db.query<T>(text, params);
    }
    throw err;
  }
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertDatabaseConfigured();
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function initializePgVector(): Promise<void> {
  assertDatabaseConfigured();
  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
}

export async function getPgVectorStatus(): Promise<{
  ok: boolean;
  database: string;
  vectorExtensionVersion: string | null;
}> {
  assertDatabaseConfigured();

  const result = await db.query<{
    database: string;
    vector_extension_version: string | null;
  }>(`
    SELECT
      current_database() AS database,
      (
        SELECT extversion
        FROM pg_extension
        WHERE extname = 'vector'
      ) AS vector_extension_version
  `);

  const row = result.rows[0];

  return {
    ok: Boolean(row?.vector_extension_version),
    database: row?.database ?? "",
    vectorExtensionVersion: row?.vector_extension_version ?? null,
  };
}
