import { access } from 'node:fs/promises';
import path from 'node:path';
import { vaultTarget, connection, checkBackend } from './vault.mjs';
try {
  const target = await vaultTarget();
  for (const name of ['main.js', 'manifest.json', 'styles.css']) await access(path.join(target.plugin, name));
  console.log(`Plugin installed in ${target.plugin}`);
  await checkBackend(await connection(target));
  console.log('Ready for Windows–Android testing. No notes were changed.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
