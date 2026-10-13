import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../esbuild.config.mjs';
import { distDir, vaultTarget, connection, checkBackend } from './vault.mjs';

export async function createAndroidUpdate(outputRoot = distDir) {
  await buildPlugin();
  const folder = path.join(outputRoot, 'android-update', 'metronome');
  await mkdir(folder, { recursive: true });
  for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(path.join(distDir, name), path.join(folder, name));
  const zip = path.join(outputRoot, 'metronome-android-update.zip');
  if (process.platform === 'win32') {
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -LiteralPath $env:METRONOME_ANDROID_DIR -DestinationPath $env:METRONOME_ANDROID_ZIP -Force'],
    { env: { ...process.env, METRONOME_ANDROID_DIR: folder, METRONOME_ANDROID_ZIP: zip } });
    console.log(`Android update: ${zip}`);
  }
  console.log('Replace main.js, manifest.json, and styles.css in Android <vault>/.obsidian/plugins/metronome/, then toggle the plugin off/on. Keep existing data.json.');
  return { folder, zip };
}

export async function createAndroidPackage(settings, outputRoot = distDir) {
  await buildPlugin();
  const folder = path.join(outputRoot, 'android', 'metronome');
  await mkdir(folder, { recursive: true });
  for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(path.join(distDir, name), path.join(folder, name));
  // Connection settings only: never reuse Windows cursors or acknowledged file hashes on Android.
  const data = { version: 1, settings: { ...settings, enabled: false }, binding: settings.endpoint,
    state: { cursor: 0, remote: {}, bases: {}, pending: {}, generation: 0 } };
  await writeFile(path.join(folder, 'data.json'), JSON.stringify(data, null, 2), 'utf8');
  const zip = path.join(outputRoot, 'metronome-android.zip');
  if (process.platform === 'win32') {
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -LiteralPath $env:METRONOME_ANDROID_DIR -DestinationPath $env:METRONOME_ANDROID_ZIP -Force'],
    { env: { ...process.env, METRONOME_ANDROID_DIR: folder, METRONOME_ANDROID_ZIP: zip } });
    console.log(`Android package: ${zip}`);
  } else console.log(`Android plugin folder: ${folder}`);
  console.log('This private package contains your sync token. Do not commit or share it.');
  console.log('Copy metronome/ into Android <vault>/.obsidian/plugins/, enable the plugin, then enable sync in its settings.');
  return { folder, zip };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--update')) {
      await createAndroidUpdate();
    } else {
    const settings = await connection(await vaultTarget());
    await checkBackend(settings);
    await createAndroidPackage(settings);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
