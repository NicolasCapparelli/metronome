# Changelog

## Alpha 1.0 — 2026-10-13

Release tag: `alpha1.0`. Plugin/package version: `1.0.0`.

- Windows and Android sync for notes, attachments, canvases, and shared settings.
- Live server notifications with authenticated, one-use tickets, reconnect catch-up, and polling fallback.
- Manual sync through Ctrl+S on desktop, the ribbon button, or the Sync now command.
- Recoverable deletions, atomic renames, conflict copies, casing reconciliation, and cloud history restore.
- Batched state writes, cleared incoming-event echoes, empty conflict folder cleanup, and sync timing diagnostics.
- Desktop GitHub backups independent of sync.
- Automated coverage for the sync engine, filesystem races, manual mode, live channel, and Worker/SQLite/R2 backend.

### Current limitations

- A deployment supports one vault and one shared token; per-device access controls are not implemented.
- Files are readable by the backend; end-to-end encryption is not implemented.
- Android catches up while Obsidian is active and cannot sync while suspended or closed.
- Files are limited to 10 MiB; arbitrary empty folders are not journaled.
- Shared settings may require restarting Obsidian. Plugin code and device-specific settings remain local.
