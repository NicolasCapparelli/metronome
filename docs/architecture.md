# Architecture decision: Windows–Android first

Decision date: 2026-10-13. This repository began empty. The goal is a new personal Obsidian plugin with seconds-scale active sync, offline catch-up, low cloud cost, and preserved concurrent edits.

## Version 0.2 implementation update

The original preview below has been extended with protocol 2. Existing SQLite rows, R2 content, cursors, and vault identity are retained. Tombstones use an empty hash (which cannot be a SHA-256 content digest), keeping all prior content revisions readable. File renames can atomically publish the destination and tombstone the source, with ancestry checks on both paths and idempotent retry acknowledgements. An older client receives HTTP 426 rather than interpreting the new data incorrectly.

Files now include attachments and canvases; binary contents use base64 transport with a decoded 10 MiB limit. Markdown and other supported text formats retain their original text representation, preserving existing hashes. Shared settings are explicitly scoped to core JSON, themes, snippets, and other plugins' data.json; Metronome's credentials/state, workspaces, plugin code, caches, trash, and Git data are excluded. Hidden settings are inventoried through the adapter because vault events do not cover them.

Text writes use Obsidian's atomic process API. Deletions and binary replacements move the actual file into local recovery first, check the captured bytes, and restore the file if a racing edit changes the expected content. Conflicting edits survive as synced copies. Large outgoing deletion batches pause for in-app review. The cloud history command restores prior content as a new revision while preserving a differing current local version.

The remaining milestones are encryption and individual device access, retention management, push notifications, and broader physical-device validation. Android still needs the app active to sync. File contents and filenames remain readable by the personal backend.

## Alternatives evaluated

| Approach | Fit | Complexity and maintenance |
| --- | --- | --- |
| R2 alone | Cheap offline rendezvous, but file listing and object writes do not constitute a transactional multi-device protocol | Moderate client complexity; unsafe without explicit concurrency control |
| Worker + SQLite Durable Object + R2 | Recommended for Metronome: cloud rendezvous plus an authoritative ordered journal and atomic ancestry checks | Moderate implementation; low server maintenance; Cloudflare account setup required |
| Self-hosted LiveSync + CouchDB | Strongest mature alternative if the goal is simply to obtain sync now; already has conflicts, encryption, and mobile support | Mature implementation; an always-available server and secure hosting need maintenance |
| Remotely Save + R2 | Existing mobile and S3-compatible cloud support; simplest R2 route without building a plugin | Existing settings and sync algorithm; current README distinguishes basic conflict options from paid merge/duplicate options |
| Syncthing Android fork / direct peers | Useful for folder sync and avoids a cloud note store | Peer availability, Android service lifecycle, permissions, and relay discovery; less suitable for asynchronous device use |
| WebRTC plugin | Fast when peers connect; LiveSync already provides a P2P option | Signaling/TURN and simultaneous availability complicate the first release |

For a user who only needs working sync, adopt LiveSync rather than writing a new protocol. For the stated goal of building Metronome, choose the coordinated cloud approach and keep the first implementation small. We did not copy or fork code from these projects; the review covered their published architecture, capabilities, and algorithm documentation, not a full source audit. Forking an entire mature plugin would bring a wider UI, dependency, and protocol surface than this focused first release.

## Protocol implemented in the preview

1. The client persists a server identity, an incremental journal cursor, cached latest revisions, per-file acknowledged content hashes, and a pending-path queue.
2. Local vault events increment pending generations and persist them. One inventory at startup queues current Markdown files and previously acknowledged paths, recovering edits made while inactive.
3. `GET /changes?cursor=N` reads an indexed, ordered journal in pages of 100. The queue and cached revisions are saved with the cursor before local application. Crash recovery replays pending paths rather than skipping downloaded changes.
4. `GET /content?revision=N` reads the immutable bytes of that revision. SHA-256 verification precedes application.
5. `POST /commit` carries a path, an expected base revision, and content. The backend uploads immutable R2 bytes, then atomically rechecks the base and updates the SQLite head and journal. A competing commit gets HTTP 409 and retries after pulling. Returning an existing head with identical bytes makes lost-response retries harmless. Old bytes remain available by revision.
6. A client compares local and remote content against the last acknowledged hash. Only local changes upload; only remote changes download. Identical edits converge without a conflict. Concurrent differing edits preserve local bytes in a deterministic conflict file, then apply the remote canonical revision. Copies are synced on a subsequent pass.
7. Incoming writes use Obsidian `Vault.process` to compare current bytes and replace within one operation. If the user edits while a download is in flight, the write does not replace those bytes. Local generation counters preserve edits made during an upload.
8. Network errors back off up to 60 seconds. Visibility and network-resume events request catch-up. The interval polls only while the document is visible.

