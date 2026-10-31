import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { createApplication } from '../src/app.js';
import type { RelayConfig } from '../src/config.js';
import type { Project, StoredEvent, Task, TaskCommand } from '../src/types.js';
// The installable Mini App deliberately ships plain ESM with no build/runtime dependency.
// @ts-expect-error The production JavaScript adapter has no separate declaration bundle.
import { Relay } from '../plugins/minimax-coderelay/miniapp/node/relay.mjs';

const runFile = promisify(execFile);
const model = { providerId: 'synthetic-fixture', modelId: 'not-a-real-minimax-call', variant: '' };
type HostInput = {
  sessionId: string;
  text?: string;
  requestId?: string;
  answers?: unknown[];
  decision?: string;
};
type HostOptions = { signal: AbortSignal; onEvent: (event: Record<string, unknown>) => void };
type HostResult = {
  sessionId: string;
  status: 'finished' | 'aborted';
  text?: string;
  model?: typeof model;
  pendingQuestion?: typeof question;
};
type Run = (input: HostInput, options: HostOptions) => Promise<HostResult>;
type Reply = (input: HostInput) => Promise<void>;
const question = {
  requestId: 'question-integration',
  mode: 'questionnaire',
  request: {
    schemaVersion: 2,
    id: 'form-integration',
    steps: [
      {
        id: 'implementation',
        question: '选择实现',
        selectionMode: 'single',
        allowOther: false,
        options: [{ id: 'tested', label: '带验证的实现' }],
      },
    ],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeout = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'coderelay-http-bridge-'));
  const workspace = join(directory, 'repository');
  const dataDir = join(directory, 'gateway');
  await mkdir(workspace);
  await mkdir(dataDir);
  await runFile('git', ['init', '--quiet'], { cwd: workspace });
  await writeFile(join(workspace, 'message.txt'), 'initial content\n');
  await runFile('git', ['add', 'message.txt'], { cwd: workspace });
  await runFile(
    'git',
    [
      '-c',
      'user.name=CodeRelay Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: workspace },
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const config: RelayConfig = {
    schemaVersion: 1,
    publicUrl: url,
    host: '127.0.0.1',
    port: address.port,
    dataDir,
    adminToken: `cr_admin_${randomBytes(32).toString('base64url')}`,
    createdAt: Date.now(),
  };
  const gateway = createApplication(config, { log() {} });
  server.on('request', gateway.app);
  async function http<T>(
    path: string,
    token: string,
    body?: unknown,
    expectedStatus = 200,
  ): Promise<T> {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(value)}`);
    return value as T;
  }
  const { token: clientToken } = await http<{ token: string }>(
    '/v1/admin/access-tokens',
    config.adminToken,
    { name: 'HTTP integration fixture', scopes: ['tasks:read', 'tasks:write'] },
    201,
  );
  const calls = { run: 0, answer: 0, replies: [] as HostInput[] };
  const handlers: { run: Run; answer: Run; reply: Reply } = {
    async run(input) {
      return {
        sessionId: input.sessionId,
        status: 'finished',
        text: 'Synthetic Host fixture only.',
      };
    },
    async answer(input) {
      return {
        sessionId: input.sessionId,
        status: 'finished',
        text: 'Synthetic Host answer only.',
      };
    },
    async reply() {},
  };
  // Only this Host boundary is synthetic. HTTP, SQLite, queue, journal, Git,
  // verification processes and command acknowledgements use production code.
  const context = {
    dataDir: join(directory, 'device'),
    pluginRoot: join(directory, 'plugin'),
    signal: new AbortController().signal,
    capabilities: { has: () => true },
    logger: { info() {}, error() {} },
    agent: {
      async session(sessionId: string) {
        return { sessionId, workspaceDir: workspace, isDefaultWorkspace: false, model };
      },
      async run(input: HostInput, options: HostOptions) {
        calls.run++;
        return handlers.run(input, options);
      },
      async answer(input: HostInput, options: HostOptions) {
        calls.answer++;
        return handlers.answer(input, options);
      },
      async reply(input: HostInput) {
        calls.replies.push(input);
        await handlers.reply(input);
      },
    },
  };
  const relays: InstanceType<typeof Relay>[] = [];
  function newRelay() {
    const relay = new Relay(context);
    relays.push(relay);
    return relay;
  }
  const relay = newRelay();
  t.after(async () => {
    for (const instance of relays) if (!instance.disposed) await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  const pair = await http<{ code: string }>(
    '/v1/admin/pairing-codes',
    config.adminToken,
    { name: 'Integration desktop fixture' },
    201,
  );
  await relay.pair({ gatewayUrl: url, code: pair.code, name: 'Synthetic MiniMax Host' });
  const { project } = (await relay.bind({
    sessionId: 'owned-fixture-session',
    name: '临时 Git 仓库',
  })) as { project: Project };
  async function submit(suffix: string, runVerification = false): Promise<Task> {
    const response = await http<{ task: Task }>(
      '/v1/tasks',
      clientToken,
      {
        projectId: project.id,
        requestKey: `integration-${suffix}`,
        prompt: 'Update the local fixture file.',
        acceptanceCriteria: ['The changed file has independent Git evidence.'],
        runVerification,
      },
      201,
    );
    return response.task;
  }
  async function complete(task: Task) {
    await until(
      () => Boolean(relay.journal.value.jobs[task.id]?.completedReceipt),
      'durable gateway completion',
    );
    return (await http<{ task: Task }>(`/v1/tasks/${task.id}`, clientToken)).task;
  }
  return {
    directory,
    workspace,
    context,
    relay,
    newRelay,
    gateway,
    project,
    http,
    clientToken,
    config,
    handlers,
    calls,
    submit,
    complete,
  };
}

test('real HTTP + SQLite + plugin bridge: synthetic Host edit has real Git and subprocess verification evidence', async (t) => {
  const f = await fixture(t);
  f.handlers.run = async (input, options) => {
    assert.match(input.text!, /changed file has independent Git evidence/);
    options.onEvent({ type: 'turn.started', sessionId: input.sessionId, model });
    await writeFile(join(f.workspace, 'message.txt'), 'changed by synthetic Host fixture\n');
    options.onEvent({
      type: 'text.delta',
      sessionId: input.sessionId,
      text: 'Fixture edit finished.',
    });
    return {
      sessionId: input.sessionId,
      status: 'finished',
      text: 'Fixture completed; actual verification follows.',
      model,
    };
  };
  await f.relay.setVerification({
    projectId: f.project.id,
    commands: [
      {
        name: '实际文件验证',
        file: process.execPath,
        timeoutMs: 5000,
        args: [
          '-e',
          'const fs=require("node:fs");if(!fs.readFileSync("message.txt","utf8").includes("changed by synthetic"))process.exit(7);process.stdout.write("real subprocess verified the changed file\\n");',
        ],
      },
    ],
  });
  const task = await f.submit('evidence', true);
  await f.relay.connect();
  const finished = await f.complete(task);
  assert.equal(finished.status, 'succeeded');
  assert.equal(f.calls.run, 1);
  const result = finished.result as unknown as {
    model: typeof model;
    verification: { exitCode: number; stdout: string }[];
    evidence: {
      before: { source: string; head: { exitCode: number }; status: { stdout: string } };
      after: { diff: { stdout: string; exitCode: number } };
    };
  };
  assert.equal(result.model.variant, '');
  assert.equal(result.verification[0]!.exitCode, 0);
  assert.match(result.verification[0]!.stdout, /real subprocess verified/);
  assert.equal(result.evidence.before.source, 'independent-git-process');
  assert.equal(result.evidence.before.head.exitCode, 0);
  assert.equal(result.evidence.before.status.stdout, '');
  assert.equal(result.evidence.after.diff.exitCode, 0);
  assert.match(result.evidence.after.diff.stdout, /\+changed by synthetic Host fixture/);
  const { events } = await f.http<{ events: StoredEvent[] }>(
    `/v1/tasks/${task.id}/events`,
    f.clientToken,
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  assert.ok(events.some((event) => event.type === 'verification.finished'));
  const browserStatus = JSON.stringify(await f.relay.status());
  assert.ok(!browserStatus.includes(f.relay.journal.value.connection.token));
  assert.ok(!browserStatus.includes(f.relay.journal.value.jobs[task.id].assignment.leaseToken));
  assert.match(await readFile(join(f.workspace, 'message.txt'), 'utf8'), /synthetic Host/);
});

test('real HTTP bridge: synthetic child-session approval and questionnaire continue once with applied receipts', async (t) => {
  const f = await fixture(t);
  const approval = deferred<void>();
  f.handlers.run = async (input, options) => {
    options.onEvent({
      type: 'permission.requested',
      sessionId: 'owned-child-fixture',
      requestId: 'child-permission',
      toolName: 'shell',
      reason: 'Synthetic approval contract test.',
    });
    await approval.promise;
    options.onEvent({ type: 'question.requested', sessionId: input.sessionId, ...question });
    return { sessionId: input.sessionId, status: 'finished', pendingQuestion: question };
  };
  f.handlers.reply = async (input) => {
    assert.equal(input.sessionId, 'owned-child-fixture');
    approval.resolve();
  };
  f.handlers.answer = async (input) => {
    assert.equal(input.requestId, question.requestId);
    assert.deepEqual(input.answers, [
      { stepId: 'implementation', selectedOptionIds: ['tested'], selectedOther: false },
    ]);
    return {
      sessionId: input.sessionId,
      status: 'finished',
      text: 'Synthetic questionnaire continuation.',
    };
  };
  const task = await f.submit('interactions');
  await f.relay.connect();
  await until(
    () => f.gateway.store.getTask(task.id).status === 'waiting_input',
    'permission event reaches SQLite',
  );
  const approvalCommand = await f.http<{ command: TaskCommand }>(
    `/v1/tasks/${task.id}/commands`,
    f.clientToken,
    {
      requestKey: 'integration-permission',
      kind: 'reply',
      payload: {
        sessionId: 'owned-child-fixture',
        requestId: 'child-permission',
        decision: 'allowOnce',
      },
    },
  );
  await f.relay.heartbeat(f.relay.active, true);
  await until(
    () => f.gateway.store.events(task.id).some((event) => event.type === 'question.requested'),
    'full questionnaire reaches SQLite',
  );
  const answerCommand = await f.http<{ command: TaskCommand }>(
    `/v1/tasks/${task.id}/commands`,
    f.clientToken,
    {
      requestKey: 'integration-question',
      kind: 'answer',
      payload: {
        sessionId: 'owned-fixture-session',
        requestId: question.requestId,
        answers: [
          { stepId: 'implementation', selectedOptionIds: ['tested'], selectedOther: false },
        ],
      },
    },
  );
  await f.relay.heartbeat(f.relay.active, true);
  assert.equal((await f.complete(task)).status, 'succeeded');
  const { commands } = await f.http<{ commands: TaskCommand[] }>(
    `/v1/tasks/${task.id}/commands`,
    f.clientToken,
  );
  for (const expected of [approvalCommand.command.id, answerCommand.command.id])
    assert.equal(commands.find((command) => command.id === expected)?.status, 'applied');
  assert.equal(f.calls.run, 1);
  assert.equal(f.calls.answer, 1);
  assert.equal(f.calls.replies.length, 1);
  const { events } = await f.http<{ events: StoredEvent[] }>(
    `/v1/tasks/${task.id}/events`,
    f.clientToken,
  );
  assert.equal(
    events.some(
      (event) => event.type === 'permission.resolved' || event.type === 'question.answered',
    ),
    false,
    'remote receipts must not be mistaken for a competing local decision',
  );
});

test('real HTTP bridge: cancel waits for the synthetic Host to confirm abort', async (t) => {
  const f = await fixture(t);
  f.handlers.run = async (input, options) =>
    new Promise((resolve) =>
      options.signal.addEventListener(
        'abort',
        () => resolve({ sessionId: input.sessionId, status: 'aborted' }),
        { once: true },
      ),
    );
  const task = await f.submit('cancel');
  await f.relay.connect();
  await until(() => f.calls.run === 1, 'Host dispatch');
  const requested = await f.http<{ task: Task }>(`/v1/tasks/${task.id}/cancel`, f.clientToken, {
    requestKey: 'integration-cancel-request',
  });
  assert.equal(requested.task.status, 'cancel_requested');
  await f.relay.heartbeat(f.relay.active, true);
  assert.equal((await f.complete(task)).status, 'cancelled');
  const { commands } = await f.http<{ commands: TaskCommand[] }>(
    `/v1/tasks/${task.id}/commands`,
    f.clientToken,
  );
  assert.equal(commands.find((command) => command.kind === 'cancel')?.status, 'applied');
  assert.equal(f.calls.run, 1);
});

test('real HTTP bridge: plugin restart reports uncertain synthetic Host work without replay and observes explicit reconciliation', async (t) => {
  const f = await fixture(t);
  f.handlers.run = async () => new Promise<HostResult>(() => {});
  const task = await f.submit('restart');
  await f.relay.connect();
  await until(() => f.calls.run === 1, 'Host dispatch before interruption');
  const queued = await f.submit('blocked-after-restart');
  await f.relay.dispose();
  const recovered = f.newRelay();
  await recovered.init();
  assert.equal(recovered.enabled, false);
  assert.equal(recovered.journal.value.jobs[task.id].outcome, 'unknown');
  await recovered.connect();
  await until(
    () => Boolean(recovered.journal.value.jobs[task.id].completedReceipt),
    'unknown is durably reported over HTTP',
  );
  assert.equal(
    (await f.http<{ task: Task }>(`/v1/tasks/${task.id}`, f.clientToken)).task.status,
    'unknown',
  );
  assert.equal(
    (await f.http<{ task: Task }>(`/v1/tasks/${queued.id}`, f.clientToken)).task.status,
    'queued',
  );
  assert.equal(f.calls.run, 1, 'neither the interrupted task nor queued work is dispatched');
  await recovered.disconnect();
  await assert.rejects(recovered.reconcileStatus(task.id), {
    code: 'ADMIN_RECONCILIATION_REQUIRED',
  });
  await f.http(`/v1/admin/tasks/${task.id}/reconcile`, f.config.adminToken, {
    outcome: 'cancelled',
    reason: 'Synthetic fixture manually inspected for the integration test.',
  });
  const result = await recovered.reconcileStatus(task.id);
  assert.equal(result.reconciled, true);
  assert.equal(result.task.status, 'cancelled');
  assert.equal(f.calls.run, 1);
});
