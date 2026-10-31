import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { RelayError } from '../src/errors.js';
import { RelayStore } from '../src/store.js';
import type { Json, Project, WorkerEvent } from '../src/types.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function rejectsCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof RelayError && error.code === code);
}
function fixture(t: TestContext, leaseMs = 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'coderelay-store-'));
  const filename = join(dir, 'relay.sqlite');
  let now = 1_800_000_000_000;
  const stores: RelayStore[] = [];
  const open = () => {
    const store = new RelayStore({ filename, now: () => now, leaseMs });
    stores.push(store);
    return store;
  };
  const store = open();
  t.after(() => {
    for (const item of stores) item.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const pair = (name = 'test device') => {
    const { code } = store.createPairingCode(name);
    return store.pairDevice({ code, name, version: '0.1.0' });
  };
  const device = pair();
  const bind = (
    sessionId = 'session-project',
    workspaceDir = '/workspace/project',
    deviceId = device.device.id,
  ): Project =>
    store.upsertProject(deviceId, {
      name: 'Test project',
      sessionId,
      workspaceDir,
      workspaceKey: digest(workspaceDir),
    });
  const project = bind();
  let key = 0;
  const submit = (projectId = project.id, prompt = 'Fix the failing test.') =>
    store.submit('owner', {
      projectId,
      prompt,
      requestKey: `task-key-${++key}`,
      acceptanceCriteria: ['Run the configured tests.'],
    });
  const claim = () => {
    const assignment = store.claim(device.device.id);
    assert.ok(assignment);
    return assignment;
  };
  return {
    dir,
    filename,
    store,
    open,
    pair,
    bind,
    device,
    project,
    submit,
    claim,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
function permission(
  sequence = 1,
  sessionId = 'child-session',
  requestId = 'permission-1',
): WorkerEvent {
  return {
    sequence,
    type: 'permission.requested',
    payload: { sessionId, requestId, toolName: 'shell', reason: 'Run the test suite.' },
  };
}
function question(sequence = 1, expiresAt?: number): WorkerEvent {
  const request: Json = {
    schemaVersion: 2,
    steps: [
      {
        id: 'implementation',
        selectionMode: 'single',
        required: true,
        allowOther: true,
        options: [
          { id: 'small', label: 'Small fix' },
          { id: 'refactor', label: 'Refactor' },
        ],
      },
    ],
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
  return {
    sequence,
    type: 'question.requested',
    payload: { sessionId: 'session-project', requestId: 'question-1', request },
  };
}
function answerPayload(option = 'small'): Json {
  return {
    sessionId: 'session-project',
    requestId: 'question-1',
    answers: [{ stepId: 'implementation', selectedOptionIds: [option], selectedOther: false }],
  };
}

test('pairing is one-use, bounded in time, and keeps credentials out of returned inventories and audit', (t) => {
  const f = fixture(t);
  const { code } = f.store.createPairingCode('new desktop');
  const { token, device } = f.store.pairDevice({ code, name: 'new desktop', version: '3.1.6' });
  assert.equal(f.store.authenticateDevice(token)?.id, device.id);
  assert.equal(f.store.authenticateDevice('not-a-token'), null);
  rejectsCode(
    () => f.store.pairDevice({ code, name: 'again', version: '3.1.6' }),
    'INVALID_PAIRING_CODE',
  );
  const expired = f.store.createPairingCode('expires');
  f.advance(5 * 60_000);
  rejectsCode(
    () => f.store.pairDevice({ code: expired.code, name: 'expires', version: '3.1.6' }),
    'INVALID_PAIRING_CODE',
  );
  const visible = JSON.stringify({
    devices: f.store.devices(),
    projects: f.store.projects(),
    audit: f.store.audit(),
  });
  assert.ok(!visible.includes(token));
  assert.ok(!visible.includes(code));
  assert.ok(!visible.includes('token_hash'));
});

test('device and task lease tokens are hashed at rest', (t) => {
  const f = fixture(t);
  f.submit();
  const assignment = f.claim();
  const bytes = Buffer.concat(
    readdirSync(f.dir)
      .filter((name) => name.startsWith('relay.sqlite'))
      .map((name) => readFileSync(join(f.dir, name))),
  );
  assert.equal(bytes.includes(Buffer.from(f.device.token)), false);
  assert.equal(bytes.includes(Buffer.from(assignment.leaseToken)), false);
  assert.equal(bytes.includes(Buffer.from(digest(f.device.token))), true);
  if (process.platform !== 'win32') assert.equal(statSync(f.filename).mode & 0o777, 0o600);
});

test('a revoked device loses every worker capability and queued work is cancelled', (t) => {
  const f = fixture(t);
  const running = f.submit();
  const queued = f.submit();
  f.claim();
  f.store.revokeDevice(f.device.device.id);
  assert.equal(f.store.authenticateDevice(f.device.token), null);
  assert.equal(f.store.getTask(running.id).status, 'unknown');
  assert.equal(f.store.getTask(queued.id).status, 'cancelled');
  assert.equal(f.store.projects()[0]?.enabled, false);
  rejectsCode(() => f.store.claim(f.device.device.id), 'DEVICE_UNAUTHORIZED');
  rejectsCode(() => f.store.heartbeatDevice(f.device.device.id), 'DEVICE_UNAUTHORIZED');
  f.store.revokeDevice(f.device.device.id);
  assert.equal(f.store.audit().filter((item) => item.action === 'device.revoked').length, 1);
});

test('pairing attempt limits do not silently evict an existing valid code', (t) => {
  const f = fixture(t);
  const first = f.store.createPairingCode('first');
  for (let index = 1; index < 64; index++) f.store.createPairingCode(`device ${index}`);
  rejectsCode(() => f.store.createPairingCode('excess'), 'PAIRING_LIMIT');
  assert.ok(f.store.pairDevice({ code: first.code, name: 'first', version: '0.1' }).device.id);
});

test('project bindings are device-owned and enforce canonical path and hash formats', (t) => {
  const f = fixture(t);
  const other = f.pair('other');
  rejectsCode(
    () =>
      f.store.upsertProject(other.device.id, {
        projectId: f.project.id,
        name: 'stolen',
        sessionId: 's',
        workspaceDir: '/workspace/stolen',
        workspaceKey: digest('/workspace/stolen'),
      }),
    'PROJECT_NOT_FOUND',
  );
  rejectsCode(
    () =>
      f.store.upsertProject(f.device.device.id, {
        name: 'relative',
        sessionId: 'r',
        workspaceDir: './relative',
        workspaceKey: digest('./relative'),
      }),
    'INVALID_INPUT',
  );
  rejectsCode(
    () =>
      f.store.upsertProject(f.device.device.id, {
        name: 'bad hash',
        sessionId: 'r',
        workspaceDir: '/workspace/good',
        workspaceKey: 'bad',
      }),
    'INVALID_INPUT',
  );
  assert.ok(
    f.store.upsertProject(f.device.device.id, {
      name: 'Windows',
      sessionId: 'win',
      workspaceDir: 'C:\\Projects\\RDPsync',
      workspaceKey: digest('c:\\projects\\rdpsync'),
    }).id,
  );
  assert.deepEqual(f.store.projects(other.device.id), []);
});

test('identical project registration retries work while queued or active, but rebinding is rejected', (t) => {
  const f = fixture(t);
  f.submit();
  assert.equal(f.bind().id, f.project.id);
  const edit = () =>
    f.store.upsertProject(f.device.device.id, {
      projectId: f.project.id,
      name: 'Edited',
      sessionId: 'new-session',
      workspaceDir: '/workspace/new',
      workspaceKey: digest('/workspace/new'),
    });
  rejectsCode(edit, 'PROJECT_BUSY');
  f.claim();
  rejectsCode(edit, 'PROJECT_BUSY');
  f.advance(1000);
  f.store.sweep();
  rejectsCode(edit, 'PROJECT_BUSY');
});

test('duplicate project session ownership cannot be reassigned to another binding', (t) => {
  const f = fixture(t);
  const other = f.bind('second-session', '/workspace/second');
  rejectsCode(
    () =>
      f.store.upsertProject(f.device.device.id, {
        projectId: other.id,
        name: 'replace',
        sessionId: f.project.sessionId,
        workspaceDir: other.workspaceDir,
        workspaceKey: other.workspaceKey,
      }),
    'SESSION_ALREADY_BOUND',
  );
});

test('task request keys are principal-scoped and changed input is a conflict', (t) => {
  const f = fixture(t);
  const input = {
    projectId: f.project.id,
    requestKey: 'idempotent-01',
    prompt: 'Implement feature.',
  };
  const first = f.store.submit('owner', input);
  assert.equal(
    f.store.submit('owner', { ...input, acceptanceCriteria: [], runVerification: true }).id,
    first.id,
  );
  rejectsCode(
    () => f.store.submit('owner', { ...input, prompt: 'Different feature.' }),
    'IDEMPOTENCY_CONFLICT',
  );
  assert.notEqual(f.store.submit('another-authorized-principal', input).id, first.id);
  assert.equal(f.store.audit().filter((item) => item.action === 'task.submitted').length, 2);
});

test('task validation rejects malformed requests and oversized JSON before writing', (t) => {
  const f = fixture(t);
  rejectsCode(
    () => f.store.submit('owner', { projectId: f.project.id, requestKey: 'short', prompt: 'x' }),
    'INVALID_INPUT',
  );
  rejectsCode(
    () =>
      f.store.submit('owner', { projectId: f.project.id, requestKey: 'valid-key', prompt: ' ' }),
    'INVALID_INPUT',
  );
  rejectsCode(
    () =>
      f.store.submit('owner', {
        projectId: f.project.id,
        requestKey: 'valid-key',
        prompt: 'x'.repeat(100001),
      }),
    'INVALID_INPUT',
  );
  assert.equal(f.store.listTasks().length, 0);
});

test('claim order is FIFO and one device cannot receive a second simultaneous task', (t) => {
  const f = fixture(t);
  const first = f.submit();
  const second = f.submit();
  const assignment = f.claim();
  assert.equal(assignment.task.id, first.id);
  assert.equal(f.store.claim(f.device.device.id), null);
  f.store.complete(f.device.device.id, first.id, assignment.leaseToken, {
    outcome: 'succeeded',
    result: { verification: 'not_run' },
  });
  assert.equal(f.claim().task.id, second.id);
});

test('separate SQLite connections cannot claim the same task or bypass the device lock', (t) => {
  const f = fixture(t);
  const peer = f.open();
  const first = f.submit();
  f.submit();
  const assignment = peer.claim(f.device.device.id);
  assert.ok(assignment);
  assert.equal(assignment.task.id, first.id);
  assert.equal(f.store.claim(f.device.device.id), null);
  assert.equal(peer.claim(f.device.device.id), null);
  assert.equal(f.store.getTask(first.id).status, 'running');
});

test('different physical workspace bindings cannot bypass unknown work exclusion', (t) => {
  const f = fixture(t);
  const alias = f.bind('second-session-same-path', f.project.workspaceDir);
  const first = f.submit();
  f.submit(alias.id);
  f.claim();
  f.advance(1000);
  assert.equal(f.store.getTask(first.id).status, 'unknown');
  assert.equal(f.store.claim(f.device.device.id), null);
  f.store.reconcile(first.id, {
    outcome: 'failed',
    reason: 'Checked device; the original process has exited.',
  });
  assert.equal(f.claim().task.projectId, alias.id);
});

test('a queued task on another authorized device can run independently', (t) => {
  const f = fixture(t);
  const second = f.pair('second');
  const project = f.bind('s2', '/workspace/second', second.device.id);
  f.submit();
  f.submit(project.id);
  assert.ok(f.store.claim(f.device.device.id));
  assert.ok(f.store.claim(second.device.id));
});

test('lease heartbeat extends ownership but an expired lease never resumes execution', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const assignment = f.claim();
  f.advance(900);
  const heartbeat = f.store.heartbeat(f.device.device.id, task.id, assignment.leaseToken);
  assert.equal(heartbeat.leaseExpiresAt, f.now() + 1000);
  f.advance(1000);
  rejectsCode(
    () => f.store.heartbeat(f.device.device.id, task.id, assignment.leaseToken),
    'LEASE_EXPIRED',
  );
  assert.equal(f.store.getTask(task.id).status, 'unknown');
  assert.equal(f.store.claim(f.device.device.id), null);
});

test('gateway restart preserves live leases and task receipts', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const assignment = f.claim();
  f.store.close();
  const reopened = f.open();
  assert.equal(reopened.getTask(task.id).status, 'running');
  assert.equal(reopened.authenticateDevice(f.device.token)?.id, f.device.device.id);
  assert.ok(reopened.heartbeat(f.device.device.id, task.id, assignment.leaseToken).leaseExpiresAt);
  assert.equal(reopened.claim(f.device.device.id), null);
});

test('lease identity and device ownership are checked independently', (t) => {
  const f = fixture(t);
  const other = f.pair('other');
  const task = f.submit();
  const assignment = f.claim();
  rejectsCode(
    () => f.store.heartbeat(other.device.id, task.id, assignment.leaseToken),
    'TASK_NOT_FOUND',
  );
  rejectsCode(
    () => f.store.heartbeat(f.device.device.id, task.id, 'crl_' + 'a'.repeat(43)),
    'INVALID_LEASE',
  );
  rejectsCode(
    () =>
      f.store.complete(other.device.id, task.id, assignment.leaseToken, {
        outcome: 'succeeded',
        result: {},
      }),
    'TASK_NOT_FOUND',
  );
});

test('events require contiguous sequence and a whole invalid batch rolls back', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  rejectsCode(
    () =>
      f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
        { sequence: 1, type: 'text.delta', payload: { text: 'one' } },
        { sequence: 3, type: 'text.delta', payload: { text: 'three' } },
      ]),
    'EVENT_GAP',
  );
  assert.equal(f.store.getTask(task.id).lastSequence, 0);
  assert.deepEqual(f.store.events(task.id), []);
  assert.equal(
    f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
      { sequence: 1, type: 'text.delta', payload: { text: 'one' } },
    ]),
    1,
  );
});

