require("dotenv/config");

const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");

const isRailwayRuntime =
  Boolean(process.env.RAILWAY_ENVIRONMENT) || Boolean(process.env.RAILWAY_PROJECT_ID);

const connectionString =
  isRailwayRuntime && process.env.DATABASE_URL_PRIVATE
    ? process.env.DATABASE_URL_PRIVATE
    : process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL is required to run migrations");
  process.exit(1);
}

const ssl =
  process.env.PGSSLMODE === "require"
    ? { rejectUnauthorized: false }
    : process.env.NODE_ENV === "production" && !isRailwayRuntime
      ? { rejectUnauthorized: false }
      : undefined;

async function main() {
  const pool = new Pool({ connectionString, ssl });
  const migrationsDir = path.join(__dirname, "..", "migrations");
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  try {
    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await pool.query(sql);
      console.log(`Applied migration ${file}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
