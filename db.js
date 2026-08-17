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

const VALID_STATUSES = ['call_again', 'do_not_call', 'booked', 'exhausted'];
const MAX_UNRESOLVED_ATTEMPTS = 3; // voicemail/no-answer/callback tries before auto-exhausting
const UNRESOLVED_DISPOSITIONS = ['voicemail', 'no-answer', 'callback'];

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
  // Additive migrations — safe to run against a table that already exists
  // from before this feature was added (Render's leads table included).
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_called_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_imported_at TIMESTAMPTZ;`);
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
        `INSERT INTO leads (name, company, title, phone, last_imported_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (phone) DO UPDATE SET
           name = COALESCE(NULLIF(EXCLUDED.name, ''), leads.name),
           company = COALESCE(NULLIF(EXCLUDED.company, ''), leads.company),
           title = COALESCE(NULLIF(EXCLUDED.title, ''), leads.title),
           last_imported_at = now()`,
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
//
// Attempt tracking: dispositions that aren't a real conversation (voicemail,
// no-answer, callback) increment `attempts`. After MAX_UNRESOLVED_ATTEMPTS,
// a lead the rep left as "call again" (the default) is auto-flipped to
// 'exhausted' instead — it stops resurfacing in the active queue, but stays
// in the table and isn't confused with an explicit do-not-call. An actual
// connected call resets the counter to 0 (clean slate after a real talk).
// A rep's explicit status choice (booked / do_not_call) always overrides
// this and is never auto-changed.
//
// Manual revival: if this is called with a status of 'call_again' and NO
// disposition (i.e. from the CRM page, not a live call), that's ops
// consciously putting a lead back in rotation — attempts resets to 0 so it
// gets a fresh 3 tries rather than immediately re-exhausting.
async function updateLead(id, { disposition, notes, status, agent }) {
  if (status && !VALID_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const isUnresolved = disposition && UNRESOLVED_DISPOSITIONS.includes(disposition);
  const { rows } = await pool.query(
    `UPDATE leads SET
       last_disposition = COALESCE($2, last_disposition),
       notes = COALESCE($3, notes),
       agent = COALESCE($5, agent),
       last_called_at = CASE WHEN $2 IS NOT NULL THEN now() ELSE last_called_at END,
       call_count = call_count + CASE WHEN $2 IS NOT NULL THEN 1 ELSE 0 END,
       attempts = CASE
         WHEN $2 = 'connected' THEN 0
         WHEN $6 THEN attempts + 1
         WHEN $2 IS NULL AND $4 = 'call_again' THEN 0
         ELSE attempts
       END,
       status = CASE
         WHEN $4 IS NOT NULL AND $4 != 'call_again' THEN $4
         WHEN $4 = 'call_again' AND $6 AND (attempts + 1) >= $7 THEN 'exhausted'
         WHEN $4 IS NOT NULL THEN $4
         ELSE status
       END,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, disposition || null, notes ?? null, status || null, agent || null, isUnresolved, MAX_UNRESOLVED_ATTEMPTS]
  );
  return rows[0] || null;
}

// Deletes one lead entirely (not a status change — actually removes the row).
// Used for cleaning up test/sample data, not for real leads you've worked.
async function deleteLead(id) {
  const { rowCount } = await pool.query(`DELETE FROM leads WHERE id = $1`, [id]);
  return rowCount > 0;
}

// Bulk delete by id list — same use case, faster for clearing a batch at once.
async function deleteLeads(ids) {
  if (!ids.length) return 0;
  const { rowCount } = await pool.query(`DELETE FROM leads WHERE id = ANY($1::int[])`, [ids]);
  return rowCount;
}

module.exports = { pool, init, importLeads, listLeads, updateLead, deleteLead, deleteLeads, VALID_STATUSES };