test('exact event retries are idempotent, altered reuse is rejected, and pagination is bounded', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  const event: WorkerEvent = {
    sequence: 1,
    type: 'text.delta',
    time: f.now(),
    payload: { a: 1, b: 2 },
  };
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [event]);
  assert.equal(
    f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
      { ...event, payload: { b: 2, a: 1 } },
    ]),
    1,
  );
  rejectsCode(
    () =>
      f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
        { ...event, payload: { a: 2 } },
      ]),
    'EVENT_CONFLICT',
  );
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
    { sequence: 2, type: 'tool.finished', payload: { name: 'read', ok: true } },
  ]);
  assert.equal(f.store.events(task.id, 1, 1)[0]?.sequence, 2);
  rejectsCode(() => f.store.events(task.id, -1), 'INVALID_INPUT');
  rejectsCode(() => f.store.events(task.id, 0, 101), 'INVALID_INPUT');
  assert.equal(f.store.getTask(task.id).status, 'running');
});

test('events are byte-bounded and host turn.finished does not claim task success', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  rejectsCode(
    () =>
      f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
        { sequence: 1, type: 'text.delta', payload: 'x'.repeat(130 * 1024) },
      ]),
    'PAYLOAD_TOO_LARGE',
  );
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
    { sequence: 1, type: 'turn.finished', payload: { status: 'finished' } },
  ]);
  assert.equal(f.store.getTask(task.id).status, 'running');
});

