import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApplication, type ApplicationOptions } from '../src/app.js';
import { initConfig } from '../src/config.js';
import { RelayStore } from '../src/store.js';
import type { Assignment, Device, Project, Task, TaskCommand } from '../src/types.js';

interface HttpOptions {
  method?: string;
  token?: string;
  json?: unknown;
  rawBody?: string;
  headers?: Record<string, string | string[]>;
}
interface HttpResponse<T> {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  body: T;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface Paired {
  device: Device;
  token: string;
}
type LogRecord = { level: string; code: string; requestId: string };

async function fixture(t: TestContext, options: { publicUrl?: string; store?: RelayStore } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'coderelay-http-'));
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const config = initConfig({
    dataDir: directory,
    port,
    ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
  });
  const logs: LogRecord[] = [];
  const appOptions: ApplicationOptions = {
    log: (event) => logs.push(event),
    ...(options.store ? { store: options.store } : {}),
  };
  const gateway = createApplication(config, appOptions);
  server.on('request', gateway.app);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    gateway.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function request<T = ErrorBody>(
    path: string,
    input: HttpOptions = {},
  ): Promise<HttpResponse<T>> {
    const payload =
      input.rawBody ?? (input.json === undefined ? undefined : JSON.stringify(input.json));
    return new Promise((resolve, reject) => {
      // node:http preserves deliberately malformed Host values; fetch can silently replace them.
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: input.method ?? (payload === undefined ? 'GET' : 'POST'),
          headers: {
            ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
            ...(payload === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': String(Buffer.byteLength(payload)),
                }),
            ...input.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.once('error', reject);
          response.once('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = null;
            if (response.headers['content-type']?.includes('application/json') && text) {
              try {
                body = JSON.parse(text);
              } catch (error) {
                reject(error);
                return;
              }
            }
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              text,
              body: body as T,
            });
          });
        },
      );
      req.setTimeout(10_000, () => req.destroy(new Error('HTTP fixture request timed out.')));
      req.once('error', reject);
      req.end(payload);
    });
  }
  async function access(scopes = ['tasks:read', 'tasks:write']): Promise<string> {
    const result = await request<{ token: string }>('/v1/admin/access-tokens', {
      token: config.adminToken,
      json: { name: 'HTTP fixture client', scopes },
    });
    assert.equal(result.status, 201, result.text);
    return result.body.token;
  }
  async function pair(name = 'HTTP fixture device'): Promise<Paired> {
    const code = await request<{ code: string }>('/v1/admin/pairing-codes', {
      token: config.adminToken,
      json: { name },
    });
    assert.equal(code.status, 201, code.text);
    const paired = await request<Paired>('/v1/devices/pair', {
      json: { code: code.body.code, name, version: 'test-only' },
    });
    assert.equal(paired.status, 200, paired.text);
    return paired.body;
  }
  async function bind(paired: Paired): Promise<Project> {
    const bound = await request<{ project: Project }>('/v1/worker/projects', {
      token: paired.token,
      json: {
        name: 'HTTP fixture project',
        sessionId: `session-${paired.device.id}`,
        workspaceDir: join(directory, 'workspace'),
        workspaceKey: createHash('sha256').update(directory).digest('hex'),
        model: { providerId: 'synthetic', modelId: 'contract-test', variant: '' },
      },
    });
    assert.equal(bound.status, 200, bound.text);
    return bound.body.project;
  }
  async function submit(
    project: Project,
    token: string,
    requestKey = 'http-fixture-task',
  ): Promise<Task> {
    const result = await request<{ task: Task }>('/v1/tasks', {
      token,
      json: {
        projectId: project.id,
        requestKey,
        prompt: 'Synthetic HTTP contract; no real agent dispatch.',
      },
    });
    assert.equal(result.status, 201, result.text);
    return result.body.task;
  }
  async function claim(paired: Paired): Promise<Assignment> {
    const result = await request<{ assignment: Assignment }>('/v1/worker/claim', {
      token: paired.token,
      json: {},
    });
    assert.equal(result.status, 200, result.text);
    assert.ok(result.body.assignment);
    return result.body.assignment;
  }
  return { config, directory, gateway, logs, request, access, pair, bind, submit, claim };
}

