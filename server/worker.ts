import { contentBytes, hashText, MAX_NOTE_BYTES, PAGE_SIZE, validPath, type Commit, type Revision } from '../src/protocol';

interface Env { VAULTS: DurableObjectNamespace; BLOBS: R2Bucket; SYNC_TOKEN: string; VAULT_ID: string }
type Row = { seq: number; path: string; hash: string };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const revision = (row: Row): Revision => ({ path: row.path, revision: row.seq, hash: row.hash, ...(row.hash === '' ? { deleted: true as const } : {}) });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.SYNC_TOKEN || env.SYNC_TOKEN.length < 32 || !/^[a-zA-Z0-9_-]{1,64}$/.test(env.VAULT_ID))
      return json({ error: 'Service not configured' }, 503);
    // Browser WebSockets cannot send our Authorization header. A one-use,
    // short-lived ticket is issued only by the authenticated endpoint below.
    if (new URL(request.url).pathname === '/events' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket')
      return env.VAULTS.get(env.VAULTS.idFromName(env.VAULT_ID)).fetch(request);
    // Compare fixed-length digests, never log credentials or note bodies.
    const supplied = await hashText(request.headers.get('Authorization') ?? '');
    const expected = await hashText(`Bearer ${env.SYNC_TOKEN}`);
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
    if (mismatch) return json({ error: 'Unauthorized' }, 401);
    if (request.headers.get('X-Metronome-Protocol') !== '2') return json({ error: 'Update and reload Metronome on this device' }, 426);
    const id = env.VAULTS.idFromName(env.VAULT_ID);
    return env.VAULTS.get(id).fetch(request);
  }
} satisfies ExportedHandler<Env>;