test('late result with the original lease resolves unknown work without reexecution', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.advance(1000);
  assert.equal(f.store.getTask(task.id).status, 'unknown');
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
    { sequence: 1, type: 'text.delta', payload: { text: 'late evidence' } },
  ]);
  const done = f.store.complete(f.device.device.id, task.id, a.leaseToken, {
    outcome: 'succeeded',
    result: { verification: 'not_run' },
  });
  assert.equal(done.status, 'succeeded');
  assert.equal(done.completedAt, f.now());
  assert.equal(f.store.audit().filter((item) => item.action === 'task.claimed').length, 1);
});

test('completion retries are idempotent and cannot overwrite a different terminal result', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  const result = {
    outcome: 'succeeded' as const,
    result: { summary: 'Done', verification: { status: 'not_run' } },
  };
  f.store.complete(f.device.device.id, task.id, a.leaseToken, result);
  assert.equal(f.store.complete(f.device.device.id, task.id, a.leaseToken, result).id, task.id);
  rejectsCode(
    () =>
      f.store.complete(f.device.device.id, task.id, a.leaseToken, {
        ...result,
        result: { summary: 'Different' },
      }),
    'COMPLETION_CONFLICT',
  );
  assert.equal(f.store.audit().filter((item) => item.action === 'task.completed').length, 1);
});

