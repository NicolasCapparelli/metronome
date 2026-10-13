import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, SyncEngine, type Local } from '../src/engine';
import { hashText, StaleRevision, validPath, type Commit, type Remote, type Revision } from '../src/protocol';

class MemoryLocal implements Local {
  files = new Map<string, string>();
  beforeReplace?: () => void;
  failReplace = false;
  async read(path: string) { return this.files.get(path) ?? null; }
  async alignCase(path: string) {
    if (this.files.has(path)) return null;
    const old = [...this.files.keys()].find(p => p !== path && p.toLowerCase() === path.toLowerCase());
    if (!old) return null;
    this.files.set(path, this.files.get(old)!); this.files.delete(old); return old;
  }
  async replace(path: string, expected: string | null, content: string) {
    this.beforeReplace?.();
    if (this.failReplace) throw new Error('Disk full');
    if (await this.read(path) !== expected) return false;
    this.files.set(path, content);
    return true;
  }
  async preserve(path: string, content: string) {
    const copy = `_metronome-conflicts/${await hashText(path + '\0' + content)}${path.match(/\.[^/.]+$/)?.[0] ?? '.bin'}`;
    this.files.set(copy, content);
    return copy;
  }
  async remove(path: string, expected: string) {
    this.beforeReplace?.();
    if (await this.read(path) !== expected) return false;
    this.files.delete(path); return true;
  }
}
class MemoryRemote implements Remote {
  heads = new Map<string, Revision>();
  revisions: Revision[] = [];
  contents = new Map<number, string>();
  offline = false;
  loseResponse = false;
  afterCommit?: () => void;
  beforeCommit?: () => Promise<void>;
  identity = 'test-vault';
  reads = 0;
  async changes(cursor: number) {
    if (this.offline) throw new Error('Offline');
    const changes = this.revisions.filter(r => r.revision > cursor);
    return { changes, cursor: changes.at(-1)?.revision ?? cursor, more: false, identity: this.identity };
  }
  async read(r: Revision) { this.reads++; return this.contents.get(r.revision)!; }
  async commit(change: Commit) {
    if (this.offline) throw new Error('Offline');
    const hook = this.beforeCommit;
    this.beforeCommit = undefined;
    await hook?.();
    const hash = change.content === null ? '' : await hashText(change.content);
    const head = this.heads.get(change.path);
    if (head?.hash === hash) return head;
    if ((head?.revision ?? 0) !== change.base) throw new StaleRevision();
    const next: Revision = { path: change.path, revision: this.revisions.length + 1, hash, ...(change.content === null ? { deleted: true as const } : {}) };
    this.heads.set(change.path, next);
    this.revisions.push(next);
    if (change.content !== null) this.contents.set(next.revision, change.content);
    this.afterCommit?.();
    if (this.loseResponse) { this.loseResponse = false; throw new Error('Response lost'); }
    return next;
  }
}
function device(remote: Remote, local = new MemoryLocal()) {
  const state = emptyState();
  let saved = structuredClone(state);
  const engine = new SyncEngine(state, local, remote, async () => { saved = structuredClone(state); });
  return { state, local, engine, saved: () => saved };
}
async function seed(remote: MemoryRemote) {
  await remote.commit({ path: 'Note.md', base: 0, content: 'original' });
}

test('incoming write and deletion events are drained without another sync', async () => {
  const remote = new MemoryRemote(); await seed(remote);
  const d = device(remote);
  d.local.beforeReplace = () => d.engine.mark('Note.md');
  assert.deepEqual(await d.engine.sync(), []); assert.deepEqual(Object.keys(d.state.pending), []);
  await remote.commit({ path: 'Note.md', base: remote.heads.get('Note.md')!.revision, content: null });
  assert.deepEqual(await d.engine.sync(), []); assert.deepEqual(Object.keys(d.state.pending), []);
  assert.equal(d.local.files.has('Note.md'), false);
});

