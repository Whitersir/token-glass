# Contributing to Token Glass

Bug reports, documentation fixes, parser fixtures, accessibility improvements, and small focused pull requests are welcome. For a new data source or a change in counting rules, open an issue first so the format and measurement boundary can be agreed on.

## Development

Use Node.js 20+ for the dependency-free JavaScript service. The native widget requires Windows x64 and the system .NET Framework compiler.

```powershell
node --test
powershell -NoProfile -ExecutionPolicy Bypass -File build-widget.ps1 -Test
```

CI skips GPU initialization on headless runners. Check the actual glass appearance, dragging, folding, display scaling, and hide/reopen behavior on an interactive Windows desktop before changing rendering code.

## Pull requests

- Explain the concrete problem and resulting behavior.
- Include relevant tests for parsing, deduplication, persistence, or protocol changes.
- Preserve existing user configuration and stored statistics.
- Keep browser text estimates visibly distinct from usage reported in logs.
- Use synthetic, minimal fixtures. Remove prompts, replies, account details, credentials, project paths, and real session identifiers.
- Never commit `data/`, `backup/`, `config.json`, `node-path.txt`, or `browser-extension/connection.js`.

By contributing, you agree that your contribution is licensed under the project's MIT license.