test('results are bounded, and an unknown completion preserves the workspace lock', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.submit();
  rejectsCode(
    () =>
      f.store.complete(f.device.device.id, task.id, a.leaseToken, {
        outcome: 'succeeded',
        result: 'x'.repeat(513 * 1024),
      }),
    'PAYLOAD_TOO_LARGE',
  );
  const uncertain = { outcome: 'unknown' as const, result: { reason: 'host disconnected' } };
  f.store.complete(f.device.device.id, task.id, a.leaseToken, uncertain);
  f.store.complete(f.device.device.id, task.id, a.leaseToken, uncertain);
  assert.equal(f.store.claim(f.device.device.id), null);
  assert.equal(f.store.getTask(task.id).completedAt, null);
});

test('owner reconciliation is explicit and blocks stale worker overwrite forever', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  rejectsCode(
    () => f.store.reconcile(task.id, { outcome: 'failed', reason: 'Verified device state.' }),
    'TASK_NOT_UNKNOWN',
  );
  f.advance(1000);
  f.store.sweep();
  rejectsCode(
    () => f.store.reconcile(task.id, { outcome: 'failed', reason: 'no' }),
    'INVALID_INPUT',
  );
  const reconciled = f.store.reconcile(task.id, {
    outcome: 'cancelled',
    reason: 'Checked processes and worktree; no live task remains.',
  });
  assert.equal(reconciled.status, 'cancelled');
  rejectsCode(
    () =>
      f.store.complete(f.device.device.id, task.id, a.leaseToken, {
        outcome: 'succeeded',
        result: {},
      }),
    'TASK_RECONCILED',
  );
  assert.match(
    String(
      f.store.audit().find((item) => item.action === 'task.reconciled')?.details &&
        JSON.stringify(f.store.audit()),
    ),
    /Checked processes/,
  );
});

