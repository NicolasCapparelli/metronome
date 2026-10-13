# Windows and Android setup

First deploy your personal backend using the README instructions. Copy `metronome.local.example.json` to `metronome.local.json` and set `vaultPath` to your existing vault. The installer writes plugin files under:

```text
<your-vault>\.obsidian\plugins\metronome
```

The installer preserves existing settings and sync history. It also adds a rule to the vault's `.gitignore` for `.obsidian/plugins/metronome/data.json`, which contains your sync token. It does not edit notes or enable the plugin. Keep an independent backup of your vault before testing this alpha.

## Find the two connection values first

### Worker URL

1. Open [the Cloudflare dashboard](https://dash.cloudflare.com/) and sign in to the account you used to deploy.
2. Open **Workers & Pages** (under **Compute** or **Compute & AI** in the sidebar).
3. Select **metronome-sync**. This is the Worker name in this project's `wrangler.jsonc`.
4. Open **Settings → Domains & Routes**.
5. Find the hostname ending in **workers.dev**. Copy it and include `https://` at the beginning.
6. Paste the full address into Obsidian's **Settings → Metronome → Worker URL**.

Example only: `https://metronome-sync.your-account.workers.dev`. Your account portion will be different. If the workers.dev route is disabled, enable that route on this page. If metronome-sync is missing, verify you are in the deployment account; if it was not deployed, run `npm run deploy:server` from this project. The successful deployment output prints its URL.

Opening the URL in a browser without a token normally shows **Unauthorized**. That is expected: the service is authenticated rather than a webpage.

### Sync token

This is the random string you generated and pasted into `npx wrangler secret put SYNC_TOKEN` during backend setup. Use the saved copy of that exact string in Obsidian's **Settings → Metronome → Sync token**.

To check that the secret exists, open **Cloudflare → Workers & Pages → metronome-sync → Settings → Variables and Secrets** and look for **SYNC_TOKEN**. Cloudflare does not reveal the saved secret's value. If you did not save its original value, replace it:

1. In PowerShell, go to the project:

   ```powershell
   cd C:\Projects\metronome
   ```

2. Generate a new token:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Copy the entire printed string and save it privately, such as in your password manager.
4. Run:

   ```powershell
   npx wrangler secret put SYNC_TOKEN
   ```

5. At its secret-value prompt, paste that string and press Enter. Wait for the success message.
6. Paste the same string into Metronome's **Sync token** field on Windows. If Android is already configured, update its token too. If it is not configured yet, `npm run android` will include the Windows token in the private installation package.

The sync token is a secret you create for Metronome. A Cloudflare login password, account API token, or R2 access key is not the value for this field. The vault path is already configured in `metronome.local.json`; R2 and Durable Object bindings are configured on the server.

See Cloudflare's [workers.dev routing guide](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) and [secret management guide](https://developers.cloudflare.com/workers/configuration/secrets/).

## 1. Start the development watcher

Open PowerShell and run:

```powershell
cd C:\Projects\metronome
npm run dev
```

Leave that terminal open. It builds immediately, copies `main.js` and `manifest.json` into MyVault, and rebuilds when source files or the manifest change. Look for **Build ready — toggle Metronome off/on in Obsidian to reload**. Press **Ctrl+C** to stop watching. You do not need to run a local server; the plugin uses your deployed Cloudflare Worker.

For a single build and install without a watcher:

```powershell
npm run install:plugin
```

The target is stored in ignored `metronome.local.json`. To use another vault later, change `vaultPath` there. `configDir` is `.obsidian` for your current vault.

## 2. Enable Metronome in Windows Obsidian

1. Pause Google Drive's folder synchronization and Android DriveSync for this vault before starting Metronome. This path is inside Google's **Other computers** area; avoid two sync systems changing the same notes.
2. Open **MyVault** in Obsidian.
3. Open **Settings → Community plugins**.
4. Use the **refresh/reload plugins** icon near **Installed plugins**. If Metronome still does not appear, close and reopen the MyVault window.
5. Find **Metronome** in the installed list and toggle it **on**. Do not use Browse: this plugin is installed locally.
6. Open **Settings → Metronome** in the left sidebar, or use the settings/gear icon beside its installed entry.
7. In **Worker URL**, paste the HTTPS `workers.dev` address printed by your deployment. For example: `https://metronome-sync.your-account.workers.dev`. Use your actual URL, not the Cloudflare dashboard URL or an R2 bucket URL.
8. In **Sync token**, paste the exact random token you previously stored as the Worker's `SYNC_TOKEN` secret.
9. Turn **Enable sync** on, then click **Save and apply**.
10. Keep Obsidian open. Metronome will inventory notes, attachments, and shared settings, then upload changed files. The initial upload can take longer than ordinary syncing because this is your real vault.

Check progress with **Ctrl+P → Metronome: Show sync status**. The desktop status bar also shows progress. A **synced** status with **0 pending** means the queue has cleared. If you see pending issues, read the notices; don't assume the entire vault has transferred. Some files may exceed the 10 MiB or portable-path limits. **Show sync status** includes the stored issue details. Unsupported filenames are currently skipped.

Now check your live backend from the project terminal:

```powershell
npm run doctor
```

This reads the installed connection settings and verifies the deployed Worker's authenticated change feed. It does not modify notes or print the token. If you changed `SYNC_TOKEN` after the first deployment, update the plugin's token to match.

## 3. Reload after code changes

With `npm run dev` running:

1. Save your code changes in the Metronome project.
2. Wait for **Build ready** in the terminal.
3. In Obsidian, open **Settings → Community plugins**, find **Metronome**, toggle it **off**, then **on**.

Settings and sync history survive this reload. If you change the manifest name/version, restart the vault window so Obsidian refreshes the manifest. No source checkout, terminal, or Node.js installation is needed on Android.

## 4. Generate the Android installation package

After Windows connection settings are saved, run:

```powershell
npm run android
```

This command verifies your backend connection, builds the current plugin, and produces:

```text
C:\Projects\metronome\dist\metronome-android.zip
```

The ZIP contains a **metronome** folder with:

- `main.js`: compiled plugin.
- `manifest.json`: plugin metadata.
- `data.json`: your Worker URL and token, with fresh Android sync history and sync initially paused.

The package contains a credential. Keep it private and transfer it directly by USB. Do not commit it to Git or send it as a public attachment. The `dist` directory is ignored by this project's Git rules.

## 5. Install on Android

1. Connect your phone to the PC by USB. Unlock it and select **File transfer** if Android asks what to do with the USB connection.
2. In Windows File Explorer, open the phone's internal storage. Copy `metronome-android.zip` into **Download**.
3. On the phone, open Obsidian and choose the Android vault you want to sync with MyVault. Its local folder/name may differ; the Worker URL determines the cloud vault. To use a new vault, create **MyVault** in a folder you can access, such as **Documents/MyVault**. If you already have the same vault, use its existing local folder.
4. Close Obsidian before copying plugin files. Keep DriveSync paused for this vault.
5. Open your Android file manager and enable **Show hidden files**. Obsidian's configuration folder starts with a dot: `.obsidian`.
6. Extract the ZIP in **Download**. Find the extracted **metronome** folder.
7. Navigate to the Android vault's `.obsidian` directory. Create a **plugins** folder if one does not already exist.
8. Copy the extracted **metronome** folder into **plugins**. The final layout must be:

   ```text
   <Android vault>/.obsidian/plugins/metronome/main.js
   <Android vault>/.obsidian/plugins/metronome/manifest.json
   <Android vault>/.obsidian/plugins/metronome/data.json
   ```

   Avoid an extra nested folder such as `plugins/metronome/metronome/main.js`. If your file manager cannot access the vault's folder, choose a shared-storage vault folder that it can access rather than an app-private folder.

9. Reopen the Android vault in Obsidian.
10. Open **Settings → Community plugins**. Enable community plugins if restricted mode is on, then enable **Metronome** from **Installed plugins**.
11. Open **Settings → Metronome**. The URL and token should already be populated.
12. Turn **Enable sync** on and tap **Save and apply**.
13. Keep Obsidian open on both devices until the first sync finishes. On Android, use the command palette to run **Metronome: Show sync status**.

For an initially empty Android vault, notes, attachments, and enabled shared settings download from the backend. For an existing Android vault, identical notes converge without copies; differing notes can produce conflict copies because this device has no previous shared revision history. Attachments up to 10 MiB transfer when Sync attachments is enabled.

If Android has Git backup configured, exclude `.obsidian/plugins/metronome/data.json` in its own `.gitignore` as well. The Windows installer changes only the Windows vault's ignore file.

## 6. Confirm sync in both directions

1. In Windows Obsidian, create a note named **Metronome sync test** with the text `Hello from Windows`.
2. Keep Android Obsidian open. Check that the note appears, usually within a poll interval plus transfer time.
3. On Android, add a line: `Hello from Android`.
4. Check that the new line appears on Windows.
5. Turn Android network access off, edit the test note, then restore network access. Check the offline edit appears on Windows after reconnecting.

You can now leave `npm run dev` running while developing, and reload only Metronome after each build.

## Later Android updates

With the phone connected over USB, run this from the Metronome project:

```powershell
npm run android:push
```

It builds, finds the installed plugin, copies only `main.js` and `manifest.json`, and verifies their SHA-256 hashes. The discovered folder is remembered in `metronome.local.json` for future updates. Then toggle Metronome off/on in Android Obsidian and run **Metronome: Sync now**. There is no ZIP to unpack and no need to browse phone folders. Android settings and sync history are preserved.

Your Pixel is already authorized. On another phone, enable **Settings → Developer options → USB debugging**, connect and unlock it, and accept **Allow USB debugging**. To expose Developer options, open **Settings → About phone** and tap **Build number** seven times. ADB is detected from the Android SDK location; if needed, add `adbPath` to `metronome.local.json`. For multiple connected phones set `androidSerial`; for multiple vaults set `androidPluginPath` to the existing plugin folder. See [Android's ADB guide](https://developer.android.com/tools/adb).

If a USB connection is unavailable:

Run `npm run android -- --update` to package a new build without credentials or sync state. On an already configured Android device, replace **only `main.js` and `manifest.json`**, then disable/re-enable Metronome. Keep Android's existing **data.json**: replacing it would reset that device's sync history and connection settings.

## Common problems

| Symptom | Action |
| --- | --- |
| Metronome is missing from Installed plugins | Verify the three-level `plugins/metronome/main.js` path; refresh the list or reopen the vault. |
| The dev command cannot find the vault | Verify your vault drive is mounted and check `metronome.local.json`. |
| The doctor reports HTTP 401 | The token does not match the Worker's `SYNC_TOKEN`; correct it in Windows settings. |
| The doctor reports HTTP 503 | Verify the Worker secret, VAULT_ID, and Cloudflare bindings. |
| Android settings are empty | Ensure the initial installation included the generated `data.json`, not the plain plugin ZIP. |
| Old deletion/rename notices or an update message | Update and reload Metronome on both devices; v0.2 syncs deletions and renames. |
| Bulk deletion paused | Verify the vault is mounted and files were intentionally removed, then run Metronome: Review and sync bulk deletions. |
| Images/PDFs are missing | Enable Sync attachments on both devices; inspect Show sync status for size/path issues. |
| Shared settings have not applied | Sync, then restart Obsidian. Plugin code and workspaces remain per device. |
| Nothing arrives while Android Obsidian is closed | Reopen Obsidian; the plugin cannot run continuously while Android suspends the app. |

Reload instructions follow [Obsidian's plugin development guide](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin), and the installed-plugin controls are described in [Obsidian's community plugin help](https://help.obsidian.md/community-plugins).

## Restore a deleted file or an earlier version

1. Open the command palette and run **Metronome: Restore a file from cloud history**.
2. Search for the original path, including a deleted path.
3. Choose a revision; content revisions from the newest 100 history entries are offered.
4. Keep both devices open to sync the restored file. A differing current local version is preserved as a conflict copy.

Local deleted files and replaced attachment bytes also remain under hidden `.metronome-recovery/`. Metronome does not sync that directory or discard the cloud revision history.

## Automatic or manual sync (0.2.1)

1. Reload Metronome on both devices after updating: turn the plugin off and back on.
2. For automatic sync, leave **Enable sync** and **Automatic sync** on. Idle five-second checks no longer flash the status bar.
3. For manual sync, open **Settings → Metronome**, keep **Enable sync** on, turn **Automatic sync** off, and press **Save and apply**. Configure each device separately.
4. Press **Ctrl+S** anywhere in Obsidian to sync when automatic sync is off. On Android without a keyboard, use the Metronome ribbon button or the **Metronome: Sync now** command. Both sending and receiving devices must sync to exchange changes.
5. To inspect preserved edits, run **Metronome: Open a conflict copy** from the command palette. This works without expanding the conflict folder. **Show sync status** includes recent preservation details.

Startup casing differences now adopt the cloud spelling without changing content. If content differs, a copy is preserved. Errors on unrelated files no longer hold up deletions. Plugin activation lists and Obsidian Git automation settings remain local to each device; preferences, themes, snippets, and other plugin settings continue to sync. The original cause of a folder view automatically collapsing has not been verified; the conflict picker provides direct access while investigating that UI behavior.
