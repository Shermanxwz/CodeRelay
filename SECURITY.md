# Security and trust boundaries

CodeRelay is a **single-owner gateway for a trusted development device**. Its remote MCP endpoint can cause that device's MiniMax Agent to edit files and use its authorized tools. Use separate deployments for unrelated owners. A project binding is not an OS sandbox.

## Credentials and permissions

- Device pairing codes and OAuth owner consent codes are single-use and expire in five minutes.
- Device, lease, access, refresh and consent secrets are stored as hashes in gateway databases. The local plugin must keep its usable device credential in its private journal; it never returns that token to its page.
- Administrators, devices and client tokens have distinct authentication paths. OAuth scopes are checked on each operation. Long-lived CLI tokens and devices can be revoked.
- OAuth uses public clients, exact redirect matching, S256 PKCE, CSRF cookie/form binding, resource/audience binding, single-use codes and refresh-family replay detection.
- The MiniMax plugin declares only `session.run`. It calls official Host APIs and never reads MiniMax login tokens or internal databases.
- Never expose MiniMax's guarded local port as the remote MCP endpoint. The plugin initiates requests to its explicitly configured gateway.

## Execution and evidence

Stable request keys and durable receipts limit duplicate dispatch. They cannot guarantee exactly-once external effects across process/network failures. Uncertain execution becomes `unknown` and holds the device/workspace lock until observed completion or explicit owner reconciliation.

Prompts, repository contents, Agent output and test output are untrusted data. A malicious repository can influence an Agent or an owner-configured test command. Keep MiniMax's tool permissions active, configure allowed projects deliberately, and make permission/plan decisions based on the actual request. The gateway validates interaction identifiers and options; it cannot independently prove that a remote client represented a human's decision truthfully. Client permissions and the owner's authorization remain part of the boundary.

Independent verification commands are configured on the device, not accepted as arbitrary executable strings from MCP. They run as the user's account, with `shell:false`. Spawned commands and the Host can still perform actions allowed by that account. POSIX process groups and Windows taskkill aid cancellation; detached descendants require separate inspection.

Git evidence does not include the contents of untracked or ignored files. Redaction is best effort, not a complete secret scanner. Do not place credentials into source changes, test output, task prompts or audit notes.

## Deployment

Use HTTPS, an origin without a subpath, a local private SQLite volume and protected state directories. The default listener is loopback. Container deployment uses a non-root gateway and a private volume behind a TLS proxy. Public MCP access is authenticated; health checks disclose only basic service readiness. Configure reverse-proxy logs to exclude request bodies and Authorization headers.

Keep operating system, Node, MiniMax Code, base images and dependencies updated. Re-run the CI and live acceptance process after changes. Public standard CI does not remove GitHub API, storage or other service limits.

## Reporting

Do not post tokens, private source, full database files or active task payloads in public issues. For a non-sensitive reproducible defect, open an issue with version, environment, minimal reproduction and redacted evidence. For a sensitive vulnerability, use GitHub's private vulnerability reporting if enabled; otherwise contact the repository owner privately before disclosing details. This repository does not assert that private reporting is enabled until its repository setting is verified.