test('queued cancellation is immediate and retried cancellation does not duplicate receipts', (t) => {
  const f = fixture(t);
  const task = f.submit();
  assert.equal(f.store.cancel('owner', task.id, 'cancel-queued-1').status, 'cancelled');
  assert.equal(f.store.cancel('owner', task.id, 'cancel-queued-1').status, 'cancelled');
  assert.equal(f.store.claim(f.device.device.id), null);
  assert.equal(f.store.commands(task.id).length, 1);
  assert.equal(f.store.commands(task.id)[0]?.status, 'applied');
});

test('cancellation acknowledgement never pretends the Agent has actually stopped', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  assert.equal(f.store.cancel('owner', task.id, 'cancel-running-1').status, 'cancel_requested');
  const cmd = f.store.heartbeat(f.device.device.id, task.id, a.leaseToken).commands[0];
  assert.ok(cmd);
  f.store.ackCommand(f.device.device.id, task.id, a.leaseToken, cmd.id, { status: 'applied' });
  assert.equal(f.store.getTask(task.id).status, 'cancel_requested');
  const done = f.store.complete(f.device.device.id, task.id, a.leaseToken, {
    outcome: 'cancelled',
    result: { confirmedByHost: true },
  });
  assert.equal(done.status, 'cancelled');
});

test('an unknown task cannot be continued or sent new commands before reconciliation', (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.claim();
  f.advance(1000);
  rejectsCode(() => f.store.cancel('owner', task.id, 'cancel-unknown-1'), 'OUTCOME_UNKNOWN');
  rejectsCode(
    () =>
      f.store.submit('owner', {
        projectId: f.project.id,
        requestKey: 'continue-unknown-1',
        prompt: 'Continue.',
        parentTaskId: task.id,
      }),
    'PARENT_NOT_TERMINAL',
  );
});

