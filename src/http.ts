import { requestUrl } from 'obsidian';
import { StaleRevision, type ChangePage, type Commit, type Remote, type Revision } from './protocol';

export class HttpRemote implements Remote {
  constructor(private endpoint: string, private token: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('Use an HTTPS Worker URL without credentials, query, or fragment');
  }
  private async request(path: string, body?: unknown) {
    const result = await requestUrl({ url: this.endpoint.replace(/\/$/, '') + path,
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-Metronome-Protocol': '2' },
      body: body === undefined ? undefined : JSON.stringify(body), throw: false });
    if (result.status === 409) throw new StaleRevision('Remote changed; retry after pulling');
    if (result.status === 426) throw new Error('Update and reload Metronome on this device');
    if (result.status !== 200) throw new Error(`Sync service returned HTTP ${result.status}`);
    return result;
  }
  async changes(cursor: number): Promise<ChangePage> { return (await this.request(`/changes?cursor=${cursor}`)).json; }
  async read(r: Revision): Promise<string> { return (await this.request(`/content?revision=${r.revision}`)).text; }
  async commit(change: Commit): Promise<Revision> { return (await this.request('/commit', change)).json; }
  async history(path: string): Promise<Revision[]> {
    const rows = (await this.request('/history?path=' + encodeURIComponent(path))).json.revisions;
    if (!Array.isArray(rows)) throw new Error('Invalid revision history');
    return rows;
  }
  async eventsUrl(): Promise<string> {
    const ticket = (await this.request('/events-ticket', {})).json.ticket;
    if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) throw new Error('Invalid live-update ticket');
    const url = new URL(this.endpoint.replace(/\/$/, '') + '/events');
    url.protocol = 'wss:'; url.searchParams.set('ticket', ticket);
    return url.toString();
  }
}
