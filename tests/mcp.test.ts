import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import express from 'express';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { handleMcp } from '../src/mcp.js';
import { RelayStore } from '../src/store.js';
import type { Assignment, Device, Json, Principal, Project } from '../src/types.js';

interface Fixture {
  store: RelayStore;
  server: Server;
  url: string;
  device: Device;
  project: Project;
  now: number;
  clients: Client[];
  finished: number;
}
interface TaskView {
  id: string;
  status: string;
  verification: { status: string };
}
interface ToolData {
  task: TaskView;
  tasks: TaskView[];
  devices: Device[];
  projects: Project[];
  command: { id: string; status: string; kind: string };
  recentCommands: { id: string; status: string }[];
  error: { code: string; message: string };
  events: Array<{
    sequence: number;
    type: string;
    payload?: Json;
    payloadFormat?: string;
    payloadChunk?: { chunk: string; sha256: string };
  }>;
  nextSequence: number;
  nextPayloadOffset: number | null;
  hasMore: boolean;
  nextBefore: string | null;
  nextOffset: number | null;
  chunk: string | null;
  sha256: string;
  verification: { status: string; checkCount: number };
  ready: boolean;
  taskStatus: string;
}
const PRINCIPALS: Record<string, Principal> = {
  writer: {
    id: 'owner:test-client',
    clientId: 'test-client',
    scopes: ['tasks:read', 'tasks:write'],
  },
  reader: { id: 'owner:read-client', clientId: 'read-client', scopes: ['tasks:read'] },
  writeonly: { id: 'owner:write-only', clientId: 'write-only', scopes: ['tasks:write'] },
  other: {
    id: 'owner:other-client',
    clientId: 'other-client',
    scopes: ['tasks:read', 'tasks:write'],
  },
};
const toolNames = [
  'answer_question',
  'cancel_task',
  'continue_task',
  'get_events',
  'get_result',
  'get_task',
  'list_devices',
  'list_projects',
  'list_tasks',
  'reply_permission',
  'steer_task',
  'submit_task',
];

async function fixture(t: TestContext): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'coderelay-mcp-'));
  const f = { now: Date.UTC(2026, 0, 1), clients: [], finished: 0 } as unknown as Fixture;
  f.store = new RelayStore({ filename: join(directory, 'relay.sqlite'), now: () => f.now });
  const pairing = f.store.createPairingCode('MCP test device');
  f.device = f.store.pairDevice({
    code: pairing.code,
    name: 'MCP test device',
    version: 'test',
  }).device;
  f.project = f.store.upsertProject(f.device.id, {
    name: 'MCP project',
    sessionId: 'session_main',
    workspaceDir: '/tmp/coderelay-mcp-project',
    workspaceKey: 'a'.repeat(64),
  });
  const app = express();
  // Intentionally allow a larger parser bound: handleMcp must retain its own backstop.
  app.use(express.json({ limit: '1mb' }));
  app.all('/mcp', async (req, res) => {
    const principal = PRINCIPALS[req.headers.authorization?.replace(/^Bearer /, '') ?? ''];
    if (!principal) {
      res.status(401).end();
      return;
    }
    res.once('finish', () => {
      f.finished++;
    });
    await handleMcp(req, res, f.store, principal);
  });
  f.server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    f.server.once('error', reject);
    f.server.listen(0, '127.0.0.1', resolve);
  });
  const address = f.server.address();
  assert.ok(address && typeof address !== 'string');
  f.url = `http://127.0.0.1:${address.port}/mcp`;
  t.after(async () => {
    await Promise.all(f.clients.map((client) => client.close().catch(() => undefined)));
    f.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      f.server.close((error) => (error ? reject(error) : resolve())),
    );
    f.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return f;
}
async function connect(
  f: Fixture,
  token = 'writer',
  mode: 'legacy' | 'modern' = 'legacy',
): Promise<Client> {
  const client = new Client(
    { name: 'CodeRelay integration test', version: '1.0.0' },
    {
      capabilities: {},
      versionNegotiation: { mode: mode === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    },
  );
  f.clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(f.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ raw: CallToolResult; data: ToolData }> {
  const raw = await client.callTool({ name, arguments: args });
  const text = raw.content?.find((item) => item.type === 'text');
  assert.ok(text && text.type === 'text');
  return { raw, data: JSON.parse(text.text) as ToolData };
}
async function submit(
  f: Fixture,
  client: Client,
  key = 'submit-key-0001',
  extra: Record<string, unknown> = {},
): Promise<TaskView> {
  const reply = await call(client, 'submit_task', {
    projectId: f.project.id,
    requestKey: key,
    prompt: 'Implement the requested feature and report evidence.',
    ...extra,
  });
  assert.notEqual(reply.raw.isError, true);
  return reply.data.task;
}
function claim(f: Fixture): Assignment {
  const assignment = f.store.claim(f.device.id);
  assert.ok(assignment);
  return assignment;
}

test('official SDK clients initialize/list/call over both legacy and current stateless HTTP', async (t) => {
  const f = await fixture(t);
  for (const mode of ['legacy', 'modern'] as const) {
    const client = await connect(f, 'writer', mode);
    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), toolNames);
    assert.equal(client.getServerVersion()?.name, 'CodeRelay');
    assert.equal((await call(client, 'list_projects')).data.projects[0]?.id, f.project.id);
    assert.equal((await call(client, 'list_devices')).data.devices[0]?.id, f.device.id);
    for (const tool of listing.tools) {
      if (
        [
          'submit_task',
          'continue_task',
          'cancel_task',
          'steer_task',
          'reply_permission',
          'answer_question',
        ].includes(tool.name)
      ) {
        assert.equal(tool.annotations?.readOnlyHint, false);
        assert.equal(tool.annotations?.destructiveHint, true);
      } else assert.equal(tool.annotations?.readOnlyHint, true);
    }
    const permission = listing.tools.find((tool) => tool.name === 'reply_permission')!;
    assert.ok(permission.description?.includes('explicit'));
    assert.ok(permission.description?.includes('Never infer or automatically grant'));
  }
  assert.ok(f.finished >= 6);
});