test('a confirmed task can be continued only in the same project and session', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.store.complete(f.device.device.id, task.id, a.leaseToken, { outcome: 'failed', result: {} });
  const other = f.bind('other', '/workspace/other');
  rejectsCode(
    () =>
      f.store.submit('owner', {
        projectId: other.id,
        requestKey: 'continue-wrong-project',
        prompt: 'Continue.',
        parentTaskId: task.id,
      }),
    'PARENT_PROJECT_MISMATCH',
  );
  assert.equal(
    f.store.submit('owner', {
      projectId: f.project.id,
      requestKey: 'continue-correct-project',
      prompt: 'Continue.',
      parentTaskId: task.id,
    }).parentTaskId,
    task.id,
  );
});

test('permission replies require the actual pending child session and request IDs', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [permission()]);
  assert.equal(f.store.getTask(task.id).status, 'waiting_input');
  rejectsCode(
    () =>
      f.store.enqueueCommand('owner', task.id, {
        requestKey: 'fake-approval-key',
        kind: 'reply',
        payload: { sessionId: task.sessionId, requestId: 'permission-1', decision: 'allowOnce' },
      }),
    'INTERACTION_NOT_PENDING',
  );
  const input = {
    requestKey: 'actual-approval-key',
    kind: 'reply' as const,
    payload: { sessionId: 'child-session', requestId: 'permission-1', decision: 'allowOnce' },
  };
  const command = f.store.enqueueCommand('owner', task.id, input);
  assert.equal(f.store.enqueueCommand('owner', task.id, input).id, command.id);
  rejectsCode(
    () => f.store.enqueueCommand('owner', task.id, { ...input, requestKey: 'second-approval-key' }),
    'INTERACTION_NOT_PENDING',
  );
  f.store.ackCommand(f.device.device.id, task.id, a.leaseToken, command.id, { status: 'applied' });
  assert.equal(f.store.getTask(task.id).status, 'running');
  rejectsCode(
    () => f.store.enqueueCommand('owner', task.id, { ...input, requestKey: 'late-approval-key' }),
    'INTERACTION_NOT_PENDING',
  );
});

test('permission decisions cannot escalate to an always-allow rule', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [permission()]);
  rejectsCode(
    () =>
      f.store.enqueueCommand('owner', task.id, {
        requestKey: 'unsafe-approval-key',
        kind: 'reply',
        payload: { sessionId: 'child-session', requestId: 'permission-1', decision: 'alwaysAllow' },
      }),
    'INVALID_INPUT',
  );
});

test('local permission resolution invalidates a queued remote decision', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [permission()]);
  const command = f.store.enqueueCommand('owner', task.id, {
    requestKey: 'remote-approval-key',
    kind: 'reply',
    payload: { sessionId: 'child-session', requestId: 'permission-1', decision: 'allowOnce' },
  });
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
    {
      sequence: 2,
      type: 'permission.resolved',
      payload: { sessionId: 'child-session', requestId: 'permission-1', decision: 'deny' },
    },
  ]);
  assert.equal(
    f.store.commands(task.id).find((item) => item.id === command.id)?.status,
    'rejected',
  );
  assert.equal(f.store.getTask(task.id).status, 'running');
  assert.deepEqual(f.store.heartbeat(f.device.device.id, task.id, a.leaseToken).commands, []);
});

test('forged local resolution events roll back without hiding a real pending permission', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [permission()]);
  rejectsCode(
    () =>
      f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
        {
          sequence: 2,
          type: 'permission.resolved',
          payload: { sessionId: 'another-session', requestId: 'permission-1' },
        },
      ]),
    'INTERACTION_NOT_FOUND',
  );
  assert.equal(f.store.getTask(task.id).status, 'waiting_input');
  assert.equal(f.store.getTask(task.id).lastSequence, 1);
});