Polling is the first transport; WebSocket hibernation notifications can later wake this same pull protocol. Polling is more straightforward to validate across mobile suspension and reconnect. Expected active receive latency is approximately one poll interval plus transfers, but this has not yet been measured on physical devices.

The deployment is single-user, one vault. HTTPS and a random bearer secret protect access; the Worker owns all R2 access. End-to-end encryption and per-device revocation are separate milestones. A shared secret is adequate for a private development deployment, not a hosted multi-user product. Free-tier limits bound service availability but are not a comprehensive abuse-control system.

## Cost estimate, verified against current documentation

- R2 **Standard**: 10 GB-month, 1 million Class A operations, 10 million Class B operations monthly included; no egress fee. Excess storage costs $0.015/GB-month and operation overages also apply. Infrequent Access has a different model and no corresponding free tier.
- Workers Free: 100,000 requests/day and 10 ms CPU per invocation.
- SQLite Durable Objects Free: 100,000 requests/day, 13,000 GB-s/day, 5 million rows read/day, 100,000 rows written/day, 5 GB stored. Exceeding a free limit causes relevant operations to fail until reset. SQLite-backed objects are available on the Free plan.
- Two devices polling every five seconds for eight hours/day produce about 11,520 poll requests/day, before note reads and commits. Even 24-hour polling by both is 34,560 polls/day. R2 is not read on empty polls. SQL journal reads use the revision primary-key index.

Expected cost for modest personal use: $0/month within included usage. Retained revisions and abandoned uploads accumulate; there is no cleanup or storage budget enforcement yet. Large startup imports, repeated conflicts, other Workers on the account, or abuse can change the estimate. Physical-device performance and deployed CPU consumption need measurement before a production claim.

## Safety boundaries and milestones

1. **Current preview:** Markdown creates/edits, server CAS, offline queue, conflict copies, durable journal, integrity checks, portable-path validation, settings/status, emulator tests, and installation guide.
2. **Next: physical Windows/Android validation:** run the README checklist across separate networks, measure latency/battery impact, verify actual mobile API behavior, and inject suspension/restart faults. Keep preview vaults isolated from existing sync.
3. **Deletion and rename safety:** add tombstone revisions and recoverable local application, explicit bulk-delete thresholds, atomic rename semantics or tracked move pairs, and edit-versus-delete conflict tests. A missing local mount must never become mass deletion permission. The preview reports missing acknowledged files and leaves cloud data intact.
4. **Attachments:** binary blobs, streaming limits, size budgets, resumable uploads if necessary, and conflict preservation for arbitrary vault assets.
5. **Privacy and recovery:** end-to-end encryption with a reviewed key design, individual device credentials/revocation, revision restore UI, retained-history policy, safe blob garbage collection, and pairing UX.
6. **Polish:** hibernating WebSocket notifications, onboarding improvements, release packaging, and broader device tests.

## Sources

- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [SQLite Durable Object storage and transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Obsidian mobile development: no Node.js/Electron APIs](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development)
- [Obsidian requestUrl](https://docs.obsidian.md/Reference/TypeScript%20API/requestUrl)
- [Obsidian startup event timing](https://docs.obsidian.md/plugins/guides/load-time)
- [Obsidian TypeScript API, including Vault.process](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)
- [LiveSync P2P setup](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/setup_p2p.md)
- [Remotely Save capabilities and conflict options](https://github.com/remotely-save/remotely-save)
- [Remotely Save v3 algorithm overview](https://github.com/remotely-save/remotely-save/blob/master/docs/sync_algorithm/v3/intro.md)
- [Syncthing Android fork](https://github.com/cmwen/syncthing-android-fork)
