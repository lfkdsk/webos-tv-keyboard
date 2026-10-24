import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createServer } = require('../service/server.js');

class FakeSsap extends EventEmitter {
  constructor() { super(); this.state = 'ready'; this.lastError = null; this.calls = []; this.subs = {}; }
  subscribe(id, uri, cb) { this.subs[uri] = cb; }
  call(uri, payload) { this.calls.push([uri.split('/').pop(), payload]); return Promise.resolve({ returnValue: true }); }
}

test('token gate, typing endpoints and keyboard events', async () => {
  const ssap = new FakeSsap();
  const { server } = createServer({ token: 'tok', ssap });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/')).status, 403, 'no token');
  assert.equal((await fetch(base + '/?t=bad')).status, 403, 'wrong token');
  const page = await fetch(base + '/?t=tok');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /电视键盘/);
  const post = (p, b) => fetch(base + p + '?t=tok', { method: 'POST', body: JSON.stringify(b) }).then((r) => r.json());
  assert.equal((await post('/api/insert', { text: '蝴蝶君' })).ok, true);
  await post('/api/delete', { count: 2 });
  await post('/api/enter', {});
  assert.deepEqual(ssap.calls, [['insertText', { text: '蝴蝶君', replace: 0 }], ['deleteCharacters', { count: 2 }], ['sendEnterKey', {}]]);
  // SSE carries keyboard focus changes pushed by the TV.
  const ac = new AbortController();
  const es = await fetch(base + '/events?t=tok', { signal: ac.signal });
  const reader = es.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"focus":false/);
  ssap.subs['ssap://com.webos.service.ime/registerRemoteKeyboard']({ currentWidget: { focus: true, contentType: 'text' } });
  const second = new TextDecoder().decode((await reader.read()).value);
  assert.match(second, /"focus":true/);
  ac.abort();
  server.close();
});
