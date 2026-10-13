import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('authenticated one-use live channel announces committed changes and reconnect cursor', async () => {
  const bundle = await build({ entryPoints: ['server/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const token = 'test-token-with-at-least-32-characters';
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: '2025-09-01', bindings: { SYNC_TOKEN: token, VAULT_ID: 'events' },
    durableObjects: { VAULTS: { className: 'VaultCoordinator', useSQLite: true } }, r2Buckets: ['BLOBS'] }));
  const request = (path: string, body: unknown) => mf.dispatchFetch(`https://example.test${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Metronome-Protocol': '2' }, body: JSON.stringify(body) });
  const upgrade = (ticket: string) => mf.dispatchFetch(`https://example.test/events?ticket=${ticket}`, { headers: { Upgrade: 'websocket' } });
  const sockets: Array<{ close(): void }> = [];
  try {
    assert.equal((await mf.dispatchFetch('https://example.test/events-ticket', { method: 'POST' })).status, 401);
    assert.equal((await upgrade('0'.repeat(64))).status, 401);
    const ticket = (await (await request('/events-ticket', {})).json() as { ticket: string }).ticket;
    const response = await upgrade(ticket); assert.equal(response.status, 101);
    const socket = response.webSocket!; sockets.push(socket);
    const messages: any[] = [];
    socket.addEventListener('message', event => { messages.push(event.data === 'pong' ? 'pong' : JSON.parse(String(event.data))); });
    socket.accept();
    const waitFor = async (count: number) => {
      for (let i = 0; i < 100 && messages.length < count; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(messages.length, count);
    };
    await waitFor(1); assert.equal(messages[0].type, 'ready'); assert.equal(messages[0].cursor, 0);
    assert.equal((await upgrade(ticket)).status, 401, 'ticket can only be consumed once');
    const first = await request('/commit', { path: 'Private note.md', base: 0, content: 'private content' });
    const head = await first.json() as { revision: number };
    await waitFor(2); assert.equal(messages[1].cursor, head.revision);
    assert.deepEqual(Object.keys(messages[1]).sort(), ['cursor', 'identity', 'type']);
    assert.equal((await request('/commit', { path: 'Private note.md', base: 0, content: 'stale' })).status, 409);
    await request('/commit', { path: 'Private note.md', base: 0, content: 'private content' });
    assert.equal(messages.length, 2, 'failed CAS and retry produce no announcement');
    await request('/commit', { path: 'Renamed.md', base: 0, content: 'private content', from: { path: 'Private note.md', base: head.revision } });
    await waitFor(3);
    const renamed = await mf.dispatchFetch('https://example.test/changes', { headers: { Authorization: `Bearer ${token}`, 'X-Metronome-Protocol': '2' } });
    const feed = await renamed.json() as { cursor: number; changes: Array<{ path: string; revision: number }> };
    const next = feed.changes.find(r => r.path === 'Renamed.md')!;
    await request('/commit', { path: 'Renamed.md', base: next.revision, content: null });
    await waitFor(4); assert.ok(messages[3].cursor > feed.cursor);
    socket.send('ping'); await waitFor(5); assert.equal(messages[4], 'pong');
    const fresh = (await (await request('/events-ticket', {})).json() as { ticket: string }).ticket;
    const reconnect = (await upgrade(fresh)).webSocket!; sockets.push(reconnect);
    const ready = new Promise<any>(resolve => reconnect.addEventListener('message', event => resolve(JSON.parse(String(event.data)))));
    reconnect.accept(); assert.equal((await ready).cursor, messages[3].cursor);
  } finally { for (const socket of sockets) socket.close(); await mf.dispose(); }
});
