import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Relay, validateAnswers } from '../miniapp/node/relay.mjs';
import { workspaceIdentity, runCommand, validateCommands } from '../miniapp/node/evidence.mjs';
import { gatewayUrl } from '../miniapp/node/gateway.mjs';
import { Journal } from '../miniapp/node/state.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const question = {
  requestId: 'question_1',
  mode: 'questionnaire',
  request: {
    schemaVersion: 2,
    id: 'q_1',
    steps: [
      {
        id: 'step_1',
        question: '哪个方案？',
        selectionMode: 'single',
        allowOther: true,
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
    ],
  },
};

async function fixture(t, handlers = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'coderelay-miniapp-'));
  const workspace = join(directory, 'project');
  await mkdir(workspace);
  const identity = await workspaceIdentity(workspace);
  const calls = { run: 0, answer: 0, reply: [], events: [], complete: [], acks: [], network: [] };
  const agent = {
    async session(sessionId) {
      return {
        sessionId,
        workspaceDir: workspace,
        isDefaultWorkspace: false,
        status: 'idle',
        model: { providerId: 'minimax_oauth', modelId: 'fixture-model' },
      };
    },
    async run(input, options) {
      calls.run++;
      return handlers.run
        ? handlers.run(input, options)
        : { sessionId: input.sessionId, status: 'finished', text: 'done' };
    },
    async answer(input, options) {
      calls.answer++;
      return handlers.answer
        ? handlers.answer(input, options)
        : { sessionId: input.sessionId, status: 'finished', text: 'answered' };
    },
    async reply(input) {
      calls.reply.push(input);
      return handlers.reply?.(input);
    },
  };
  const context = {
    dataDir: join(directory, 'state'),
    pluginRoot: join(directory, 'package'),
    agent,
    capabilities: { has: () => true },
    signal: new AbortController().signal,
    logger: { info() {}, error() {} },
  };
  const relay = new Relay(context, {
    gitEvidence: async () => ({ source: 'test-fixture' }),
    ...handlers.options,
  });
  await relay.init();
  const project = {
    id: 'project_1',
    name: '项目',
    deviceId: 'device_1',
    sessionId: 'session_1',
    ...identity,
    model: { providerId: 'minimax_oauth', modelId: 'fixture-model' },
  };
  const assignment = {
    project,
    leaseToken: 'lease-private-test',
    task: {
      id: 'task_1',
      projectId: project.id,
      deviceId: 'device_1',
      workspaceKey: identity.workspaceKey,
      sessionId: 'session_1',
      prompt: 'Implement the request',
      acceptanceCriteria: ['Verified behavior'],
      runVerification: false,
      leaseExpiresAt: Date.now() + 90000,
    },
  };
  await relay.journal.change((state) => {
    state.connection = {
      gatewayUrl: 'https://relay.example',
      device: { id: 'device_1', name: '测试设备' },
      token: 'device-token-never-on-page',
    };
    state.projects[project.id] = project;
  });
  relay.gateway = {
    async request(path, body) {
      calls.network.push({ path, body });
      if (path.endsWith('/heartbeat')) return { leaseExpiresAt: Date.now() + 90000, commands: [] };
      if (path.endsWith('/events')) {
        calls.events.push(structuredClone(body));
        if (handlers.events) return handlers.events(body);
        return { acknowledgedSequence: body.events.at(-1).sequence };
      }
      if (path.endsWith('/complete')) {
        calls.complete.push(body);
        return { task: { id: assignment.task.id, status: body.outcome } };
      }
      if (path.endsWith('/ack')) {
        calls.acks.push(body);
        return { command: {} };
      }
      if (path.endsWith('/claim')) return { assignment: null };
      if (path === '/v1/worker/projects')
        return { project: { ...project, ...body, id: project.id } };
      if (path === `/v1/worker/tasks/${assignment.task.id}`)
        return { task: { id: assignment.task.id, status: 'cancelled' } };
      throw new Error(`unexpected ${path}`);
    },
  };
  t.after(async () => {
    await relay.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { relay, calls, context, assignment, project, directory, workspace };
}

test('official manifests are self-contained and declare only session.run', async () => {
  const plugin = JSON.parse(
    await readFile(new URL('../.minimax-plugin/plugin.json', import.meta.url), 'utf8'),
  );
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const mini = JSON.parse(
    await readFile(new URL('../miniapp/miniapp.json', import.meta.url), 'utf8'),
  );
  assert.equal(plugin.name, 'minimax-coderelay');
  assert.equal(pkg.mcode.schemaVersion, 2);
  assert.deepEqual(mini.agentAccess, ['session.run']);
  assert.equal(mini.runtime.entry, './miniapp/node/server.mjs');
  assert.equal(mini.engines.mcode, '>=3.1.6');
  const png = await readFile(new URL('../icon.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
});

test('journal serializes writes and persists private mode', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coderelay-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new Journal(directory);
  await journal.init();
  await Promise.all(
    Array.from({ length: 20 }, () =>
      journal.change((state) => {
        state.count = (state.count || 0) + 1;
      }),
    ),
  );
  const loaded = new Journal(directory);
  await loaded.init();
  assert.equal(loaded.value.count, 20);
  if (process.platform !== 'win32') assert.equal((await stat(journal.path)).mode & 0o777, 0o600);
});

test('binding uses a verified own session, rejects default directories and hashes canonical path', async (t) => {
  const { relay, context, workspace } = await fixture(t);
  const response = await relay.bind({ name: '项目', sessionId: 'session_1' });
  assert.equal(response.project.workspaceKey, (await workspaceIdentity(workspace)).workspaceKey);
  context.agent.session = async (sessionId) => ({
    sessionId,
    isDefaultWorkspace: true,
    workspaceDir: workspace,
  });
  await assert.rejects(relay.bind({ name: '不允许', sessionId: 'session_2' }), {
    code: 'OPEN_A_PROJECT_FIRST',
  });
});

test('assignment is durable before Agent dispatch and repeat deliveries do not execute twice', async (t) => {
  let f;
  f = await fixture(t, {
    run: async (input) => {
      const disk = JSON.parse(await readFile(f.relay.journal.path, 'utf8'));
      assert.equal(disk.jobs.task_1.assignment.leaseToken, 'lease-private-test');
      assert.equal(disk.jobs.task_1.phase, 'running');
      return { sessionId: input.sessionId, status: 'finished', text: 'implemented' };
    },
  });
  await f.relay.accept(f.assignment, 90);
  await until(() => f.relay.journal.value.jobs.task_1.outcome);
  await f.relay.accept(f.assignment, 90);
  assert.equal(f.calls.run, 1);
  const status = JSON.stringify(await f.relay.status());
  assert.ok(!status.includes('lease-private-test'));
  assert.ok(!status.includes('device-token-never-on-page'));
});

test('lost event acknowledgement replays identical durable sequences', async (t) => {
  let lose = true;
  const { relay, calls, assignment } = await fixture(t, {
    events: async (body) => {
      if (lose) {
        lose = false;
        throw Object.assign(new Error(), { code: 'NETWORK_UNAVAILABLE' });
      }
      return { acknowledgedSequence: body.events.at(-1).sequence };
    },
  });
  await relay.accept(assignment, 90);
  await until(() => relay.journal.value.jobs.task_1.outcome);
  clearTimeout(relay.tickTimer);
  await relay.event('task_1', 'text.delta', { text: 'real event' });
  await assert.rejects(relay.flushJob('task_1'));
  await relay.flushJob('task_1');
  assert.deepEqual(calls.events[0], calls.events[1]);
  assert.equal(relay.journal.value.jobs.task_1.events.length, 0);
});

test('child-session permissions require explicit matching receipt and duplicate commands do not replay', async (t) => {
  const pending = deferred();
  let f;
  f = await fixture(t, {
    run: async (input, options) => {
      options.onEvent({
        type: 'permission.requested',
        sessionId: 'child_2',
        requestId: 'approval_2',
        toolName: 'shell',
        reason: 'run tests',
      });
      return pending.promise;
    },
    reply: async () => {
      assert.equal(f.relay.journal.value.jobs.task_1.commands.cmd_1.status, 'started');
    },
  });
  await f.relay.accept(f.assignment, 90);
  await until(() => Object.keys(f.relay.journal.value.jobs.task_1.permissions).length);
  await assert.rejects(
    f.relay.command('task_1', {
      id: 'wrong',
      kind: 'reply',
      payload: { sessionId: 'session_1', requestId: 'approval_2', decision: 'allowOnce' },
    }),
    { code: 'PERMISSION_NOT_PENDING' },
  );
  const command = {
    id: 'cmd_1',
    kind: 'reply',
    payload: { sessionId: 'child_2', requestId: 'approval_2', decision: 'allowOnce' },
  };
  await Promise.all([f.relay.command('task_1', command), f.relay.command('task_1', command)]);
  assert.equal(f.calls.reply.length, 1);
  assert.equal(f.calls.reply[0].sessionId, 'child_2');
  assert.equal(
    f.relay.journal.value.jobs.task_1.recentEvents.some(
      (event) => event.type === 'permission.resolved',
    ),
    false,
    'remote interaction uses its command receipt, not a local-resolution event',
  );
  pending.resolve({ sessionId: 'session_1', status: 'finished', text: 'done' });
  await until(() => f.relay.journal.value.jobs.task_1.outcome);
});

test('questionnaires are answered only after run resolved; actual host answer continues the task', async (t) => {
  let originalResolved = false;
  const { relay, calls, assignment } = await fixture(t, {
    run: async (input, options) => {
      options.onEvent({ type: 'question.requested', sessionId: input.sessionId, ...question });
      originalResolved = true;
      return { sessionId: input.sessionId, status: 'finished', pendingQuestion: question };
    },
    answer: async (input) => {
      assert.equal(originalResolved, true);
      assert.equal(input.requestId, 'question_1');
      return { sessionId: input.sessionId, status: 'finished', text: 'continued' };
    },
  });
  await relay.accept(assignment, 90);
  await until(() => relay.active?.waiter && relay.journal.value.jobs.task_1.question);
  await assert.rejects(
    relay.localCommand('task_1', {
      kind: 'answer',
      payload: {
        sessionId: 'session_1',
        requestId: 'question_1',
        answers: [{ stepId: 'wrong', selectedOptionIds: ['a'], selectedOther: false }],
      },
    }),
    { code: 'INVALID_ANSWER_STEP' },
  );
  await relay.localCommand('task_1', {
    kind: 'answer',
    payload: {
      sessionId: 'session_1',
      requestId: 'question_1',
      answers: [{ stepId: 'step_1', selectedOptionIds: ['a'], selectedOther: false }],
    },
  });
  await until(() => relay.journal.value.jobs.task_1.outcome);
  assert.equal(calls.answer, 1);
  assert.equal(relay.journal.value.jobs.task_1.result.summary, 'continued');
  assert.ok(
    relay.journal.value.jobs.task_1.recentEvents.some(
      (event) => event.type === 'question.answered',
    ),
  );
});

test('cancel receipt alone is not completion; confirmed host abort becomes cancelled', async (t) => {
  const { relay, assignment } = await fixture(t, {
    run: async (input, options) =>
      new Promise((resolve) =>
        options.signal.addEventListener(
          'abort',
          () => setTimeout(() => resolve({ sessionId: input.sessionId, status: 'aborted' }), 20),
          { once: true },
        ),
      ),
  });
  await relay.accept(assignment, 90);
  await until(() => relay.journal.value.jobs.task_1.phase === 'running');
  await relay.command('task_1', { id: 'cancel_1', kind: 'cancel', payload: {} });
  assert.equal(relay.journal.value.jobs.task_1.outcome, null);
  await until(() => relay.journal.value.jobs.task_1.outcome);
  assert.equal(relay.journal.value.jobs.task_1.outcome, 'cancelled');
});

test('lease loss records unknown, aborts host, and cannot claim another task', async (t) => {
  let aborted = false;
  const { relay, assignment, calls } = await fixture(t, {
    run: async (input, options) =>
      new Promise((resolve) =>
        options.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve({ sessionId: input.sessionId, status: 'aborted' });
          },
          { once: true },
        ),
      ),
  });
  await relay.accept(assignment, 90);
  await until(() => relay.journal.value.jobs.task_1.phase === 'running');
  relay.loseLease(relay.active, 'LEASE_EXPIRED');
  await until(() => relay.journal.value.jobs.task_1.outcome === 'unknown' && !relay.active);
  assert.equal(aborted, true);
  relay.enabled = true;
  await relay.tick();
  assert.equal(
    calls.network.some((call) => call.path.endsWith('/claim')),
    false,
  );
});

