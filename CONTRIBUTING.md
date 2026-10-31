# Contributing

Use Node 24 or 26. Install with `npm ci`, then run `npm run check`. Run `npm run package` with Python 3 available to verify the exact release archives. Do not edit generated `dist/` or commit `.coderelay`, credentials, databases or test artifacts.

All protocol changes require updates to `docs/protocol.md`, both gateway and MiniMax adapter, and meaningful contract tests. Keep device and client credentials separate. Never turn an uncertain outcome into an automatic retry; preserve original request keys and event sequences on delivery retries.

Tests for device behavior must clearly identify synthetic MiniMax Host fixtures. Actual Git repositories, HTTP servers, databases and child processes can be used in temporary directories. A passing fixture does not establish live account or desktop compatibility.

Before reporting success, inspect exact changes, real command exit codes, the tested commit and remaining live acceptance boundaries. Keep model conclusions separate from independent evidence.
