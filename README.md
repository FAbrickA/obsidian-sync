# WebDAV Sync Lab

A focused Obsidian plugin for syncing notes, attachments, and bookmarks over WebDAV, designed around Mail.ru's WebDAV behavior.

- Free multi-version text merging and explicit conflict resolution.
- Durable operation recovery, retained version history, and recoverable local copies.
- Immutable, SHA-256-verified history that does not depend on conditional WebDAV writes.
- Automatic sync and a desktop shutdown drain that waits for accepted work.
- No Remotely Save account, subscription, telemetry, or end-to-end encryption. HTTPS protects the connection; the server can read your files.

**Preview:** Windows Obsidian 1.8.10 and Mail.ru were exercised during development. Physical Linux and Android validation is still pending. Android background completion is best effort; force-stop cannot be prevented.

## Install with BRAT

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's Community plugins catalog.
2. Open BRAT settings and choose **Add beta plugin**.
3. Enter `FAbrickA/obsidian-sync`, select release **0.2.1**, and install it.
4. Enable **WebDAV Sync Lab** in Community plugins and configure your WebDAV connection.

BRAT handles plugin file installation and subsequent updates. Check BRAT's own Obsidian version requirement; it can be higher than this plugin's minimum of 1.8.10. This plugin is not yet listed directly in the community catalog.

Start with a test vault and a separate empty WebDAV folder. Choose **create v2** on the first device and **attach v2** on the others. Do not use an active Remotely Save folder or run both plugins against the same destination. Passwords and plugin settings are not synced.

Manual fallback: download the plugin ZIP from [Releases](https://github.com/FAbrickA/obsidian-sync/releases) and extract it into `<vault>/.obsidian/plugins/webdav-sync-lab/`.

## Development

Use Node.js 24.18.0 and Python 3.12+:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:release
npm run package
```

Release assets are generated in `dist/`. The **Prepare installable release** GitHub Actions workflow creates a draft containing the standalone files required by Obsidian and BRAT. Review the draft before publishing it.

Apache-2.0. Bundled `node-diff3` is MIT licensed; full notices are included in the standalone bundle and release assets. The implementation is original code and does not include Remotely Save PRO source.
