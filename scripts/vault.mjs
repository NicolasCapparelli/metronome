import { readFile, writeFile, mkdir, stat, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const distDir = path.join(projectRoot, 'dist');

export async function vaultTarget() {
  const localConfig = path.join(projectRoot, 'metronome.local.json');
  let config;
  try { config = JSON.parse(await readFile(localConfig, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Copy metronome.local.example.json to metronome.local.json and set your vaultPath first.');
    throw error;
  }
  if (typeof config.vaultPath !== 'string' || !path.isAbsolute(config.vaultPath)) throw new Error('vaultPath must be an absolute existing vault path.');
  const configDir = config.configDir ?? '.obsidian';
  if (typeof configDir !== 'string' || !configDir || path.isAbsolute(configDir)
    || configDir.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Error('configDir must be a relative folder within the vault.');
  const vault = await realpath(config.vaultPath);
  const obsidian = path.join(vault, configDir);
  if (!(await stat(obsidian)).isDirectory()) throw new Error(`Obsidian configuration folder is missing: ${obsidian}`);
  const plugin = path.join(obsidian, 'plugins', 'metronome');
  // Reject redirected directories before writing outside the intended plugin folder.
  let current = vault;
  for (const part of [...configDir.split(/[\\/]/), 'plugins', 'metronome']) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Plugin target contains a redirected or non-directory path: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { vault, plugin, configDir };
}

export async function protectSettings(target) {
  const ignorePath = path.join(target.vault, '.gitignore');
  const rules = [`/${target.configDir.replaceAll('\\', '/')}/plugins/metronome/data.json`, '/.metronome-recovery/'];
  let text = '';
  try { text = await readFile(ignorePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const missing = rules.filter(rule => !text.split(/\r?\n/).includes(rule));
  if (missing.length) {
    await writeFile(ignorePath, `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n# Metronome device credentials and local recovery\n${missing.join('\n')}\n`, 'utf8');
    console.log('Added the Metronome settings file to the vault Git ignore rules.');
  }
}

export async function installPlugin(target, result) {
  await protectSettings(target);
  await mkdir(target.plugin, { recursive: true });
  // Never copy data.json, other plugins, or community-plugins.json during a rebuild.
  await writeFile(path.join(target.plugin, 'main.js'), result);
  await writeFile(path.join(target.plugin, 'manifest.json'), await readFile(path.join(projectRoot, 'manifest.json')));
  await writeFile(path.join(target.plugin, 'styles.css'), await readFile(path.join(projectRoot, 'styles.css')));
  console.log(`Installed in ${target.plugin}`);
}

export async function connection(target) {
  let data;
  try { data = JSON.parse(await readFile(path.join(target.plugin, 'data.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('First enable Metronome in Windows Obsidian, enter your Worker URL and token, and click Save and apply.');
    throw error;
  }
  const { endpoint, token } = data.settings ?? {};
  if (typeof endpoint !== 'string' || typeof token !== 'string' || token.length < 32) throw new Error('Complete the Worker URL and sync token in Metronome settings first.');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The Worker URL must be HTTPS without embedded credentials.');
  if (data.binding && data.binding !== endpoint) throw new Error('Saved endpoint does not match this vault’s sync history.');
  return { endpoint: endpoint.replace(/\/+$/, ''), token };
}

export async function checkBackend(settings) {
  let response;
  try {
    response = await fetch(`${settings.endpoint}/changes?cursor=0`, {
      headers: { Authorization: `Bearer ${settings.token}`, 'X-Metronome-Protocol': '2' }, signal: AbortSignal.timeout(15000)
    });
  } catch { throw new Error('Could not reach the Worker within 15 seconds. Check the URL and your connection.'); }
  if (response.status === 401) throw new Error('The Worker rejected the token. Use the exact SYNC_TOKEN secret from deployment.');
  if (response.status === 503) throw new Error('The Worker is not configured or its storage is unavailable. Check SYNC_TOKEN, VAULT_ID, and Cloudflare bindings.');
  if (!response.ok) throw new Error(`The Worker returned HTTP ${response.status}. Check the deployment and URL.`);
  let page;
  try { page = await response.json(); } catch { throw new Error('The endpoint did not return the Metronome protocol. Check the Worker URL.'); }
  if (typeof page.identity !== 'string' || !Array.isArray(page.changes) || !Number.isSafeInteger(page.cursor))
    throw new Error('The endpoint did not return a valid Metronome change feed.');
  console.log('Backend reachable; authentication and change feed verified.');
}
