import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createServer } = require('../service/server.js');
const { targetFor } = require('../service/inject.js');

test('token gate, typing endpoints, errors and status events', async () => {
  const calls = [];
  let supported = true;
  const injector = {
    status: async () => ({ appId: 'org.moonfin.webos', supported, focusedEditable: true }),
    insert: async (t) => { calls.push(['insert', t]); if (!supported) { const e = new Error('app-not-supported'); e.appId = 'netflix'; throw e; } return { value: t }; },
    deleteChars: async (n) => { calls.push(['delete', n]); return {}; },
    enter: async () => { calls.push(['enter']); return {}; },
  };
  const ssap = Object.assign(new EventEmitter(), { state: 'ready' });
  const { server } = createServer({ token: 'tok', injector, ssap });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/')).status, 403, 'no token');
  assert.equal((await fetch(base + '/?t=bad')).status, 403, 'wrong token');
  assert.match(await (await fetch(base + '/?t=tok')).text(), /电视键盘/);
  const post = (p, b) => fetch(base + p + '?t=tok', { method: 'POST', body: JSON.stringify(b) }).then((r) => r.json());
  assert.equal((await post('/api/insert', { text: '蝴蝶君' })).value, '蝴蝶君');
  await post('/api/delete', { count: 2 });
  await post('/api/enter', {});
  assert.deepEqual(calls, [['insert', '蝴蝶君'], ['delete', 2], ['enter']]);
  supported = false;
  const err = await post('/api/insert', { text: 'x' });
  assert.equal(err.ok, false);
  assert.match(err.message, /不支持/);
  const ac = new AbortController();
  const es = await fetch(base + '/events?t=tok', { signal: ac.signal });
  const reader = es.body.getReader();
  let text = '';
  while (!/org\.moonfin\.webos/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /"supported":false/);
  ac.abort();
  server.close();
});

test('maps the foreground app to its DevTools page', () => {
  const targets = [
    { type: 'page', url: 'file:///media/developer/apps/usr/palm/applications/com.gathin.tvhome/index.html', webSocketDebuggerUrl: 'ws://a' },
    { type: 'page', url: 'file:///media/developer/apps/usr/palm/applications/org.moonfin.webos/index.html', webSocketDebuggerUrl: 'ws://b' },
  ];
  assert.equal(targetFor(targets, 'org.moonfin.webos').webSocketDebuggerUrl, 'ws://b');
  assert.equal(targetFor(targets, 'netflix'), undefined);
});
