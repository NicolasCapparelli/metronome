import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { GitBackup, desktopGitRunner as createRunner, githubRemote } from '../src/backup';
import type { GitRunner } from '../src/backup';
const desktopGitRunner = (root: string) => createRunner(root, execFile);

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'metronome-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const remote = path.join(root, 'remote.git');
  await mkdir(vault); await mkdir(remote);
  const run = desktopGitRunner(vault);
  await desktopGitRunner(remote)(['init', '--bare']);
  let failPush = false;
  const runner: GitRunner = args => {
    if (args[0] === 'push') return failPush ? Promise.resolve({ code: 1, stdout: '', stderr: 'offline' }) : run(['push', remote, ...args.slice(2)]);
    return run(args);
  };
  const backup = new GitBackup(runner, '.obsidian', async rules => {
    let text = '';
    try { text = await readFile(path.join(vault, '.gitignore'), 'utf8'); } catch {}
    const missing = rules.filter(rule => !text.split(/\r?\n/).includes(rule));
    if (missing.length) await writeFile(path.join(vault, '.gitignore'), text + '\n' + missing.join('\n') + '\n');
  });
  const git = async (...args: string[]) => {
    const result = await run(args); assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  const ready = async () => {
    await backup.initialize();
    await git('config', 'user.name', 'Backup Test'); await git('config', 'user.email', 'backup@example.test');
    await backup.setRemote('origin', 'https://github.com/test/vault.git');
  };
  return { root, vault, remote, backup, git, ready, setOffline: (value: boolean) => { failPush = value; } };
}

test('backup detects setup, commits changes with metadata, pushes and excludes private files', async t => {
  const f = await fixture(t);
  assert.equal((await f.backup.status()).repository, false);
  await f.ready();
  await mkdir(path.join(f.vault, '.obsidian/plugins/metronome'), { recursive: true });
  await writeFile(path.join(f.vault, '.obsidian/plugins/metronome/data.json'), 'secret');
  await writeFile(path.join(f.vault, 'note.md'), 'first');
  const first = await f.backup.backup('origin', 'Test vault');
  assert.equal(first.created, true);
  const files = await f.git('ls-files');
  assert.match(files, /note.md/); assert.doesNotMatch(files, /data.json/);
  const message = await f.git('log', '-1', '--format=%B');
  assert.match(message, /Vault: Test vault/); assert.match(message, /Local time:/); assert.match(message, /note.md/);
  assert.equal((await desktopGitRunner(f.remote)(['rev-parse', 'refs/heads/main'])).code, 0);
  assert.equal((await f.backup.backup('origin', 'Test vault')).created, false);
  await writeFile(path.join(f.vault, 'note.md'), 'changed');
  assert.equal((await f.backup.backup('origin', 'Test vault')).created, true);
  await rm(path.join(f.vault, 'note.md'));
  await f.backup.backup('origin', 'Test vault');
  assert.doesNotMatch(await f.git('ls-files'), /note.md/);
});

test('failed pushes keep commits and retry without duplicate commits', async t => {
  const f = await fixture(t); await f.ready();
  await writeFile(path.join(f.vault, 'note.md'), 'offline');
  f.setOffline(true);
  await assert.rejects(f.backup.backup('origin', 'Test'), /saved locally.*push failed/);
  const head = await f.git('rev-parse', 'HEAD');
  f.setOffline(false);
  assert.equal((await f.backup.backup('origin', 'Test')).created, false);
  assert.equal(await f.git('rev-parse', 'HEAD'), head);
});

test('existing staged changes are preserved and backup refuses to commit them', async t => {
  const f = await fixture(t); await f.ready();
  await writeFile(path.join(f.vault, 'note.md'), 'staged'); await f.git('add', 'note.md');
  await assert.rejects(f.backup.backup('origin', 'Test'), /staged changes/);
  assert.match(await f.git('diff', '--cached', '--name-only'), /note.md/);
});

test('tracked credentials block backup even when ignore rules exist', async t => {
  const f = await fixture(t); await f.ready();
  await mkdir(path.join(f.vault, '.obsidian/plugins/metronome'), { recursive: true });
  await writeFile(path.join(f.vault, '.obsidian/plugins/metronome/data.json'), 'secret');
  await f.git('add', '-f', '.obsidian/plugins/metronome/data.json'); await f.git('commit', '-m', 'existing secret');
  await assert.rejects(f.backup.backup('origin', 'Test'), /already tracks/);
});

test('a repository above the vault is never used or initialized', async t => {
  const f = await fixture(t);
  await desktopGitRunner(f.root)(['init']);
  await assert.rejects(f.backup.initialize(), /inside another Git repository/);
});

test('GitHub URLs reject embedded credentials, options, and other hosts', () => {
  assert.equal(githubRemote('git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git');
  for (const url of ['-bad', 'https://token@github.com/owner/repo', 'https://example.com/o/r', 'https://github.com/o/r?token=secret'])
    assert.throws(() => githubRemote(url));
});