test('ordinary downloads batch state saves and replay safely after a final save failure', async () => {
  const remote = new MemoryRemote();
  for (let i = 0; i < 12; i++) await remote.commit({ path: `${i}.md`, base: 0, content: `note ${i}` });
  const local = new MemoryLocal(); const state = emptyState(); let saved = structuredClone(state); let writes = 0;
  const engine = new SyncEngine(state, local, remote, async () => {
    if (++writes === 2) throw new Error('Interrupted');
    saved = structuredClone(state);
  });
  await assert.rejects(engine.sync(), /Interrupted/);
  assert.equal(local.files.size, 12); assert.equal(Object.keys(saved.pending).length, 12);
  const retry = new SyncEngine(saved, local, remote, async () => {});
  assert.deepEqual(await retry.sync(), []); assert.equal(Object.keys(saved.pending).length, 0);
  assert.equal(local.files.size, 12); assert.equal(retry.stats.downloads, 0);
  assert.equal(retry.stats.stateWrites, 1);
});

test('Windows to Android and back, nested Markdown, no unchanged transfer', async () => {
  const remote = new MemoryRemote();
  const windows = device(remote); const android = device(remote);
  windows.local.files.set('Folder/Note.md', 'from Windows'); windows.engine.mark('Folder/Note.md');
  assert.deepEqual(await windows.engine.sync(), []);
  await android.engine.sync();
  assert.equal(android.local.files.get('Folder/Note.md'), 'from Windows');
  android.local.files.set('Folder/Note.md', 'from Android'); android.engine.mark('Folder/Note.md');
  await android.engine.sync(); await windows.engine.sync();
  assert.equal(windows.local.files.get('Folder/Note.md'), 'from Android');
  const reads = remote.reads; const writes = remote.revisions.length;
  await windows.engine.sync(); await android.engine.sync();
  assert.equal(remote.reads, reads); assert.equal(remote.revisions.length, writes);
});

test('concurrent offline edits keep canonical and conflict copy, then replicate copy', async () => {
  const remote = new MemoryRemote(); await seed(remote);
  const a = device(remote); const b = device(remote);
  await a.engine.sync(); await b.engine.sync();
  a.local.files.set('Note.md', 'Windows edit'); a.engine.mark('Note.md');
  b.local.files.set('Note.md', 'Android edit'); b.engine.mark('Note.md');
  await a.engine.sync(); await b.engine.sync();
  assert.equal(b.local.files.get('Note.md'), 'Windows edit');
  assert.ok([...b.local.files.values()].includes('Android edit'));
  await b.engine.sync(); await a.engine.sync();
  assert.ok([...a.local.files.values()].includes('Android edit'));
});

test('stale push cannot overwrite a commit made after pulling', async () => {
  const remote = new MemoryRemote(); await seed(remote);
  const a = device(remote); await a.engine.sync();
  a.local.files.set('Note.md', 'local'); a.engine.mark('Note.md');
  remote.beforeCommit = async () => { await remote.commit({ path: 'Note.md', base: 1, content: 'racing remote' }); };
  await a.engine.sync();
  assert.ok(a.state.pending['Note.md']);
  assert.equal(remote.contents.get(remote.heads.get('Note.md')!.revision), 'racing remote');
  await a.engine.sync();
  assert.ok([...a.local.files.values()].includes('local'));
  assert.equal(a.local.files.get('Note.md'), 'racing remote');
});

test('offline queue survives restart', async () => {
  const remote = new MemoryRemote(); const a = device(remote);
  a.local.files.set('Note.md', 'offline edit'); a.engine.mark('Note.md');
  remote.offline = true;
  await assert.rejects(a.engine.sync(), /Offline/);
  const restored = structuredClone(a.state);
  const restarted = new SyncEngine(restored, a.local, remote, async () => {});
  remote.offline = false;
  await restarted.sync();
  assert.equal(remote.contents.get(1), 'offline edit');
});

test('startup inventory recovers edits made while the plugin was inactive', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); await a.engine.sync();
  const restored = a.saved();
  a.local.files.set('Note.md', 'edited with plugin disabled');
  const restarted = new SyncEngine(restored, a.local, remote, async () => {});
  for (const path of a.local.files.keys()) restarted.mark(path);
  for (const path of Object.keys(restored.bases)) restarted.mark(path);
  await restarted.sync();
  assert.equal(remote.contents.get(2), 'edited with plugin disabled');
});

test('identical concurrent edits converge without creating copies', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); const b = device(remote);
  await a.engine.sync(); await b.engine.sync();
  for (const d of [a, b]) { d.local.files.set('Note.md', 'same edit'); d.engine.mark('Note.md'); }
  await a.engine.sync(); await b.engine.sync();
  assert.equal(remote.revisions.length, 2); assert.equal(b.local.files.size, 1);
});

