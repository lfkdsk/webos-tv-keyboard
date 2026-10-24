'use strict';
// webOS JS service: keeps the LAN typing server running and tells the app what to show.
// It holds an activity so the service is not reaped while idle, and a persistent scheduled
// activity brings it back after a reboot.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Service = require('webos-service');
const { Ssap } = require('./ssap');
const { createServer } = require('./server');
const { createInjector } = require('./inject');
const qrcode = require('./qrcode');

const ID = require('./package.json').name;
const APP_ID = ID.replace(/\.service$/, '');
const PORT = 7788;
const STATE = path.join(__dirname, 'state');
const service = new Service(ID);

if (!fs.existsSync(STATE)) fs.mkdirSync(STATE, { mode: 0o700 });
function token() {
  const f = path.join(STATE, 'token');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) {
    const t = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(f, t, { mode: 0o600 });
    return t;
  }
}
// The service sandbox hides network interfaces from os.networkInterfaces(), so ask the
// connection manager. Wired wins over Wi-Fi when both are up.
let lanIp = null;
function lanAddress() { return lanIp; }
function refreshAddress() {
  service.call('luna://com.palm.connectionmanager/getStatus', {}, (m) => {
    const p = m.payload || {};
    const pick = (n) => (n && n.state === 'connected' && n.ipAddress ? n.ipAddress : null);
    lanIp = pick(p.wired) || pick(p.wifi) || lanIp;
    if (lanIp) ssap.start();
    if (!lanIp) {
      for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) lanIp = lanIp || n.address;
    }
  });
}

const TOKEN = token();
refreshAddress();
setInterval(refreshAddress, 30000);
const ssap = new Ssap(path.join(STATE, 'ssap-key.json'), () => lanIp || '127.0.0.1');
// Foreground app via SSAP (READ_APP_STATUS works for unsigned clients, unlike the IME methods).
const injector = createInjector(() => ssap.call('ssap://com.webos.applicationManager/getForegroundAppInfo').then((r) => r.appId || null));
const { server, snapshot } = createServer({ token: TOKEN, ssap, injector });
let listening = false, listenError = null;
server.on('error', (e) => { listenError = String(e.code || e.message); });
server.listen(PORT, '0.0.0.0', () => { listening = true; });
// ssap.start() runs once the LAN address is known (refreshAddress); start() is idempotent.

// Hold an activity forever so webos-service does not exit this process when idle.
service.activityManager.create('keep-typing-server', () => {});

function fromApp(m) {
  try { const id = m.ls2Message.applicationID(); return typeof id === 'string' && id.split(' ')[0] === APP_ID; } catch (e) { return false; }
}

service.register('state', (m) => {
  // The TV announces <hostname>.local over mDNS on its own, so that name survives IP changes
  // and switching between Ethernet and Wi-Fi; the QR uses it, the IP is shown as a fallback.
  const ip = lanAddress();
  const host = (os.hostname() || '').toLowerCase();
  const mdns = /^[a-z0-9-]+$/.test(host) ? host + '.local' : null;
  const tail = ':' + PORT + '/?t=' + TOKEN;
  const url = mdns ? 'http://' + mdns + tail : ip ? 'http://' + ip + tail : null;
  const ipUrl = ip ? 'http://' + ip + tail : null;
  const own = fromApp(m);
  const svgFor = (u) => { if (!u || !own) return null; const qr = qrcode(0, 'M'); qr.addData(u); qr.make(); return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true }); };
  // Two codes: the .local one is the address to keep; the IP one works on phones without mDNS.
  m.respond(Object.assign({ returnValue: true, listening, listenError, url: own ? url : null, ipUrl: own ? ipUrl : null, qr: svgFor(url), qrIp: ipUrl !== url ? svgFor(ipUrl) : null }, snapshot()));
});

// Called by the boot activity; starting the service is the point, nothing else to do.
service.register('tick', (m) => {
  if (m.activity) service.activityManager.complete(m.activity, { restart: true }, () => m.respond({ returnValue: true }));
  else m.respond({ returnValue: true });
});

service.call('luna://com.palm.activitymanager/create', {
  activity: {
    name: ID + '.boot', description: 'Start the TV keyboard server after boot',
    type: { foreground: true, persist: true }, schedule: { interval: '15m' },
    callback: { method: 'luna://' + ID + '/tick', params: {} },
  },
  start: true, replace: true, subscribe: false,
}, () => {});
