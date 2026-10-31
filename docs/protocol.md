# CodeRelay protocol v1

This is the contract between the gateway and the MiniMax desktop plugin. The gateway is single-owner; each device has its own revocable credential. All timestamps are Unix milliseconds. All JSON responses use UTF-8. Errors are `{ "error": { "code": "...", "message": "..." } }`. JSON bodies are bounded. Production connections require HTTPS. The plugin never sends MiniMax login credentials.

## Provisioning and identity

- `POST /v1/admin/pairing-codes` with the administrator bearer and `{ "name": "My device" }` returns `{code, expiresAt}`. Codes are one-use and expire after 5 minutes.
- `POST /v1/devices/pair` (no bearer) with `{code, name, version}` returns `{device, token, leaseSeconds:90}`. The plugin stores the device token only in its private Node data directory, never in the browser page or logs. A lost redemption response requires a new code; never guess the outcome.
- All `/v1/worker/*` endpoints require the device token as `Authorization: Bearer ...`.
- `POST /v1/worker/projects` with `{projectId?, name, sessionId, workspaceDir, workspaceKey, model?}` returns `{project}`. `workspaceKey` is SHA-256 of the canonical real path, lowercased on Windows. The session is created by the Mini App page inside the intended project; the plugin verifies its own session with `agent.session`. Default/plugin directories must be rejected. Editing a binding with active or unknown work is rejected.
- `GET /v1/worker/projects` returns `{projects}` for this device only. `POST /v1/worker/heartbeat` with `{}` updates device presence.
- `GET /v1/worker/tasks/:id` returns `{task}` only for this device. It never exposes the lease token. Use it to reconcile a lost completion receipt or observe an administrator's reconciliation, never to restart an uncertain task.

## Task execution

- `POST /v1/worker/claim` with `{}` returns `{assignment:null|{task,project,leaseToken},leaseSeconds:90,pollAfterMs:2000}`. The first version runs at most one task per device. A workspace (not merely a project name) is exclusively held by running, waiting, cancelling, and unknown tasks. Claiming is transactional.
- The adapter must durably record assignment ID and leaseToken **before** starting the Agent. `task` includes `prompt`, `acceptanceCriteria`, `runVerification`, and the bound `sessionId`.
- `POST /v1/worker/tasks/:id/heartbeat` with `{leaseToken}` returns `{leaseExpiresAt,commands}`. Call every 15 seconds, including while an approval/question is waiting. Each command has `{id, taskId, kind, payload, status, requestKey, createdAt, updatedAt, message}`. Pending commands are redelivered until acknowledged. If heartbeat cannot be confirmed before the lease expires, the adapter requests cancellation and records an unknown outcome; the gateway never silently reassigns the task.
- `POST /v1/worker/tasks/:id/events` with `{leaseToken,events:[{sequence,type,time?,payload}]}` returns `{acknowledgedSequence}`. Sequence starts at 1, is contiguous, and is durable at the sender. Exact duplicate events are accepted; sequence reuse with different content is rejected. Send at most 100 events or 128 KiB in a batch. Event type must be preserved, including child-session IDs in approvals. Use `permission.requested`, `question.requested`, `turn.started`, `turn.finished`, `tool.started`, `tool.finished`, `text.delta`, `model.selected`, `verification.started`, and `verification.finished` where appropriate. A host `turn.finished` alone is not task completion.
- `POST /v1/worker/tasks/:id/complete` with `{leaseToken,outcome,result,error?}` returns `{task}`. Outcomes: `succeeded`, `failed`, `cancelled`, `unknown`. `succeeded` means the Agent workflow finished, not automatically that tests passed. `result` contains `summary`, `model`, `sessionId`, `evidence`, `verification`, and `verificationLimitations` where available. Maximum JSON result size is 512 KiB. Git evidence is collected independently of the model. No test exit code may be invented. Verification runs only commands configured locally by the owner, using argv and shell:false. No shell command from MCP arguments is executed by the bridge itself.
- A server restart preserves leases. Lease expiry after assignment becomes `unknown`, never `queued`. Late completion from the original matching lease is allowed while the task is still unknown and unreconciled. An explicit administrator reconciliation closes an unknown task only after checking the actual device/process/workspace. The plugin never automatically resumes/reexecutes an uncertain run after restart.

## Commands and interaction

