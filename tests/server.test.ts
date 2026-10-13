import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { emptyState, SyncEngine, type Local } from '../src/engine';
import { hashText, StaleRevision, type Commit, type Remote, type Revision } from '../src/protocol';

test('actual Worker + SQLite Durable Object + R2: auth, CAS, history, limits, pagination', async () => {
  const bundled = await build({ entryPoints: ['server/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const token = 'test-token-with-at-least-32-characters';
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0]!.text,
    compatibilityDate: '2025-09-01', bindings: { SYNC_TOKEN: token, VAULT_ID: 'test' },
    durableObjects: { VAULTS: { className: 'VaultCoordinator', useSQLite: true } }, r2Buckets: ['BLOBS'] }));
  const request = (path: string, body?: unknown, auth = token) => mf.dispatchFetch(`https://example.test${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${auth}`, 'X-Metronome-Protocol': '2' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await request('/changes', undefined, 'wrong')).status, 401);
    const first = await request('/commit', { path: 'Note.md', base: 0, content: 'one' });
    assert.equal(first.status, 200); const r1 = await first.json() as { revision: number };
    assert.equal((await request('/content?revision=' + r1.revision)).status, 200);
    assert.equal(await (await request('/content?revision=' + r1.revision)).text(), 'one');
    assert.equal((await request('/commit', { path: 'Note.md', base: 0, content: 'one' })).status, 200);
    assert.equal((await request('/commit', { path: 'Note.md', base: 0, content: 'stale' })).status, 409);
    const racing = await Promise.all([
      request('/commit', { path: 'Note.md', base: r1.revision, content: 'two' }),
      request('/commit', { path: 'Note.md', base: r1.revision, content: 'three' })
    ]);
    assert.deepEqual(racing.map(r => r.status).sort(), [200, 409]);
    assert.equal(await (await request('/content?revision=' + r1.revision)).text(), 'one');
    assert.equal((await request('/commit', { path: 'note.md', base: 0, content: 'case' })).status, 422);
    assert.equal((await request('/commit', { path: '../escape.md', base: 0, content: 'bad' })).status, 400);
    const largeNote = 'x'.repeat(10 * 1024 * 1024);
    const largeResponse = await request('/commit', { path: 'Large.md', base: 0, content: largeNote });
    assert.equal(largeResponse.status, 200);
    const largeRevision = await largeResponse.json() as Revision;
    assert.equal(await (await request('/content?revision=' + largeRevision.revision)).text(), largeNote);
    assert.equal((await request('/commit', { path: 'Big.md', base: 0, content: 'x'.repeat(10 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await request('/changes?cursor=-1')).status, 400);
    for (let n = 0; n < 101; n++) {
      assert.equal((await request('/commit', { path: `Page/${n}.md`, base: 0, content: `${n}` })).status, 200);
    }
    const page = await (await request('/changes?cursor=0')).json() as { changes: unknown[]; cursor: number; more: boolean; identity: string };
    assert.equal(page.changes.length, 100); assert.equal(page.more, true); assert.ok(page.identity);
    const next = await (await request(`/changes?cursor=${page.cursor}`)).json() as typeof page;
    assert.equal(next.changes.length, 4); assert.equal(next.more, false); assert.equal(next.identity, page.identity);

    // Exercise the client protocol against the actual emulator, not a mock server.
    const remote: Remote = {
      changes: async cursor => await (await request(`/changes?cursor=${cursor}`)).json() as Awaited<ReturnType<Remote['changes']>>,
      read: async r => await (await request(`/content?revision=${r.revision}`)).text(),
      commit: async (c: Commit) => {
        const response = await request('/commit', c);
        if (response.status === 409) throw new StaleRevision();
        assert.equal(response.status, 200);
        return await response.json() as Revision;
      }
    };
    const device = () => {
      const files = new Map<string, string>();
      const local: Local = {
        remove: async (path, expected) => { if (files.get(path) !== expected) return false; files.delete(path); return true; },
        read: async path => files.get(path) ?? null,
        replace: async (path, expected, content) => {
          if ((files.get(path) ?? null) !== expected) return false;
          files.set(path, content); return true;
        },
        preserve: async (path, content) => {
          const copy = `_metronome-conflicts/${await hashText(path + '\0' + content)}.md`;
          files.set(copy, content); return copy;
        }
      };
      return { files, engine: new SyncEngine(emptyState(), local, remote, async () => {}) };
    };
    const windows = device(); const android = device();
    windows.files.set('Roundtrip.md', 'Windows'); windows.engine.mark('Roundtrip.md');
    assert.deepEqual(await windows.engine.sync(), []); assert.deepEqual(await android.engine.sync(), []);
    assert.equal(android.files.get('Roundtrip.md'), 'Windows');
    windows.files.set('Roundtrip.md', 'Windows offline'); windows.engine.mark('Roundtrip.md');
    android.files.set('Roundtrip.md', 'Android offline'); android.engine.mark('Roundtrip.md');
    await windows.engine.sync(); await android.engine.sync(); await android.engine.sync(); await windows.engine.sync();
    assert.equal(android.files.get('Roundtrip.md'), 'Windows offline');
    assert.ok([...windows.files.values()].includes('Android offline'));

    assert.equal((await mf.dispatchFetch('https://example.test/changes', { headers: { Authorization: `Bearer ${token}` } })).status, 426);
    const original = await (await request('/commit', { path: 'Move/Untitled.md', base: 0, content: 'rename me' })).json() as Revision;
    const move = { path: 'Move/Named.md', base: 0, content: 'rename me', from: { path: original.path, base: original.revision } };
    const moved = await (await request('/commit', move)).json() as Revision;
    assert.equal(moved.removed?.deleted, true);
    assert.equal(moved.removed?.path, original.path);
    assert.deepEqual(await (await request('/commit', move)).json(), moved, 'lost-response rename retries are idempotent');
    assert.equal((await request('/commit', { path: original.path, base: original.revision, content: 'stale edit' })).status, 409);
    const history = await (await request('/history?path=' + encodeURIComponent(original.path))).json() as { revisions: Revision[] };
    assert.equal(history.revisions[0]?.deleted, true);
    assert.equal(await (await request('/content?revision=' + original.revision)).text(), 'rename me');
    assert.equal((await request('/content?revision=' + moved.removed!.revision)).status, 410);

    windows.files.set('Case.md', 'case rename'); windows.engine.mark('Case.md'); await windows.engine.sync(); await android.engine.sync();
    windows.files.delete('Case.md'); windows.files.set('case.md', 'case rename'); windows.engine.rename('Case.md', 'case.md');
    assert.deepEqual(await windows.engine.sync(), []); await windows.engine.sync();
    assert.deepEqual(await android.engine.sync(), []);
    assert.equal(android.files.has('Case.md'), false); assert.equal(android.files.get('case.md'), 'case rename');
    windows.files.delete('case.md'); windows.files.set('Case.md', 'case rename'); windows.engine.rename('case.md', 'Case.md');
    assert.deepEqual(await windows.engine.sync(), []); await windows.engine.sync(); await android.engine.sync();
    assert.equal(android.files.has('case.md'), false); assert.equal(android.files.get('Case.md'), 'case rename');

    windows.files.set('Temporary.md', 'new title'); windows.engine.mark('Temporary.md'); await windows.engine.sync(); await android.engine.sync();
    windows.files.delete('Temporary.md'); windows.files.set('Folder/Final.md', 'new title'); windows.engine.rename('Temporary.md', 'Folder/Final.md');
    assert.deepEqual(await windows.engine.sync(), []); await windows.engine.sync(); await android.engine.sync();
    assert.equal(android.files.has('Temporary.md'), false); assert.equal(android.files.get('Folder/Final.md'), 'new title');
    windows.files.delete('Folder/Final.md'); windows.engine.mark('Folder/Final.md');
    await windows.engine.sync(); await android.engine.sync(); assert.equal(android.files.has('Folder/Final.md'), false);
    windows.files.set('Another.md', 'rename into a deleted path'); windows.engine.mark('Another.md'); await windows.engine.sync();
    windows.files.delete('Another.md'); windows.files.set('Folder/Final.md', 'rename into a deleted path'); windows.engine.rename('Another.md', 'Folder/Final.md');
    assert.deepEqual(await windows.engine.sync(), []); await windows.engine.sync(); await android.engine.sync();
    assert.equal(android.files.get('Folder/Final.md'), 'rename into a deleted path');

    const attachment = Buffer.alloc(10 * 1024 * 1024, 255).toString('base64');
    const assetResponse = await request('/commit', { path: 'Assets/test.pdf', base: 0, content: attachment });
    assert.equal(assetResponse.status, 200);
    const asset = await assetResponse.json() as Revision;
    assert.equal(await (await request('/content?revision=' + asset.revision)).text(), attachment);
    assert.equal((await request('/commit', { path: 'Assets/bad.pdf', base: 0, content: 'not base64!' })).status, 400);
    assert.equal((await request('/commit', { path: '.obsidian/plugins/metronome/data.json', base: 0, content: '{}' })).status, 400);
    assert.equal((await request('/commit', { path: '.obsidian/workspace.json', base: 0, content: '{}' })).status, 400);
    assert.equal((await request('/commit', { path: '.obsidian/app.json', base: 0, content: '{"readableLineLength":true}' })).status, 200);
  } finally { await mf.dispose(); }
});