test('a crash leaves started commands and running work unknown, never resumed', async (t) => {
  const f = await fixture(t, { run: async () => new Promise(() => {}) });
  await f.relay.accept(f.assignment, 90);
  await until(() => f.relay.journal.value.jobs.task_1.phase === 'running');
  await f.relay.journal.change((state) => {
    state.jobs.task_1.commands.uncertain = { kind: 'reply', status: 'started', local: false };
  });
  const recovered = new Relay(f.context);
  await recovered.init();
  assert.equal(recovered.journal.value.jobs.task_1.outcome, 'unknown');
  assert.equal(recovered.journal.value.jobs.task_1.commands.uncertain.status, 'unknown');
  assert.equal(f.calls.run, 1);
  assert.equal(recovered.enabled, false);
  await recovered.dispose();
});

test('an unexpected error after dispatch is unknown', async (t) => {
  const f = await fixture(t, {
    run: async () => {
      throw new Error('unexpected transport loss');
    },
  });
  await f.relay.accept(f.assignment, 90);
  await until(() => f.relay.journal.value.jobs.task_1.outcome);
  assert.equal(f.relay.journal.value.jobs.task_1.outcome, 'unknown');
});

test('a known non-dispatched BUSY response is failed without repeating the invocation', async (t) => {
  const f = await fixture(t, {
    run: async () => {
      throw Object.assign(new Error('busy'), { code: 'BUSY', retryable: true });
    },
  });
  await f.relay.accept(f.assignment, 90);
  await until(() => f.relay.journal.value.jobs.task_1.outcome);
  assert.equal(f.relay.journal.value.jobs.task_1.outcome, 'failed');
  assert.equal(f.calls.run, 1);
});

