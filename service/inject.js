'use strict';
// Puts typed text into the foreground app through the TV's local DevTools endpoint
// (127.0.0.1:9998, open in Developer Mode for sideloaded web apps). The system IME methods
// are off limits to Developer Mode apps ("private"/"devices" ACG groups) and SSAP leaves
// them unanswered for unsigned clients, so this is the path that works without root.
// Store apps and LG system apps are not debuggable and are reported as unsupported.
const http = require('http');
const { WsClient } = require('./ws-client');

const DEVTOOLS = { host: '127.0.0.1', port: 9998 };

function listTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: DEVTOOLS.host, port: DEVTOOLS.port, path: '/json', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('devtools-bad-json')); } });
    });
    req.on('timeout', () => req.destroy(new Error('devtools-timeout')));
    req.on('error', reject);
  });
}

function targetFor(targets, appId) {
  const marker = '/applications/' + appId + '/';
  return targets.find((t) => t.type === 'page' && (t.url || '').includes(marker) && t.webSocketDebuggerUrl);
}

// One short-lived DevTools session per action; the page keeps no state of ours.
function session(wsUrl, fn) {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(wsUrl.replace('localhost', DEVTOOLS.host));
    let seq = 0;
    const pending = new Map();
    const send = (method, params) => new Promise((ok, fail) => {
      const id = ++seq;
      pending.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params: params || {} }), 0x1);
    });
    const timer = setTimeout(() => { ws.close(); reject(new Error('devtools-timeout')); }, 8000);
    ws.on('message', (buf) => {
      let m;
      try { m = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.fail(new Error(m.error.message || 'devtools-error')); else p.ok(m.result || {});
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('open', () => {
      fn(send).then((v) => { clearTimeout(timer); ws.close(); resolve(v); }, (e) => { clearTimeout(timer); ws.close(); reject(e); });
    });
    ws.connect(5000);
  });
}

// Make sure a text field has focus: keep the focused one, otherwise take the first visible one.
const FOCUS_JS = `(() => {
  const ok = (el) => el && (el.isContentEditable || (el.tagName === 'TEXTAREA') || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number|)$/i.test(el.type || '')));
  let el = document.activeElement;
  if (!ok(el)) {
    el = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].find((e) => ok(e) && e.offsetParent !== null && !e.disabled && !e.readOnly);
    if (el) el.focus();
  }
  if (!ok(el)) return { editable: false };
  return { editable: true, value: el.isContentEditable ? el.textContent : el.value, placeholder: el.placeholder || '' };
})()`;

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result && r.result.value;
}

function createInjector(getForeground) {
  async function withPage(fn) {
    const appId = await getForeground();
    if (!appId) throw new Error('no-foreground-app');
    let targets;
    try { targets = await listTargets(); } catch (e) { throw new Error('devtools-unavailable'); }
    const t = targetFor(targets, appId);
    if (!t) { const err = new Error('app-not-supported'); err.appId = appId; throw err; }
    return session(t.webSocketDebuggerUrl, fn).then((v) => Object.assign({ appId }, v));
  }
  const key = (send, k, code, keyCode) => send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
    .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }));

  return {
    async status() {
      const appId = await getForeground();
      if (!appId) return { appId: null, supported: false };
      let targets;
      try { targets = await listTargets(); } catch (e) { return { appId, supported: false, reason: 'devtools-unavailable' }; }
      const t = targetFor(targets, appId);
      if (!t) return { appId, supported: false, reason: 'app-not-supported' };
      try {
        const info = await session(t.webSocketDebuggerUrl, (send) => evaluate(send, `(() => { const a = document.activeElement; return { title: document.title, focusedEditable: !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') }; })()`));
        return Object.assign({ appId, supported: true }, info);
      } catch (e) { return { appId, supported: false, reason: String(e.message || e) }; }
    },
    insert(text) {
      return withPage(async (send) => {
        const f = await evaluate(send, FOCUS_JS);
        if (!f || !f.editable) throw new Error('no-text-field');
        await send('Input.insertText', { text });
        return { value: await evaluate(send, FOCUS_JS.replace('if (el) el.focus();', '')).then((v) => v && v.value) };
      });
    },
    deleteChars(count) {
      return withPage(async (send) => {
        const f = await evaluate(send, FOCUS_JS);
        if (!f || !f.editable) throw new Error('no-text-field');
        for (let i = 0; i < count; i++) await key(send, 'Backspace', 'Backspace', 8);
        return {};
      });
    },
    enter() {
      return withPage(async (send) => {
        await evaluate(send, FOCUS_JS);
        await key(send, 'Enter', 'Enter', 13);
        // Many TV apps listen for keypress/keyup rather than form submit; Input.dispatchKeyEvent
        // above covers keydown/keyup, a 'char' event covers keypress.
        await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', windowsVirtualKeyCode: 13 });
        return {};
      });
    },
  };
}

module.exports = { createInjector, targetFor };
