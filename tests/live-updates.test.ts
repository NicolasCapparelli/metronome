import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveUpdates } from '../src/live-updates';

class Socket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() { this.readyState = 3; }
  send() {}
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('live notifications validate cursors, ignore malformed messages, and stop cleanly', async () => {
  const socket = new Socket(); const received: number[] = [];
  const live = new LiveUpdates(async () => 'wss://example.test', cursor => received.push(cursor), () => socket as unknown as WebSocket);
  try {
    live.start(); await settle(); socket.open(); assert.equal(live.connected, true);
    socket.message({ type: 'ready', cursor: 4, identity: 'vault' });
    socket.message({ type: 'changed', cursor: 5, identity: 'vault' });
    socket.message({ type: 'changed', cursor: -1, identity: 'vault' });
    socket.message({ type: 'changed', cursor: 6 });
    socket.onmessage?.({ data: 'bad JSON' });
    assert.deepEqual(received, [4, 5]);
    live.stop(); assert.equal(live.connected, false); assert.equal(socket.onmessage, null);
  } finally { live.stop(); }
});

test('stopping while a ticket request is pending never opens a connection', async () => {
  let finish!: (url: string) => void; let created = 0;
  const live = new LiveUpdates(() => new Promise(resolve => { finish = resolve; }), () => {}, () => { created++; return new Socket() as unknown as WebSocket; });
  live.start(); live.stop(); finish('wss://example.test'); await settle(); assert.equal(created, 0);
});

test('dropped connection obtains a fresh ticket and reconnects', async () => {
  const sockets: Socket[] = []; let tickets = 0;
  const live = new LiveUpdates(async () => `wss://example.test/${++tickets}`, () => {}, () => {
    const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;
  });
  try {
    live.start(); await settle(); sockets[0]!.open(); sockets[0]!.onclose?.();
    assert.equal(live.connected, false);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(tickets, 2); assert.equal(sockets.length, 2);
    sockets[1]!.open(); assert.equal(live.connected, true);
  } finally { live.stop(); }
});