test('steering that becomes its own turn is awaited before task completion', async (t) => {
  const main = deferred(),
    steer = deferred();
  const f = await fixture(t, {
    run: async (input) => (input.whenBusy ? steer.promise : main.promise),
  });
  await f.relay.accept(f.assignment, 90);
  await until(() => f.relay.journal.value.jobs.task_1.phase === 'running');
  await f.relay.command('task_1', {
    id: 'steer_1',
    kind: 'steer',
    payload: { text: 'add a check' },
  });
  main.resolve({ sessionId: 'session_1', status: 'finished', text: 'first' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.relay.journal.value.jobs.task_1.outcome, null);
  steer.resolve({ sessionId: 'session_1', status: 'finished', text: 'follow-up' });
  await until(() => f.relay.journal.value.jobs.task_1.outcome);
  assert.equal(f.relay.journal.value.jobs.task_1.result.summary, 'follow-up');
});

test('real local verification executes argv, preserves exit code, and cannot be chosen by task', async (t) => {
  const f = await fixture(t, { options: { runCommand } });
  await f.relay.setVerification({
    projectId: 'project_1',
    commands: [
      {
        name: 'failing-check',
        file: process.execPath,
        args: ['-e', 'process.stdout.write("verified-output");process.exitCode=7'],
        timeoutMs: 2000,
      },
    ],
  });
  f.assignment.task.runVerification = true;
  f.assignment.task.command = 'echo this must not run';
  await f.relay.accept(f.assignment, 90);
  await until(() => f.relay.journal.value.jobs.task_1.outcome);
  const result = f.relay.journal.value.jobs.task_1;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.result.verification[0].exitCode, 7);
  assert.equal(result.result.verification[0].stdout, 'verified-output');
});

