# CodeRelay for MiniMax Code

Connect a local project in the already signed-in MiniMax Code desktop application to a CodeRelay gateway. ChatGPT, Claude, or another authorized MCP client submits a task; this plugin runs the task through the **real desktop Host Agent API**. It does not extract MiniMax credentials, attach to arbitrary existing conversations, emulate the Agent, or expose the Host's private port.

The application UI is Chinese. Source and runtime files are self-contained; no `npm install` or build is needed on the device.

## Requirements and tested environment

- **MiniMax Code 3.1.6 or later**, macOS or Windows, signed in with an available model and quota.
- A running CodeRelay v1 gateway and a one-use device pairing code issued by its administrator.
- The intended repository open in a **local project conversation**, not a cloud, SSH, or Remote Control conversation.
- The checked-in tests exercise the official Host contract using an explicitly simulated Host and actual local subprocesses. **A live signed-in MiniMax desktop end-to-end run has not been performed in this repository's automated CI.** Passing contract tests does not establish live account, subscription, model, operating-system, or desktop compatibility.

The manifests follow MiniMax's official package contract verified against 3.1.6. Runtime feature checks still reject missing Host methods and disabled permissions.

## Install

Copy the entire `minimax-coderelay` directory, including the hidden `.minimax-plugin` directory, into your actual MiniMax data directory's `plugins` folder. Default locations:

