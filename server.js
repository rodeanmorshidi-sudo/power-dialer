/**
 * Power Dialer — single service
 * ---------------------------------------------------------------
 * This one server does everything:
 *   - serves the dialer page (public/index.html) to your reps
 *   - GET  /token   -> hands the browser a short-lived calling token
 *   - POST /voice   -> tells Twilio to dial the contact's real number
 *   - POST /status  -> optional call status logging
 *
 * Reps just open the service's URL in a browser. Fill in .env
 * (see .env.example), then:  npm install && npm start
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const db = require('./db');
 
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_CALLER_ID,
  PORT = 3000,
} = process.env;
 
const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
 
// Serve the dialer page + twilio-telephony.js from /public
app.use(express.static(path.join(__dirname, 'public')));
app.use('/twilio-sdk.js', express.static(path.join(__dirname, 'node_modules/@twilio/voice-sdk/dist/twilio.min.js')));
 
// --- 1. Issue an access token for a browser agent ---------------
app.get('/token', (req, res) => {
  const identity = (req.query.agent || 'agent').toString().slice(0, 64);
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
app.post('/voice', (req, res) => {
  const to = (req.body.To || '').toString().trim();
  const twiml = new twilio.twiml.VoiceResponse();
 
  // 7-15 digits only: this also blocks accidental emergency dialing (e.g. 911)
  if (!/^\+?[0-9]{7,15}$/.test(to)) {
    twiml.say('Sorry, that number is not valid.');
  } else {
    const dial = twiml.dial({
      callerId: TWILIO_CALLER_ID,
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
 
// --- 4. Leads / lightweight CRM -----------------------------------
// Import a CSV's contacts into the leads table. Safe to call repeatedly
// with the same list; existing leads (matched by phone) keep their status.
app.post('/api/leads/import', async (req, res) => {
  try {
    const contacts = Array.isArray(req.body.contacts) ? req.body.contacts : [];
    if (!contacts.length) return res.status(400).json({ error: 'no contacts provided' });
    await db.importLeads(contacts);
    const leads = await db.listLeads(req.query.status);
    res.json({ leads });
  } catch (e) {
    console.error('import failed', e);
    res.status(500).json({ error: 'import failed' });
  }
});
 
// List leads, optionally filtered by status (?status=call_again|do_not_call|booked)
app.get('/api/leads', async (req, res) => {
  try {
    const leads = await db.listLeads(req.query.status);
    res.json({ leads });
  } catch (e) {
    console.error('list leads failed', e);
    res.status(500).json({ error: 'could not load leads' });
  }
});
 
// Update a lead after a call: disposition (what happened), status (what's
// next), notes, and which agent worked it.
app.patch('/api/leads/:id', async (req, res) => {
  try {
    const { disposition, notes, status, agent } = req.body;
    const lead = await db.updateLead(req.params.id, { disposition, notes, status, agent });
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    res.json({ lead });
  } catch (e) {
    console.error('update lead failed', e);
    res.status(400).json({ error: e.message || 'update failed' });
  }
});
 
// Health check (handy for uptime pings on free hosting tiers)
app.get('/healthz', (_, res) => res.send('ok'));
 
db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`Power Dialer running on :${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize database. Is DATABASE_URL set?', e);
    process.exit(1);
  });
 