export class VaultCoordinator {
  private sql: SqlStorage;
  constructor(private ctx: DurableObjectState, private env: Env) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS revisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, hash TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS heads (
      path_key TEXT PRIMARY KEY, path TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec("INSERT OR IGNORE INTO metadata (key, value) VALUES ('identity', ?)", crypto.randomUUID());
    this.sql.exec('CREATE TABLE IF NOT EXISTS event_tickets (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/events-ticket') {
      const ticket = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      this.sql.exec('DELETE FROM event_tickets WHERE expires < ?', Date.now());
      this.sql.exec('INSERT INTO event_tickets (hash, expires) VALUES (?, ?)', await hashText(ticket), Date.now() + 60000);
      return json({ ticket });
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 400);
      const ticket = url.searchParams.get('ticket') ?? '';
      if (!/^[a-f0-9]{64}$/.test(ticket)) return json({ error: 'Invalid ticket' }, 401);
      const hash = await hashText(ticket);
      const valid = this.sql.exec<{ expires: number }>('SELECT expires FROM event_tickets WHERE hash = ?', hash).toArray()[0];
      if (!valid || valid.expires < Date.now()) return json({ error: 'Expired or consumed ticket' }, 401);
      if (this.ctx.getWebSockets().length >= 20) return json({ error: 'Too many live connections' }, 429);
      this.sql.exec('DELETE FROM event_tickets WHERE hash = ?', hash);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server!);
      const cursor = this.sql.exec<{ cursor: number }>('SELECT COALESCE(MAX(seq), 0) AS cursor FROM revisions').one().cursor;
      server!.send(this.event('ready', cursor));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === 'GET' && url.pathname === '/history') {
      const path = url.searchParams.get('path');
      if (!validPath(path)) return json({ error: 'Invalid path' }, 400);
      return json({ revisions: this.sql.exec<Row>('SELECT seq, path, hash FROM revisions WHERE path = ? ORDER BY seq DESC LIMIT 100', path).toArray().map(revision) });
    }
    if (request.method === 'GET' && url.pathname === '/changes') {
      const text = url.searchParams.get('cursor') ?? '0';
      const cursor = Number(text);
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(cursor)) return json({ error: 'Invalid cursor' }, 400);
      const rows = this.sql.exec<Row>('SELECT seq, path, hash FROM revisions WHERE seq > ? ORDER BY seq LIMIT ?', cursor, PAGE_SIZE + 1).toArray();
      const page = rows.slice(0, PAGE_SIZE);
      const identity = this.sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key = 'identity'").one().value;
      return json({ changes: page.map(revision), cursor: page.at(-1)?.seq ?? cursor, more: rows.length > PAGE_SIZE, identity });
    }
    if (request.method === 'GET' && url.pathname === '/content') {
      const seq = Number(url.searchParams.get('revision'));
      if (!Number.isSafeInteger(seq) || seq < 1) return json({ error: 'Invalid revision' }, 400);
      const row = this.sql.exec<Row>('SELECT seq, path, hash FROM revisions WHERE seq = ?', seq).toArray()[0];
      if (!row) return json({ error: 'Unknown revision' }, 404);
      if (row.hash === '') return json({ error: 'Deleted revision has no content' }, 410);
      const blob = await this.env.BLOBS.get(`${this.env.VAULT_ID}/${row.hash}`);
      if (!blob) return json({ error: 'Missing blob; revision retained' }, 503);
      return new Response(blob.body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (request.method === 'POST' && url.pathname === '/commit') return this.commit(request);
    return json({ error: 'Not found' }, 404);
  }

  private event(type: 'ready' | 'changed', cursor: number): string {
    const identity = this.sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key = 'identity'").one().value;
    return JSON.stringify({ type, cursor, identity });
  }
  private broadcast(cursor: number): void {
    const message = this.event('changed', cursor);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch { try { socket.close(1011, 'Reconnect'); } catch {} }
    }
  }
  webSocketMessage(socket: WebSocket): void { socket.close(1008, 'Notifications only'); }
  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    // Browsers may close without a status; reserved synthetic codes cannot be sent.
    socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
  }
  webSocketError(socket: WebSocket): void { try { socket.close(1011, 'Reconnect'); } catch {} }

  private head(path: string): Row | undefined {
    return this.sql.exec<Row>('SELECT seq, path, hash FROM heads WHERE path_key = ?', path.toLowerCase()).toArray()[0];
  }
  private source(path: string): Row | undefined {
    const head = this.head(path);
    return head?.path === path ? head : this.sql.exec<Row>('SELECT seq, path, hash FROM revisions WHERE path = ? ORDER BY seq DESC LIMIT 1', path).toArray()[0];
  }
  private acknowledge(current: Row, source?: Row): Response {
    return json({ ...revision(current), ...(source?.hash === '' ? { removed: revision(source) } : {}) });
  }

  private async commit(request: Request): Promise<Response> {
    // Bound the streamed request itself, rather than trusting Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'Missing body' }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_NOTE_BYTES * 6 + 2048) { await reader.cancel(); return json({ error: 'Request too large' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let change: Commit;
    try { change = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!change || !validPath(change.path) || !Number.isSafeInteger(change.base) || change.base < 0 || !(typeof change.content === 'string' || change.content === null))
      return json({ error: 'Invalid commit' }, 400);
    if (change.from && (!validPath(change.from.path) || change.from.path === change.path || !Number.isSafeInteger(change.from.base)
      || change.from.base < 1 || change.content === null)) return json({ error: 'Invalid rename' }, 400);
    if (change.content !== null) {
      try { if (contentBytes(change.path, change.content) > MAX_NOTE_BYTES) return json({ error: 'File too large' }, 413); }
      catch { return json({ error: 'Invalid attachment encoding' }, 400); }
    }
    const hash = change.content === null ? '' : await hashText(change.content);
    const current = this.head(change.path);
    const source = change.from && this.source(change.from.path);
    if (current && current.path !== change.path && current.hash !== '' && change.from?.path !== current.path) return json({ error: 'Windows case collision' }, 422);
    // Retrying an acknowledged or lost response is safe if the current bytes match.
    if (current?.path === change.path && current.hash === hash && (!change.from || source?.hash === '')) return this.acknowledge(current, source || undefined);
    if ((current?.seq ?? 0) !== change.base) return json({ error: 'Stale base' }, 409);
    if (change.from && (!source || source.seq !== change.from.base || source.hash === '')) return json({ error: 'Stale rename source' }, 409);

    // Upload immutable content before publishing metadata. An interrupted upload
    // can leave an unreferenced blob, but can never publish missing content.
    if (change.content !== null) await this.env.BLOBS.put(`${this.env.VAULT_ID}/${hash}`, change.content);
    // R2 awaits allow other requests to run. Recheck ancestry in the SQL transaction.
    let published = 0;
    const response = this.ctx.storage.transactionSync(() => {
      const latest = this.head(change.path);
      const latestSource = change.from && this.source(change.from.path);
      if (latest && latest.path !== change.path && latest.hash !== '' && change.from?.path !== latest.path) return json({ error: 'Windows case collision' }, 422);
      if (latest?.path === change.path && latest.hash === hash && (!change.from || latestSource?.hash === '')) return this.acknowledge(latest, latestSource || undefined);
      if ((latest?.seq ?? 0) !== change.base) return json({ error: 'Stale base' }, 409);
      if (change.from && (!latestSource || latestSource.seq !== change.from.base || latestSource.hash === '')) return json({ error: 'Stale rename source' }, 409);
      let removed: Row | undefined;
      if (change.from) {
        removed = this.sql.exec<Row>("INSERT INTO revisions (path, hash) VALUES (?, '') RETURNING seq, path, hash", change.from.path).one();
        this.sql.exec("UPDATE heads SET seq = ?, hash = '' WHERE path_key = ?", removed.seq, change.from.path.toLowerCase());
      }
      const inserted = this.sql.exec<Row>('INSERT INTO revisions (path, hash) VALUES (?, ?) RETURNING seq, path, hash', change.path, hash).one();
      this.sql.exec(`INSERT INTO heads (path_key, path, seq, hash) VALUES (?, ?, ?, ?)
        ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, seq = excluded.seq, hash = excluded.hash`,
      change.path.toLowerCase(), change.path, inserted.seq, hash);
      published = inserted.seq;
      return this.acknowledge(inserted, removed);
    });
    if (published) this.broadcast(published);
    return response;
  }
}
