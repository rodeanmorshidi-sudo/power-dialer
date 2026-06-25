# Power Dialer

A browser-based power dialer for a small outbound team. Reps open one web page,
work a CSV call list one contact at a time, and calls connect right in the
browser tab (no softphone). Every call gets a disposition and notes. Built on
Twilio Voice.

This is ONE app. The same server both shows reps the dialer page AND handles the
calling behind the scenes. Your reps just open its URL.

---

## The files (what each one is)

- `public/index.html` - the dialer page reps look at and click. Runs in demo
  mode (fake calls) until you flip it to live.
- `public/twilio-telephony.js` - the real calling engine the page uses once live.
- `server.js` - the backend. Serves the page, hands out calling tokens, and tells
  Twilio what number to dial. Runs on a host (not in the browser).
- `package.json` - the list of libraries the backend needs.
- `.env.example` - a blank template for your secret credentials. You copy it to
  `.env` and fill it in.
- `.gitignore` - keeps your secrets (`.env`) out of any code repo.

---

## Try the demo right now (no setup)

Open `public/index.html` in a browser. Click **Sample list**, then **Dial**.
Work the loop: dial, ring, connect (timer runs), hang up, pick a disposition, add
a note, save, advance. Hotkeys: `space` dial / hang up, `m` mute, `s` skip,
`1`-`6` disposition, `enter` save & next. Drop your own CSV anywhere on the page
to load real contacts (it auto-matches name/company/title/phone columns).

The demo does not call anyone and stores nothing. It is just to feel the workflow.

---

## Going live: the big picture

Three things need to know about each other, and the setup order matters because
they have a chicken-and-egg dependency:

1. Your app needs a permanent public address (a URL on the internet).
2. Twilio needs to be told that URL (so it knows where to ask "what do I dial?").
3. Your app needs Twilio's IDs (so it can sign calling tokens).

The trick that avoids confusion: **deploy the app first to get its URL, THEN
create the Twilio TwiML App with that URL, THEN paste the TwiML App's ID back
into the app's settings.** Do it in that order and nothing loops back on itself.

You do NOT need to buy a domain. The host gives you a free URL.

---

## Step-by-step

### 1. Get the code into a GitHub repo
Render (the host) deploys from GitHub.
- Create a free GitHub account if you don't have one.
- Make a new repository, e.g. `power-dialer`.
- Upload this whole folder to it (drag the files into GitHub's web uploader, or
  use `git`). Make sure `.gitignore` is included so your `.env` never uploads.

### 2. Deploy to Render (this gives you your permanent URL)
- Sign up at render.com (free, no credit card for the free tier).
- Click **New > Web Service**, connect your GitHub, pick the `power-dialer` repo.
- Render auto-detects Node. Confirm:
  - Build command: `npm install`
  - Start command: `node server.js`
- Click **Create Web Service**. After it builds, Render shows your URL, e.g.
  `https://power-dialer.onrender.com`. **Copy it.** This is your permanent address.
- Note: the free tier sleeps after 15 minutes idle and takes ~1 minute to wake on
  the next visit. Fine for testing. For reps calling all day, upgrade that service
  to the **$7/month Starter** plan so it never sleeps (no cold-start mid-session).

### 3. Create the Twilio number + Standard API key (if not done)
- Buy a voice-capable Twilio number. Add an **emergency address** to it (cheap,
  avoids a $75 accidental-911 fee).
- Create a **Standard** API key (NOT Restricted - restricted keys can't sign
  calling tokens). Save its **SID** and **Secret** (secret is shown once).

### 4. Create the TwiML App with your Render URL
This is what tells Twilio where your app lives.
- Twilio Console > Voice > TwiML > TwiML Apps > **Create**.
- Set the Voice **Request URL** to your Render URL with `/voice` on the end:
  `https://power-dialer.onrender.com/voice`  (method: HTTP POST)
- Save it and copy the **TwiML App SID**.

### 5. Give the app its Twilio IDs (environment variables)
Instead of editing a `.env` file on a server, you paste these into Render.
- In Render: your service > **Environment** > add these variables:
  - `TWILIO_ACCOUNT_SID`  (Console home, starts with AC)
  - `TWILIO_API_KEY`      (the Standard key SID, starts with SK)
  - `TWILIO_API_SECRET`   (the secret you saved)
  - `TWILIO_TWIML_APP_SID`(from step 4, starts with AP)
  - `TWILIO_CALLER_ID`    (your Twilio number, e.g. +14155550100)
- Save. Render redeploys automatically.

### 6. Flip the page to live mode
Edit `public/index.html` (in your GitHub repo) and:
- Uncomment the two `<script>` tags near the top (the Twilio SDK lines).
- Comment out `const phone = DemoTelephony();`
- Uncomment `const phone = TwilioTelephony({ backendUrl: '', agent: 'dean' });`
  (`backendUrl: ''` means "same site", which is correct here.)
- Change the header badge text from "Demo" so reps aren't confused.
- Commit. Render redeploys.

### 7. Your reps start calling
Send both reps the Render URL. They open it in Chrome, allow microphone access
once, load a CSV, and dial. That's it - nothing runs on your laptop, nothing for
them to install. Give each rep a different `agent` value if you want them tracked
separately (e.g. `agent: 'dean'`, `agent: 'rep2'`).

---

## Local testing with ngrok (optional, just for you)
If you want to test on your laptop before deploying:
`npm install`, fill in a local `.env`, `npm start`, then `npx ngrok http 3000`.
Use the ngrok URL (+ `/voice`) as the TwiML App Request URL. The ngrok URL
changes every restart, which is why it's for testing only, not for your reps.

---

## Rough cost
Twilio: ~$1/mo per number + ~1.3-1.5 cents/min outbound US. Render: free to test,
$7/mo to keep it always-on for your reps. Two reps doing ~200 dials/day lands in
low single-digit dollars/day on Twilio plus the $7 host.

---

## Compliance - read before dialing
Power dialing (a live rep on every call) avoids the worst robocall exposure, but
you're still responsible for:
- Caller ID honesty - use a number you control; no spoofing.
- Do-not-call - scrub against the national DNC registry and honor opt-outs. The
  "Do not call" disposition should feed a suppression list so those numbers are
  never redialed. (This wiring is a TODO - see below.)
- Calling hours - generally 8am-9pm in the called party's local time.
- Consent for wireless/consumer numbers - TCPA rules are strict here; B2B desk
  lines are lower-risk but not DNC-exempt.
- Recording consent - recording is off by default in `server.js`. If you enable
  it, several states require all-party consent; add a verbal disclosure.

General guidance, not legal advice. At volume or into consumer numbers, get it
reviewed by counsel.

## Sensible next steps
- Wire the "Do not call" disposition to a real suppression list.
- Save dispositions/notes to a database or your CRM (the demo keeps them only in
  the browser for the session).
- Pull contacts from Apollo instead of CSV.
- Local-presence caller ID (match the area code you're calling).
