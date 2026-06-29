// Apply ONE (or a few) specific migration file(s) by name, using the same
// connection setup as migrate.js. Use this instead of `npm run db:migrate`
// on an already-migrated DB — the full runner re-applies everything from 001,
// which trips on older non-idempotent migrations (e.g. 011_site_memory.sql:
// "multiple primary keys for table site_memory are not allowed").
//
//   node scripts/migrate-file.js 022_chat_attachments_image.sql
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
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error("usage: node scripts/migrate-file.js <file.sql> [more.sql ...]");
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl });
  const migrationsDir = path.join(__dirname, "..", "migrations");
  try {
    for (const file of targets) {
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