test('network and questionnaire input validation rejects unsupported shapes', () => {
  assert.throws(() => gatewayUrl('http://example.com'), { code: 'HTTPS_REQUIRED' });
  assert.throws(() => gatewayUrl('https://user:secret@example.com'), {
    code: 'INVALID_GATEWAY_URL',
  });
  assert.equal(gatewayUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.throws(() => validateCommands([{ name: 'bad', file: 'node', args: '--test' }]), {
    code: 'INVALID_COMMAND_ARGUMENTS',
  });
  assert.throws(
    () =>
      validateAnswers(question, [
        { stepId: 'step_1', selectedOptionIds: ['a', 'b'], selectedOther: false },
      ]),
    { code: 'INVALID_ANSWER_OPTION' },
  );
  const free = {
    stepId: 'step_1',
    selectedOptionIds: [],
    selectedOther: true,
    otherText: 'choice',
  };
  const fixed = structuredClone(question);
  fixed.request.steps[0].allowOther = false;
  assert.throws(() => validateAnswers(fixed, [free]), { code: 'INVALID_ANSWER_TEXT' });
  assert.throws(() => validateAnswers(question, [{ ...free, otherText: '  ' }]), {
    code: 'INVALID_ANSWER_TEXT',
  });
  assert.throws(() => validateAnswers(question, [{ ...free, selectedOther: false }]), {
    code: 'INVALID_ANSWER_TEXT',
  });
  assert.throws(() => validateAnswers(question, [{ ...free, skipped: true }]), {
    code: 'INVALID_ANSWER',
  });
  assert.deepEqual(
    validateAnswers(question, [
      { stepId: 'step_1', selectedOptionIds: [], selectedOther: false, skipped: true },
    ]),
    [{ stepId: 'step_1', selectedOptionIds: [], selectedOther: false, skipped: true }],
  );
});

test('an explicit gateway lease rejection stops the Host before the local lease deadline', async (t) => {
  const f = await fixture(t, {
    run: async (input, options) =>
      new Promise((resolve) =>
        options.signal.addEventListener(
          'abort',
          () => resolve({ sessionId: input.sessionId, status: 'aborted' }),
          { once: true },
        ),
      ),
  });
  await f.relay.accept(f.assignment, 90);
  await until(() => f.relay.journal.value.jobs.task_1.phase === 'running');
  const original = f.relay.gateway.request;
  f.relay.gateway.request = async (path, body) => {
    if (path.endsWith('/heartbeat'))
      throw Object.assign(new Error(), { code: 'LEASE_EXPIRED', status: 409 });
    return original(path, body);
  };
  await assert.rejects(f.relay.heartbeat(f.relay.active, true), { code: 'LEASE_EXPIRED' });
  await until(() => f.relay.journal.value.jobs.task_1.outcome === 'unknown');
  assert.equal(f.relay.journal.value.jobs.task_1.error, 'LEASE_EXPIRED');
});

test('verification does not permit steering to start an Agent alongside a local check', async (t) => {
  const verification = deferred();
  const f = await fixture(t, { options: { runCommand: async () => verification.promise } });
  await f.relay.setVerification({
    projectId: 'project_1',
    commands: [{ name: 'check', file: 'node', args: ['--test'], timeoutMs: 1000 }],
  });
  f.assignment.task.runVerification = true;
  await f.relay.accept(f.assignment, 90);
  await until(() => f.relay.journal.value.jobs.task_1.phase === 'verifying');
  await assert.rejects(
    f.relay.command('task_1', {
      id: 'late_steer',
      kind: 'steer',
      payload: { text: 'change more' },
    }),
    { code: 'TASK_NOT_ACCEPTING_STEERING' },
  );
  verification.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false });
  await until(() => f.relay.journal.value.jobs.task_1.outcome);
  assert.equal(f.calls.run, 1);
});