- `cancel` payload `{}`: abort the current call using its AbortController. An acknowledgement is not proof that execution stopped; complete with cancelled only after the host confirms, otherwise unknown.
- `steer` payload `{text}`: call `agent.run({sessionId,text,whenBusy:'steer'},...)`. Never automatically queue a second execution after an unknown response. Serialize completion against in-flight steering calls.
- `reply` payload `{sessionId,requestId,decision:'allowOnce'|'deny'}`: respond only to a matching pending permission event. Preserve delegated child-session IDs. Only explicit owner decisions may allow tools.
- `answer` payload `{sessionId,requestId,answers:[{stepId,selectedOptionIds,selectedOther,otherText?,skipped?}]}`: respond to the matching paused questionnaire only after the original `run` resolves with pendingQuestion. Continue observing its new turn. The gateway checks that the request is pending and belongs to this task.
- `POST /v1/worker/tasks/:id/commands/:commandId/ack` with `{leaseToken,status:'applied'|'rejected'|'unknown',message?}` returns `{command}`. The adapter journals a command before executing it. After a crash, a previously-started non-idempotent command is unknown, not automatically replayed. Applied/rejected command receipts are replayable.
- Owner decisions made in the local Mini App UI are journaled locally before calling the host. On confirmed success they produce `permission.resolved` or `question.answered` events with `{sessionId,requestId,decision?}`. These settle the interaction and reject stale remote decisions. Unknown local decisions must never be reported as confirmed.

## Client and administrator routes

OAuth bearer scopes: `tasks:read`, `tasks:write`. OAuth tokens cannot access administrator/device endpoints. Device tokens cannot access client or administrator endpoints.

- `GET /v1/projects` and `GET /v1/devices`: read-only inventories (no credentials).
- `POST /v1/tasks` with `{projectId,requestKey,prompt,acceptanceCriteria?,runVerification?,parentTaskId?}` creates a task. Request keys are scoped to the authenticated principal; an identical retry returns the existing task; changed input is a conflict. A continuation identifies a terminal parent from the same project; unknown parents cannot be continued.
- `GET /v1/tasks?limit=...&before=...`, `GET /v1/tasks/:id`, `GET /v1/tasks/:id/events?after=0&limit=100` and `GET /v1/tasks/:id/commands` return `{tasks}`, `{task}`, `{events,nextSequence}`, `{commands}`.
- Task list pages contain bounded prompt/criteria previews and `hasResult`, not the full prompt or result. `nextBefore` is a task ID cursor. Read the individual task for full details; MCP result tools additionally support lossless bounded chunks and a SHA-256 snapshot guard.
- `POST /v1/tasks/:id/cancel` with `{requestKey}` requests cancellation.
- `POST /v1/tasks/:id/commands` with `{requestKey,kind,payload}` enqueues an interaction; responses never expose a lease token.
- `POST /v1/admin/tasks/:id/reconcile` with `{outcome:'succeeded'|'failed'|'cancelled',reason,result?}` resolves a checked unknown task. Store the reason in the audit log.
- `POST /v1/admin/devices/:id/revoke` revokes the credential and marks uncertain active work unknown.
- `GET /v1/admin/audit?after=0&limit=100` returns bounded audit records.
- `POST /v1/admin/connector-codes` with `{}` creates a one-use OAuth consent code.
- `POST /v1/admin/access-tokens` with `{scopes:['tasks:read','tasks:write'],name}` creates a scoped CLI token. Display it once. Never put tokens in URL query strings.
- `POST /v1/admin/access-tokens/revoke` with `{token}` revokes that CLI credential or the OAuth token's entire family. Administrative authorization is required. `GET /v1/admin/status` provides safe device/project/task inventory without credentials or full results.

## MCP

`POST /mcp` exposes normal MCP tools for broad client compatibility. Tools: `list_projects`, `list_devices`, `submit_task`, `get_task`, `list_tasks`, `get_events`, `get_result`, `continue_task`, `cancel_task`, `steer_task`, `reply_permission`, `answer_question`. All mutations require `tasks:write`; reads require `tasks:read`. Server-enforced interaction checks apply even if a model ignores tool descriptions. An approval tool is not advertised as read-only. Missing support for native MCP Tasks does not stop the submit/poll/result workflow.

## Operational limits

One gateway process, a local SQLite volume, and one owner per deployment. Do not put SQLite on NFS. Size/retention limits, device revocation, active-job workspace exclusion, and authentication are enforced by the gateway; the MiniMax host remains responsible for its Agent tool permissions. Closing the Mini App or the desktop host interrupts work. No claim of OS sandboxing or exactly-once external side effects is made.