- macOS: `~/.minimax/plugins/minimax-coderelay/`
- Windows: `%USERPROFILE%\.minimax\plugins\minimax-coderelay\`

The resulting manifest must be `<dataDir>/plugins/minimax-coderelay/.minimax-plugin/plugin.json`. Use the configured MiniMax data directory if it differs from the default. Do not add another author or repository directory level. MiniMax's GitHub import is not the installation mechanism for these Mini App packages.

Restart MiniMax Code, enable CodeRelay, open the intended project, and ask it to open **CodeRelay** or select the installed Mini App. The page needs the Host-provided `window.mcode.miniapp` API and cannot operate in an ordinary browser.

Alternatively, hand the complete package directory or release ZIP to the MiniMax desktop Agent and ask it to install the Mini App through its official `miniapp` package workflow. Do not run a package directly to work around an installation error.

## Connect and bind a project

1. In CodeRelay, enter the gateway HTTPS URL, device name, and one-use pairing code. Pairing code redemption is never automatically retried after a lost response; obtain a fresh code if its outcome is unknown.
2. Inside the intended local project conversation, enter a project name and choose **绑定当前项目**. The page calls `agent.create()` once. Node then reads only that newly owned session with `agent.session(id)`, rejects a default/plugin workspace, resolves its real path, and registers its SHA-256 workspace identity. Windows path hashing is case-folded.
3. Optionally configure **本地验证命令**. These commands are stored locally by the owner and are never taken from a remote task's command string.
4. Choose **开始接单**. Keep the computer awake, MiniMax Code running, and the Mini App service open. A project can be inspected with **打开工作会话**.
5. Connect ChatGPT or Claude to the gateway and use the registered project ID to submit work. Results distinguish the Agent summary, independent Git evidence, and actual verification process results.

The original conversation is not taken over. The dedicated session inherits its project and model at creation. The bridge does not silently change the account or select another provider if that model becomes unavailable. Actual `turn.started` models are recorded.

**暂停接单** stops new claims while active work and heartbeats continue. A plugin restart starts paused. If a task was in progress, its result becomes unknown and is never automatically rerun. Verify the actual device/session/worktree, use the gateway administrator's reconciliation action, then choose **检查管理员处理结果**. If cancellation happened during a paused questionnaire, create a new project binding before further work.

## Approvals and questionnaires

The page shows each Host permission request, including requests raised by child Agent sessions. **仅允许本次** and **拒绝** call the official `agent.reply` with the exact session/request IDs. There is no automatic allow policy or global permission rewrite.

Questionnaires display every official step, preserve drafts across refreshes, and allow free text only when the step permits it. An explicit skip is supported. A pending approval locks both decision buttons, and a pending answer cannot be submitted again. `agent.answer` is invoked only after the original `run` resolved with `pendingQuestion`. Remote MCP approvals and answers are checked against the same pending requests. A Host response of `AGENT_OUTCOME_UNKNOWN`, loss of lease, or an unconfirmed cancellation blocks automatic replay.

The Host sidebar can also show these owned sessions and their approval cards. A caller's acknowledgement of a cancellation request is not evidence that execution stopped.

## Independent verification

Example local configuration:

```json
[
  { "name": "Node tests", "file": "node", "args": ["--test"], "timeoutMs": 120000 },
  { "name": "Python tests", "file": "python", "args": ["-m", "pytest", "-q"], "timeoutMs": 120000 }
]
```

Commands execute in the bound project with `spawn(file, args, {shell:false})`. Use direct executable paths where necessary. On Windows, `.cmd` files such as `npm.cmd` cannot be launched as executables with `shell:false`; configure `node.exe` plus the actual `npm-cli.js` path, or use a direct test executable. Shell interpreters are only used if the owner explicitly configures one locally. Remote task text never becomes bridge subprocess arguments.

Each check records the real exit code, termination signal, bounded stdout/stderr, truncation, timeout and cancellation flags. A nonzero/unknown exit code or timeout fails the task's verification. Git evidence is collected independently with `rev-parse`, `status`, unstaged diff and staged diff; external diff/text-conversion drivers and fsmonitor are disabled. Untracked contents and ignored files are not included in diffs. This is evidence of the observed worktree, not proof that the Agent followed every instruction.

Process termination requests apply to a POSIX child process group; Windows uses `taskkill.exe /PID <observed-child-pid> /T /F`. Owner-configured tools can launch detached processes outside that group. Do not interpret cancellation as an operating-system sandbox or an absolute guarantee about detached descendants.

## Data & access

- Declares only **`session.run`**. It creates and continues this plugin's own Agent sessions, reads their project/model status, and relays their events. It does not enumerate or read unrelated user conversations.
- Agent turns can read/write project files, run shell commands and use installed Skills/MCP tools under MiniMax's permission policy. Project binding does not create an OS-level sandbox.
- Node stores gateway device credentials, project bindings, local verification definitions, task/command receipts, outstanding event sequences and bounded recent results in `context.dataDir/coderelay-state.json`. Writes are serialized, atomic, fsynced where supported, and request mode `0600`; the directory requests `0700`. On Windows, access is additionally determined by the account's inherited filesystem ACLs.
- The long-lived device token stays in Node. It is not sent to the page, embedded in assets, placed in browser storage, or logged. One-use pairing input is cleared after submission. MiniMax's own account credentials are neither read nor exported.
- **Bridge HTTP traffic:** only the explicitly configured CodeRelay gateway URL, via HTTPS (loopback HTTP is supported for local development). No CDN, analytics or third-party page resources are loaded. MiniMax itself makes its normal model/tool network calls; owner-configured verification programs may also make their own network requests.
- Task prompts, assigned project path/session identifiers, Agent progress/approval data, final replies, bounded Git diffs and configured verification output are returned to the owner's gateway. Common token patterns and the gateway device token are redacted, but redaction is not a complete secrets scanner; keep secrets out of project changes and command output.
- Node spawns only `git` for evidence, owner-configured verification executables, and Windows `taskkill.exe` for controlled cancellation. The Agent may run additional commands through its own Host tools.
- Gateway URLs are never generic proxy targets. Only the fixed CodeRelay v1 paths are called. The local HTTP port uses MiniMax's per-run guard; the plugin does not access or forward Host authentication headers.

## Durability and limits

Assignments and command receipts are written before dispatch. After a process crash, a started command is unknown and is not replayed. Confirmed receipts and exact sequence-numbered event batches can be retransmitted. The gateway's lease token is not exposed to the page. Lease expiry requests Host cancellation and records an unknown result; another task is not started while uncertainty remains.

One task per device is active. Remote steering is awaited along with the original task, including the case where steering becomes another turn. At most 100 events / 128 KiB are sent per batch. The local outbox is capped; failure to persist/forward events stops further execution as an unknown outcome instead of losing evidence silently. Result and command output sizes are bounded. This does not promise exactly-once effects in external services.

The current UI exposes the newest 50 tasks; local journals are retained until deliberately archived by the owner. Keep this small personal gateway under normal backup and retention management. Do not delete the journal while a task or unknown outcome exists.

## Update or uninstall

Pause new work, wait for active tasks to settle and reconcile unknown outcomes. Close the Mini App and exit MiniMax Code before replacing the complete installed plugin directory. Keep backups outside the `plugins/` discovery folder. Runtime state lives in the Host-provided `dataDir`, separate from package files; preserve it when updating. Revoking the device on the gateway prevents further access. Remove the installed plugin directory only after work is settled; separately stored state is not automatically erased.

## Development and validation

```sh
node --test plugins/minimax-coderelay/test/*.test.mjs
```

Tests cover real journal persistence, duplicate assignment/command delivery, exact event replay, child approvals, questionnaire timing, cancellation acknowledgement versus confirmation, lease loss, crash recovery, steering completion, and actual argv subprocess exit codes. Test Host responses are explicitly fixtures; production has no simulated Agent fallback.

From the complete CodeRelay repository, after installing its dependencies, also run:

```sh
node --import tsx --test tests/bridge.integration.test.ts
```

This integration suite uses a real loopback HTTP gateway, SQLite, the production device adapter, a temporary Git repository and real verification subprocesses. It checks pairing through final evidence, remote child-session approval and questionnaire receipts, confirmed cancellation, and unknown work across plugin restart and administrator reconciliation. Only the MiniMax Host boundary is synthetic. The test process needs permission to listen on loopback and spawn local executables.

The root repository also runs `tests/ui.test.ts` against the actual page JavaScript using the development-only LinkeDOM dependency. It checks pairing, binding, pending-action locks, approval/session identifiers, questionnaire choices and drafts, unknown outcomes, reconciliation and text-safe rendering. LinkeDOM does not render pixels or implement native focus/radio behavior; the test harness explicitly provides those limited event shims. Narrow-window CSS rules are checked, but **1200 × 800 and 520 × 900 browser screenshots have not been verified**: the environment's official Chromium download returned a “Site Unavailable” HTML page instead of a browser archive. No browser fallback or real account was used. The isolated-package test copies the complete plugin to a temporary directory, imports its declared entry and serves its page/API without `npm install` or root repository dependencies.

For final live acceptance, install the release in a signed-in MiniMax desktop, pair to a test gateway, bind a disposable repository, submit a small actual edit, request approval, verify a local command and inspect the real diff/exit code. Then test pause, cancellation, plugin restart, duplicate delivery and lease interruption. Record the desktop version, OS, provider and observed evidence without exporting credentials. Until this is done, live compatibility remains unverified.

## Official contracts

- [Mini App package contract](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/blob/main/docs/package-contract.md)
- [Node runtime](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/blob/main/docs/runtime.md)
- [Agent API](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/blob/main/docs/agent.md)
- [Page APIs](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/blob/main/docs/client.md)
- [Security boundary](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/blob/main/docs/security.md)

The implementation follows these public contracts without importing MiniMax internal transports or reading its runtime databases. Official TypeScript declarations were consulted; no Host implementation or account data is included.
