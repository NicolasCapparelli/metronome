import { connection, vaultTarget } from './vault.mjs';

// Read credentials locally; never print credentials or the short-lived ticket.
const { endpoint, token } = await connection(await vaultTarget());
const headers = { Authorization: `Bearer ${token}`, 'X-Metronome-Protocol': '2', 'Content-Type': 'application/json' };
const response = await fetch(`${endpoint}/events-ticket`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`Live ticket request failed: HTTP ${response.status}`);
const { ticket } = await response.json();
if (!/^[a-f0-9]{64}$/.test(ticket)) throw new Error('Invalid live ticket');
const url = new URL(`${endpoint}/events`); url.protocol = 'wss:'; url.searchParams.set('ticket', ticket);
const socket = new WebSocket(url);
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Live channel timed out')), 15000);
    const finish = error => { clearTimeout(timeout); error ? reject(error) : resolve(); };
    let ready = false;
    socket.addEventListener('message', event => {
      if (event.data === 'pong' && ready) { finish(); return; }
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'ready' && Number.isSafeInteger(message.cursor) && message.identity) {
          ready = true; socket.send('ping');
        }
      } catch { /* Await a valid notification. */ }
    });
    socket.addEventListener('error', () => finish(new Error('Live channel connection failed')));
    socket.addEventListener('close', () => { if (!ready) finish(new Error('Live channel closed before ready')); });
  });
  console.log('Live channel verified: authenticated connection, current cursor, and heartbeat.');
} finally { socket.close(1000); }