test('questionnaires validate exact step IDs, option IDs, selection count and expiry', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [question(1, f.now() + 900)]);
  rejectsCode(
    () =>
      f.store.enqueueCommand('owner', task.id, {
        requestKey: 'bad-option-answer',
        kind: 'answer',
        payload: answerPayload('invented'),
      }),
    'ANSWER_MISMATCH',
  );
  rejectsCode(
    () =>
      f.store.enqueueCommand('owner', task.id, {
        requestKey: 'bad-step-answer',
        kind: 'answer',
        payload: {
          sessionId: 'session-project',
          requestId: 'question-1',
          answers: [{ stepId: 'not-a-step', selectedOptionIds: ['small'], selectedOther: false }],
        },
      }),
    'ANSWER_MISMATCH',
  );
  rejectsCode(
    () =>
      f.store.enqueueCommand('owner', task.id, {
        requestKey: 'two-options-answer',
        kind: 'answer',
        payload: {
          sessionId: 'session-project',
          requestId: 'question-1',
          answers: [
            {
              stepId: 'implementation',
              selectedOptionIds: ['small', 'refactor'],
              selectedOther: false,
            },
          ],
        },
      }),
    'ANSWER_MISMATCH',
  );
  f.advance(900);
  rejectsCode(
    () =>
      f.store.enqueueCommand('owner', task.id, {
        requestKey: 'expired-question-answer',
        kind: 'answer',
        payload: answerPayload(),
      }),
    'QUESTION_EXPIRED',
  );
});

test('valid questionnaire answers resolve only after the device confirms application', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [question()]);
  const command = f.store.enqueueCommand('owner', task.id, {
    requestKey: 'valid-question-answer',
    kind: 'answer',
    payload: answerPayload(),
  });
  assert.equal(f.store.getTask(task.id).status, 'waiting_input');
  f.store.ackCommand(f.device.device.id, task.id, a.leaseToken, command.id, { status: 'applied' });
  assert.equal(f.store.getTask(task.id).status, 'running');
});

test('questionnaire free text and explicit skip preserve the real host contract', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [question()]);
  const input = {
    sessionId: 'session-project',
    requestId: 'question-1',
    answers: [
      {
        stepId: 'implementation',
        selectedOptionIds: [],
        selectedOther: true,
        otherText: 'Only repair the failing branch.',
      },
    ],
  };
  const cmd = f.store.enqueueCommand('owner', task.id, {
    requestKey: 'free-text-question-answer',
    kind: 'answer',
    payload: input,
  });
  f.store.ackCommand(f.device.device.id, task.id, a.leaseToken, cmd.id, {
    status: 'rejected',
    message: 'Retry after reviewing the change.',
  });
  assert.equal(f.store.getTask(task.id).status, 'waiting_input');
  assert.ok(
    f.store.enqueueCommand('owner', task.id, {
      requestKey: 'explicit-skip-answer',
      kind: 'answer',
      payload: {
        sessionId: 'session-project',
        requestId: 'question-1',
        answers: [
          { stepId: 'implementation', selectedOptionIds: [], selectedOther: false, skipped: true },
        ],
      },
    }).id,
  );
});

test('multiple pending interactions keep the task waiting until all are resolved', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
    permission(),
    permission(2, 'another-child', 'permission-2'),
  ]);
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
    {
      sequence: 3,
      type: 'permission.resolved',
      payload: { sessionId: 'child-session', requestId: 'permission-1' },
    },
  ]);
  assert.equal(f.store.getTask(task.id).status, 'waiting_input');
  f.store.appendEvents(f.device.device.id, task.id, a.leaseToken, [
    {
      sequence: 4,
      type: 'permission.resolved',
      payload: { sessionId: 'another-child', requestId: 'permission-2' },
    },
  ]);
  assert.equal(f.store.getTask(task.id).status, 'running');
});

test('unknown command execution locks the task and prevents automatic retry', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  const command = f.store.enqueueCommand('owner', task.id, {
    requestKey: 'steer-unknown-key',
    kind: 'steer',
    payload: { text: 'Preserve the public API.' },
  });
  f.store.ackCommand(f.device.device.id, task.id, a.leaseToken, command.id, {
    status: 'unknown',
    message: 'Connection lost after dispatch.',
  });
  assert.equal(f.store.getTask(task.id).status, 'unknown');
  assert.equal(f.store.claim(f.device.device.id), null);
  rejectsCode(() => f.store.heartbeat(f.device.device.id, task.id, a.leaseToken), 'LEASE_EXPIRED');
});

