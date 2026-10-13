import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vault, DataAdapter } from 'obsidian';
import { vaultLocal, encodeBinary, decodeBinary } from '../src/vault-local';
import { settingsFiles } from '../src/settings-files';
import { validPath, sharedSettingsPath, contentBytes } from '../src/protocol';

function fakeVault() {
  const files = new Map<string, Uint8Array>();
  const folders = new Set(['', '.obsidian']);
  let beforeRename: (() => void) | undefined;
  const bytes = (path: string) => { const value = files.get(path); if (!value) throw new Error('Missing file'); return value; };
  const write = (path: string, text: string) => files.set(path, new TextEncoder().encode(text));
  const adapter = {
    exists: async (path: string) => files.has(path) || folders.has(path),
    stat: async (path: string) => files.has(path) ? { type: 'file', size: bytes(path).length, mtime: 1, ctime: 1 }
      : folders.has(path) ? { type: 'folder', size: 0, mtime: 1, ctime: 1 } : null,
    read: async (path: string) => new TextDecoder().decode(bytes(path)),
    readBinary: async (path: string) => Uint8Array.from(bytes(path)).buffer,
    write: async (path: string, text: string) => { write(path, text); },
    writeBinary: async (path: string, value: ArrayBuffer) => { files.set(path, new Uint8Array(value)); },
    mkdir: async (path: string) => { folders.add(path); },
    rmdir: async (path: string, recursive: boolean) => {
      assert.equal(recursive, false);
      if ([...files.keys(), ...folders].some(child => child.startsWith(path + '/'))) throw new Error('Not empty');
      folders.delete(path);
    },
    process: async (path: string, fn: (value: string) => string) => { const next = fn(new TextDecoder().decode(bytes(path))); write(path, next); return next; },
    rename: async (old: string, next: string) => {
      beforeRename?.(); beforeRename = undefined;
      if (files.has(next)) throw new Error('Destination exists');
      files.set(next, bytes(old)); files.delete(old);
    },
    list: async (folder: string) => {
      const direct = (path: string) => path.startsWith(folder + '/') && !path.slice(folder.length + 1).includes('/');
      return { files: [...files.keys()].filter(direct), folders: [...folders].filter(direct) };
    }
  };
  const getFile = (path: string) => files.has(path) && !path.startsWith('.') ? { path, stat: { size: bytes(path).length } } : null;
  const vault = {
    configDir: '.obsidian', adapter,
    getAbstractFileByPath: getFile,
    getFiles: () => [...files.keys()].filter(path => !path.startsWith('.')).map(path => getFile(path)),
    createFolder: adapter.mkdir,
    create: async (path: string, text: string) => { if (files.has(path)) throw new Error('Exists'); write(path, text); return getFile(path); },
    createBinary: async (path: string, value: ArrayBuffer) => { if (files.has(path)) throw new Error('Exists'); files.set(path, new Uint8Array(value)); return getFile(path); },
    process: async (file: { path: string }, fn: (value: string) => string) => adapter.process(file.path, fn),
    rename: async (file: { path: string }, next: string) => adapter.rename(file.path, next)
  } as unknown as Vault;
  return { vault, files, folders, adapter, write, onRename: (fn: () => void) => { beforeRename = fn; },
    local: vaultLocal(vault, validPath, () => true, () => {}) };
}

test('cleanup removes only an empty conflict folder and keeps recovery and other folders', async () => {
  const f = fakeVault();
  f.folders.add('_metronome-conflicts'); f.folders.add('.metronome-recovery'); f.folders.add('Empty');
  f.write('_metronome-conflicts/copy.md', 'keep');
  await f.local.cleanup!(); assert.ok(f.folders.has('_metronome-conflicts'));
  f.files.delete('_metronome-conflicts/copy.md');
  f.folders.add('_metronome-conflicts/sub');
  await f.local.cleanup!(); assert.ok(f.folders.has('_metronome-conflicts'));
  f.folders.delete('_metronome-conflicts/sub');
  await f.local.cleanup!(); assert.equal(f.folders.has('_metronome-conflicts'), false);
  assert.ok(f.folders.has('.metronome-recovery')); assert.ok(f.folders.has('Empty'));
});

test('binary codec round-trips arbitrary bytes and the 10 MiB boundary', () => {
  const bytes = Uint8Array.from({ length: 10 * 1024 * 1024 }, (_, i) => i % 256);
  const encoded = encodeBinary(bytes.buffer);
  assert.equal(contentBytes('image.png', encoded), bytes.length);
  assert.deepEqual(new Uint8Array(decodeBinary(encoded)), bytes);
});

