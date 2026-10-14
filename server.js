/**
 * Power Dialer — single service
 * ---------------------------------------------------------------
 * This one server does everything:
 *   - serves the login page, dialer page, and CRM page
 *   - POST /api/login, /api/logout, GET /api/me -> rep accounts
 *   - GET  /token   -> hands a logged-in rep a short-lived calling token
 *   - POST /voice   -> tells Twilio to dial, using that rep's own number
 *   - POST /status  -> optional call status logging
 *   - /api/leads    -> each rep's own leads (admins can see everyone's)
 *
 * Accounts are created with:  node scripts/users.js add <username> ...
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const twilio = require('twilio');
const db = require('./db');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_CALLER_ID, // fallback number for anyone without their own
  PORT = 3000,
} = process.env;

const SESSION_COOKIE = 'pd_session';

const app = express();
app.set('trust proxy', 1); // Render terminates HTTPS in front of us
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '5mb' }));

/* ---------------- sessions ---------------- */

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

async function loadUser(req, _res, next) {
  try {
    req.user = await db.getSessionUser(readCookie(req, SESSION_COOKIE));
  } catch (e) {
    console.error('session lookup failed', e);
    req.user = null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not logged in' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'admins only' });
  next();
}

app.use(loadUser);

// The dialer and CRM pages need a login; send anyone else to the login page.
app.get(['/', '/index.html', '/crm.html'], (req, res, next) => {
  if (!req.user) return res.redirect('/login.html');
  next();
});
app.get('/login.html', (req, res, next) => {
  if (req.user) return res.redirect('/');
  next();
});

// Serve the pages + twilio-telephony.js from /public
app.use(express.static(path.join(__dirname, 'public')));
app.use('/twilio-sdk.js', express.static(path.join(__dirname, 'node_modules/@twilio/voice-sdk/dist/twilio.min.js')));

/* ---------------- login ---------------- */

// Simple brute-force guard: 10 failed attempts per IP per 15 minutes.
const failedLogins = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function tooManyFailures(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) return false;
  return entry.count >= 10;
}
function recordFailure(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) failedLogins.set(ip, { first: Date.now(), count: 1 });
  else entry.count++;
}

