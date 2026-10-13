// Notifications carry only a cursor. The normal authenticated change feed remains
// authoritative, including after a dropped connection or mobile suspension.
export class LiveUpdates {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = true;
  private epoch = 0;
  private attempts = 0;
  private pongAt = 0;
  constructor(private url: () => Promise<string>, private changed: (cursor: number, identity: string) => void,
    private create: (url: string) => WebSocket = url => new WebSocket(url)) {}
  get connected(): boolean { return this.socket?.readyState === 1; }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false; void this.connect();
  }
  stop(): void {
    this.stopped = true; this.epoch++;
    if (this.retry !== undefined) clearTimeout(this.retry);
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.retry = undefined; this.heartbeat = undefined;
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
      this.socket.close(); this.socket = undefined;
    }
  }
  private async connect(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const url = await this.url();
      if (this.stopped || epoch !== this.epoch) return;
      const socket = this.socket = this.create(url);
      const disconnected = () => {
        if (this.stopped || epoch !== this.epoch) return;
        this.epoch++;
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close(); this.socket = undefined;
        if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
        this.heartbeat = undefined; this.reconnect();
      };
      socket.onopen = () => {
        if (this.stopped || epoch !== this.epoch) return;
        this.attempts = 0; this.pongAt = Date.now();
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.pongAt > 60000) { disconnected(); return; }
          try { socket.send('ping'); } catch { disconnected(); }
        }, 25000);
      };
      socket.onmessage = event => {
        if (this.stopped || epoch !== this.epoch) return;
        if (event.data === 'pong') { this.pongAt = Date.now(); return; }
        try {
          const message = JSON.parse(event.data);
          if ((message.type === 'ready' || message.type === 'changed') && Number.isSafeInteger(message.cursor)
            && message.cursor >= 0 && typeof message.identity === 'string' && message.identity)
            this.changed(message.cursor, message.identity);
        } catch { /* Ignore malformed notifications; the change feed validates data. */ }
      };
      socket.onclose = socket.onerror = disconnected;
      // A network that silently drops the upgrade must not leave us connecting forever.
      this.retry = setTimeout(() => { if (!this.connected) disconnected(); }, 15000);
    } catch {
      if (!this.stopped && epoch === this.epoch) this.reconnect();
    }
  }
  private reconnect(): void {
    if (this.stopped) return;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = setTimeout(() => { void this.connect(); }, Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)));
  }
}