test('deletion captures the actual file in local recovery', async () => {
  const f = fakeVault(); f.write('Note.md', 'original');
  assert.equal(await f.local.remove('Note.md', 'original'), true);
  assert.equal(f.files.has('Note.md'), false);
  const backup = [...f.files.keys()][0]!;
  assert.ok(backup.startsWith('.metronome-recovery/'));
  assert.equal(await f.adapter.read(backup), 'original');
});

test('an edit between comparison and deletion is restored, never lost', async () => {
  const f = fakeVault(); f.write('Note.md', 'original'); f.onRename(() => f.write('Note.md', 'typed during deletion'));
  assert.equal(await f.local.remove('Note.md', 'original'), false);
  assert.equal(await f.adapter.read('Note.md'), 'typed during deletion');
});

test('binary replacement preserves the previous bytes in local recovery', async () => {
  const f = fakeVault(); f.files.set('image.png', Uint8Array.from([0, 255, 1]));
  assert.equal(await f.local.replace('image.png', 'AP8B', 'AQID'), true);
  assert.deepEqual(f.files.get('image.png'), Uint8Array.from([1, 2, 3]));
  const backup = [...f.files.keys()].find(path => path.startsWith('.metronome-recovery/'))!;
  assert.deepEqual(f.files.get(backup), Uint8Array.from([0, 255, 1]));
});

test('settings discovery includes settings and excludes state, workspaces, and plugin code', async () => {
  const f = fakeVault();
  for (const folder of ['.obsidian/plugins', '.obsidian/plugins/metronome', '.obsidian/plugins/other', '.obsidian/snippets', '.obsidian/themes', '.obsidian/themes/Custom']) f.folders.add(folder);
  for (const path of ['.obsidian/app.json', '.obsidian/hotkeys.json', '.obsidian/workspace.json', '.obsidian/workspace-mobile.json',
    '.obsidian/plugins/metronome/data.json', '.obsidian/plugins/other/data.json', '.obsidian/plugins/other/main.js',
    '.obsidian/snippets/test.css', '.obsidian/themes/Custom/theme.css']) f.write(path, '{}');
  const paths = await settingsFiles(f.adapter as unknown as DataAdapter, '.obsidian');
  assert.deepEqual(paths.sort(), ['.obsidian/app.json', '.obsidian/hotkeys.json', '.obsidian/plugins/other/data.json', '.obsidian/snippets/test.css', '.obsidian/themes/Custom/theme.css'].sort());
});

test('settings write and delete through adapter without needing vault indexing', async () => {
  const f = fakeVault(); f.write('.obsidian/app.json', '{}');
  assert.equal(await f.local.replace('.obsidian/app.json', '{}', '{"theme":"dark"}'), true);
  assert.equal(await f.local.read('.obsidian/app.json'), '{"theme":"dark"}');
  assert.equal(await f.local.remove('.obsidian/app.json', '{"theme":"dark"}'), true);
  assert.equal(f.files.has('.obsidian/app.json'), false);
});

test('a disabled or unloaded plugin cannot write files', async () => {
  const f = fakeVault(); const local = vaultLocal(f.vault, validPath, () => false, () => {});
  await assert.rejects(local.replace('Note.md', null, 'value'), /unloaded/);
  await assert.rejects(f.local.replace('.obsidian/plugins/metronome/data.json', null, '{}'), /scope/);
  assert.equal(f.files.size, 0);
});

test('initial filename casing is aligned without changing bytes or announcing a conflict', async () => {
  const f = fakeVault(); f.write('Exercise As A Test.md', 'same bytes');
  assert.equal(await f.local.alignCase!('Exercise as a Test.md'), 'Exercise As A Test.md');
  assert.equal(await f.local.read('Exercise as a Test.md'), 'same bytes');
  assert.deepEqual([...f.files.keys()], ['Exercise as a Test.md']);
  assert.equal(await f.local.alignCase!('Exercise as a Test.md'), null);
});

test('failed case alignment restores the original file', async () => {
  const f = fakeVault(); f.write('Note.md', 'original');
  const rename = f.vault.rename.bind(f.vault);
  f.vault.rename = async (file, next) => { if (next === 'note.md') throw new Error('Rename blocked'); await rename(file, next); };
  await assert.rejects(f.local.alignCase!('note.md'), /Rename blocked/);
  assert.deepEqual([...f.files.keys()], ['Note.md']);
  assert.equal(await f.local.read('Note.md'), 'original');
});

test('device-specific plugin activation and Git automation are never shared', () => {
  for (const path of ['.obsidian/community-plugins.json', '.obsidian/core-plugins.json', '.obsidian/core-plugins-migration.json', '.obsidian/plugins/obsidian-git/data.json']) {
    assert.equal(sharedSettingsPath(path), false);
    assert.equal(validPath(path), true, 'historical change feed entries remain readable');
  }
  assert.equal(validPath('.obsidian/app.json'), true);
});
