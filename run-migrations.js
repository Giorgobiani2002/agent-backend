require('dotenv/config');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function run() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = [
    '001_gemini_chat_schema.sql',
    '002_playbooks.sql',
    '003_bulk_runs.sql',
    '004_playbooks_kind.sql',
  ];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    try {
      await c.query(sql);
      console.log('OK:', f);
    } catch (e) {
      console.error('SKIP:', f, '-', e.message.split('\n')[0]);
    }
  }
  await c.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