test('a note above the old limit syncs between devices', async () => {
  const remote = new MemoryRemote(); const a = device(remote); const b = device(remote);
  const content = 'x'.repeat(10 * 1024 * 1024);
  a.local.files.set('Large.md', content); a.engine.mark('Large.md');
  assert.deepEqual(await a.engine.sync(), []);
  assert.deepEqual(await b.engine.sync(), []);
  assert.equal(b.local.files.get('Large.md'), content);
  assert.equal(Object.keys(a.state.pending).length, 0);
});

test('oversized local note remains pending without upload', async () => {
  const remote = new MemoryRemote(); const a = device(remote);
  a.local.files.set('Note.md', 'x'.repeat(10 * 1024 * 1024 + 1)); a.engine.mark('Note.md');
  assert.match((await a.engine.sync())[0]!, /10 MiB/);
  assert.equal(remote.revisions.length, 0); assert.ok(a.state.pending['Note.md']);
});

test('lost upload response recovers without duplicate revision or conflict', async () => {
  const remote = new MemoryRemote(); const a = device(remote);
  a.local.files.set('Note.md', 'edit'); a.engine.mark('Note.md'); remote.loseResponse = true;
  assert.match((await a.engine.sync())[0]!, /Response lost/);
  await a.engine.sync();
  assert.equal(remote.revisions.length, 1); assert.equal(a.local.files.size, 1);
  assert.equal(Object.keys(a.state.pending).length, 0);
});

test('editing while downloading never overwrites the new local edit', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); await a.engine.sync();
  await remote.commit({ path: 'Note.md', base: 1, content: 'remote' });
  a.local.beforeReplace = () => { a.local.files.set('Note.md', 'typing'); a.engine.mark('Note.md'); a.local.beforeReplace = undefined; };
  await a.engine.sync();
  assert.equal(a.local.files.get('Note.md'), 'typing'); assert.ok(a.state.pending['Note.md']);
  await a.engine.sync();
  assert.ok([...a.local.files.values()].includes('typing'));
});

test('editing during upload retains pending edit for the next pass', async () => {
  const remote = new MemoryRemote(); const a = device(remote);
  a.local.files.set('Note.md', 'snapshot'); a.engine.mark('Note.md');
  remote.afterCommit = () => { a.local.files.set('Note.md', 'new edit'); a.engine.mark('Note.md'); remote.afterCommit = undefined; };
  await a.engine.sync(); assert.ok(a.state.pending['Note.md']);
  await a.engine.sync(); assert.equal(remote.contents.get(2), 'new edit');
});

test('failed local apply with persisted cursor is retried after restart', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); a.local.failReplace = true;
  assert.match((await a.engine.sync())[0]!, /Disk full/);
  const restored = a.saved(); assert.equal(restored.cursor, 1); assert.ok(restored.pending['Note.md']);
  a.local.failReplace = false;
  await new SyncEngine(restored, a.local, remote, async () => {}).sync();
  assert.equal(a.local.files.get('Note.md'), 'original');
});

test('conflict copy survives failed apply; retry does not duplicate it', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote);
  a.local.files.set('Note.md', 'different initial note'); a.engine.mark('Note.md'); a.local.failReplace = true;
  await a.engine.sync(); assert.equal(a.local.files.size, 2);
  a.local.failReplace = false; await a.engine.sync(); assert.equal(a.local.files.size, 2);
  assert.equal(a.local.files.get('Note.md'), 'original');
});

test('local deletion propagates without losing the historical content', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); await a.engine.sync();
  a.local.files.delete('Note.md'); a.engine.mark('Note.md');
  assert.deepEqual(await a.engine.sync(), []);
  assert.equal(a.local.files.has('Note.md'), false); assert.equal(remote.revisions.length, 2);
  assert.equal(remote.heads.get('Note.md')?.deleted, true);
  assert.equal(remote.contents.get(1), 'original');
});

test('replaced remote identity stops sync', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); await a.engine.sync();
  remote.identity = 'new-server';
  await assert.rejects(a.engine.sync(), /Cloud vault was replaced/);
  assert.equal(a.local.files.get('Note.md'), 'original');
});

