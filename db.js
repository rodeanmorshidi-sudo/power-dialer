/**
 * db.js — thin Postgres wrapper for users, sessions, and leads.
 * Uses DATABASE_URL (Render's Postgres sets this automatically).
 *
 * Every lead belongs to exactly one user (owner_id). Reps only ever see and
 * touch their own leads; admins can see and manage everyone's from the CRM.
 */
const crypto = require('crypto');
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
const SESSION_DAYS = 30;

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      caller_id TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT,
      company TEXT,
      title TEXT,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'call_again',
      last_disposition TEXT,
      notes TEXT,
      call_count INTEGER NOT NULL DEFAULT 0,
      agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Additive migrations — safe to run against a table that already exists.
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_called_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_imported_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;`);
  // A phone number used to be unique across the whole system. Now it's unique
  // per owner, so two reps can each have the same business in their own list.
  await pool.query(`ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_phone_key;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS leads_owner_phone_idx ON leads(owner_id, phone);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status);`);
  await pool.query(`DELETE FROM sessions WHERE expires_at < now();`);
}

/* ---------------- passwords ---------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Random, readable password: no lookalike characters (0/O, 1/l/I).
function generatePassword(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < chars.length * Math.floor(256 / chars.length)) out += chars[byte % chars.length];
  }
  return out;
}

/* ---------------- users ---------------- */

const PUBLIC_USER_COLS = 'id, username, email, caller_id, is_admin, created_at';

async function createUser({ username, email, password, callerId, isAdmin }) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, email, password_hash, caller_id, is_admin)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_USER_COLS}`,
    [username.toLowerCase(), email || null, hashPassword(password), callerId || null, !!isAdmin]
  );
  return rows[0];
}

async function updateUser(username, { email, password, callerId, isAdmin }) {
  const { rows } = await pool.query(
    `UPDATE users SET
       email = COALESCE($2, email),
       password_hash = COALESCE($3, password_hash),
       caller_id = COALESCE($4, caller_id),
       is_admin = COALESCE($5, is_admin)
     WHERE username = $1 RETURNING ${PUBLIC_USER_COLS}`,
    [username.toLowerCase(), email ?? null, password ? hashPassword(password) : null,
     callerId ?? null, typeof isAdmin === 'boolean' ? isAdmin : null]
  );
  if (rows[0] && password) {
    // a password reset logs that user out everywhere
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [rows[0].id]);
  }
  return rows[0] || null;
}

async function deleteUser(username) {
  const { rowCount } = await pool.query(`DELETE FROM users WHERE username = $1`, [username.toLowerCase()]);
  return rowCount > 0;
}

async function getUserByUsername(username) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE username = $1 OR lower(email) = $1`, [String(username || '').toLowerCase().trim()]);
  return rows[0] || null;
}

async function listUsers() {
  const { rows } = await pool.query(`SELECT ${PUBLIC_USER_COLS} FROM users ORDER BY username`);
  return rows;
}

/* ---------------- sessions ---------------- */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [sha256(token), userId, String(SESSION_DAYS)]
  );
  return { token, maxAgeMs: SESSION_DAYS * 24 * 60 * 60 * 1000 };
}

async function getSessionUser(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.caller_id, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  return rows[0] || null;
}

async function deleteSession(token) {
  if (token) await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
}

/* ---------------- leads ---------------- */

// Bulk upsert from a CSV import into one owner's list. Existing leads in that
// owner's list (matched by phone) keep their status/notes/history, so
// importing the same list twice is safe. Other reps' leads are never touched.
async function importLeads(ownerId, contacts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of contacts) {
      await client.query(
        `INSERT INTO leads (name, company, title, phone, owner_id, last_imported_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (owner_id, phone) DO UPDATE SET
           name = COALESCE(NULLIF(EXCLUDED.name, ''), leads.name),
           company = COALESCE(NULLIF(EXCLUDED.company, ''), leads.company),
           title = COALESCE(NULLIF(EXCLUDED.title, ''), leads.title),
           last_imported_at = now()`,
        [c.name || '', c.company || '', c.title || '', c.phone, ownerId]
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

// ownerId: a user id to list one owner's leads, or null (admins only) for all
// leads, including any left over from before accounts existed.
async function listLeads({ ownerId, allOwners = false, status }) {
  const where = [];
  const params = [];
  if (!allOwners) { params.push(ownerId); where.push(`l.owner_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`l.status = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT l.*, u.username AS owner
       FROM leads l LEFT JOIN users u ON u.id = l.owner_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.created_at ASC`,
    params
  );
  return rows;
}

// Limits a lead query to what this user is allowed to touch: their own leads,
// or any lead if they're an admin.
function scopeClause(user, paramIndex) {
  return user.is_admin ? 'TRUE' : `owner_id = $${paramIndex}`;
}

// Called after a rep wraps up a call: records what happened (disposition)
// and where the lead stands going forward (status).
//
// Attempt tracking: dispositions that aren't a real conversation (voicemail,
// no-answer, callback) increment `attempts`. After MAX_UNRESOLVED_ATTEMPTS,
// a lead the rep left as "call again" (the default) is auto-flipped to
// 'exhausted' instead. An actual connected call resets the counter to 0.
// A rep's explicit status choice (booked / do_not_call) always overrides
// this and is never auto-changed.
//
// Manual revival: a status of 'call_again' with NO disposition (from the CRM
// page, not a live call) resets attempts to 0 for a fresh 3 tries.
async function updateLead(user, id, { disposition, notes, status }) {
  if (status && !VALID_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const isUnresolved = !!(disposition && UNRESOLVED_DISPOSITIONS.includes(disposition));
  // Only credit the agent when a call actually happened.
  const agent = disposition ? user.username : null;
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
     WHERE id = $1 AND ${scopeClause(user, 8)}
     RETURNING *`,
    user.is_admin
      ? [id, disposition || null, notes ?? null, status || null, agent, isUnresolved, MAX_UNRESOLVED_ATTEMPTS]
      : [id, disposition || null, notes ?? null, status || null, agent, isUnresolved, MAX_UNRESOLVED_ATTEMPTS, user.id]
  );
  return rows[0] || null;
}

// Deletes leads entirely (not a status change). Reps can only delete their
// own; admins can delete any.
async function deleteLeads(user, ids) {
  if (!ids.length) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM leads WHERE id = ANY($1::int[]) AND ${scopeClause(user, 2)}`,
    user.is_admin ? [ids] : [ids, user.id]
  );
  return rowCount;
}

module.exports = {
  pool, init, VALID_STATUSES,
  generatePassword, verifyPassword,
  createUser, updateUser, deleteUser, getUserByUsername, listUsers,
  createSession, getSessionUser, deleteSession,
  importLeads, listLeads, updateLead, deleteLeads,
};
