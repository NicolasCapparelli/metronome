import { contentBytes, hashText, MAX_NOTE_BYTES, StaleRevision, validPath, validateRevision, type Remote, type Revision } from './protocol';

export interface Local {
  read(path: string): Promise<string | null>;
  // Adopt the cloud spelling without changing bytes. Return the former spelling.
  alignCase?(path: string): Promise<string | null>;
  cleanup?(): Promise<void>;
  // Must compare inside the same atomic operation that writes the file.
  replace(path: string, expected: string | null, content: string): Promise<boolean>;
  preserve(path: string, content: string): Promise<string>;
  remove(path: string, expected: string): Promise<boolean>;
}
export interface SyncState {
  identity?: string;
  cursor: number;
  remote: Record<string, Revision>;
  bases: Record<string, { revision: number; hash: string }>;
  pending: Record<string, number>;
  generation: number;
  moves?: Record<string, string>;
}
export function emptyState(): SyncState {
  return { cursor: 0, remote: Object.create(null), bases: Object.create(null),
    pending: Object.create(null), generation: 0 };
}

export class SyncEngine {
  private running = false;
  allowBulkDeletion = false;
  stats = { networkMs: 0, saveMs: 0, stateWrites: 0, downloads: 0, uploads: 0 };
  constructor(readonly state: SyncState, private local: Local, private remote: Remote,
    private save: () => Promise<void>, private permitted: (path: string) => boolean = validPath) {
    // JSON reloads lose null prototypes. Arbitrary filenames must never resolve
    // inherited dictionary properties such as constructor or __proto__.
    for (const key of ['remote', 'bases', 'pending'] as const) state[key] = Object.assign(Object.create(null), state[key]);
    if (state.moves) state.moves = Object.assign(Object.create(null), state.moves);
  }

  mark(path: string): void {
    if (validPath(path) && this.permitted(path)) this.state.pending[path] = ++this.state.generation;
  }

  rename(old: string, next: string): void {
    if (!validPath(old) || !validPath(next)) return;
    (this.state.moves ??= Object.create(null))[old] = next;
    this.mark(old); this.mark(next);
  }

