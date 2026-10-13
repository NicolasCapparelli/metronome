export interface GitResult { code: number; stdout: string; stderr: string }
export type GitRunner = (args: string[]) => Promise<GitResult>;
export interface BackupStatus { repository: boolean; branch?: string; remotes: string[]; lastCommit?: string }

export function githubRemote(value: string): string {
  const remote = value.trim();
  if (!/^(https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(remote))
    throw new Error('Enter a GitHub repository URL: https://github.com/owner/repo.git or git@github.com:owner/repo.git');
  return remote;
}

/** Git operates only at the vault root; no shell or credentials are supplied by Metronome. */
export class GitBackup {
  private busy = false;
  constructor(private run: GitRunner, private configDir: string, private protect: (rules: string[]) => Promise<void>) {}

  private async git(...args: string[]): Promise<string> {
    const result = await this.run(args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Git command failed');
    return result.stdout.trim();
  }

  async status(): Promise<BackupStatus> {
    await this.git('--version');
    // A parent repository must never accidentally include files outside this vault.
    const prefix = await this.run(['rev-parse', '--show-prefix']);
    if (prefix.code !== 0) return { repository: false, remotes: [] };
    if (prefix.stdout.trim()) throw new Error('This vault is inside another Git repository. Use a repository rooted at the vault itself.');
    const branch = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const last = await this.run(['log', '-1', '--format=%h · %s']);
    return { repository: true, branch: branch.stdout.trim() || undefined,
      remotes: (await this.git('remote')).split('\n').filter(Boolean), lastCommit: last.code === 0 ? last.stdout.trim() : undefined };
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('A backup operation is already running');
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }

  initialize(): Promise<void> {
    return this.exclusive(async () => {
      if (!(await this.status()).repository) await this.git('init', '-b', 'main');
      await this.protectFiles();
    });
  }

  setRemote(name: string, url: string): Promise<void> {
    return this.exclusive(async () => {
      const remote = githubRemote(url);
      const status = await this.status();
      if (!status.repository) throw new Error('Initialize the vault repository first');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error('Invalid remote name');
      await this.git('remote', status.remotes.includes(name) ? 'set-url' : 'add', name, remote);
    });
  }

  remoteUrl(name: string): Promise<string> { return this.git('remote', 'get-url', '--push', name); }

  private async protectFiles(): Promise<void> {
    const paths = [`${this.configDir}/plugins/metronome`, '.metronome-recovery', '.trash'];
    const tracked = await this.git('ls-files', '--', ...paths);
    if (tracked) throw new Error('Git already tracks Metronome credentials or local recovery/trash files. Remove these paths from the Git index and review repository history before backing up.');
    await this.protect(paths.map(path => '/' + path + '/'));
  }

  backup(remote: string, vaultName: string): Promise<{ commit: string; created: boolean }> {
    return this.exclusive(async () => {
      const status = await this.status();
      if (!status.repository || !status.branch) throw new Error('Backup needs a vault repository with a checked-out branch');
      if (!status.remotes.includes(remote)) throw new Error('Choose a configured backup remote');
      githubRemote(await this.remoteUrl(remote));
      const changesResult = await this.run(['status', '--porcelain']);
      if (changesResult.code !== 0) throw new Error(changesResult.stderr);
      const changes = changesResult.stdout;
      if (changes.split('\n').some(line => line && line[0] !== ' ' && line[0] !== '?'))
        throw new Error('Git has staged changes or conflicts. Commit or unstage them before using Metronome backup.');
      for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
        if ((await this.run(['rev-parse', '--verify', '--quiet', ref])).code === 0)
          throw new Error('Finish the current Git operation before backing up');
      }
      // git status also exposes a rebase even when the index is clean.
      if (/rebase in progress|currently rebasing|bisecting/i.test(await this.git('status')))
        throw new Error('Finish the current Git operation before backing up');
      if (!(await this.git('var', 'GIT_AUTHOR_IDENT'))) throw new Error('Configure your Git name and email first');
      await this.protectFiles();
      await this.git('add', '-A', '--', '.');
      const summary = await this.git('diff', '--cached', '--stat');
      const created = !!summary;
      if (created) {
        const date = new Date();
        const message = `Metronome backup · ${date.toISOString()}\n\nVault: ${vaultName.replace(/[\r\n]/g, ' ')}\nLocal time: ${date.toString()}\nBranch: ${status.branch}\n\n${summary}`;
        await this.git('commit', '-m', message);
      }
      const commit = await this.git('rev-parse', '--short', 'HEAD');
      try { await this.git('push', remote, `HEAD:refs/heads/${status.branch}`); }
      catch (error) { throw new Error(`Backup saved locally (${commit}), but push failed. Retry backup to push it. ${error instanceof Error ? error.message : error}`); }
      return { commit, created };
    });
  }
}

export function desktopGitRunner(root: string, execute?: typeof import('node:child_process').execFile): GitRunner {
  // Loaded only on desktop, so the Android sync bundle remains usable.
  const execFile = execute ?? (require('node:child_process') as typeof import('node:child_process')).execFile;
  return args => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') { reject(new Error('Git is not installed or is not on PATH. Install Git, then restart Obsidian.')); return; }
      resolve({ code: error ? 1 : 0, stdout, stderr: stderr || (error?.message ?? '') });
    });
  });
}
