'use strict';
// Minimal WebSocket client (RFC 6455: text/binary frames, ping/pong, close), no dependencies.
// The TV's Node 20 has no WebSocket client; the SSAP endpoint on the TV is wss with LG's own
// certificate, so the caller passes TLS options (rejectUnauthorized) through.
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class WsClient extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = new URL(url);
    this.options = options || {};
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
  }

  connect(timeoutMs = 10000) {
    const key = crypto.randomBytes(16).toString('base64');
    const req = https.request(Object.assign({
      hostname: this.url.hostname,
      port: this.url.port || 443,
      path: this.url.pathname + this.url.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    }, this.options));
    const timer = setTimeout(() => req.destroy(new Error('connect-timeout')), timeoutMs);
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        this.emit('error', new Error('handshake-mismatch'));
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on('data', (d) => this.onData(d));
      socket.on('close', () => this.finish());
      socket.on('error', (e) => this.emit('error', e));
      if (head && head.length) this.onData(head);
      this.emit('open');
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      this.emit('error', new Error('handshake-http-' + res.statusCode));
      this.finish();
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      this.emit('error', e);
      this.finish();
    });
    req.end();
  }

  send(data, opcode = 0x1) {
    if (!this.socket || this.closed) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      const maskKey = masked ? b.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this.buffer = b.subarray(off + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.send(payload, 0xa); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        this.fragments.push(payload);
      } else {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
      }
      if (fin) {
        const msg = Buffer.concat(this.fragments);
        this.fragments = [];
        this.emit('message', msg, this.fragmentOpcode === 0x1);
      }
    }
  }

  close() {
    if (this.closed) return;
    try { this.send(Buffer.alloc(0), 0x8); } catch (e) { /* ignore */ }
    if (this.socket) this.socket.end();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    if (this.socket) this.socket.destroy();
    this.emit('close');
  }
}

module.exports = { WsClient };
