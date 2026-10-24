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
let lastToast = 0;
const { server, snapshot } = createServer({
  token: TOKEN,
  ssap,
  // A short reminder on screen when a keyboard opens, at most every 10 minutes.
  onKeyboard: (kb) => {
    if (!kb.focus || Date.now() - lastToast < 600000 || !readSettings().toast) return;
    lastToast = Date.now();
    const ip = lanAddress();
    if (ip) ssap.call('ssap://system.notifications/createToast', { message: '手机或电脑打开 http://' + ip + ':' + PORT + ' 打字（首次请在「电视键盘」里扫码）' }).catch(() => {});
  },
});
let listening = false, listenError = null;
server.on('error', (e) => { listenError = String(e.code || e.message); });
server.listen(PORT, '0.0.0.0', () => { listening = true; });
// ssap.start() runs once the LAN address is known (refreshAddress); start() is idempotent.

function readSettings() { try { return Object.assign({ toast: true }, JSON.parse(fs.readFileSync(path.join(STATE, 'settings.json'), 'utf8'))); } catch (e) { return { toast: true }; } }
function writeSettings(s) { fs.writeFileSync(path.join(STATE, 'settings.json'), JSON.stringify(s), { mode: 0o600 }); }

// Hold an activity forever so webos-service does not exit this process when idle.
service.activityManager.create('keep-typing-server', () => {});

function fromApp(m) {
  try { const id = m.ls2Message.applicationID(); return typeof id === 'string' && id.split(' ')[0] === APP_ID; } catch (e) { return false; }
}

service.register('state', (m) => {
  const ip = lanAddress();
  const url = ip ? 'http://' + ip + ':' + PORT + '/?t=' + TOKEN : null;
  let svg = null;
  if (url && fromApp(m)) { const qr = qrcode(0, 'M'); qr.addData(url); qr.make(); svg = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true }); }
  m.respond(Object.assign({ returnValue: true, listening, listenError, url: fromApp(m) ? url : null, qr: svg, settings: readSettings() }, snapshot()));
});
service.register('settings', (m) => {
  if (!fromApp(m)) { m.respond({ returnValue: false, errorText: 'caller-not-authorized' }); return; }
  const s = readSettings();
  if (typeof (m.payload || {}).toast === 'boolean') s.toast = m.payload.toast;
  writeSettings(s);
  m.respond({ returnValue: true, settings: s });
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