test('read-only credentials cannot mutate and write-only credentials cannot read', async (t) => {
  const f = await fixture(t);
  const reader = await connect(f, 'reader');
  const calls: Array<[string, Record<string, unknown>]> = [
    [
      'submit_task',
      { projectId: f.project.id, requestKey: 'readonly-submit', prompt: 'Do not execute.' },
    ],
    [
      'continue_task',
      { parentTaskId: 'fake', requestKey: 'readonly-continue', prompt: 'Do not execute.' },
    ],
    ['cancel_task', { taskId: 'fake', requestKey: 'readonly-cancel' }],
    ['steer_task', { taskId: 'fake', requestKey: 'readonly-steer', text: 'Do not execute.' }],
    [
      'reply_permission',
      {
        taskId: 'fake',
        requestKey: 'readonly-reply',
        sessionId: 'fake',
        requestId: 'fake',
        decision: 'allowOnce',
      },
    ],
    [
      'answer_question',
      {
        taskId: 'fake',
        requestKey: 'readonly-answer',
        sessionId: 'fake',
        requestId: 'fake',
        answers: [{ stepId: 'step1', selectedOptionIds: ['a'], selectedOther: false }],
      },
    ],
  ];
  for (const [name, args] of calls) {
    const result = await call(reader, name, args);
    assert.equal(result.raw.isError, true);
    assert.equal(result.data.error.code, 'INSUFFICIENT_SCOPE');
  }
  assert.equal(f.store.listTasks().length, 0);
  assert.equal((await call(reader, 'list_projects')).data.projects.length, 1);
  const writer = await connect(f, 'writeonly');
  assert.equal((await call(writer, 'list_devices')).data.error.code, 'INSUFFICIENT_SCOPE');
});

test('MCP submission preserves idempotency and separates principal request-key namespaces', async (t) => {
  const f = await fixture(t);
  const client = await connect(f);
  const first = await submit(f, client);
  const again = await submit(f, client);
  assert.equal(again.id, first.id);
  const conflict = await call(client, 'submit_task', {
    projectId: f.project.id,
    requestKey: 'submit-key-0001',
    prompt: 'Changed task input.',
  });
  assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
  const other = await connect(f, 'other');
  assert.notEqual((await submit(f, other)).id, first.id);
  assert.equal(f.store.listTasks().length, 2);
});

