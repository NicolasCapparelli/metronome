import { Notice, Modal, SuggestModal, Plugin, PluginSettingTab, Setting, TFile, FileSystemAdapter, Platform, type App } from 'obsidian';
import { GitBackup, desktopGitRunner } from './backup';
import { backupSettings } from './backup-settings';
import { settingsSection } from './settings-ui';
import { emptyState, SyncEngine, type SyncState } from './engine';
import { HttpRemote } from './http';
import { LiveUpdates } from './live-updates';
import { hashText, validPath, settingsPath, sharedSettingsPath, contentBytes, MAX_NOTE_BYTES, validateRevision, type Revision } from './protocol';
import { vaultLocal } from './vault-local';
import { settingsFiles } from './settings-files';

interface Settings { endpoint: string; token: string; enabled: boolean; attachments?: boolean; sharedSettings?: boolean; automaticSync?: boolean }
interface Data { version: 1; settings: Settings; binding: string; state: SyncState; lastSuccess?: string; issues?: string[]; conflicts?: string[]; lastRun?: { totalMs: number; settingsMs: number; networkMs: number; saveMs: number; stateWrites: number; downloads: number; uploads: number } }
const defaults = (): Data => ({ version: 1, settings: { endpoint: '', token: '', enabled: false }, binding: '', state: emptyState() });

export default class Metronome extends Plugin {
  data!: Data;
  backup?: GitBackup;
  private engine?: SyncEngine;
  private status!: HTMLElement;
  private saves: Promise<void> = Promise.resolve();
  private active = false;
  private busy = false;
  private nextRetry = 0;
  private failures = 0;
  private debounce?: number;
  private settingsSeen = new Map<string, string>();
  private internalRenames = new Set<string>();
  private conflictMessages = new Set<string>();
  private syncAgain = false;
  private autoAgain = false;
  private live?: LiveUpdates;
  private lastCheck = 0;