app.post('/api/login', async (req, res) => {
  try {
    if (tooManyFailures(req.ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const { username, password } = req.body || {};
    const user = username && password ? await db.getUserByUsername(username) : null;
    if (!user || !db.verifyPassword(String(password), user.password_hash)) {
      recordFailure(req.ip);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    failedLogins.delete(req.ip);
    const { token, maxAgeMs } = await db.createSession(user.id);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: maxAgeMs,
      path: '/',
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('login failed', e);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

app.post('/api/logout', async (req, res) => {
  try { await db.deleteSession(readCookie(req, SESSION_COOKIE)); } catch (e) { console.error(e); }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  const { username, email, caller_id, is_admin } = req.user;
  res.json({ username, email, caller_id: caller_id || TWILIO_CALLER_ID || null, is_admin });
});

// Admins: list accounts (for the CRM's owner filter and "import for" picker).
app.get('/api/users', requireAdmin, async (_req, res) => {
  try {
    const users = await db.listUsers();
    res.json({ users: users.map(({ id, username, is_admin }) => ({ id, username, is_admin })) });
  } catch (e) {
    console.error('list users failed', e);
    res.status(500).json({ error: 'could not load users' });
  }
});

/* ---------------- calling ---------------- */

// --- 1. Issue an access token for the logged-in rep --------------
app.get('/token', requireUser, (req, res) => {
  const identity = req.user.username;
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY,
    TWILIO_API_SECRET,
    { identity, ttl: 3600 }
  );
  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    incomingAllow: false,
  }));

  res.json({ identity, token: token.toJwt() });
});

// --- 2. Bridge the browser call to the contact's phone ----------
// Twilio tells us who's calling as From = "client:<username>". We look that
// rep up and show their own number as caller ID.
app.post('/voice', async (req, res) => {
  const to = (req.body.To || '').toString().trim();
  const from = (req.body.From || '').toString();
  const twiml = new twilio.twiml.VoiceResponse();

  let callerId = TWILIO_CALLER_ID;
  try {
    if (from.startsWith('client:')) {
      const rep = await db.getUserByUsername(from.slice('client:'.length));
      if (rep && rep.caller_id) callerId = rep.caller_id;
    }
  } catch (e) {
    console.error('caller ID lookup failed, using default number', e);
  }

  // 7-15 digits only: this also blocks accidental emergency dialing (e.g. 911)
  if (!/^\+?[0-9]{7,15}$/.test(to)) {
    twiml.say('Sorry, that number is not valid.');
  } else {
    const dial = twiml.dial({
      callerId,
      answerOnBridge: true,
      // record: 'record-from-answer-dual',   // enable only where consent rules allow
    });
    dial.number(to);
  }
  res.type('text/xml').send(twiml.toString());
});

// --- 3. Optional: receive call status events --------------------
app.post('/status', (req, res) => {
  const { CallSid, CallStatus, To, CallDuration } = req.body;
  console.log(`[status] ${CallSid} -> ${CallStatus} (${To}, ${CallDuration || 0}s)`);
  res.sendStatus(204);
});

/* ---------------- leads / lightweight CRM ---------------- */

// Import a CSV's contacts into the logged-in rep's own list. Admins can pass
// owner_id to load a list into another rep's account.
app.post('/api/leads/import', requireUser, async (req, res) => {
  try {
    const contacts = Array.isArray(req.body.contacts) ? req.body.contacts : [];
    if (!contacts.length) return res.status(400).json({ error: 'no contacts provided' });
    let ownerId = req.user.id;
    if (req.body.owner_id != null && Number(req.body.owner_id) !== req.user.id) {
      if (!req.user.is_admin) return res.status(403).json({ error: 'admins only' });
      ownerId = Number(req.body.owner_id);
    }
    await db.importLeads(ownerId, contacts);
    const leads = await db.listLeads({ ownerId, status: req.query.status });
    res.json({ leads });
  } catch (e) {
    console.error('import failed', e);
    res.status(500).json({ error: 'import failed' });
  }
});

// List the rep's own leads. Admins can add ?scope=all to see every rep's.
app.get('/api/leads', requireUser, async (req, res) => {
  try {
    const allOwners = req.query.scope === 'all' && req.user.is_admin;
    const leads = await db.listLeads({ ownerId: req.user.id, allOwners, status: req.query.status });
    res.json({ leads });
  } catch (e) {
    console.error('list leads failed', e);
    res.status(500).json({ error: 'could not load leads' });
  }
});

// Update a lead after a call: disposition (what happened), status (what's
// next), and notes. The agent is always the logged-in rep.
app.patch('/api/leads/:id', requireUser, async (req, res) => {
  try {
    const { disposition, notes, status } = req.body;
    const lead = await db.updateLead(req.user, Number(req.params.id), { disposition, notes, status });
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    res.json({ lead });
  } catch (e) {
    console.error('update lead failed', e);
    res.status(400).json({ error: e.message || 'update failed' });
  }
});

// Delete a single lead outright.
app.delete('/api/leads/:id', requireUser, async (req, res) => {
  try {
    const count = await db.deleteLeads(req.user, [Number(req.params.id)]);
    if (!count) return res.status(404).json({ error: 'lead not found' });
    res.json({ deleted: true });
  } catch (e) {
    console.error('delete lead failed', e);
    res.status(500).json({ error: 'delete failed' });
  }
});

// Bulk delete — body: { ids: [1, 2, 3] }.
app.delete('/api/leads', requireUser, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return res.status(400).json({ error: 'no valid ids provided' });
    const count = await db.deleteLeads(req.user, ids);
    res.json({ deleted: count });
  } catch (e) {
    console.error('bulk delete failed', e);
    res.status(500).json({ error: 'delete failed' });
  }
});

// Health check (handy for uptime pings)
app.get('/healthz', (_, res) => res.send('ok'));

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`Power Dialer running on :${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize database. Is DATABASE_URL set?', e);
    process.exit(1);
  });
