// Local preview of the phone page with a fake TV: node scripts/preview.mjs → http://127.0.0.1:7789/?t=dev
// The fake foreground app rotates every few seconds so the status card can be checked.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createServer } = require('../service/server.js');

const apps = [
  { appId: 'com.lfkdsk.overseabili', supported: true, focusedEditable: true },
  { appId: 'org.moonfin.webos', supported: true, focusedEditable: false },
  { appId: 'netflix', supported: false, reason: 'app-not-supported' },
];
let i = 0, field = '';
setInterval(() => (i = (i + 1) % apps.length), 6000);
const injector = {
  status: async () => apps[i],
  insert: async (t) => { if (!apps[i].supported) { const e = new Error('app-not-supported'); throw e; } field += t; console.log('field:', field); return { value: field }; },
  deleteChars: async (n) => { field = Array.from(field).slice(0, -n || undefined).join(''); console.log('field:', field); return {}; },
  enter: async () => { console.log('ENTER with', field); field = ''; return {}; },
};
const ssap = Object.assign(new EventEmitter(), { state: 'ready' });
const { server } = createServer({ token: 'dev', injector, ssap });
server.listen(Number(process.env.PORT || 7789), '127.0.0.1', () => console.log('preview: http://127.0.0.1:7789/?t=dev'));
