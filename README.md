# Metronome

An Obsidian sync plugin for Windows and Android. **Alpha 1.0** syncs notes, attachments, and shared settings through a personal Cloudflare backend, with live updates, recoverable deletions, atomic renames, conflict copies, and cloud revision restore. The GitHub release tag is `alpha1.0`; the plugin and package version is `1.0.0`. This is a prerelease.

Follow [the detailed Windows–Android setup guide](docs/setup-windows-android.md). `npm run dev` builds and watches directly into your configured Obsidian plugin directory; `npm run android` creates a private Android package with connection settings and fresh device history. Do not share that private package. The public release download contains only plugin code, the manifest, and styles.

## Architecture

Obsidian → HTTPS Cloudflare Worker → one SQLite Durable Object per vault → private R2 objects.

The Worker authenticates clients; the Durable Object atomically coordinates revisions; R2 holds immutable note contents. No Cloudflare account credentials or R2 keys are installed on devices. Each deployment currently supports one personal vault with one shared sync token.

Metronome syncs file creates, edits, renames, and deletions, including subfolders. Saves debounce for 750 ms. Connected devices receive a server notification when a new revision is committed, then pull changes since their persisted cursor. Polling remains a fallback when the live connection is unavailable. A startup inventory recovers edits made while the plugin was inactive. Conflicts preserve the local edit under `_metronome-conflicts/` before applying the remote canonical note; those copies also sync. Neither timestamps nor device clocks decide which version survives.

In **Settings → Metronome**, turn **Automatic sync** off and press **Save and apply** to sync manually. Keep **Enable sync** on. **Ctrl+S** anywhere in Obsidian then triggers sync; the ribbon button and **Metronome: Sync now** also work. Manual mode makes no startup, timer, focus, or reconnect sync requests. The setting is per device. Idle automatic checks remain visually quiet. Use **Metronome: Open a conflict copy** to select a preserved file without expanding the conflict folder; new conflicts are summarized once per cycle.

Plugin activation lists and Obsidian Git automation settings stay per device, along with workspaces and Metronome's connection state. Ordinary shared preferences, themes, snippets, and other plugins' data continue to sync. Initial capitalization differences adopt the latest cloud spelling and preserve differing content. Explicit renames while Obsidian is open still propagate.

**Scope and limits:** Notes, attachments, canvases, and shared Obsidian settings; 10 MiB per file and portable paths up to 220 characters. Shared settings include root JSON settings, themes, snippets, and other plugins’ data.json. Workspaces, caches, plugin code, Metronome credentials/history, Git internals, trash, and local recovery files are excluded. Incoming settings may require an Obsidian restart. Empty folders are not journaled. End-to-end encryption and per-device credentials are not implemented. Android catches up when Obsidian is active; it cannot sync continuously while suspended or closed.

## Build and verify

Use Node.js 22 or newer (Node.js 24 recommended).

```powershell
npm ci
npm run check
```

Build outputs: `dist/main.js` and `dist/manifest.json`. Sync uses browser and Obsidian APIs. Optional desktop Git backup uses Node's process API to run installed Git; Android does not load that API.

## GitHub backup

In Metronome settings, **GitHub backup** detects a Git repository rooted at the vault. Existing repositories skip initialization. Otherwise, choose **Initialize backup repository**, create an empty GitHub repository, and connect its HTTPS or SSH URL. Install Git and configure your Git name, email, and GitHub authentication (Git Credential Manager or SSH) on the desktop first.

Choose **Back up current state** to stage current vault changes, commit them, and push the current branch. Commit messages include UTC and local time, vault name, branch, and a changed-file summary. With no changes, the button pushes any existing local commits. A failed push retains the commit for retry. This feature works independently of cloud sync and is currently desktop-only.

Existing ignore rules are respected. Metronome plugin files (including credentials/history), `.metronome-recovery/`, and `.trash/` are excluded. Already tracked private files block backup until you remove them from the index and review history. Staged changes, conflicts, detached HEAD, and unfinished Git operations require attention before backup. Metronome never pulls or force-pushes; if the remote has diverged, resolve that with Git first. Backup includes all eligible vault files regardless of sync scope, and respects GitHub's repository/file limits.

Validation covers client conflict/recovery behavior, local adapter safety, and the Worker/SQLite/R2 protocol in Miniflare. Run `npm run check` for current results. Deployment and installation are automated; physical-device acceptance checks still need to be run after each protocol upgrade.

## Deploy your personal backend

1. Create a Cloudflare account, enable R2 Standard storage, and use the Workers Free plan initially. R2 enrollment may require billing details. Usage above R2's free allowance can incur charges.
2. Run `npx wrangler login`.
3. Run `npx wrangler r2 bucket create metronome-notes`. If that name is already used in your account, choose another and update `wrangler.jsonc`.
4. Set `VAULT_ID` in `wrangler.jsonc` before first use. Treat this as permanent for that deployment. It is the cloud vault identity, independent of local vault names.
5. Generate a random token locally:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

6. Store it securely and run `npx wrangler secret put SYNC_TOKEN`. Paste it at the prompt; do not put it in a shell command or checked-in file.
7. Run `npm run deploy:server` and record the HTTPS `workers.dev` URL.