function assertError(response: HttpResponse<ErrorBody>, status: number, code?: string): void {
  assert.equal(response.status, status, response.text);
  assert.equal(typeof response.body.error.message, 'string');
  if (code) assert.equal(response.body.error.code, code, response.text);
}
function cli(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
    );
    child.stdin!.end(stdin ?? '');
  });
}
function duplicateHostRequest(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => socket.destroy(new Error('Raw HTTP fixture timed out.')));
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('end', () => resolve(Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1])));
    socket.once('connect', () =>
      socket.write(
        'GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n',
      ),
    );
  });
}

test('HTTP permits configured and loopback hosts, rejects hostile or malformed authority, and distrusts forwarding headers', async (t) => {
  const f = await fixture(t, { publicUrl: 'https://relay.example.test' });
  for (const host of [
    'relay.example.test',
    'relay.example.test:443',
    'localhost',
    `127.0.0.1:${f.config.port}`,
    '[::1]',
  ]) {
    assert.equal((await f.request('/healthz', { headers: { Host: host } })).status, 200, host);
  }
  for (const host of [
    'evil.example',
    'relay.example.test.evil.example',
    'evil.example@127.0.0.1',
    '127.0.0.1/ignored-path',
    '127.0.0.1?ignored=query',
    '127.0.0.1#ignored',
    '127.0.0.1\\ignored',
    '127.0.0.1:badport',
  ]) {
    const result = await f.request('/healthz', { headers: { Host: host } });
    assert.ok(result.status === 400 || result.status === 403, `${host}: ${result.status}`);
  }
  assertError(
    await f.request('/healthz', {
      headers: { Host: 'evil.example', 'X-Forwarded-Host': 'relay.example.test' },
    }),
    403,
    'INVALID_HOST',
  );
  assert.equal(await duplicateHostRequest(f.config.port), 400);
  assert.equal(
    (
      await f.request('/healthz', {
        headers: {
          'X-Forwarded-Host': 'evil.example',
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-For': '198.51.100.1',
        },
      })
    ).status,
    200,
  );
});

