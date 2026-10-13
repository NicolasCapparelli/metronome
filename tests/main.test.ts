import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { emptyState } from '../src/engine';

async function loadPlugin(automaticSync: boolean) {
  const result = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, platform: 'browser', format: 'cjs', external: ['obsidian', 'node:child_process'] });
  const commands = new Map<string, () => void>();
  const events = new Map<string, (event: any) => void>();
  const intervals: (() => void)[] = [];
  const statuses: string[] = [];
  const notices: string[] = [];
  let requests = 0;
  let layout!: () => void;
  const data = { version: 1, settings: { endpoint: 'https://example.test', token: 'x'.repeat(32), enabled: true, automaticSync }, binding: '', state: emptyState() };
  const window = { setTimeout, clearTimeout, setInterval: (fn: () => void) => { intervals.push(fn); return 1; } };
  class Plugin {
    app = { workspace: { onLayoutReady: (fn: () => void) => { layout = fn; } }, vault: {
      configDir: '.obsidian', getFiles: () => [], getAbstractFileByPath: () => null,
      on: () => ({}), adapter: { list: async () => ({ files: [], folders: [] }), exists: async () => false, stat: async () => null }
    } };
    loadData = async () => data;
    saveData = async () => {};
    addStatusBarItem = () => ({ setText: (text: string) => statuses.push(text) });
    addSettingTab() {} addRibbonIcon() {} registerEvent() {} registerInterval() {}
    addCommand(command: { id: string; callback: () => void }) { commands.set(command.id, command.callback); }
    registerDomEvent(_target: unknown, type: string, callback: (event: any) => void) { events.set(type, callback); }
  }
  const obsidian = { Plugin, PluginSettingTab: class {}, SuggestModal: class {}, Modal: class {}, Setting: class {}, TFile: class {}, Platform: { isDesktopApp: false }, FileSystemAdapter: class {},
    Notice: class { constructor(text: string) { notices.push(text); } },
    requestUrl: async () => { requests++; return { status: 200, json: { changes: [], cursor: 0, more: false, identity: 'vault' } }; }
  };
  const context = vm.createContext({ module: { exports: {} }, require: (name: string) => { assert.equal(name, 'obsidian'); return obsidian; }, window, document: { hidden: false }, URL, crypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval });
  new vm.Script(result.outputFiles[0]!.text).runInContext(context);
  const Constructor = context.module.exports.default;
  const plugin = new Constructor(); await plugin.onload(); layout();
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  return { plugin, data, commands, events, intervals, statuses, notices, requests: () => requests, settle };
}

test('manual mode makes no startup, interval, focus, or online requests; Ctrl+S triggers sync', async () => {
  const f = await loadPlugin(false);
  f.intervals[0]!(); f.events.get('online')!({}); f.events.get('visibilitychange')!({});
  await f.settle(); assert.equal(f.requests(), 0);
  let prevented = false;
  f.events.get('keydown')!({ key: 's', ctrlKey: true, preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} });
  await f.settle(); assert.equal(prevented, true); assert.equal(f.requests(), 1);
  assert.ok(f.notices.some(text => text.startsWith('Metronome: sync complete')));
  f.plugin.onunload();
});

test('idle automatic polling checks the cloud without flashing syncing or showing notices', async () => {
  const f = await loadPlugin(true);
  const before = f.statuses.length; const requests = f.requests();
  f.intervals[0]!(); await f.settle();
  assert.equal(f.requests(), requests + 1);
  assert.equal(f.statuses.slice(before).includes('Metronome: syncing'), false);
  assert.equal(f.notices.length, 0);
  let prevented = false;
  f.events.get('keydown')!({ key: 's', ctrlKey: true, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'automatic mode leaves the normal save shortcut alone');
  f.plugin.onunload();
});