  async sync(onActivity: () => void = () => {}): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    this.stats = { networkMs: 0, saveMs: 0, stateWrites: 0, downloads: 0, uploads: 0 };
    const errors: string[] = [];
    const generationAtStart = this.state.generation;
    const hadPending = Object.keys(this.state.pending).length > 0;
    try {
      let more: boolean;
      do {
        const oldIdentity = this.state.identity;
        const oldCursor = this.state.cursor;
        const page = await this.network(() => this.remote.changes(this.state.cursor));
        if (typeof page.identity !== 'string' || !page.identity) throw new Error('Missing vault identity');
        if (this.state.identity && this.state.identity !== page.identity)
          throw new Error('Cloud vault was replaced. Sync stopped; reconnect using a fresh test vault.');
        this.state.identity = page.identity;
        if (!Number.isSafeInteger(page.cursor) || page.cursor < this.state.cursor
          || !Array.isArray(page.changes) || typeof page.more !== 'boolean'
          || (page.more && page.cursor === this.state.cursor)) throw new Error('Invalid change cursor');
        let last = this.state.cursor;
        if (page.changes.length || Object.keys(this.state.pending).length) onActivity();
        for (const r of page.changes) {
          validateRevision(r);
          if (r.revision <= last || r.revision > page.cursor) throw new Error('Unordered change feed');
          last = r.revision;
          if (!this.state.remote[r.path] || this.state.remote[r.path]!.revision < r.revision)
            this.state.remote[r.path] = r;
          this.mark(r.path);
        }
        this.state.cursor = page.cursor;
        // Persist the work queue with the cursor before touching local files.
        if (page.cursor !== oldCursor || this.state.identity !== oldIdentity) await this.checkpoint();
        more = page.more;
      } while (more);

      // Different devices may initially index the same file with different casing.
      // The newest cloud revision owns the spelling unless a local rename is queued.
      const canonical = new Map<string, Revision>();
      for (const head of Object.values(this.state.remote)) {
        const key = head.path.toLowerCase();
        if (!canonical.has(key) || canonical.get(key)!.revision < head.revision) canonical.set(key, head);
      }
      for (const head of canonical.values()) {
        if (!this.permitted(head.path)
          || Object.values(this.state.moves ?? {}).some(path => path.toLowerCase() === head.path.toLowerCase())) continue;
        try {
          const old = await this.local.alignCase?.(head.path);
          if (old) {
            onActivity();
            if (this.state.bases[old]?.hash) this.state.bases[head.path] = this.state.bases[old]!;
            delete this.state.bases[old]; delete this.state.pending[old];
            this.mark(head.path);
            await this.checkpoint();
          }
        } catch (error) { errors.push(`${head.path}: ${error instanceof Error ? error.message : String(error)}`); }
      }

      // Drain work generated by our own file events and conflict copies in this
      // cycle instead of waiting for the next five-second poll. Bound racing edits.
      const attempted = new Set<string>();
      for (let pass = 0; pass < 3; pass++) {
        const deletions: string[] = [];
        const paths = Object.keys(this.state.pending).sort((a, b) =>
          Number(!!this.state.remote[b] && this.state.remote[b]!.revision !== this.state.bases[b]?.revision)
          - Number(!!this.state.remote[a] && this.state.remote[a]!.revision !== this.state.bases[a]?.revision));
        for (const path of paths) {
          if (attempted.has(path)) continue;
          try {
            if (!this.permitted(path)) { delete this.state.pending[path]; continue; }
            const generation = this.state.pending[path];
            const content = await this.local.read(path);
            if (content === null && this.state.bases[path] && !this.state.remote[path]?.deleted) { deletions.push(path); continue; }
            attempted.add(path);
            await this.reconcile(path, { content, generation });
          }
          catch (error) {
            if (!(error instanceof StaleRevision)) errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        // Publish move targets first. reconcile keeps a failed move's source
        // pending, while unrelated file issues never block ordinary deletions.
        const outstanding = deletions.filter(path => !this.state.remote[path]?.deleted);
        const liveCount = Object.values(this.state.bases).filter(base => base.hash !== '').length;
        if (!this.allowBulkDeletion && outstanding.length > 20 && outstanding.length > liveCount / 5)
          errors.push('Bulk deletion paused: more than 20 files and 20% of the vault are missing. Restore the files or use the bulk-deletion command.');
        else for (const path of deletions) {
          try { attempted.add(path); await this.reconcile(path); }
          catch (error) { if (!(error instanceof StaleRevision)) errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (!Object.keys(this.state.pending).some(path => !attempted.has(path)) || errors.length) break;
      }
      // Cloud writes emit ordinary Obsidian file events too. Clear only echoes
      // whose current bytes still match the acknowledged head; retain real edits.
      for (const path of Object.keys(this.state.pending)) {
        const base = this.state.bases[path]; const head = this.state.remote[path];
        if (!attempted.has(path) || !base || !head || base.revision !== head.revision) continue;
        const generation = this.state.pending[path];
        try {
          const current = await this.local.read(path);
          const hash = current === null ? '' : await hashText(current);
          if (hash === base.hash && this.state.pending[path] === generation) {
            delete this.state.pending[path];
            if (this.state.moves) delete this.state.moves[path];
          }
        } catch { /* Leave failed reads queued for the next explicit retry. */ }
      }
      await this.local.cleanup?.();
      if (hadPending || this.state.generation !== generationAtStart) await this.checkpoint();
      return [...new Set(errors)];
    } finally { this.running = false; this.allowBulkDeletion = false; }
  }

  private async reconcile(path: string, snapshot?: { content: string | null; generation: number | undefined }): Promise<void> {
    const generation = snapshot ? snapshot.generation : this.state.pending[path];
    const content = snapshot ? snapshot.content : await this.local.read(path);
    const base = this.state.bases[path];
    const movingFrom = Object.keys(this.state.moves ?? {}).find(old => this.state.moves![old] === path);
    const movingHead = movingFrom && this.state.remote[movingFrom];
    const caseMove = !!movingFrom && movingFrom.toLowerCase() === path.toLowerCase() && !!movingHead && !movingHead.deleted;
    const head = caseMove ? undefined : this.state.remote[path];
    if (content === null) {
      if (head?.deleted) {
        this.state.bases[path] = { revision: head.revision, hash: '' };
      } else if (base && base.hash !== '') {
        const target = this.state.moves?.[path];
        if (target && this.state.pending[target] !== undefined) return;
        if (head && head.hash !== base.hash) {
          const copy = await this.local.preserve(path, await this.verifiedRead(head));
          this.mark(copy); await this.checkpoint();
        }
        this.stats.uploads++;
        const next = await this.network(() => this.remote.commit({ path, base: head?.revision ?? base.revision, content: null }));
        validateRevision(next);
        if (next.path !== path || !next.deleted) throw new Error('Server did not acknowledge deletion');
        this.state.remote[path] = next;
        this.state.bases[path] = { revision: next.revision, hash: '' };
      } else if (head) {
        const incoming = await this.verifiedRead(head);
        if (!await this.local.replace(path, null, incoming)) return;
        this.state.bases[path] = { revision: head.revision, hash: head.hash };
      }
    } else {
      if (contentBytes(path, content) > MAX_NOTE_BYTES) throw new Error('File exceeds 10 MiB limit');
      const hash = await hashText(content);
      if (head?.deleted && base?.hash !== '' && !movingFrom) {
        if (!base || hash !== base.hash) {
          const copy = await this.local.preserve(path, content);
          this.mark(copy); await this.checkpoint();
        }
        if (!await this.local.remove(path, content)) return;
        this.state.bases[path] = { revision: head.revision, hash: '' };
      } else if (head?.hash === hash) {
        this.state.bases[path] = { revision: head.revision, hash };
      } else if (head && !head.deleted && (!base || head.hash !== base.hash)) {
        const incoming = await this.verifiedRead(head);
        if (!base || hash !== base.hash) {
          // The copy must exist before the original changes; deterministic names survive retries.
          const copyPath = await this.local.preserve(path, content);
          this.mark(copyPath);
          await this.checkpoint();
        }
        if (!await this.local.replace(path, content, incoming)) return;
        this.state.bases[path] = { revision: head.revision, hash: head.hash };
      } else if (!base || hash !== base.hash) {
        const old = movingFrom;
        const oldHead = old && this.state.remote[old];
        const from = old && oldHead && !oldHead.deleted ? { path: old, base: oldHead.revision } : undefined;
        if (old && oldHead && !oldHead.deleted && oldHead.hash !== this.state.bases[old]?.hash) {
          const copy = await this.local.preserve(old, await this.verifiedRead(oldHead));
          this.mark(copy); await this.checkpoint();
        }
        this.stats.uploads++;
        const next = await this.network(() => this.remote.commit({ path, base: caseMove && from ? from.base : head?.revision ?? 0, content, ...(from ? { from } : {}) }));
        validateRevision(next);
        if (next.path !== path || next.hash !== hash) throw new Error('Server acknowledged different content');
        this.state.remote[path] = next;
        this.state.bases[path] = { revision: next.revision, hash };
        if (next.removed) {
          validateRevision(next.removed);
          if (next.removed.path !== from?.path || !next.removed.deleted) throw new Error('Invalid rename acknowledgement');
          this.state.remote[next.removed.path] = next.removed;
          this.mark(next.removed.path);
        }
      }
    }
    // Event generations prevent an edit made during a transfer from being dropped.
    if (this.state.pending[path] === generation) delete this.state.pending[path];
    if (this.state.pending[path] === undefined && this.state.moves) delete this.state.moves[path];
    // The cursor/work queue was checkpointed before applying changes. A crash
    // replays them safely from current bytes and immutable cloud revisions.
    // Batch ordinary acknowledgements; preserve-before-overwrite checkpoints stay immediate.
  }

  private async verifiedRead(head: Revision): Promise<string> {
    if (head.deleted) throw new Error('Deleted revision has no content');
    this.stats.downloads++;
    const content = await this.network(() => this.remote.read(head));
    if (await hashText(content) !== head.hash) throw new Error('Downloaded note failed integrity check');
    if (contentBytes(head.path, content) > MAX_NOTE_BYTES) throw new Error('Downloaded file exceeds 10 MiB limit');
    return content;
  }
  private async network<T>(action: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try { return await action(); }
    finally { this.stats.networkMs += Date.now() - start; }
  }
  private async checkpoint(): Promise<void> {
    const start = Date.now(); this.stats.stateWrites++;
    try { await this.save(); }
    finally { this.stats.saveMs += Date.now() - start; }
  }
}