test('HTTP origin guard and security headers cover discovery and public health endpoints', async (t) => {
  const f = await fixture(t);
  for (const origin of ['https://evil.example', 'null', `${f.config.publicUrl}.evil.example`]) {
    assertError(
      await f.request('/.well-known/oauth-authorization-server', { headers: { Origin: origin } }),
      403,
      'INVALID_ORIGIN',
    );
  }
  for (const path of ['/healthz', '/readyz', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await f.request(path, { headers: { Origin: f.config.publicUrl } });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-powered-by'], undefined);
    assert.match(String(response.headers['x-request-id']), /^[a-f0-9-]{36}$/);
  }
});

test('administrator, device, client and unknown credentials cannot cross HTTP role boundaries', async (t) => {
  const f = await fixture(t);
  const paired = await f.pair();
  const client = await f.access();
  const roleCases: Array<[string, number, number, number, number]> = [
    [f.config.adminToken, 200, 401, 401, 401],
    [paired.token, 401, 200, 401, 401],
    [client, 401, 401, 200, 405],
    ['cr_unknown_credential_1234567890', 401, 401, 401, 401],
  ];
  for (const [token, admin, worker, reader, mcp] of roleCases) {
    assert.equal((await f.request('/v1/admin/status', { token })).status, admin);
    assert.equal((await f.request('/v1/worker/heartbeat', { token, json: {} })).status, worker);
    assert.equal((await f.request('/v1/projects', { token })).status, reader);
    assert.equal((await f.request('/mcp', { token })).status, mcp);
  }
  const challenge = await f.request('/mcp');
  assertError(challenge, 401);
  assert.equal(
    challenge.headers['www-authenticate'],
    `Bearer resource_metadata="${f.config.publicUrl}/.well-known/oauth-protected-resource/mcp"`,
  );
  const unavailableStream = await f.request('/mcp', { token: client });
  assert.equal(unavailableStream.headers.allow, 'POST');
  for (const [path, credential] of [
    ['/v1/admin/no-such-route', f.config.adminToken],
    ['/v1/worker/no-such-route', paired.token],
  ] as const) {
    const response = await f.request(path, { token: credential });
    assertError(response, 404, 'NOT_FOUND');
    assert.equal(response.headers['www-authenticate'], undefined);
  }
});

test('HTTP bearer schemes are case insensitive and URL/body credentials never authenticate a caller', async (t) => {
  const f = await fixture(t);
  const token = await f.access();
  for (const scheme of ['Bearer', 'bearer', 'bEaReR']) {
    assert.equal(
      (await f.request('/v1/projects', { headers: { Authorization: `${scheme} ${token}` } }))
        .status,
      200,
      scheme,
    );
  }
  for (const parameter of ['access_token', 'token', 'adminToken']) {
    const response = await f.request(`/v1/projects?${parameter}=${token}`);
    assertError(response, 400, 'TOKEN_IN_URL');
    assert.ok(!response.text.includes(token));
  }
  assertError(
    await f.request('/v1/admin/connector-codes', { json: { token: f.config.adminToken } }),
    401,
  );
  assertError(
    await f.request('/v1/projects', { headers: { Authorization: `Basic ${token}` } }),
    401,
  );
  assertError(
    await f.request('/v1/projects', {
      headers: { Authorization: [`Bearer ${token}`, `Bearer ${token}`] },
    }),
    401,
  );
});

test('REST read and write scopes are independently enforced before store operations', async (t) => {
  const f = await fixture(t);
  const paired = await f.pair();
  const project = await f.bind(paired);
  const reader = await f.access(['tasks:read']);
  const writer = await f.access(['tasks:write']);
  const task = await f.submit(project, writer);
  for (const path of [
    '/v1/projects',
    '/v1/devices',
    '/v1/tasks',
    `/v1/tasks/${task.id}`,
    `/v1/tasks/${task.id}/events`,
    `/v1/tasks/${task.id}/commands`,
  ]) {
    assert.equal((await f.request(path, { token: reader })).status, 200, path);
    assertError(await f.request(path, { token: writer }), 403, 'INSUFFICIENT_SCOPE');
  }
  const writes: Array<[string, unknown]> = [
    [
      '/v1/tasks',
      { projectId: project.id, requestKey: 'reader-cannot-submit', prompt: 'Should be denied.' },
    ],
    [`/v1/tasks/${task.id}/cancel`, { requestKey: 'reader-cannot-cancel' }],
    [
      `/v1/tasks/${task.id}/commands`,
      { requestKey: 'reader-cannot-steer', kind: 'steer', payload: { text: 'Should be denied.' } },
    ],
  ];
  for (const [path, body] of writes)
    assertError(await f.request(path, { token: reader, json: body }), 403, 'INSUFFICIENT_SCOPE');
  const unchanged = await f.request<{ task: Task }>(`/v1/tasks/${task.id}`, { token: reader });
  assert.equal(unchanged.body.task.status, 'queued');
  assert.equal(
    (await f.request<{ tasks: Task[] }>('/v1/tasks', { token: reader })).body.tasks.length,
    1,
  );
});

test('official MCP client uses real HTTP-issued credentials and cannot bypass the gateway read scope', async (t) => {
  const f = await fixture(t);
  const paired = await f.pair();
  const project = await f.bind(paired);
  const reader = await f.access(['tasks:read']);
  const client = new Client(
    { name: 'HTTP authentication integration', version: 'test' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${f.config.publicUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${reader}` } },
      }),
    );
    const projects = await client.callTool({ name: 'list_projects', arguments: {} });
    const inventory = projects.content.find((item) => item.type === 'text');
    assert.ok(inventory && inventory.type === 'text');
    assert.equal(JSON.parse(inventory.text).projects[0].id, project.id);
    const denied = await client.callTool({
      name: 'submit_task',
      arguments: {
        projectId: project.id,
        requestKey: 'mcp-readonly-denied',
        prompt: 'This must never be queued.',
      },
    });
    assert.equal(denied.isError, true);
    const details = denied.content.find((item) => item.type === 'text');
    assert.ok(details && details.type === 'text');
    assert.equal(JSON.parse(details.text).error.code, 'INSUFFICIENT_SCOPE');
    assert.deepEqual(
      (await f.request<{ tasks: Task[] }>('/v1/tasks', { token: reader })).body.tasks,
      [],
    );
  } finally {
    await client.close();
  }
});

test('administrator revocation works through HTTP and CLI stdin without returning or logging token values', async (t) => {
  const f = await fixture(t);
  const first = await f.access();
  const second = await f.access();
  assertError(
    await f.request('/v1/admin/access-tokens/revoke', { token: first, json: { token: second } }),
    401,
  );
  const revoked = await f.request<{ revoked: boolean }>('/v1/admin/access-tokens/revoke', {
    token: f.config.adminToken,
    json: { token: first },
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.ok(!revoked.text.includes(first));
  assertError(await f.request('/v1/projects', { token: first }), 401);
  assert.equal((await f.request('/v1/projects', { token: second })).status, 200);
  const output = await cli(['revoke-token', '--data-dir', f.directory], `${second}\n`);
  assert.equal(JSON.parse(output.stdout).revoked, true);
  assert.ok(!`${output.stdout}${output.stderr}`.includes(second));
  assertError(await f.request('/v1/projects', { token: second }), 401);
  assert.ok(!JSON.stringify(f.logs).includes(first));
  assert.ok(!JSON.stringify(f.logs).includes(second));
});

test('HTTP parser rejects malformed JSON, nonobject schemas, wrong media types and oversized bodies without echoing input', async (t) => {
  const f = await fixture(t);
  const path = '/v1/admin/connector-codes';
  for (const rawBody of [`{"secret":"${f.config.adminToken}"`, 'null', '123', '"secret"']) {
    const response = await f.request(path, { token: f.config.adminToken, rawBody });
    assertError(response, 400, 'INVALID_JSON');
    assert.ok(!response.text.includes(f.config.adminToken));
  }
  for (const json of [[], { unexpected: f.config.adminToken }]) {
    assertError(await f.request(path, { token: f.config.adminToken, json }), 400, 'INVALID_INPUT');
  }
  assertError(
    await f.request(path, {
      token: f.config.adminToken,
      rawBody: '{}',
      headers: { 'Content-Type': 'text/plain' },
    }),
    415,
    'UNSUPPORTED_MEDIA_TYPE',
  );
  const oversized = await f.request(path, {
    token: f.config.adminToken,
    json: { text: 'x'.repeat(601 * 1024) },
  });
  assertError(oversized, 413, 'PAYLOAD_TOO_LARGE');
  assert.ok(oversized.text.length < 500);
  assert.ok(!oversized.text.includes(f.directory));
  assert.equal(
    (await f.request(path, { token: f.config.adminToken, json: {} })).status,
    201,
    'parser failures must not poison the next request',
  );
  const client = await f.access();
  const largeRpc = await f.request('/mcp', {
    token: client,
    json: {
      jsonrpc: '2.0',
      id: 'oversized',
      method: 'tools/call',
      params: { text: 'x'.repeat(513 * 1024) },
    },
  });
  assert.equal(largeRpc.status, 413);
  assert.ok(largeRpc.text.length < 500);
});

test('HTTP worker event batches and completion payloads enforce byte limits before changing task state', async (t) => {
  const f = await fixture(t);
  const token = await f.access();
  const paired = await f.pair();
  const project = await f.bind(paired);
  const task = await f.submit(project, token);
  const assignment = await f.claim(paired);
  const eventsPath = `/v1/worker/tasks/${task.id}/events`;
  const leaseToken = assignment.leaseToken;
  assertError(
    await f.request(eventsPath, {
      token: paired.token,
      json: {
        leaseToken,
        events: Array.from({ length: 101 }, (_, index) => ({
          sequence: index + 1,
          type: 'text.delta',
          payload: {},
        })),
      },
    }),
    400,
    'INVALID_INPUT',
  );
  assertError(
    await f.request(eventsPath, {
      token: paired.token,
      json: {
        leaseToken,
        events: [{ sequence: 1, type: 'text.delta', payload: { text: '界'.repeat(45_000) } }],
      },
    }),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  const events = await f.request<{ events: unknown[] }>(`/v1/tasks/${task.id}/events`, { token });
  assert.deepEqual(events.body.events, []);
  assertError(
    await f.request(`/v1/worker/tasks/${task.id}/complete`, {
      token: paired.token,
      json: { leaseToken, outcome: 'succeeded', result: { text: 'x'.repeat(512 * 1024) } },
    }),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  const running = await f.request<{ task: Task }>(`/v1/worker/tasks/${task.id}`, {
    token: paired.token,
  });
  assert.equal(running.body.task.status, 'running');
  const accepted = await f.request<{ acknowledgedSequence: number }>(eventsPath, {
    token: paired.token,
    json: {
      leaseToken,
      events: [
        { sequence: 1, type: 'text.delta', time: Date.now(), payload: { text: '合法事件' } },
      ],
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.acknowledgedSequence, 1);
  const result = { summary: 'HTTP fixture finished.', details: 'x'.repeat(256 * 1024) };
  const completed = await f.request<{ task: Task }>(`/v1/worker/tasks/${task.id}/complete`, {
    token: paired.token,
    json: { leaseToken, outcome: 'succeeded', result },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.task.status, 'succeeded');
  const details = await f.request<{ task: Task }>(`/v1/tasks/${task.id}`, { token });
  assert.deepEqual(
    details.body.task.result,
    result,
    'single-task details preserve the full bounded result',
  );
  for (const [path, credential] of [
    ['/v1/tasks', token],
    ['/v1/admin/status', f.config.adminToken],
  ] as const) {
    const listing = await f.request<{ tasks: Array<Record<string, unknown>> }>(path, {
      token: credential,
    });
    assert.equal(listing.status, 200);
    assert.ok(listing.text.length < 16_000);
    assert.equal(
      Object.hasOwn(listing.body.tasks[0]!, 'result'),
      false,
      'list summaries must not amplify large result bodies',
    );
  }
});

test('worker recovery status is device-owned and normal task/inventory/audit responses never contain bearer or lease secrets', async (t) => {
  const f = await fixture(t);
  const token = await f.access();
  const first = await f.pair('First device');
  const second = await f.pair('Second device');
  const project = await f.bind(first);
  const task = await f.submit(project, token);
  const assignment = await f.claim(first);
  const path = `/v1/worker/tasks/${task.id}`;
  assert.equal((await f.request(path, { token: first.token })).status, 200);
  const alien = await f.request(path, { token: second.token });
  const missing = await f.request('/v1/worker/tasks/no-such-task', { token: second.token });
  assertError(alien, 404);
  assertError(missing, 404);
  assert.deepEqual(alien.body, missing.body);
  const writePaths: Array<[string, unknown]> = [
    ['heartbeat', { leaseToken: assignment.leaseToken }],
    ['events', { leaseToken: assignment.leaseToken, events: [] }],
    ['complete', { leaseToken: assignment.leaseToken, outcome: 'succeeded', result: null }],
    ['commands/no-such-command/ack', { leaseToken: assignment.leaseToken, status: 'applied' }],
  ];
  for (const [suffix, body] of writePaths) {
    const denied = await f.request(`${path}/${suffix}`, { token: second.token, json: body });
    const absent = await f.request(`/v1/worker/tasks/no-such-task/${suffix}`, {
      token: second.token,
      json: body,
    });
    assertError(denied, 404);
    assert.deepEqual(denied.body, absent.body);
  }
  assertError(await f.request(path, { token }), 401);
  for (const [route, credential] of [
    [path, first.token],
    ['/v1/projects', token],
    ['/v1/devices', token],
    ['/v1/tasks', token],
    [`/v1/tasks/${task.id}`, token],
    ['/v1/admin/status', f.config.adminToken],
    ['/v1/admin/audit', f.config.adminToken],
  ] as const) {
    const response = await f.request(route, { token: credential });
    assert.equal(response.status, 200, response.text);
    for (const secret of [
      token,
      first.token,
      second.token,
      assignment.leaseToken,
      f.config.adminToken,
      createHash('sha256').update(first.token).digest('hex'),
      createHash('sha256').update(assignment.leaseToken).digest('hex'),
    ])
      assert.ok(!response.text.includes(secret), `${route} exposed a credential or verifier`);
  }
  assert.equal(
    (
      await f.request(`/v1/admin/devices/${first.device.id}/revoke`, {
        token: f.config.adminToken,
        json: {},
      })
    ).status,
    200,
  );
  assertError(await f.request(path, { token: first.token }), 401);
});

test('worker command polling and acknowledgement paths preserve durable receipt shapes', async (t) => {
  const f = await fixture(t);
  const token = await f.access();
  const paired = await f.pair();
  const project = await f.bind(paired);
  const task = await f.submit(project, token);
  const assignment = await f.claim(paired);
  const created = await f.request<{ command: TaskCommand }>(`/v1/tasks/${task.id}/commands`, {
    token,
    json: {
      requestKey: 'http-command-steer',
      kind: 'steer',
      payload: { text: 'Additional explicit fixture guidance.' },
    },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.command.status, 'pending');
  const heartbeat = await f.request<{ leaseExpiresAt: number; commands: TaskCommand[] }>(
    `/v1/worker/tasks/${task.id}/heartbeat`,
    { token: paired.token, json: { leaseToken: assignment.leaseToken } },
  );
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.commands[0]?.id, created.body.command.id);
  assert.ok(heartbeat.body.leaseExpiresAt > Date.now());
  const receipt = await f.request<{ command: TaskCommand }>(
    `/v1/worker/tasks/${task.id}/commands/${created.body.command.id}/ack`,
    {
      token: paired.token,
      json: {
        leaseToken: assignment.leaseToken,
        status: 'applied',
        message: 'Synthetic Host receipt.',
      },
    },
  );
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.command.status, 'applied');
  const listing = await f.request<{ commands: TaskCommand[] }>(`/v1/tasks/${task.id}/commands`, {
    token,
  });
  assert.deepEqual(listing.body.commands, [receipt.body.command]);
});

test('HTTP pagination and resource IDs reject malformed inputs with bounded private errors', async (t) => {
  const f = await fixture(t);
  const token = await f.access();
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=not-a-number',
    'limit=1&limit=2',
    'before=',
  ]) {
    assertError(await f.request(`/v1/tasks?${query}`, { token }), 400, 'INVALID_INPUT');
  }
  for (const query of ['after=-1', 'after=9007199254740992', 'limit=101']) {
    assertError(
      await f.request(`/v1/admin/audit?${query}`, { token: f.config.adminToken }),
      400,
      'INVALID_INPUT',
    );
  }
  const response = await f.request(`/v1/tasks/${'x'.repeat(257)}`, { token });
  assertError(response, 400, 'INVALID_INPUT');
  assert.ok(response.text.length < 500);
  assert.ok(!response.text.includes(f.directory));
});

test('unexpected internal exceptions produce a request ID and sanitized logs without stack, path or secret', async (t) => {
  const sensitive = 'SENSITIVE_INTERNAL_DATABASE_PATH_AND_CREDENTIAL';
  class FailedStore extends RelayStore {
    override projects(): Project[] {
      throw new Error(`${sensitive}: /private/coderelay/relay.sqlite`);
    }
  }
  const store = new FailedStore({ filename: ':memory:' });
  t.after(() => store.close());
  const f = await fixture(t, { store });
  const token = await f.access();
  const response = await f.request('/v1/projects', { token });
  assertError(response, 500, 'INTERNAL_ERROR');
  assert.ok(!response.text.includes(sensitive));
  assert.ok(!response.text.includes('/private/'));
  assert.deepEqual(f.logs, [
    { level: 'error', code: 'INTERNAL_ERROR', requestId: String(response.headers['x-request-id']) },
  ]);
  assert.ok(!JSON.stringify(f.logs).includes(token));
});

test('CLI backup snapshots an active WAL database and emits a complete private manifest without credentials', async (t) => {
  const f = await fixture(t);
  const token = await f.access();
  const paired = await f.pair();
  const project = await f.bind(paired);
  const task = await f.submit(project, token);
  const destination = join(f.directory, 'private-backup');
  const result = await cli(['backup', '--data-dir', f.directory, '--output', destination]);
  const output = JSON.parse(result.stdout) as { backup: string; files: string[] };
  assert.equal(output.backup, destination);
  assert.deepEqual(output.files.sort(), ['auth.sqlite', 'config.json', 'relay.sqlite']);
  for (const secret of [f.config.adminToken, paired.token, token])
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as {
    version: number;
    files: Array<{ name: string; sha256: string }>;
  };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.files.length, 3);
  for (const item of manifest.files) {
    const path = join(destination, item.name);
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), item.sha256);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o700);
  const snapshot = new DatabaseSync(join(destination, 'relay.sqlite'), { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    const row = snapshot.prepare('SELECT id,status FROM tasks WHERE id=?').get(task.id);
    assert.equal(row?.id, task.id);
    assert.equal(row?.status, 'queued');
  } finally {
    snapshot.close();
  }
  const authSnapshot = new DatabaseSync(join(destination, 'auth.sqlite'), { readOnly: true });
  try {
    assert.equal(authSnapshot.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally {
    authSnapshot.close();
  }
});
