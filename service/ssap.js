'use strict';
// Client for the TV's own remote-control endpoint (SSAP over wss://<tv-ip>:3001), the same
// one LG's phone app uses. It connects through the TV's LAN address: on 127.0.0.1 the endpoint
// answers "invalid origin" unless the client claims a web origin. First connection shows an "allow this device" prompt on the TV;
// the client key it returns is stored and reused. Reconnects with backoff.
const fs = require('fs');
const { EventEmitter } = require('events');
const { WsClient } = require('./ws-client');

// Unsigned manifest on purpose: newer firmware rejects the signed one that open-source clients
// share ("blacklisted certificate") but still accepts an unsigned one after the user approves it.
// getForegroundAppInfo needs READ_RUNNING_APPS; READ_APP_STATUS alone answers 401.
const PERMISSIONS = ['READ_RUNNING_APPS', 'READ_APP_STATUS', 'READ_INSTALLED_APPS', 'WRITE_NOTIFICATION_TOAST', 'CONTROL_INPUT_TEXT'];

class Ssap extends EventEmitter {
  constructor(keyFile, hostFn) {
    super();
    this.keyFile = keyFile;
    this.hostFn = hostFn || (() => '127.0.0.1');
    this.ws = null;
    this.state = 'idle'; // idle | connecting | prompting | ready | error
    this.lastError = null;
    this.seq = 0;
    this.pending = new Map();
    this.subs = new Map();
    this.retry = 1000;
    this.stopped = false;
  }

  key() { try { return JSON.parse(fs.readFileSync(this.keyFile, 'utf8')).key || null; } catch (e) { return null; } }
  saveKey(k) { fs.writeFileSync(this.keyFile + '.tmp', JSON.stringify({ key: k }), { mode: 0o600 }); fs.renameSync(this.keyFile + '.tmp', this.keyFile); }
  setState(s, err) { this.state = s; if (err !== undefined) this.lastError = err; this.emit('state', s); }

  start() {
    if (this.ws || this.stopped) return;
    this.setState('connecting');
    const ws = new WsClient('wss://' + this.hostFn() + ':3001/', { rejectUnauthorized: false });
    this.ws = ws;
    ws.on('open', () => {
      const payload = { forcePairing: false, pairingType: 'PROMPT', manifest: { manifestVersion: 1, appVersion: '1.0', permissions: PERMISSIONS } };
      const k = this.key();
      if (k) payload['client-key'] = k;
      ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload }));
    });
    ws.on('message', (buf) => this.onMessage(buf));
    ws.on('error', (e) => { this.lastError = String(e.message || e); });
    ws.on('close', () => {
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new Error('disconnected'));
      this.pending.clear();
      if (this.stopped) return;
      this.setState('error');
      setTimeout(() => this.start(), this.retry);
      this.retry = Math.min(this.retry * 2, 30000);
    });
    ws.connect();
  }

  onMessage(buf) {
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
    if (m.id === 'register_0') {
      if (m.type === 'response' && m.payload && m.payload.pairingType === 'PROMPT') { this.setState('prompting'); return; }
      if (m.type === 'registered') {
        if (m.payload && m.payload['client-key'] && m.payload['client-key'] !== this.key()) this.saveKey(m.payload['client-key']);
        this.retry = 1000;
        this.setState('ready', null);
        for (const [id, s] of this.subs) this.ws.send(JSON.stringify({ type: 'subscribe', id, uri: s.uri, payload: s.payload || {} }));
        return;
      }
      if (m.type === 'error') { this.setState('error', m.error || 'pairing-rejected'); return; }
    }
    const sub = this.subs.get(m.id);
    if (sub) { if (m.payload) sub.cb(m.payload); return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.error || 'ssap-error'));
    else p.resolve(m.payload || {});
  }

  call(uri, payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.state !== 'ready') { reject(new Error('not-ready')); return; }
      const id = 'c' + (++this.seq);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, 8000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ type: 'request', id, uri, payload: payload || {} }));
    });
  }

  // Survives reconnects: re-sent every time the connection becomes ready.
  subscribe(id, uri, cb, payload) {
    this.subs.set(id, { uri, cb, payload });
    if (this.ws && this.state === 'ready') this.ws.send(JSON.stringify({ type: 'subscribe', id, uri, payload: payload || {} }));
  }
}

module.exports = { Ssap };
