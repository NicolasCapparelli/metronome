export const MAX_NOTE_BYTES = 10 * 1024 * 1024;
export const PAGE_SIZE = 100;
export interface Revision { path: string; revision: number; hash: string; deleted?: true; removed?: Revision }
export interface ChangePage { changes: Revision[]; cursor: number; more: boolean; identity: string }
export interface Commit { path: string; base: number; content: string | null; from?: { path: string; base: number } }
export interface Remote {
  changes(cursor: number): Promise<ChangePage>;
  read(revision: Revision): Promise<string>;
  commit(change: Commit): Promise<Revision>;
}
export class StaleRevision extends Error {}

export function sharedSettingsPath(path: string): boolean {
  // Plugin activation and Git automation depend on what is installed on each
  // device. Sharing them can start another sync tool or enable missing plugins.
  if (/^\.obsidian\/(community-plugins|core-plugins|core-plugins-migration)\.json$/i.test(path)
    || /^\.obsidian\/plugins\/obsidian-git\//i.test(path)) return false;
  return settingsPath(path);
}
export function settingsPath(path: string): boolean {
  return /^\.obsidian\/[^/]+\.json$/i.test(path) && !/^\.obsidian\/workspace/i.test(path)
    || /^\.obsidian\/(snippets|themes)\//.test(path)
    || /^\.obsidian\/plugins\/[^/]+\/data\.json$/.test(path) && !/^\.obsidian\/plugins\/metronome\//i.test(path);
}
export function textPath(path: string): boolean { return /\.(md|canvas|json|css|txt|svg|csv|yaml|yml)$/i.test(path); }
export function contentBytes(path: string, content: string): number {
  if (textPath(path)) return new TextEncoder().encode(content).length;
  if (content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('Invalid attachment encoding');
  return content.length / 4 * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
}

// Portable Windows paths, with an explicit allowlist for shared Obsidian settings.
export function validPath(path: unknown): path is string {
  return typeof path === 'string' && path === path.normalize('NFC') && path.length <= 220
    && (!path.startsWith('.') || settingsPath(path))
    && path.split('/').every((part, index) => part.length > 0 && (!part.startsWith('.') || index === 0 && part === '.obsidian')
      && !/[<>:"\\|?*\u0000-\u001f]/.test(part) && !/[. ]$/.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export async function hashText(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateRevision(value: unknown): asserts value is Revision {
  const r = value as Revision | undefined;
  if (!r || !validPath(r.path) || !Number.isSafeInteger(r.revision) || r.revision < 1
    || typeof r.hash !== 'string' || !(r.deleted === true ? r.hash === '' : r.deleted === undefined && /^[a-f0-9]{64}$/.test(r.hash))) throw new Error('Invalid server revision');
}
