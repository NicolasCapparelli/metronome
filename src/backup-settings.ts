import { Notice, Setting, type TextComponent } from 'obsidian';
import type { GitBackup } from './backup';
import { settingsMessage, settingsSection } from './settings-ui';

export function backupSettings(container: HTMLElement, backup: GitBackup | undefined, vaultName: string): void {
  const section = settingsSection(container, 'GitHub backup', 'Keep a separate copy of your vault in GitHub. Backups are independent of sync.');
  if (!backup) {
    settingsMessage(section, 'Back up from your desktop', 'Open this vault in desktop Obsidian to connect GitHub and create backups. Your mobile changes can reach that desktop through sync.');
    return;
  }
  const panel = section.createDiv();
  let generation = 0;
  let feedback = '';
  const refresh = async () => {
    const current = ++generation;
    panel.empty();
    settingsMessage(panel, 'Checking repository', 'Looking for Git in this vault…');
    try {
      const status = await backup.status();
      let remote = status.remotes.includes('origin') ? 'origin' : status.remotes[0] ?? 'origin';
      let url = status.remotes.length ? await backup.remoteUrl(remote) : '';
      if (current !== generation || !panel.isConnected) return;
      panel.empty();
      const feedbackEl = panel.createDiv();
      feedbackEl.setAttr('aria-live', 'polite');
      if (feedback) settingsMessage(feedbackEl, 'Backup complete', feedback);
      const action = (title: string, description: string, label: string, work: () => Promise<unknown>, primary = false) => {
        const row = new Setting(panel).setName(title).setDesc(description);
        row.settingEl.addClass('metronome-action');
        row.addButton(button => {
          button.setButtonText(label);
          if (primary) button.setCta();
          button.onClick(async () => {
            const controls = Array.from(panel.querySelectorAll('button, input, select')) as unknown as Array<{ disabled: boolean }>;
            controls.forEach(control => { control.disabled = true; });
            button.setButtonText('Working…');
            feedbackEl.empty();
            try { await work(); await refresh(); }
            catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              settingsMessage(feedbackEl, 'Action needs attention', message, true);
            } finally {
              controls.forEach(control => { control.disabled = false; });
              button.setButtonText(label);
            }
          });
        });
      };
      if (!status.repository) {
        settingsMessage(panel, 'Step 1 of 2 · Set up this vault', 'Create a local Git repository to start saving backup history. Your existing files stay in place.');
        action('Local repository', 'Notes, attachments, and settings are included. Existing Git ignore rules are respected.', 'Initialize repository', () => backup.initialize(), true);
      } else {
        settingsMessage(panel, status.remotes.length ? 'Repository connected' : 'Step 2 of 2 · Connect GitHub', status.remotes.length
          ? 'Save a snapshot and upload it whenever you want a backup.'
          : 'Create an empty GitHub repository, then paste its HTTPS or SSH URL below.');
        const metadata = panel.createEl('dl', { cls: 'metronome-repository' });
        for (const [name, value] of [['Branch', status.branch ?? 'Detached HEAD — check out a branch to back up'], ['Latest commit', status.lastCommit ?? 'No backups committed yet']]) {
          const line = metadata.createDiv();
          line.createEl('dt', { text: name });
          line.createEl('dd', { text: value });
        }
        if (status.remotes.length && status.branch) {
          action('Back up current state', 'Commit changed files with a timestamp and change summary, then push to GitHub.', 'Back up now', async () => {
            const result = await backup.backup(remote, vaultName);
            feedback = result.created ? `Committed and pushed (${result.commit}).` : `No new changes. Local commits pushed (${result.commit}).`;
            new Notice(feedback);
          }, true);
        }
        if (!status.remotes.length) {
          action('Create your GitHub repository', 'Opens GitHub in your browser. Leave the new repository empty.', 'Create repository ↗', async () => { window.open('https://github.com/new', '_blank', 'noopener,noreferrer'); });
        }
        let remoteInput: TextComponent;
        let remoteRequest = 0;
        if (status.remotes.length > 1) {
          const row = new Setting(panel).setName('Backup remote').setDesc('Choose which connected repository receives backups.');
          row.settingEl.addClass('metronome-field');
          row.addDropdown(dropdown => {
            for (const name of status.remotes) dropdown.addOption(name, name);
            dropdown.setValue(remote).onChange(async name => {
              const request = ++remoteRequest;
              remote = name;
              remoteInput.setDisabled(true);
              try {
                const value = await backup.remoteUrl(name);
                if (request !== remoteRequest || current !== generation) return;
                url = value; remoteInput.setValue(value);
              } catch (error) { new Notice(String(error)); }
              finally { if (request === remoteRequest) remoteInput.setDisabled(false); }
            });
          });
        }
        const field = new Setting(panel).setName('GitHub repository URL').setDesc('Use your existing GitHub authentication through Git Credential Manager or SSH.');
        field.settingEl.addClass('metronome-field');
        field.addText(input => {
          remoteInput = input;
          input.inputEl.setAttr('aria-label', 'GitHub repository URL');
          input.inputEl.spellcheck = false;
          input.setPlaceholder('https://github.com/owner/vault.git').setValue(url).onChange(value => { url = value; });
        });
        action('Repository connection', status.remotes.length ? 'Apply a new URL for this backup remote.' : 'Connect this vault to the repository you created.', status.remotes.length ? 'Save repository URL' : 'Connect repository', () => backup.setRemote(remote, url), !status.remotes.length);
      }
      const details = panel.createEl('details', { cls: 'metronome-details' });
      details.createEl('summary', { text: 'What is included & how backups work' });
      details.createEl('p', { text: 'Backups include vault files allowed by your Git ignore rules. Metronome credentials, plugin files, local recovery files, and trash are excluded. Configure your Git name, email, and GitHub authentication on this computer first.' });
      details.createEl('p', { text: 'If upload fails, your local commit remains available to retry. Backups never pull, merge, or force-push. Resolve staged changes or Git conflicts before creating a backup.' });
      action('Repository status', 'Recheck after making changes outside Obsidian.', 'Refresh status', async () => { feedback = ''; });
    } catch (error) {
      if (current !== generation || !panel.isConnected) return;
      panel.empty();
      settingsMessage(panel, 'Could not check repository', error instanceof Error ? error.message : String(error), true);
      const row = new Setting(panel).setName('Check again').setDesc('Install Git or resolve the issue above, then retry.');
      row.settingEl.addClass('metronome-action');
      row.addButton(button => button.setButtonText('Retry').onClick(() => { void refresh(); }));
    }
  };
  void refresh();
}