test('reply outcome uncertainty blocks further permission decisions and is not replayed', async (t) => {
  const f = await fixture(t, {
    run: async (input, options) => {
      options.onEvent({
        type: 'permission.requested',
        sessionId: input.sessionId,
        requestId: 'ask',
        toolName: 'shell',
        reason: 'check',
      });
      return new Promise((resolve) =>
        options.signal.addEventListener(
          'abort',
          () => resolve({ sessionId: input.sessionId, status: 'aborted' }),
          { once: true },
        ),
      );
    },
    reply: async () => {
      throw Object.assign(new Error(), { code: 'AGENT_OUTCOME_UNKNOWN' });
    },
  });
  await f.relay.accept(f.assignment, 90);
  await until(() => Object.keys(f.relay.journal.value.jobs.task_1.permissions).length);
  const command = {
    id: 'uncertain_reply',
    kind: 'reply',
    payload: { sessionId: 'session_1', requestId: 'ask', decision: 'allowOnce' },
  };
  await assert.rejects(f.relay.command('task_1', command), { code: 'AGENT_OUTCOME_UNKNOWN' });
  await f.relay.command('task_1', command);
  assert.equal(f.calls.reply.length, 1);
  await until(() => f.relay.journal.value.jobs.task_1.outcome === 'unknown');
  assert.equal(f.relay.journal.value.jobs.task_1.commands.uncertain_reply.status, 'unknown');
});

test('real verification cancellation terminates a process and records actual signal, never exit zero', async () => {
  const controller = new AbortController();
  const pending = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: 5000,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.notEqual(result.exitCode, 0);
});

test('an unresponsive Host is reported unknown promptly and keeps the device occupied', async (t) => {
  const f = await fixture(t, { run: async () => new Promise(() => {}) });
  await f.relay.accept(f.assignment, 90);
  await until(() => f.relay.journal.value.jobs.task_1.phase === 'running');
  f.relay.loseLease(f.relay.active, 'CANCELLATION_NOT_CONFIRMED');
  await until(() => f.relay.journal.value.jobs.task_1.outcome === 'unknown');
  assert.ok(f.relay.active, 'do not claim new work while the old Host call is still alive');
  await f.relay.flushJob('task_1');
  assert.equal(f.calls.complete[0].outcome, 'unknown');
  await assert.rejects(
    f.relay.command('task_1', { id: 'no_new_permissions', kind: 'reply', payload: {} }),
    { code: 'TASK_OUTCOME_UNKNOWN' },
  );
});

test(
  'verification can terminate remaining pipe-holding descendants after their parent exits',
  { skip: process.platform === 'win32' },
  async () => {
    const script =
      'const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",process.stdout,process.stderr]});process.exit(0);';
    const result = await runCommand(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      timeoutMs: 100,
    });
    assert.equal(result.exitCode, 0, 'parent genuinely exited zero; do not invent another code');
    assert.equal(
      result.timedOut,
      true,
      'the process tree did not finish within the configured budget',
    );
  },
);