test('corrupted downloaded content is rejected without changing local file', async () => {
  const remote = new MemoryRemote(); await seed(remote); remote.contents.set(1, 'corrupt'); const a = device(remote);
  assert.match((await a.engine.sync())[0]!, /integrity/); assert.equal(a.local.files.size, 0);
});

test('portable paths reject traversal, hidden settings, reserved names, and unsafe separators', () => {
  for (const path of ['../note.md', '.obsidian/note.md', '.obsidian/workspace.json', '.obsidian/plugins/metronome/data.json', '.git/config', 'a//b.md', '/note.md', 'C:/note.md', 'a\\b.md', 'NUL.md', 'a./b.md', 'a /b.md'])
    assert.equal(validPath(path), false, path);
  assert.equal(validPath('Notes/My note.md'), true);
  assert.equal(validPath('assets/picture.png'), true);
  assert.equal(validPath('.obsidian/app.json'), true);
  assert.equal(validPath('.obsidian/plugins/other/data.json'), true);
});


test('remote deletion removes the other device copy and converges after restart', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); const b = device(remote);
  await a.engine.sync(); await b.engine.sync();
  a.local.files.delete('Note.md'); a.engine.mark('Note.md');
  await a.engine.sync(); assert.deepEqual(await b.engine.sync(), []);
  assert.equal(b.local.files.has('Note.md'), false);
  const restored = b.saved(); await new SyncEngine(restored, b.local, remote, async () => {}).sync();
  assert.equal(b.local.files.has('Note.md'), false); assert.equal(Object.keys(restored.pending).length, 0);
});

test('an offline edit racing with deletion survives as a synced conflict copy', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); const b = device(remote);
  await a.engine.sync(); await b.engine.sync();
  b.local.files.set('Note.md', 'offline edit'); b.engine.mark('Note.md');
  a.local.files.delete('Note.md'); a.engine.mark('Note.md'); await a.engine.sync();
  assert.deepEqual(await b.engine.sync(), []); await b.engine.sync(); await a.engine.sync();
  assert.equal(b.local.files.has('Note.md'), false);
  assert.ok([...a.local.files.values()].includes('offline edit'));
});

test('local deletion racing with a remote edit preserves the remote edit', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); const b = device(remote);
  await a.engine.sync(); await b.engine.sync();
  a.local.files.delete('Note.md'); a.engine.mark('Note.md');
  b.local.files.set('Note.md', 'remote edit'); b.engine.mark('Note.md'); await b.engine.sync();
  assert.deepEqual(await a.engine.sync(), []); await a.engine.sync(); await b.engine.sync();
  assert.equal(b.local.files.has('Note.md'), false);
  assert.ok([...b.local.files.values()].includes('remote edit'));
});

test('recreating a previously deleted path syncs as a new revision', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); const b = device(remote);
  await a.engine.sync(); await b.engine.sync();
  a.local.files.delete('Note.md'); a.engine.mark('Note.md'); await a.engine.sync(); await b.engine.sync();
  a.local.files.set('Note.md', 'restored'); a.engine.mark('Note.md'); await a.engine.sync(); await b.engine.sync();
  assert.equal(b.local.files.get('Note.md'), 'restored'); assert.equal(remote.heads.get('Note.md')?.deleted, undefined);
});

test('deletion with a lost server response retries without duplicate revisions', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); await a.engine.sync();
  a.local.files.delete('Note.md'); a.engine.mark('Note.md'); remote.loseResponse = true;
  assert.match((await a.engine.sync())[0]!, /Response lost/);
  assert.deepEqual(await a.engine.sync(), []); assert.equal(remote.revisions.length, 2);
});

test('an edit made while remote deletion is applied is preserved on retry', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); await a.engine.sync();
  await remote.commit({ path: 'Note.md', base: 1, content: null });
  a.local.beforeReplace = () => { a.local.beforeReplace = undefined; a.local.files.set('Note.md', 'typing now'); a.engine.mark('Note.md'); };
  await a.engine.sync(); assert.equal(a.local.files.get('Note.md'), 'typing now');
  await a.engine.sync(); assert.equal(a.local.files.has('Note.md'), false);
  assert.ok([...a.local.files.values()].includes('typing now'));
});

