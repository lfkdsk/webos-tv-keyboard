'use strict';
// LAN web server: serves the typing page to a phone or computer and forwards what is typed
// to the TV's focused text field through SSAP. Every request needs the token from the QR
// code, so other devices on the network cannot type into the TV.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const IME = 'ssap://com.webos.service.ime/';

function createServer(opts) {
  const { token, ssap } = opts;
  const clients = new Set();
  let keyboard = { focus: false };

  function snapshot() {
    return { keyboard, pairing: ssap.state, error: ssap.lastError || null };
  }
  function broadcast() {
    const line = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
    for (const res of clients) res.write(line);
  }
  ssap.on('state', broadcast);
  // currentWidget.focus is true while a text field on the TV has the system keyboard up.
  ssap.subscribe('kb', IME + 'registerRemoteKeyboard', (p) => {
    const w = p.currentWidget || {};
    keyboard = { focus: !!w.focus, contentType: w.contentType || null, hiddenText: !!w.hiddenText };
    broadcast();
    if (opts.onKeyboard) opts.onKeyboard(keyboard);
  });

  function send(res, code, body, type) {
    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }
  function readJson(req) {
    return new Promise((resolve) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 16384) req.destroy(); else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve({}); } });
    });
  }
  async function forward(res, uri, payload) {
    try { send(res, 200, Object.assign({ ok: true }, await ssap.call(uri, payload))); } catch (e) { send(res, 503, { ok: false, error: String(e.message || e) }); }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('t') !== token) {
      send(res, 403, '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p style="font:18px system-ui;padding:24px">链接已失效。请在电视上打开「电视键盘」，重新扫码。</p>', 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') { send(res, 200, PAGE, 'text/html; charset=utf-8'); return; }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method !== 'POST') { send(res, 404, { ok: false }); return; }
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : '';
    if (url.pathname === '/api/insert') return forward(res, IME + 'insertText', { text, replace: body.replace ? 1 : 0 });
    if (url.pathname === '/api/delete') return forward(res, IME + 'deleteCharacters', { count: Math.max(0, Math.min(2000, body.count | 0)) });
    if (url.pathname === '/api/enter') return forward(res, IME + 'sendEnterKey', {});
    send(res, 404, { ok: false });
  });
  return { server, snapshot };
}

module.exports = { createServer };
