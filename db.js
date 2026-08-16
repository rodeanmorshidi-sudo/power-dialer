/**
 * db.js — thin Postgres wrapper for the leads table.
 * Uses DATABASE_URL (Render's free Postgres add-on sets this automatically).
 */
const { Pool } = require('pg');
 
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's Postgres requires SSL; disable the cert check since Render uses
  // self-signed certs internally. Fine for this use case.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});
 
const VALID_STATUSES = ['call_again', 'do_not_call', 'booked'];
 
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT,
      company TEXT,
      title TEXT,
      phone TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'call_again',
      last_disposition TEXT,
      notes TEXT,
      call_count INTEGER NOT NULL DEFAULT 0,
      agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status);`);
}
 
// Bulk upsert from a CSV import. Existing leads (matched by phone) keep
// their status/notes/history — importing the same list twice is safe and
// never resets a lead someone already worked.
async function importLeads(contacts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of contacts) {
      await client.query(
        `INSERT INTO leads (name, company, title, phone)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone) DO UPDATE SET
           name = COALESCE(NULLIF(EXCLUDED.name, ''), leads.name),
           company = COALESCE(NULLIF(EXCLUDED.company, ''), leads.company),
           title = COALESCE(NULLIF(EXCLUDED.title, ''), leads.title)`,
        [c.name || '', c.company || '', c.title || '', c.phone]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
 
async function listLeads(status) {
  if (status) {
    const { rows } = await pool.query(
      `SELECT * FROM leads WHERE status = $1 ORDER BY created_at ASC`,
      [status]
    );
    return rows;
  }
  const { rows } = await pool.query(`SELECT * FROM leads ORDER BY created_at ASC`);
  return rows;
}
 
// Called after a rep wraps up a call: records what happened (disposition)
// and where the lead stands going forward (status).
async function updateLead(id, { disposition, notes, status, agent }) {
  if (status && !VALID_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const { rows } = await pool.query(
    `UPDATE leads SET
       last_disposition = COALESCE($2, last_disposition),
       notes = COALESCE($3, notes),
       status = COALESCE($4, status),
       agent = COALESCE($5, agent),
       call_count = call_count + CASE WHEN $2 IS NOT NULL THEN 1 ELSE 0 END,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, disposition || null, notes ?? null, status || null, agent || null]
  );
  return rows[0] || null;
}
 
module.exports = { pool, init, importLeads, listLeads, updateLead, VALID_STATUSES };