test('missing large batches pause until explicitly approved', async () => {
  const remote = new MemoryRemote(); const a = device(remote);
  for (let i = 0; i < 21; i++) { const path = i + '.md'; a.local.files.set(path, 'keep history'); a.engine.mark(path); }
  await a.engine.sync();
  for (const path of a.local.files.keys()) { a.local.files.delete(path); a.engine.mark(path); }
  assert.match((await a.engine.sync())[0]!, /Bulk deletion paused/);
  assert.equal(remote.revisions.length, 21);
  a.engine.allowBulkDeletion = true; assert.deepEqual(await a.engine.sync(), []);
  assert.equal(remote.revisions.length, 42); assert.equal(a.engine.allowBulkDeletion, false);
});

test('binary attachments retain encoded bytes through create, edit, and deletion', async () => {
  const remote = new MemoryRemote(); const a = device(remote); const b = device(remote);
  a.local.files.set('Assets/photo.png', 'AAECA/8='); a.engine.mark('Assets/photo.png');
  assert.deepEqual(await a.engine.sync(), []); await b.engine.sync(); assert.equal(b.local.files.get('Assets/photo.png'), 'AAECA/8=');
  b.local.files.set('Assets/photo.png', '/wAB'); b.engine.mark('Assets/photo.png'); await b.engine.sync(); await a.engine.sync();
  assert.equal(a.local.files.get('Assets/photo.png'), '/wAB');
  a.local.files.delete('Assets/photo.png'); a.engine.mark('Assets/photo.png'); await a.engine.sync(); await b.engine.sync();
  assert.equal(b.local.files.has('Assets/photo.png'), false);
});

test('disabling a scope never interprets excluded files as deletions', async () => {
  const remote = new MemoryRemote(); await remote.commit({path: '.obsidian/app.json', base: 0, content: '{}'});
  const a = device(remote); const engine = new SyncEngine(a.state, a.local, remote, async () => {}, path => !path.startsWith('.obsidian/'));
  assert.deepEqual(await engine.sync(), []); assert.equal(a.local.files.size, 0); assert.equal(remote.revisions.length, 1);
});

test('an unrelated oversized file does not block a note deletion', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote); await a.engine.sync();
  a.local.files.set('too-big.md', 'x'.repeat(10 * 1024 * 1024 + 1)); a.engine.mark('too-big.md');
  a.local.files.delete('Note.md'); a.engine.mark('Note.md');
  assert.match((await a.engine.sync())[0]!, /10 MiB/);
  assert.equal(remote.heads.get('Note.md')?.deleted, true);
});

test('initial case differences converge without duplicate notes or conflicts', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote);
  a.local.files.set('note.md', 'original'); a.engine.mark('note.md');
  assert.deepEqual(await a.engine.sync(), []);
  assert.deepEqual([...a.local.files.entries()], [['Note.md', 'original']]);
  assert.equal(remote.revisions.length, 1);
  assert.equal(Object.keys(a.state.pending).length, 0);
});

test('a different edit under an initial case alias is preserved before adopting the cloud spelling', async () => {
  const remote = new MemoryRemote(); await seed(remote); const a = device(remote);
  a.local.files.set('note.md', 'Android edit'); a.engine.mark('note.md');
  assert.deepEqual(await a.engine.sync(), []);
  assert.equal(a.local.files.get('Note.md'), 'original');
  assert.ok([...a.local.files.values()].includes('Android edit'));
  assert.equal(Object.keys(a.state.pending).length, 0, 'the conflict copy is uploaded in the same cycle');
});

test('unchanged startup inventories flush once instead of rewriting history per file', async () => {
  const remote = new MemoryRemote(); const a = device(remote);
  for (let i = 0; i < 40; i++) { const path = `Note ${i}.md`; a.local.files.set(path, 'content'); a.engine.mark(path); }
  await a.engine.sync(); await a.engine.sync();
  let saves = 0; let activity = 0;
  const engine = new SyncEngine(a.state, a.local, remote, async () => { saves++; });
  for (const path of a.local.files.keys()) engine.mark(path);
  await engine.sync(); assert.equal(saves, 1);
  await engine.sync(() => { activity++; }); assert.equal(activity, 0, 'an idle poll never reports syncing');
});
