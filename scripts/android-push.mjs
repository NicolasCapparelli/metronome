import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildPlugin } from '../esbuild.config.mjs';
import { projectRoot, distDir } from './vault.mjs';

const exec = promisify(execFile);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function main() {
  const configPath = path.join(projectRoot, 'metronome.local.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const candidates = [config.adbPath, process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe')].filter(Boolean);
  let adb = 'adb';
  for (const candidate of candidates) { try { await access(candidate); adb = candidate; break; } catch {} }
  const run = async args => {
    try { return await exec(adb, args, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }); }
    catch (e) {
      if (e.code === 'ENOENT') throw new Error('ADB not found. Install Android SDK Platform Tools and set adbPath in metronome.local.json.');
      throw e;
    }
  };
  const listing = (await run(['devices'])).stdout;
  const devices = listing.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === 'device');
  const serial = config.androidSerial ?? (devices.length === 1 ? devices[0][0] : undefined);
  if (!serial || !devices.some(parts => parts[0] === serial))
    throw new Error('Connect and unlock your phone, enable USB debugging, and accept its authorization prompt. If multiple devices are connected, set androidSerial in metronome.local.json.');
  const shell = command => run(['-s', serial, 'shell', command]);
  let folder = config.androidPluginPath;
  if (!folder) {
    // find may report inaccessible Android system directories; only use its matching paths.
    let output;
    try { output = (await shell("find /sdcard/ -maxdepth 9 -type d -path '*/plugins/metronome' 2>/dev/null")).stdout; }
    catch (e) { if (e.killed || !e.stdout) throw e; output = e.stdout; }
    const matches = output.trim().split(/\r?\n/).filter(Boolean);
    if (matches.length !== 1) throw new Error('Could not select one Android vault. Set androidPluginPath to its existing .obsidian/plugins/metronome folder in metronome.local.json.');
    folder = matches[0];
  }
  const suffix = `/${config.configDir ?? '.obsidian'}/plugins/metronome`;
  if (typeof folder !== 'string' || !/^\/(sdcard|storage\/emulated\/0)\//.test(folder) || !folder.endsWith(suffix)
    || folder.split('/').some(part => part === '..' || part === '.') || /[\r\n\0]/.test(folder))
    throw new Error('Android plugin path must point to an existing vault plugin folder in shared storage.');
  const manifest = JSON.parse((await shell(`cat ${quote(folder + '/manifest.json')}`)).stdout);
  if (manifest.id !== 'metronome') throw new Error('Target is not an installed Metronome plugin.');
  // Remember the discovered folder, but do not bind to one device unless explicitly configured.
  if (config.androidPluginPath !== folder) {
    config.androidPluginPath = folder;
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  }
  await buildPlugin();
  for (const name of ['main.js', 'manifest.json', 'styles.css']) {
    const local = path.join(distDir, name);
    const remote = folder + '/' + name;
    await run(['-s', serial, 'push', local, remote]);
    const expected = createHash('sha256').update(await readFile(local)).digest('hex');
    const actual = (await shell(`sha256sum ${quote(remote)}`)).stdout.trim().split(/\s+/)[0];
    if (actual !== expected) throw new Error(`Android update verification failed for ${name}; retry the command.`);
  }
  console.log(`Updated and verified Android plugin: ${folder}`);
  console.log('Toggle Metronome off/on in Android Obsidian to load the update. Settings and sync history were preserved.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