test('task pagination advances through equal timestamps without duplication or leaking result bodies', async (t) => {
  const f = await fixture(t);
  const client = await connect(f);
  const expected = new Set<string>();
  for (let i = 0; i < 5; i++) expected.add((await submit(f, client, `paging-task-${i}`)).id);
  const seen = new Set<string>();
  let before: string | undefined;
  for (let i = 0; i < 5; i++) {
    const reply = await call(client, 'list_tasks', { limit: 2, ...(before ? { before } : {}) });
    for (const task of reply.data.tasks) {
      assert.equal(seen.has(task.id), false);
      seen.add(task.id);
    }
    if (reply.data.nextBefore === null) break;
    before = reply.data.nextBefore;
  }
  assert.deepEqual(seen, expected);
});

test('events return ordinary sequence cursors and lossless bounded chunks for a large event', async (t) => {
  const f = await fixture(t);
  const client = await connect(f);
  const task = await submit(f, client);
  const assignment = claim(f);
  const large = { text: 'Detailed output 中文 😀 "quoted" '.repeat(1800) };
  f.store.appendEvents(f.device.id, task.id, assignment.leaseToken, [
    { sequence: 1, type: 'turn.started', payload: { sessionId: 'session_main' } },
    { sequence: 2, type: 'text.delta', payload: large },
    { sequence: 3, type: 'turn.finished', payload: { sessionId: 'session_main' } },
  ]);
  const first = await call(client, 'get_events', { taskId: task.id, after: 0 });
  assert.equal(first.data.events.length, 1);
  assert.equal(first.data.nextSequence, 1);
  let offset = 0;
  let assembled = '';
  let hash = '';
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const response = await call(client, 'get_events', {
      taskId: task.id,
      after: 1,
      payloadOffset: offset,
      payloadLimit: 4096,
    });
    assert.notEqual(response.raw.isError, true);
    assert.ok(JSON.stringify(response.raw).length < 25_000);
    const chunk = response.data.events[0]!.payloadChunk!;
    assembled += chunk.chunk;
    hash = chunk.sha256;
    if (response.data.nextPayloadOffset === null) {
      assert.equal(response.data.nextSequence, 2);
      break;
    }
    assert.equal(response.data.nextSequence, 1);
    assert.ok(response.data.nextPayloadOffset > offset);
    offset = response.data.nextPayloadOffset;
  }
  assert.deepEqual(JSON.parse(assembled), large);
  assert.equal(createHash('sha256').update(assembled).digest('hex'), hash);
  const last = await call(client, 'get_events', { taskId: task.id, after: 2 });
  assert.equal(last.data.events[0]?.type, 'turn.finished');
  assert.equal(last.data.nextSequence, 3);
  assert.equal(last.data.hasMore, false);
});

test('large results are paged losslessly, omitted from status/list, and expose verification separately', async (t) => {
  const f = await fixture(t);
  const client = await connect(f);
  const task = await submit(f, client);
  const assignment = claim(f);
  const result: Json = {
    summary: 'Agent said complete.',
    log: 'line of evidence 中文 😀\n'.repeat(7500),
    verification: [
      {
        name: 'real test report',
        exitCode: 1,
        stdout: 'test failure output',
        timedOut: false,
        cancelled: false,
      },
    ],
  };
  f.store.complete(f.device.id, task.id, assignment.leaseToken, { outcome: 'succeeded', result });
  const status = await call(client, 'get_task', { taskId: task.id });
  assert.equal(status.data.task.status, 'succeeded');
  assert.equal(status.data.task.verification.status, 'failed');
  assert.equal(JSON.stringify(status.raw).includes('line of evidence'), false);
  assert.equal(
    JSON.stringify((await call(client, 'list_tasks')).raw).includes('line of evidence'),
    false,
  );
  let offset = 0;
  let assembled = '';
  let sha256: string | undefined;
  for (let i = 0; i < 100; i++) {
    const reply = await call(client, 'get_result', {
      taskId: task.id,
      offset,
      limit: 32_768,
      ...(sha256 ? { expectedSha256: sha256 } : {}),
    });
    assert.equal(reply.data.ready, true);
    assert.equal(reply.data.verification.status, 'failed');
    assert.ok(reply.data.chunk && reply.data.chunk.length <= 32_768);
    assert.ok(Buffer.byteLength(JSON.stringify(reply.raw), 'utf8') < 150_000);
    assembled += reply.data.chunk;
    sha256 = reply.data.sha256;
    if (reply.data.nextOffset === null) break;
    assert.ok(reply.data.nextOffset > offset);
    offset = reply.data.nextOffset;
  }
  assert.deepEqual(JSON.parse(assembled), result);
  assert.equal(createHash('sha256').update(assembled).digest('hex'), sha256);
  assert.equal(
    (await call(client, 'get_result', { taskId: task.id, expectedSha256: '0'.repeat(64) })).data
      .error.code,
    'RESULT_CHANGED',
  );
});