  async onload(): Promise<void> {
    const saved = await this.loadData() as Data | null;
    if (saved && saved.version !== 1) throw new Error('Unsupported Metronome state version');
    this.data = saved ?? defaults();
    this.data.settings.attachments ??= true;
    this.data.settings.sharedSettings ??= true;
    if (Platform.isDesktopApp && this.app.vault.adapter instanceof FileSystemAdapter) {
      this.backup = new GitBackup(desktopGitRunner(this.app.vault.adapter.getBasePath()), this.app.vault.configDir, async rules => {
        const adapter = this.app.vault.adapter;
        const append = (text: string) => {
          const missing = rules.filter(rule => !text.split(/\r?\n/).includes(rule));
          return missing.length ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n# Metronome backup exclusions\n${missing.join('\n')}\n` : text;
        };
        if (await adapter.exists('.gitignore')) await adapter.process('.gitignore', append);
        else await adapter.write('.gitignore', append(''));
      });
    }
    this.data.settings.automaticSync ??= true;
    this.status = this.addStatusBarItem();
    this.status.setText('Metronome: paused');
    this.addSettingTab(new MetronomeSettings(this.app, this));
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => this.manualSync() });
    this.addCommand({ id: 'show-status', name: 'Show sync status', callback: () => new Notice(
      `${this.status.textContent}\nPending: ${Object.keys(this.data.state.pending).length}\nUpdates: ${this.data.settings.automaticSync === false ? 'manual' : this.live?.connected ? 'live connection' : 'polling fallback'}\nLast successful sync: ${this.data.lastSuccess ?? 'never'}\n${this.data.lastRun ? `Last run: ${(this.data.lastRun.totalMs / 1000).toFixed(1)}s; network ${this.data.lastRun.networkMs}ms; settings ${this.data.lastRun.settingsMs}ms; state writes ${this.data.lastRun.stateWrites} (${this.data.lastRun.saveMs}ms); downloads ${this.data.lastRun.downloads}; uploads ${this.data.lastRun.uploads}\n` : ''}${(this.data.issues ?? []).join('\n')}\n${(this.data.conflicts ?? []).join('\n')}`, 20000) });
    this.addCommand({ id: 'restore-file', name: 'Restore a file from cloud history', callback: () => this.showRestore() });
    this.addCommand({ id: 'show-conflicts', name: 'Open a conflict copy', callback: () => {
      const files = this.app.vault.getFiles().filter(file => file.path.startsWith('_metronome-conflicts/'));
      new FilePicker(this.app, files.map(file => file.path), path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
      }).open();
    } });
    this.addCommand({ id: 'approve-bulk-deletion', name: 'Review and sync bulk deletions', callback: () => this.confirmBulkDeletion() });
    this.addRibbonIcon('refresh-cw', 'Metronome: sync now', () => this.manualSync());
    this.registerDomEvent(window, 'keydown', event => {
      if (!this.data.settings.enabled || this.data.settings.automaticSync !== false || !event.ctrlKey
        || event.altKey || event.shiftKey || event.metaKey || event.key.toLowerCase() !== 's' || event.isComposing) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) this.manualSync();
    }, { capture: true });
    this.app.workspace.onLayoutReady(() => {
      this.active = true;
      const mark = (path: string) => {
        if (!this.syncable(path) || !this.engine) return;
        this.engine.mark(path);
        if (!this.busy) void this.persist().catch(() => this.status.setText('Metronome: unable to save queue'));
        if (this.data.settings.automaticSync === false) {
          if (!this.busy) this.status.setText(`Metronome: manual · ${Object.keys(this.data.state.pending).length} pending`);
          return;
        }
        if (this.busy) return;
        if (this.debounce !== undefined) window.clearTimeout(this.debounce);
        this.debounce = window.setTimeout(() => { void this.sync(); }, 750);
      };
      this.registerEvent(this.app.vault.on('create', f => { if (f instanceof TFile) mark(f.path); }));
      this.registerEvent(this.app.vault.on('modify', f => { if (f instanceof TFile) mark(f.path); }));
      this.registerEvent(this.app.vault.on('delete', f => {
        if (f instanceof TFile) mark(f.path);
        else for (const path of new Set([...Object.keys(this.data.state.bases), ...Object.keys(this.data.state.pending)])) {
          if (path.startsWith(f.path + '/') && (this.data.state.bases[path]?.hash || !this.data.state.remote[path]?.deleted)) mark(path);
        }
      }));
      this.registerEvent(this.app.vault.on('rename', (f, old) => {
        if (this.internalRenames.has(old) || this.internalRenames.has(f.path)) return;
        if (f instanceof TFile) { if (this.syncable(old) && this.syncable(f.path)) this.engine?.rename(old, f.path); mark(old); mark(f.path); }
        else {
          for (const path of Object.keys(this.data.state.bases)) if (path.startsWith(old + '/')) { this.engine?.rename(path, f.path + path.slice(old.length)); mark(path); }
          for (const file of this.app.vault.getFiles()) if (file.path.startsWith(f.path + '/')) mark(file.path);
        }
      }));
      this.registerDomEvent(document, 'visibilitychange', () => {
        this.updateLive();
        if (!document.hidden && this.data.settings.automaticSync !== false) { this.nextRetry = 0; void this.sync(); }
      });
      this.registerDomEvent(window, 'online', () => {
        this.live?.stop(); this.updateLive();
        if (this.data.settings.automaticSync !== false) { this.nextRetry = 0; void this.sync(); }
      });
      this.registerDomEvent(window, 'offline', () => this.live?.stop());
      this.registerInterval(window.setInterval(() => { void this.tick(); }, 5000));
      void this.start();
    });
  }

  persist(): Promise<void> {
    // Snapshot now, serialize disk writes, and let a later retry recover a failed save.
    const snapshot = JSON.parse(JSON.stringify(this.data)) as Data;
    this.saves = this.saves.catch(() => {}).then(() => this.saveData(snapshot));
    return this.saves;
  }

  async configure(settings: Settings): Promise<void> {
    if (this.busy) throw new Error('Wait for the current sync to finish before changing settings');
    const endpoint = settings.endpoint.trim().replace(/\/+$/, '');
    const token = settings.token.trim();
    if (settings.enabled) {
      new HttpRemote(endpoint, token);
      if (token.length < 32) throw new Error('Use a token of at least 32 characters');
    }
    if (this.data.binding && endpoint !== this.data.binding)
      throw new Error('This vault is bound to another endpoint. Use a fresh test vault to connect elsewhere.');
    this.data.settings = { ...settings, endpoint, token };
    await this.persist();
    await this.start();
  }

  private async start(): Promise<void> {
    this.live?.stop(); this.autoAgain = false; this.lastCheck = 0;
    this.engine = undefined;
    if (!this.active || !this.data.settings.enabled) { this.status.setText('Metronome: paused'); return; }
    try {
      const { endpoint, token } = this.data.settings;
      if (this.data.binding && this.data.binding !== endpoint) throw new Error('Cloud endpoint does not match saved sync history');
      this.data.binding = endpoint;
      this.engine = new SyncEngine(this.data.state, this.local(), new HttpRemote(endpoint, token), () => {
        if (!this.active) throw new Error('Plugin unloaded; sync stopped');
        return this.persist();
      }, path => this.syncable(path));
      this.live = new LiveUpdates(() => new HttpRemote(endpoint, token).eventsUrl(), (cursor, identity) => {
        if (identity !== this.data.state.identity || cursor > this.data.state.cursor) this.queueAutomatic();
      });
      this.updateLive();
      // One startup inventory recovers edits made while Obsidian was closed.
      const files = this.app.vault.getFiles();
      for (const f of files) if (this.syncable(f.path)) this.engine.mark(f.path);
      for (const path of Object.keys(this.data.state.bases)) this.engine.mark(path);
      this.settingsSeen.clear();
      await this.scanSettings();
      await this.persist();
      if (this.data.settings.automaticSync !== false) await this.sync();
      else this.status.setText(`Metronome: manual · ${Object.keys(this.data.state.pending).length} pending`);
    } catch (e) { this.report(e); }
  }

  private local() {
    return vaultLocal(this.app.vault, path => this.syncable(path), () => this.active,
      message => this.conflictMessages.add(message), path => !!this.data.state.remote[path]?.deleted || !!this.data.state.moves?.[path],
      async (paths, action) => {
        for (const path of paths) this.internalRenames.add(path);
        try { await action(); }
        finally { for (const path of paths) this.internalRenames.delete(path); }
      });
  }

  private syncable(path: string): boolean {
    if (!validPath(path)) return false;
    if (settingsPath(path)) return sharedSettingsPath(path) && this.data.settings.sharedSettings !== false;
    if (path.startsWith(this.app.vault.configDir + '/')) return false;
    return /\.md$/i.test(path) || this.data.settings.attachments !== false;
  }

  private async scanSettings(): Promise<void> {
    if (!this.engine || this.data.settings.sharedSettings === false) return;
    const files = await settingsFiles(this.app.vault.adapter, this.app.vault.configDir);
    const present = new Set(files);
    await Promise.all(files.map(async path => {
      const stat = await this.app.vault.adapter.stat(this.app.vault.configDir + path.slice(9));
      if (!stat) return;
      const fingerprint = stat.mtime + ':' + stat.size;
      if (this.settingsSeen.get(path) !== fingerprint) this.engine?.mark(path);
      this.settingsSeen.set(path, fingerprint);
    }));
    for (const path of Object.keys(this.data.state.bases)) {
      if (sharedSettingsPath(path) && this.data.state.bases[path]?.hash && !present.has(path)) this.engine.mark(path);
    }
    for (const path of this.settingsSeen.keys()) if (!present.has(path)) this.settingsSeen.delete(path);
  }

  private confirmBulkDeletion(): void {
    const modal = new Modal(this.app);
    modal.contentEl.createEl('p', { text: 'Metronome paused a large batch of missing files. Check that your vault is fully mounted and these files were intentionally deleted. Cloud history will remain recoverable.' });
    new Setting(modal.contentEl).addButton(button => button.setButtonText('Sync these deletions').onClick(() => {
      if (!this.engine || this.busy) { new Notice('Wait for sync to finish'); return; }
      this.engine.allowBulkDeletion = true; modal.close(); this.manualSync();
    }));
    modal.open();
  }

  private showRestore(): void {
    const paths = Object.keys(this.data.state.remote).filter(path => this.syncable(path));
    new FilePicker(this.app, paths, path => { void this.restoreHistory(path); }).open();
  }

  private async restoreHistory(path: string): Promise<void> {
    try {
      const remote = new HttpRemote(this.data.settings.endpoint, this.data.settings.token);
      const revisions = (await remote.history(path)).filter(r => !r.deleted);
      for (const r of revisions) validateRevision(r);
      new RevisionPicker(this.app, revisions, r => { void this.restoreRevision(remote, r); }).open();
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }

  private async restoreRevision(remote: HttpRemote, revision: Revision): Promise<void> {
    if (this.busy || !this.engine) { new Notice('Wait for sync to finish, then try restore again'); return; }
    this.busy = true;
    try {
      await this.engine.sync();
      const content = await remote.read(revision);
      if (await hashText(content) !== revision.hash || contentBytes(revision.path, content) > MAX_NOTE_BYTES) throw new Error('Invalid historical content');
      const local = this.local();
      const current = await local.read(revision.path);
      if (current !== null && current !== content) {
        const copy = await local.preserve(revision.path, current); this.engine.mark(copy); await this.persist();
      }
      if (!await local.replace(revision.path, current, content)) throw new Error('File changed during restore; retry');
      this.engine.mark(revision.path);
      // Treat restoration as an explicit new edit against the latest cloud head.
      const head = this.data.state.remote[revision.path];
      if (head) this.data.state.bases[revision.path] = { revision: head.revision, hash: head.hash };
      await this.persist(); new Notice('Restored ' + revision.path);
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 10000); }
    finally { this.busy = false; this.manualSync(); }
  }

  private manualSync(): void {
    if (!this.engine) { new Notice('Enable Metronome in its settings first'); return; }
    this.nextRetry = 0;
    if (this.busy) { this.syncAgain = true; return; }
    void this.sync(true);
  }

  private updateLive(): void {
    if (this.active && this.data.settings.enabled && this.data.settings.automaticSync !== false && !document.hidden) this.live?.start();
    else this.live?.stop();
  }

  private queueAutomatic(): void {
    if (!this.active || this.data.settings.automaticSync === false || document.hidden) return;
    if (this.busy) { this.autoAgain = true; return; }
    if (this.debounce !== undefined) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => { this.nextRetry = 0; void this.sync(); }, 100);
  }

  private async tick(): Promise<void> {
    if (!this.active || !this.engine || document.hidden || this.data.settings.automaticSync === false || this.busy) return;
    try {
      await this.scanSettings();
      if (Object.keys(this.data.state.pending).length || !this.live?.connected || Date.now() - this.lastCheck >= 60000) void this.sync(false, true);
    } catch (error) { this.report(error); }
  }

  private async sync(manual = false, settingsAlreadyScanned = false): Promise<void> {
    if (!manual && this.data.settings.automaticSync === false) return;
    if (!this.active || !this.engine || this.busy || Date.now() < this.nextRetry) return;
    this.busy = true;
    const started = Date.now();
    if (manual) this.status.setText('Metronome: syncing');
    try {
      if (!settingsAlreadyScanned) await this.scanSettings();
      const settingsMs = Date.now() - started;
      let didWork = false;
      const errors = await this.engine.sync(() => { didWork = true; this.status.setText('Metronome: syncing'); });
      this.lastCheck = Date.now();
      if (didWork || manual) this.data.lastRun = { totalMs: Date.now() - started, settingsMs, ...this.engine.stats };
      if (!this.active) return;
      const changedIssues = JSON.stringify(errors) !== JSON.stringify(this.data.issues ?? []);
      this.data.issues = errors;
      if (this.conflictMessages.size) this.data.conflicts = [...new Set([...(this.data.conflicts ?? []), ...this.conflictMessages])].slice(-20);
      if (errors.length) {
        if (changedIssues || this.conflictMessages.size) await this.persist();
        if (!this.active) return;
        this.status.setText(`Metronome: ${errors.length} pending issue(s)`);
        if (changedIssues) new Notice(errors.slice(0, 3).join('\n'), 10000);
        // Per-file issues must not delay unrelated notes or incoming deletions.
        this.nextRetry = 0;
      } else {
        this.failures = 0;
        this.nextRetry = 0;
        if (didWork || manual || changedIssues || !this.data.lastSuccess) {
          this.data.lastSuccess = new Date().toISOString();
          await this.persist();
        }
        if (!this.active) return;
        this.status.setText(`Metronome: ${this.data.settings.automaticSync === false ? 'manual' : 'synced'} · ${Object.keys(this.data.state.pending).length} pending`);
        if (manual) new Notice(Object.keys(this.data.state.pending).length ? 'Metronome: changes arrived during sync; press Ctrl+S again to finish' : `Metronome: sync complete (${((Date.now() - started) / 1000).toFixed(1)}s)`, 3500);
        if (Object.keys(this.data.state.pending).length && this.data.settings.automaticSync !== false) {
          if (this.debounce !== undefined) window.clearTimeout(this.debounce);
          this.debounce = window.setTimeout(() => { void this.sync(); }, 750);
        }
      }
    } catch (e) {
      if (!this.active) return;
      this.nextRetry = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(this.failures++, 4));
      this.report(e);
    } finally {
      this.busy = false;
      if (this.active && this.conflictMessages.size) {
        new Notice(`Metronome preserved ${this.conflictMessages.size} conflicting edit(s) in _metronome-conflicts. Use “Show sync status” for details.`, 7000);
        this.conflictMessages.clear();
      }
      if (this.active && this.syncAgain) {
        this.syncAgain = false;
        this.autoAgain = false;
        this.manualSync();
      } else if (this.active && this.autoAgain) {
        this.autoAgain = false; this.queueAutomatic();
      }
    }
  }
  private report(e: unknown): void {
    if (!this.active) return;
    const message = e instanceof Error ? e.message : String(e);
    this.data.issues = [message];
    void this.persist().catch(() => {});
    this.status.setText(`Metronome: ${message}`);
  }
  onunload(): void {
    this.active = false;
    this.live?.stop();
    if (this.debounce !== undefined) window.clearTimeout(this.debounce);
  }
}

