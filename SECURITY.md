# Security and privacy

Do not open a public issue containing credentials, connection keys, chat transcripts, or personal usage files.

Report a suspected vulnerability through [GitHub private vulnerability reporting](https://github.com/Whitersir/token-glass/security/advisories/new) if it is enabled. If it is unavailable, open an issue containing only a request for a private reporting channel; leave the vulnerability details out of that issue.

## Data boundaries

- The Node service binds to `127.0.0.1` only.
- Browser ingress requires a per-installation key and an extension origin. Other API routes retain same-origin restrictions.
- The browser extension counts message text in memory and sends counters and hashed identifiers to the local service.
- Usage files contain metadata such as models, timestamps, local paths and session identifiers. They should remain private even though they do not contain message bodies.
- Never publish `browser-extension/connection.js`, `data/browser-bridge.key`, `data/usage.json`, personal `config.json`, or exported personal CSV files.

To rotate a leaked local bridge key, stop the widget, remove only `data/browser-bridge.key`, run `node src/prepare-browser-extension.js`, restart the widget, and reload the Chrome extension. Do not remove `data/usage.json` unless you intend to reset stored statistics.