test('verification does not equate agent completion with passing tests', async (t) => {
  const f = await fixture(t);
  const client = await connect(f);
  const pending = await submit(f, client, 'verification-pending');
  assert.equal(
    (await call(client, 'get_result', { taskId: pending.id })).data.verification.status,
    'not_reported',
  );
  const a = claim(f);
  f.store.complete(f.device.id, pending.id, a.leaseToken, {
    outcome: 'succeeded',
    result: { summary: 'done', verification: [] },
  });
  assert.equal(
    (await call(client, 'get_result', { taskId: pending.id })).data.verification.status,
    'not_run',
  );
  const cases: Array<{ name: string; result: Json; status: string }> = [
    {
      name: 'passed',
      result: { verification: [{ exitCode: 0, timedOut: false, cancelled: false }] },
      status: 'passed',
    },
    {
      name: 'no-report',
      result: { summary: 'The host did not return verification evidence.' },
      status: 'not_reported',
    },
    {
      name: 'missing',
      result: { verification: [{ name: 'No actual exit code' }] },
      status: 'incomplete',
    },
    {
      name: 'timeout',
      result: { verification: [{ exitCode: 0, timedOut: true }] },
      status: 'failed',
    },
  ];
  for (const example of cases) {
    const task = await submit(f, client, `verification-${example.name}`);
    const assignment = claim(f);
    f.store.complete(f.device.id, task.id, assignment.leaseToken, {
      outcome: 'succeeded',
      result: example.result,
    });
    assert.equal(
      (await call(client, 'get_result', { taskId: task.id })).data.verification.status,
      example.status,
    );
  }
});

test('cancellation reports request versus confirmed stop; unknown parents cannot be continued', async (t) => {
  const f = await fixture(t);
  const client = await connect(f);
  const queued = await submit(f, client, 'cancel-queued-task');
  assert.equal(
    (await call(client, 'cancel_task', { taskId: queued.id, requestKey: 'cancel-queued-command' }))
      .data.task.status,
    'cancelled',
  );
  const child = await call(client, 'continue_task', {
    parentTaskId: queued.id,
    requestKey: 'continue-cancelled',
    prompt: 'Try the revised instructions.',
  });
  assert.equal(child.data.task.status, 'queued');
  const assignment = claim(f);
  assert.equal(assignment.task.id, child.data.task.id);
  assert.equal(
    (
      await call(client, 'cancel_task', {
        taskId: assignment.task.id,
        requestKey: 'cancel-running-command',
      })
    ).data.task.status,
    'cancel_requested',
  );
  f.now += 90_001;
  const unknown = await call(client, 'get_task', { taskId: assignment.task.id });
  assert.equal(unknown.data.task.status, 'unknown');
  const refused = await call(client, 'continue_task', {
    parentTaskId: assignment.task.id,
    requestKey: 'continue-unknown',
    prompt: 'Must not run automatically.',
  });
  assert.equal(refused.data.error.code, 'PARENT_NOT_TERMINAL');
});