class MetronomeSettings extends PluginSettingTab {
  constructor(app: App, private plugin: Metronome) { super(app, plugin); }
  display(): void {
    this.containerEl.empty();
    this.containerEl.addClass('metronome-settings');
    const draft = { ...this.plugin.data.settings };
    const header = this.containerEl.createDiv({ cls: 'metronome-page-header' });
    header.createEl('h2', { text: 'Metronome' });
    header.createEl('p', { text: 'Your vault, across devices.' });
    const connection = settingsSection(this.containerEl, 'Connection', 'Use the same URL and token on both devices.');
    const endpoint = new Setting(connection).setName('Server URL').setDesc('Your Cloudflare Worker’s HTTPS address.');
    endpoint.settingEl.addClass('metronome-field');
    endpoint.addText(t => {
      t.inputEl.setAttr('aria-label', 'Server URL'); t.inputEl.spellcheck = false;
      t.setValue(draft.endpoint).setPlaceholder('https://your-server.workers.dev').onChange(v => { draft.endpoint = v; });
    });
    const token = new Setting(connection).setName('Sync token').setDesc('The SYNC_TOKEN you set on your server.');
    token.settingEl.addClass('metronome-field');
    token.addText(t => { t.inputEl.type = 'password'; t.inputEl.setAttr('aria-label', 'Sync token'); t.setValue(draft.token).onChange(v => { draft.token = v; }); });
    const preferences = settingsSection(this.containerEl, 'Sync', 'Notes are included. Files can be up to 10 MiB each.');
    new Setting(preferences).setName('Enable sync').setDesc('Allow this vault to connect to your server.').addToggle(t => t.setValue(draft.enabled).onChange(v => { draft.enabled = v; }));
    new Setting(preferences).setName('Automatic sync').setDesc('Sync edits and check for updates while Obsidian is open. Turn off to sync manually with Ctrl+S or Sync now.')
      .addToggle(t => t.setValue(draft.automaticSync !== false).onChange(v => { draft.automaticSync = v; }));
    new Setting(preferences).setName('Attachments').setDesc('Images, PDFs, canvases, and other files.').addToggle(t => t.setValue(draft.attachments !== false).onChange(v => { draft.attachments = v; }));
    new Setting(preferences).setName('Obsidian settings').setDesc('Preferences, themes, and plugin settings. Restart Obsidian after downloading changes.').addToggle(t => t.setValue(draft.sharedSettings !== false).onChange(v => { draft.sharedSettings = v; }));
    const details = preferences.createEl('details', { cls: 'metronome-details' });
    details.createEl('summary', { text: 'Privacy & recovery' });
    details.createEl('p', { text: 'The sync server can read files and filenames; end-to-end encryption is not implemented. Your token is stored locally in plugin data. Do not share that file.' });
    details.createEl('p', { text: 'Deletions and renames sync. Conflicting edits are preserved as copies. Use the restore command to recover deleted files or earlier revisions. Workspaces, enabled plugin lists, Git automation, plugin code, and Metronome credentials stay on each device.' });
    const save = new Setting(preferences).setName('Apply sync settings').setDesc('Save the connection and preferences above.');
    save.settingEl.addClass('metronome-action', 'metronome-save');
    save.addButton(b => b.setButtonText('Save and apply').setCta().onClick(async () => {
      b.setDisabled(true);
      try { await this.plugin.configure(draft); new Notice('Metronome settings applied'); }
      catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
      finally { b.setDisabled(false); }
    }));
    backupSettings(this.containerEl, this.plugin.backup, this.app.vault.getName());
  }
}

class FilePicker extends SuggestModal<string> {
  constructor(app: App, private paths: string[], private select: (path: string) => void) { super(app); this.setPlaceholder('Find a file, including deleted files'); }
  getSuggestions(query: string): string[] { return this.paths.filter(path => path.toLowerCase().includes(query.toLowerCase())).slice(0, 100); }
  renderSuggestion(path: string, el: HTMLElement): void { el.setText(path); }
  onChooseSuggestion(path: string): void { this.select(path); }
}
class RevisionPicker extends SuggestModal<Revision> {
  constructor(app: App, private rows: Revision[], private select: (r: Revision) => void) { super(app); this.setPlaceholder('Choose a revision to restore (newest first)'); }
  getSuggestions(query: string): Revision[] { return this.rows.filter(r => String(r.revision).includes(query)); }
  renderSuggestion(r: Revision, el: HTMLElement): void { el.setText('Revision ' + r.revision + ' — ' + r.path); }
  onChooseSuggestion(r: Revision): void { this.select(r); }
}
