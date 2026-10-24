'use strict';
// LAN web server: serves the typing page to a phone or computer and forwards what is typed
// to the text field of the TV's foreground app (see inject.js). Every request needs the token
// from the QR code, so other devices on the network cannot type into the TV.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const MESSAGES = {
  'app-not-supported': '当前 App 不支持远程输入（只支持开发者模式侧载的应用）',
  'no-text-field': '当前页面没有输入框，请先在电视上选中搜索框',
  'devtools-unavailable': '电视的调试入口不可用（开发者模式是否已开启？）',
  'no-foreground-app': '没有获取到电视当前的应用',
  'not-ready': '正在连接电视，请稍候',
  'clear-failed': '没能清空电视上的输入框',
};

function createServer(opts) {
  const { token, injector, ssap } = opts;
  const clients = new Set();
  let state = { appId: null, supported: false };
  let polling = null;

  function snapshot() {
    return Object.assign({ pairing: ssap ? ssap.state : 'ready' }, state);
  }
  function broadcast() {
    const line = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
    for (const res of clients) res.write(line);
  }
  // Only poll the TV while someone has the page open.
  async function poll() {
    try { state = await injector.status(); } catch (e) { state = { appId: null, supported: false, reason: String(e.message || e) }; }
    broadcast();
  }
  function startPolling() { if (!polling) { poll(); polling = setInterval(poll, 2000); } }
  function stopPolling() { if (polling && clients.size === 0) { clearInterval(polling); polling = null; } }
  if (ssap) ssap.on('state', broadcast);

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
  async function run(res, fn) {
    try {
      send(res, 200, Object.assign({ ok: true }, await fn()));
    } catch (e) {
      const code = String(e.message || e);
      send(res, 409, { ok: false, error: code, message: MESSAGES[code] || code, appId: e.appId || null });
    }
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
      startPolling();
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); stopPolling(); });
      return;
    }
    if (req.method !== 'POST') { send(res, 404, { ok: false }); return; }
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : '';
    if (url.pathname === '/api/insert') return run(res, () => injector.insert(text));
    if (url.pathname === '/api/delete') return run(res, () => injector.deleteChars(Math.max(0, Math.min(2000, body.count | 0))));
    if (url.pathname === '/api/enter') return run(res, () => injector.enter());
    if (url.pathname === '/api/clear') return run(res, () => injector.clearField());
    send(res, 404, { ok: false });
  });
  return { server, snapshot };
}

module.exports = { createServer, MESSAGES };
