import { build, context } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot, distDir, vaultTarget, installPlugin } from './scripts/vault.mjs';

export async function buildPlugin({ install = false, watch = false } = {}) {
  const target = install ? await vaultTarget() : undefined;
  await mkdir(distDir, { recursive: true });
  const options = { absWorkingDir: projectRoot, entryPoints: ['src/main.ts'], bundle: true,
    external: ['obsidian', 'node:child_process'], platform: 'browser', format: 'cjs', target: 'es2020',
    outfile: path.join(distDir, 'main.js'), write: false,
    plugins: [{ name: 'install-metronome', setup(buildApi) {
      // Include the manifest in esbuild's watch graph, without changing the bundle.
      buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', external: true,
        watchFiles: [path.join(projectRoot, 'manifest.json'), path.join(projectRoot, 'styles.css')] }));
      buildApi.onEnd(async result => {
        if (result.errors.length) return;
        try {
          const bytes = result.outputFiles[0].contents;
          await writeFile(path.join(distDir, 'main.js'), bytes);
          await copyFile(path.join(projectRoot, 'manifest.json'), path.join(distDir, 'manifest.json'));
          await copyFile(path.join(projectRoot, 'styles.css'), path.join(distDir, 'styles.css'));
          if (target) await installPlugin(target, bytes);
          console.log(`Build ready${target ? ' — toggle Metronome off/on in Obsidian to reload' : ' in dist/'}.`);
        } catch (error) { return { errors: [{ text: `Plugin installation failed: ${error.message}` }] }; }
      });
    }}]
  };
  if (!watch) { await build(options); return; }
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching src/ and manifest.json. Press Ctrl+C to stop.');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await ctx.dispose(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await buildPlugin({ install: process.argv.includes('--install'), watch: process.argv.includes('--watch') }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
