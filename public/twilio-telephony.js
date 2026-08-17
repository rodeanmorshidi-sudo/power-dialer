/**
 * TwilioTelephony — drop-in replacement for DemoTelephony in index.html.
 *
 * To go live:
 *   1. Add the Twilio Voice SDK to <head> in index.html:
 *        <script src="https://sdk.twilio.com/js/voice/releases/2.12.3/twilio.min.js"></script>
 *   2. Add this file:
 *        <script src="twilio-telephony.js"></script>
 *   3. In index.html, replace
 *        const phone = DemoTelephony();
 *      with
 *        const phone = TwilioTelephony({ backendUrl: 'https://YOUR-BACKEND', agent: 'dean' });
 *
 * Same interface the UI expects:
 *   dial(number), hangup(), setMute(bool)
 *   onRinging(), onConnected(), onDisconnected(), onError(msg)
 */
function TwilioTelephony({ backendUrl, agent = 'agent' }) {
  let device = null;
  let activeCall = null;
  let ready = null; // promise that resolves once the Device is registered

  const api = {
    onRinging() {}, onConnected() {}, onDisconnected() {}, onError() {},

    async _ensureDevice() {
      if (ready) return ready;
      ready = (async () => {
        const r = await fetch(`${backendUrl}/token?agent=${encodeURIComponent(agent)}`);
        if (!r.ok) throw new Error('token request failed');
        const { token } = await r.json();
        device = new Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'] });
        device.on('error', (e) => api.onError(e && e.message));
        // refresh the token before it expires
        device.on('tokenWillExpire', async () => {
          const rr = await fetch(`${backendUrl}/token?agent=${encodeURIComponent(agent)}`);
          const { token: t } = await rr.json();
          device.updateToken(t);
        });
        await device.register();
      })();
      return ready;
    },

    async dial(number) {
      try {
        await api._ensureDevice();
        activeCall = await device.connect({ params: { To: number } });
        activeCall.on('ringing', () => api.onRinging());
        activeCall.on('accept', () => api.onConnected());
        activeCall.on('disconnect', () => { activeCall = null; api.onDisconnected(); });
        activeCall.on('cancel', () => { activeCall = null; api.onDisconnected(); });
        activeCall.on('reject', () => { activeCall = null; api.onDisconnected(); });
        activeCall.on('error', (e) => api.onError(e && e.message));
      } catch (e) {
        api.onError(e && e.message);
      }
    },

    hangup() {
      if (activeCall) activeCall.disconnect();
      else if (device) device.disconnectAll();
    },

    setMute(muted) {
      if (activeCall) activeCall.mute(!!muted);
    },

    // Sends touch-tones into an already-connected call — e.g. "press 0 for
    // front desk" IVR menus. Twilio's Call object supports this natively;
    // it just wasn't wired up to any UI before now.
    sendDigits(digits) {
      if (activeCall) activeCall.sendDigits(digits);
      else api.onError('No active call to send digits to');
    },
  };
  return api;
}
