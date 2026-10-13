import type { DataAdapter } from 'obsidian';
import { sharedSettingsPath, validPath } from './protocol';

export async function settingsFiles(adapter: DataAdapter, configDir: string): Promise<string[]> {
  const result: string[] = [];
  const logical = (path: string) => '.obsidian' + path.slice(configDir.length);
  const walk = async (folder: string) => {
    const list = await adapter.list(folder);
    for (const file of list.files) if (sharedSettingsPath(logical(file)) && validPath(logical(file))) result.push(logical(file));
    await Promise.all(list.folders.map(async child => {
      const relative = logical(child);
      if (relative === '.obsidian/themes' || relative === '.obsidian/snippets'
        || relative.startsWith('.obsidian/themes/') || relative.startsWith('.obsidian/snippets/')
        || relative === '.obsidian/plugins' || /^\.obsidian\/plugins\/[^/]+$/.test(relative) && !relative.endsWith('/metronome')) await walk(child);
    }));
  };
  await walk(configDir);
  return result;
}
