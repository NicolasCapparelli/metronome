import type { Vault, TFile } from 'obsidian';
import type { Local } from './engine';
import { hashText, MAX_NOTE_BYTES, settingsPath, textPath } from './protocol';

export function encodeBinary(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(text);
}
export function decodeBinary(text: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
  return bytes.buffer;
}

export function vaultLocal(vault: Vault, permitted: (path: string) => boolean, active: () => boolean,
  notify: (message: string) => void, removedPath: (path: string) => boolean = () => false,
  renameQuietly: (paths: string[], action: () => Promise<void>) => Promise<void> = (_paths, action) => action()): Local {
  const disk = (path: string) => path.startsWith('.obsidian/') ? vault.configDir + path.slice(9) : path;
  const check = (path: string) => {
    if (!active()) throw new Error('Plugin unloaded; sync stopped');
    if (!permitted(path)) throw new Error('Path is outside the permitted sync scope');
  };
  const folders = async (path: string) => {
    let folder = '';
    for (const part of path.split('/').slice(0, -1)) {
      folder = folder ? folder + '/' + part : part;
      const stat = await vault.adapter.stat(folder);
      if (stat && stat.type !== 'folder') throw new Error(`Folder blocked by file: ${folder}`);
      if (!stat) {
        try {
          if (folder.startsWith('.')) await vault.adapter.mkdir(folder);
          else await vault.createFolder(folder);
        } catch (error) {
          // Obsidian or another filesystem event may have created it since stat.
          if ((await vault.adapter.stat(folder))?.type !== 'folder') throw error;
        }
      }
    }
  };
  const readDisk = async (path: string, logical: string): Promise<string | null> => {
    const stat = await vault.adapter.stat(path);
    if (!stat) return null;
    if (stat.type !== 'file') throw new Error('File path occupied by a folder');
    if (stat.size > MAX_NOTE_BYTES) throw new Error('File exceeds 10 MiB limit');
    return textPath(logical) ? vault.adapter.read(path) : encodeBinary(await vault.adapter.readBinary(path));
  };
  const read = async (path: string) => {
    check(path);
    const physical = disk(path);
    const file = vault.getAbstractFileByPath(physical);
    if (file && file.path !== physical) {
      if (removedPath(path)) return null;
      throw new Error('Local filename casing differs from the cloud');
    }
    if (!file && !settingsPath(path) && await vault.adapter.exists(physical)) {
      const alias = vault.getFiles().find(file => file.path.toLowerCase() === physical.toLowerCase() && file.path !== physical);
      if (alias) {
        if (removedPath(path)) return null;
        throw new Error('Local filename casing differs from the cloud');
      }
      throw new Error('File exists outside the vault index; retry after Obsidian indexes it');
    }
    return readDisk(physical, path);
  };
  const create = async (path: string, content: string) => {
    check(path);
    const physical = disk(path);
    await folders(physical);
    check(path);
    if (settingsPath(path)) {
      if (textPath(path)) await vault.adapter.write(physical, content);
      else await vault.adapter.writeBinary(physical, decodeBinary(content));
    }
    else if (textPath(path)) await vault.create(physical, content);
    else await vault.createBinary(physical, decodeBinary(content));
  };
  // Move the actual file into recovery before removing/replacing it. This captures
  // bytes changed after the comparison and leaves them recoverable on a crash.
  const moveToRecovery = async (path: string, expected: string): Promise<string | null> => {
    if (await read(path) !== expected) return null;
    const physical = disk(path);
    const backup = `.metronome-recovery/${crypto.randomUUID()}/${path.split('/').at(-1)}`;
    await folders(backup);
    check(path);
    const file = vault.getAbstractFileByPath(physical);
    if (file) await vault.rename(file, backup);
    else await vault.adapter.rename(physical, backup);
    const restore = async () => {
      if (!await vault.adapter.exists(physical)) {
        const moved = vault.getAbstractFileByPath(backup);
        if (moved) await vault.rename(moved, physical);
        else await vault.adapter.rename(backup, physical);
      }
    };
    let captured: string | null;
    try { captured = await readDisk(backup, path); }
    catch (error) { await restore(); throw error; }
    if (captured !== expected) {
      await restore();
      return null;
    }
    return backup;
  };
  return {
    read,
    cleanup: async () => {
      // Conflict copies are files; once their tombstones are applied the generated
      // container should disappear too. Never recurse or remove remaining contents.
      const folder = '_metronome-conflicts';
      if (!active() || (await vault.adapter.stat(folder))?.type !== 'folder') return;
      const listing = await vault.adapter.list(folder);
      if (!listing.files.length && !listing.folders.length) {
        try { await vault.adapter.rmdir(folder, false); }
        catch { /* A concurrent new conflict may have made the folder nonempty. */ }
      }
    },
    alignCase: async path => {
      check(path);
      if (settingsPath(path)) return null;
      const exact = vault.getAbstractFileByPath(path);
      if (exact?.path === path) return null;
      const alias = vault.getFiles().find(file => file.path !== path && file.path.toLowerCase() === path.toLowerCase());
      if (!alias) return null;
      const old = alias.path;
      // Two hops work on both case-sensitive Android and case-insensitive Windows.
      // Keep the temporary file indexed; suppress these implementation rename events.
      const temp = old.slice(0, old.lastIndexOf('/') + 1) + `_metronome-case-${crypto.randomUUID()}`;
      await renameQuietly([old, temp, path], async () => {
        check(path);
        await vault.rename(alias, temp);
        try {
          check(path);
          const moved = vault.getAbstractFileByPath(temp);
          if (!moved) throw new Error('File is still being indexed; retry sync');
          await vault.rename(moved, path);
        } catch (error) {
          const moved = vault.getAbstractFileByPath(temp);
          if (moved && !await vault.adapter.exists(old)) await vault.rename(moved, old);
          throw error;
        }
      });
      return old;
    },
    replace: async (path, expected, content) => {
      check(path);
      const physical = disk(path);
      await folders(physical);
      if (expected === null) {
        if (await vault.adapter.exists(physical)) return false;
        try { await create(path, content); return true; }
        catch (error) { if (await vault.adapter.exists(physical)) return false; throw error; }
      }
      if (textPath(path)) {
        let replaced = false;
        const transform = (current: string) => {
          check(path);
          if (current !== expected) return current;
          replaced = true; return content;
        };
        if (settingsPath(path)) await vault.adapter.process(physical, transform);
        else {
          const file = vault.getAbstractFileByPath(physical);
          if (!file || !('stat' in file)) return false;
          await vault.process(file as TFile, transform);
        }
        return replaced;
      }
      const backup = await moveToRecovery(path, expected);
      if (!backup) return false;
      try { await create(path, content); return true; }
      catch (error) {
        if (!await vault.adapter.exists(physical)) {
          const moved = vault.getAbstractFileByPath(backup);
          if (moved) await vault.rename(moved, physical);
          else await vault.adapter.rename(backup, physical);
        }
        throw error;
      }
    },
    remove: async (path, expected) => !!await moveToRecovery(path, expected),
    preserve: async (path, content) => {
      const id = await hashText(path + '\0' + content);
      const extension = path.match(/\.[^/.]+$/)?.[0] ?? '.bin';
      let copy = `_metronome-conflicts/${id}${extension}`;
      const existing = await read(copy);
      if (existing === content) return copy;
      if (existing !== null) copy = `_metronome-conflicts/${id}-${crypto.randomUUID()}${extension}`;
      await create(copy, content);
      notify(`Metronome preserved ${path} in ${copy}`);
      return copy;
    }
  };
}