test('permission replies preserve child-session identity and require a pending matching interaction', async (t) => {
  const f = await fixture(t);
  const client = await connect(f);
  const task = await submit(f, client, 'permission-task');
  const assignment = claim(f);
  f.store.appendEvents(f.device.id, task.id, assignment.leaseToken, [
    {
      sequence: 1,
      type: 'permission.requested',
      payload: {
        sessionId: 'child-session',
        requestId: 'permission-1',
        request: { tool: 'edit_file', path: 'file.ts' },
      },
    },
  ]);
  const base = {
    taskId: task.id,
    sessionId: 'child-session',
    requestId: 'permission-1',
    decision: 'allowOnce',
  };
  for (const [index, extra] of [
    { sessionId: 'session_main' },
    { requestId: 'permission-other' },
  ].entries()) {
    const failed = await call(client, 'reply_permission', {
      ...base,
      ...extra,
      requestKey: `permission-wrong-${index}`,
    });
    assert.equal(failed.data.error.code, 'INTERACTION_NOT_PENDING');
  }
  const replied = await call(client, 'reply_permission', {
    ...base,
    requestKey: 'permission-confirmed-by-user',
  });
  assert.equal(replied.data.command.status, 'pending');
  assert.equal(
    f.store.commands(task.id)[0]?.payload &&
      (f.store.commands(task.id)[0]!.payload as Record<string, Json>).sessionId,
    'child-session',
  );
  assert.equal(
    (
      await call(client, 'reply_permission', {
        ...base,
        requestKey: 'permission-confirmed-by-user',
      })
    ).data.command.id,
    replied.data.command.id,
  );
  assert.equal(
    (await call(client, 'reply_permission', { ...base, requestKey: 'permission-second-decision' }))
      .data.error.code,
    'INTERACTION_NOT_PENDING',
  );
  f.store.ackCommand(f.device.id, task.id, assignment.leaseToken, replied.data.command.id, {
    status: 'applied',
  });
  const status = await call(client, 'get_task', { taskId: task.id });
  assert.equal(status.data.recentCommands[0]?.status, 'applied');
});

test('question answers cannot reference invented choices or another session', async (t) => {
  const f = await fixture(t);
  const client = await connect(f);
  const task = await submit(f, client, 'questionnaire-task');
  const assignment = claim(f);
  f.store.appendEvents(f.device.id, task.id, assignment.leaseToken, [
    {
      sequence: 1,
      type: 'question.requested',
      payload: {
        sessionId: 'child-question',
        requestId: 'question-1',
        request: {
          steps: [
            {
              id: 'target',
              selectionMode: 'single',
              required: true,
              allowOther: false,
              options: [
                { id: 'staging', label: 'Staging' },
                { id: 'production', label: 'Production' },
              ],
            },
          ],
        },
      },
    },
  ]);
  const base = { taskId: task.id, sessionId: 'child-question', requestId: 'question-1' };
  assert.equal(
    (
      await call(client, 'answer_question', {
        ...base,
        requestKey: 'question-fake-answer',
        answers: [{ stepId: 'target', selectedOptionIds: ['invented'], selectedOther: false }],
      })
    ).data.error.code,
    'ANSWER_MISMATCH',
  );
  assert.equal(
    (
      await call(client, 'answer_question', {
        ...base,
        sessionId: 'wrong-session',
        requestKey: 'question-wrong-session',
        answers: [{ stepId: 'target', selectedOptionIds: ['staging'], selectedOther: false }],
      })
    ).data.error.code,
    'INTERACTION_NOT_PENDING',
  );
  const correct = await call(client, 'answer_question', {
    ...base,
    requestKey: 'question-explicit-answer',
    answers: [{ stepId: 'target', selectedOptionIds: ['staging'], selectedOther: false }],
  });
  assert.equal(correct.data.command.status, 'pending');
});

test('pagination boundaries, invalid schemas and infrastructure errors do not leak large bodies or stacks', async (t) => {
  const f = await fixture(t);
  const client = await connect(f);
  const task = await submit(f, client);
  const invalid = await client.callTool({
    name: 'get_result',
    arguments: { taskId: task.id, limit: 100_000 },
  });
  assert.equal(invalid.isError, true);
  const strict = await client.callTool({
    name: 'submit_task',
    arguments: {
      projectId: f.project.id,
      requestKey: 'extra-shell-field',
      prompt: 'Safe task',
      shellCommand: 'must not be accepted',
    },
  });
  assert.equal(strict.isError, true);
  assert.equal(f.store.listTasks().length, 1);
  const oversized = await fetch(f.url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer writer',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'submit_task', arguments: { prompt: 'x'.repeat(600_000) } },
    }),
  });
  assert.equal(oversized.status, 413);
  const method = await fetch(f.url, { headers: { Authorization: 'Bearer writer' } });
  assert.equal(method.status, 405);
  f.store.close();
  const error = await call(client, 'list_projects');
  assert.equal(error.data.error.code, 'INTERNAL_ERROR');
  const text = JSON.stringify(error.raw);
  assert.equal(text.includes('sqlite'), false);
  assert.equal(text.includes('file://'), false);
  assert.equal(text.includes('at '), false);
});
