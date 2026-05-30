// One-shot migration runner for migrations not yet applied to prod.
// The main migrate.js re-runs everything from 001 which trips on
// non-idempotent ADD CONSTRAINT statements in 013.  This applies a
// hand-curated list and reports OK/FAIL per file without aborting.
//
// Usage:  railway run --service pgvector node scripts/migrate-new-only.js
// (or set DATABASE_URL manually)

require("dotenv/config");
const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");

const ONLY = process.argv.slice(2);
const FILES = ONLY.length > 0 ? ONLY : [
  "015_playbook_country_code.sql",
  "016_agent_runs.sql",
  "017_playbook_key.sql",
  "018_alerts.sql",
];

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const ssl = /sslmode=require/i.test(cs) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: cs, ssl });
  let okCount = 0;
  let failCount = 0;
  for (const f of FILES) {
    const sql = await fs.readFile(path.join(__dirname, "..", "migrations", f), "utf8");
    try {
      await pool.query(sql);
      console.log("OK   " + f);
      okCount++;
    } catch (e) {
      console.log("FAIL " + f + " :: " + e.message);
      failCount++;
    }
  }
  await pool.end();
  console.log(`\ndone: ${okCount} ok, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
})();