test('command acknowledgement retries are idempotent and conflicting acknowledgements fail', (t) => {
  const f = fixture(t);
  const task = f.submit();
  const a = f.claim();
  const command = f.store.enqueueCommand('owner', task.id, {
    requestKey: 'steer-idempotent-key',
    kind: 'steer',
    payload: { text: 'Use the existing API.' },
  });
  const ack = { status: 'applied' as const, message: 'Host accepted steering.' };
  assert.equal(
    f.store.ackCommand(f.device.device.id, task.id, a.leaseToken, command.id, ack).status,
    'applied',
  );
  assert.equal(
    f.store.ackCommand(f.device.device.id, task.id, a.leaseToken, command.id, ack).status,
    'applied',
  );
  rejectsCode(
    () =>
      f.store.ackCommand(f.device.device.id, task.id, a.leaseToken, command.id, {
        status: 'unknown',
      }),
    'COMMAND_ACK_CONFLICT',
  );
});

test('task pagination uses a stable cursor even when creation timestamps are identical', (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 7 }, () => f.submit().id).reverse();
  const first = f.store.listTasks({ limit: 3 });
  const lastFirst = first.at(-1);
  assert.ok(lastFirst);
  const second = f.store.listTasks({ limit: 3, before: lastFirst.id });
  const lastSecond = second.at(-1);
  assert.ok(lastSecond);
  const third = f.store.listTasks({ limit: 3, before: lastSecond.id });
  assert.deepEqual(
    [...first, ...second, ...third].map((task) => task.id),
    ids,
  );
  rejectsCode(() => f.store.listTasks({ before: 'missing-task' }), 'TASK_NOT_FOUND');
  rejectsCode(() => f.store.listTasks({ limit: 0 }), 'INVALID_INPUT');
});

test('audit pagination is stable and excludes prompt contents and lease material', (t) => {
  const f = fixture(t);
  const task = f.submit(f.project.id, 'PRIVATE_PROMPT_MARKER');
  const a = f.claim();
  f.store.complete(f.device.device.id, task.id, a.leaseToken, { outcome: 'succeeded', result: {} });
  const first = f.store.audit({ limit: 2 });
  const last = first.at(-1);
  assert.ok(last);
  const rest = f.store.audit({ after: last.id });
  assert.ok(rest.every((item) => item.id > last.id));
  const serialized = JSON.stringify([...first, ...rest]);
  assert.ok(!serialized.includes('PRIVATE_PROMPT_MARKER'));
  assert.ok(!serialized.includes(a.leaseToken));
  assert.ok(!serialized.includes(f.device.token));
});

test('newer database versions fail closed without rewriting the schema', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'coderelay-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'future.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA user_version=99');
  db.close();
  rejectsCode(() => new RelayStore({ filename }), 'UNSUPPORTED_SCHEMA');
  const verify = new DatabaseSync(filename);
  assert.equal(verify.prepare('PRAGMA user_version').get()?.user_version, 99);
  verify.close();
});

test('opening an existing database tightens POSIX database and journal permissions', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows privacy is enforced by the user directory ACL, not POSIX mode bits.');
    return;
  }
  const f = fixture(t);
  for (const name of readdirSync(f.dir).filter((name) => name.startsWith('relay.sqlite')))
    chmodSync(join(f.dir, name), 0o644);
  const reopened = f.open();
  assert.ok(reopened.projects().length);
  for (const name of readdirSync(f.dir).filter((name) => name.startsWith('relay.sqlite')))
    assert.equal(statSync(join(f.dir, name)).mode & 0o777, 0o600);
});

test('a substituted SQLite journal symlink is refused before opening the database', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'coderelay-store-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'store.sqlite');
  const target = join(dir, 'target');
  writeFileSync(target, 'private data');
  try {
    symlinkSync(target, `${filename}-wal`);
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Runner cannot create symbolic links.');
      return;
    }
    throw error;
  }
  rejectsCode(() => new RelayStore({ filename }), 'INVALID_DATABASE');
  assert.equal(readFileSync(target, 'utf8'), 'private data');
});
