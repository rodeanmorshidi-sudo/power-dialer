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

// Health check (handy for uptime pings on free hosting tiers)
app.get('/healthz', (_, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Power Dialer running on :${PORT}`));