For local backend development, create an ignored `.dev.vars` file containing `SYNC_TOKEN=<your random token>` and run `npm run dev:server`. Local Wrangler emulates SQLite and R2. The plugin deliberately requires HTTPS, so its normal setup targets the deployed Worker rather than the local HTTP emulator.

## Install on Windows and Android

1. Create a disposable test vault on each device. Enable community plugins.
2. Create `<vault>/<configDir>/plugins/metronome/` and copy the two build outputs there. Obsidian normally uses `.obsidian` as its configuration directory. Use the actual directory if customized. On Android, use a vault folder you can access with a file manager or USB transfer; ensure hidden folders are visible.
3. Restart Obsidian or reload community plugins and enable Metronome.
4. In Metronome settings, enter the same Worker URL and token on both devices, enable sync, and press **Save and apply**.
5. Keep both apps open. Create a note on Windows; confirm it appears on Android. Edit it on Android; confirm the edit appears on Windows. Use **Metronome: Show sync status** on mobile to inspect pending operations.

Do not run DriveSync, another sync plugin, or a folder sync service against these test vaults at the same time. After device validation and later safety milestones, migrate a backed-up copy of the real vault with its old sync service disabled.

The bearer token grants access to this deployment's entire cloud vault. It is stored in local plugin `data.json` and is not encrypted. Avoid copying that file publicly. The server can read note contents and filenames; HTTPS protects transport, not against the server operator. Token rotation: update the Worker secret, then update both devices' settings. Changing endpoints is rejected for a previously bound vault; use a new local test vault. If the server's database identity changes, synchronization stops instead of assuming cloud data was deleted.

All cloud revisions remain stored. Do not add an R2 lifecycle expiry rule: removing old blobs breaks retained revision history. Retention policies and orphan-blob cleanup are future work; retained history counts against storage allowances. Sync is not a replacement for independent backups.

## Deletion, conflicts, and recovery

Version 0.2.2 uses a live server notification channel when **Automatic sync** is enabled. Local edits queue a sync after 750 ms; a committed cloud revision triggers a pull on other connected devices after a short debounce. Connections use authenticated, one-use tickets and announce only a vault identity and cursor. Reconnecting pulls missed changes. With a healthy connection, a safety check runs every minute; otherwise the five-second polling fallback remains. Obsidian must be open and active; Android suspension pauses the connection and resuming catches up.

Manual mode opens no live connection and performs no background sync. Use **Sync now** on Android and Ctrl+S or **Sync now** on Windows. Enable automatic sync on both devices for event-based delivery.

Ordinary file acknowledgements now share a final state write instead of rewriting the full sync history for every file. The incoming cursor and queue are still saved before local changes, and conflict copies are saved before replacing originals. File events caused by incoming changes are cleared only after their current bytes match the acknowledged cloud head. The generated `_metronome-conflicts` folder is removed when empty; local recovery and unrelated empty folders are retained. **Show sync status** reports the last run's duration, network time, settings scan time, state writes, and transfer counts to help diagnose device-specific delays.

Deletes append a tombstone rather than destroying old content. A file rename atomically records the old-path tombstone and new-path revision when its source is known. Startup inventory also recovers moves made while Obsidian was closed by publishing new paths before deleting missing old paths. Edits racing with deletions survive as conflict copies.

Incoming deletions and binary replacements move the existing file into hidden `.metronome-recovery/` before applying the change. This folder stays local and is ignored by the Git-backed vault installer. Historical cloud content remains available; run **Metronome: Restore a file from cloud history**, search for the path, and choose a revision (the newest 100 are shown). Restore preserves a differing current local version before publishing the chosen revision.

If more than 20 files and 20% of acknowledged live files disappear together, outgoing deletion pauses. Inspect the vault and use **Metronome: Review and sync bulk deletions** only for an intentional batch. Use **Metronome: Show sync status** to read persistent issue details.

Protocol 2 rejects older clients with an update message so an old plugin cannot misread tombstones or attachment data. After deploying an upgrade, update both devices and reload Metronome. Use `npm run install:plugin` on Windows and `npm run android:push` with the phone connected; settings and history are preserved.

## Device acceptance checklist

- Create and edit notes in both directions across separate networks.
- Edit offline, restart Obsidian, reconnect, and verify the edit transfers.
- Edit the same note offline on both devices. Verify both versions survive, including the conflict copy on both devices.
- Type during an incoming transfer and verify the new edit is preserved.
- Suspend Android, edit on Windows, resume Android, and verify catch-up.
- Rename and delete a note; verify the old path disappears on the other device, then restore it with **Metronome: Restore a file from cloud history**.
- Sync an image/PDF and a canvas; verify bytes and links on both devices.
- Change a shared setting, sync, restart the other device, and verify the setting.
- Restart during a transfer, then verify convergence with no overwritten edits.

Automated tests cover the sync engine and the real Worker/SQLite/R2 implementation in Miniflare. They do not substitute for these device checks.

See [the architecture decision](docs/architecture.md) for comparisons, protocol details, costs, and milestones.
