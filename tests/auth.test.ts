import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { AuthService } from '../src/auth.js';

const PUBLIC_URL = 'https://relay.example';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const REDIRECT = 'https://client.example/callback';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
interface Client {
  client_id: string;
}
interface Pair {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
}
interface Page {
  requestId: string;
  csrf: string;
  cookie: string;
  verifier: string;
  client: Client;
  redirect: string;
}
interface Fixture {
  service: AuthService;
  filename: string;
  url: string;
  server: Server;
  now: number;
  restart: () => Promise<void>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'coderelay-auth-'));
  const f = { filename: join(directory, 'auth.sqlite'), now: Date.UTC(2026, 0, 1) } as Fixture;
  const boot = async (): Promise<void> => {
    f.service = new AuthService({ filename: f.filename, publicUrl: PUBLIC_URL, now: () => f.now });
    const app = express();
    f.service.installRoutes(app);
    f.server = createServer(app);
    await new Promise<void>((resolve) => f.server.listen(0, '127.0.0.1', resolve));
    const address = f.server.address();
    assert.ok(address && typeof address !== 'string');
    f.url = `http://127.0.0.1:${address.port}`;
  };
  const stop = async (): Promise<void> => {
    f.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      f.server.close((error) => (error ? reject(error) : resolve())),
    );
    f.service.close();
  };
  f.restart = async () => {
    await stop();
    await boot();
  };
  await boot();
  t.after(async () => {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return f;
}

async function jsonPost(f: Fixture, path: string, body: unknown): Promise<Response> {
  return fetch(`${f.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}
async function formPost(
  f: Fixture,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${f.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}
async function register(f: Fixture, overrides: Record<string, unknown> = {}): Promise<Client> {
  const response = await jsonPost(f, '/oauth/register', {
    client_name: 'Test MCP client',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
    ...overrides,
  });
  assert.equal(response.status, 201);
  return (await response.json()) as Client;
}
function authParams(client: Client, verifier: string): Record<string, string> {
  return {
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    resource: RESOURCE,
    scope: 'tasks:read tasks:write',
    state: 'state-original',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}
async function page(
  f: Fixture,
  client: Client,
  overrides: Record<string, string> = {},
): Promise<Page> {
  const verifier = randomBytes(48).toString('base64url');
  const params = { ...authParams(client, verifier), ...overrides };
  const response = await fetch(`${f.url}/oauth/authorize?${new URLSearchParams(params)}`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(requestId && csrf);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  return { requestId, csrf, cookie, verifier, client, redirect: params.redirect_uri! };
}
function consentFields(p: Page, connectorCode: string): Record<string, string> {
  return {
    request_id: p.requestId,
    csrf: p.csrf,
    connector_code: connectorCode,
    decision: 'allow',
  };
}
async function approve(
  f: Fixture,
  p: Page,
  connectorCode = f.service.issueConnectorCode().code,
): Promise<string> {
  const response = await formPost(f, '/oauth/authorize', consentFields(p, connectorCode), {
    Cookie: p.cookie,
    Origin: PUBLIC_URL,
  });
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get('location')!);
  assert.equal(target.searchParams.get('state'), 'state-original');
  assert.equal(target.searchParams.get('iss'), PUBLIC_URL);
  assert.equal(target.searchParams.has('access_token'), false);
  assert.equal(target.searchParams.has('refresh_token'), false);
  const code = target.searchParams.get('code');
  assert.ok(code);
  return code;
}
async function exchange(
  f: Fixture,
  p: Page,
  code: string,
  overrides: Record<string, string> = {},
): Promise<Response> {
  return formPost(f, '/oauth/token', {
    grant_type: 'authorization_code',
    client_id: p.client.client_id,
    code,
    redirect_uri: p.redirect,
    code_verifier: p.verifier,
    resource: RESOURCE,
    ...overrides,
  });
}
async function grant(
  f: Fixture,
  client?: Client,
  scope?: string,
): Promise<{ client: Client; pair: Pair; p: Page; code: string }> {
  const c = client ?? (await register(f));
  const p = await page(f, c, scope ? { scope } : {});
  const code = await approve(f, p);
  const response = await exchange(f, p, code);
  assert.equal(response.status, 200);
  return { client: c, pair: (await response.json()) as Pair, p, code };
}
async function rotate(
  f: Fixture,
  client: Client,
  refresh: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return formPost(f, '/oauth/token', {
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: refresh,
    resource: RESOURCE,
    ...extra,
  });
}

test('OAuth discovery binds the precise protected MCP resource and advertises only supported grants', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/.well-known/oauth-authorization-server`);
  const metadata = (await response.json()) as Record<string, unknown>;
  assert.equal(metadata.issuer, PUBLIC_URL);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(metadata.response_types_supported, ['code']);
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    const resource = (await (await fetch(`${f.url}${path}`)).json()) as Record<string, unknown>;
    assert.equal(resource.resource, RESOURCE);
    assert.deepEqual(resource.authorization_servers, [PUBLIC_URL]);
    assert.deepEqual(resource.bearer_methods_supported, ['header']);
  }
});

test('dynamic registration rejects unsafe callbacks, secrets and unsupported grants', async (t) => {
  const f = await fixture(t);
  await register(f, {
    redirect_uris: [
      'https://chat.example/callback?source=relay',
      'http://127.0.0.1:4573/callback',
      'http://[::1]:4573/callback',
    ],
  });
  const invalidUris = [
    'http://client.example/callback',
    'https://*.example/callback',
    'https://client.example/callback#fragment',
    'https://client.example/callback#',
    'https://user:pass@client.example/callback',
    'javascript:alert(1)',
    'http://127.0.0.1.evil.example/callback',
    'https://client.example/callback?access_token=secret',
    ' https://client.example/callback',
    'https://client.example\\callback',
  ];
  for (const uri of invalidUris) {
    const response = await jsonPost(f, '/oauth/register', { redirect_uris: [uri] });
    assert.equal(response.status, 400, uri);
  }
  for (const extra of [
    { token_endpoint_auth_method: 'client_secret_basic' },
    { grant_types: ['client_credentials'] },
    { response_types: ['token'] },
    { scope: 'admin' },
    { client_secret: 'invented' },
    { redirect_uris: [REDIRECT, REDIRECT] },
  ]) {
    const response = await jsonPost(f, '/oauth/register', { redirect_uris: [REDIRECT], ...extra });
    assert.equal(response.status, 400);
  }
});

test('a complete consent and PKCE exchange issues scoped tokens; authorization code replay revokes its family', async (t) => {
  const f = await fixture(t);
  const { client, pair, p, code } = await grant(f);
  assert.deepEqual(f.service.verifyAccessToken(pair.access_token), {
    id: `oauth:${client.client_id}`,
    clientId: client.client_id,
    scopes: ['tasks:read', 'tasks:write'],
  });
  assert.equal(f.service.verifyAccessToken(pair.refresh_token), null);
  assert.equal(f.service.verifyAccessToken(code), null);
  assert.equal(pair.expires_in, 3600);
  const replay = await exchange(f, p, code);
  assert.equal(replay.status, 400);
  assert.equal(f.service.verifyAccessToken(pair.access_token), null);
  assert.equal((await rotate(f, client, pair.refresh_token)).status, 400);
});

test('authorization requires exact client, redirect, resource, supported scope and PKCE S256', async (t) => {
  const f = await fixture(t);
  const client = await register(f, { scope: 'tasks:read' });
  const verifier = randomBytes(48).toString('base64url');
  const valid = { ...authParams(client, verifier), scope: 'tasks:read' };
  for (const overrides of [
    { client_id: 'unknown' },
    { redirect_uri: `${REDIRECT}/another` },
    { resource: 'https://other.example/mcp' },
    { scope: 'tasks:read tasks:write' },
    { scope: 'admin' },
    { response_type: 'token' },
    { code_challenge_method: 'plain' },
    { code_challenge: 'short' },
    { resource: '' },
  ]) {
    const response = await fetch(
      `${f.url}/oauth/authorize?${new URLSearchParams({ ...valid, ...overrides })}`,
      { redirect: 'manual' },
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.has('location'), false);
  }
});

test('consent enforces cookie + CSRF + origin and rejects parameter replacement without consuming owner code', async (t) => {
  const f = await fixture(t);
  const client = await register(f);
  const p = await page(f, client);
  const code = f.service.issueConnectorCode().code;
  const normal = consentFields(p, code);
  assert.equal((await formPost(f, '/oauth/authorize', normal, { Origin: PUBLIC_URL })).status, 403);
  assert.equal(
    (
      await formPost(
        f,
        '/oauth/authorize',
        { ...normal, csrf: 'bad' },
        { Cookie: p.cookie, Origin: PUBLIC_URL },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await formPost(f, '/oauth/authorize', normal, {
        Cookie: p.cookie,
        Origin: 'https://attacker.example',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await formPost(f, '/oauth/authorize', normal, {
        Cookie: p.cookie,
        'Sec-Fetch-Site': 'cross-site',
      })
    ).status,
    403,
  );
  assert.equal(
    (await formPost(f, '/oauth/authorize', normal, { Cookie: `${p.cookie}; ${p.cookie}` })).status,
    403,
  );
  for (const key of ['client_id', 'redirect_uri', 'resource', 'scope', 'state', 'code_challenge']) {
    assert.equal(
      (
        await formPost(
          f,
          '/oauth/authorize',
          { ...normal, [key]: 'replacement' },
          { Cookie: p.cookie, Origin: PUBLIC_URL },
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await formPost(f, '/oauth/authorize?redirect_uri=https%3A%2F%2Fevil.example', normal, {
        Cookie: p.cookie,
      })
    ).status,
    400,
  );
  const authCode = await approve(f, p, code);
  assert.equal((await exchange(f, p, authCode)).status, 200);
});

test('owner consent codes are one-use, cannot authorize with no code, and denial grants no token', async (t) => {
  const f = await fixture(t);
  const client = await register(f);
  const first = await page(f, client);
  assert.equal(
    (
      await formPost(
        f,
        '/oauth/authorize',
        { request_id: first.requestId, csrf: first.csrf, decision: 'allow' },
        { Cookie: first.cookie },
      )
    ).status,
    403,
  );
  const ownerCode = f.service.issueConnectorCode().code;
  await approve(f, first, ownerCode);
  const second = await page(f, client);
  assert.equal(
    (
      await formPost(f, '/oauth/authorize', consentFields(second, ownerCode), {
        Cookie: second.cookie,
      })
    ).status,
    403,
  );
  const denied = await formPost(
    f,
    '/oauth/authorize',
    { request_id: second.requestId, csrf: second.csrf, decision: 'deny' },
    { Cookie: second.cookie },
  );
  assert.equal(denied.status, 303);
  const location = new URL(denied.headers.get('location')!);
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.has('code'), false);
});

test('code exchange cannot cross clients, redirects, resources or PKCE verifiers', async (t) => {
  const f = await fixture(t);
  const client = await register(f);
  const stranger = await register(f);
  const p = await page(f, client);
  const code = await approve(f, p);
  for (const overrides of [
    { client_id: stranger.client_id },
    { redirect_uri: `${REDIRECT}?different=1` },
    { resource: 'https://other.example/mcp' },
    { resource: '' },
    { code_verifier: 'x'.repeat(43) },
    { scope: 'tasks:read' },
  ]) {
    assert.equal((await exchange(f, p, code, overrides)).status, 400);
  }
  assert.equal((await exchange(f, p, code)).status, 200);
});

test('refresh token rotation detects replay and revokes all descendants but preserves other families', async (t) => {
  const f = await fixture(t);
  const { client, pair } = await grant(f);
  const other = await grant(f, client);
  const rotatedResponse = await rotate(f, client, pair.refresh_token);
  assert.equal(rotatedResponse.status, 200);
  const rotated = (await rotatedResponse.json()) as Pair;
  assert.notEqual(rotated.refresh_token, pair.refresh_token);
  const twiceResponse = await rotate(f, client, rotated.refresh_token);
  const twice = (await twiceResponse.json()) as Pair;
  assert.ok(f.service.verifyAccessToken(twice.access_token));
  assert.equal((await rotate(f, client, pair.refresh_token)).status, 400);
  for (const access of [pair.access_token, rotated.access_token, twice.access_token])
    assert.equal(f.service.verifyAccessToken(access), null);
  assert.equal((await rotate(f, client, twice.refresh_token)).status, 400);
  assert.ok(f.service.verifyAccessToken(other.pair.access_token));
});

test('refresh binds client/audience and can narrow but never increase granted scopes', async (t) => {
  const f = await fixture(t);
  const { client, pair } = await grant(f);
  const stranger = await register(f);
  assert.equal((await rotate(f, stranger, pair.refresh_token)).status, 400);
  assert.equal(
    (await rotate(f, client, pair.refresh_token, { resource: 'https://other.example/mcp' })).status,
    400,
  );
  assert.equal((await rotate(f, client, pair.refresh_token, { scope: 'admin' })).status, 400);
  assert.ok(f.service.verifyAccessToken(pair.access_token));
  const response = await rotate(f, client, pair.refresh_token, { scope: 'tasks:read' });
  assert.equal(response.status, 200);
  const narrowed = (await response.json()) as Pair;
  assert.deepEqual(f.service.verifyAccessToken(narrowed.access_token)?.scopes, ['tasks:read']);
  assert.equal(
    (await rotate(f, client, narrowed.refresh_token, { scope: 'tasks:read tasks:write' })).status,
    400,
  );
  // RFC 8707 permits omitting resource on refresh; it inherits the existing exact audience.
  const inherited = await formPost(f, '/oauth/token', {
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: narrowed.refresh_token,
  });
  assert.equal(inherited.status, 200);
  assert.deepEqual(
    f.service.verifyAccessToken(((await inherited.json()) as Pair).access_token)?.scopes,
    ['tasks:read'],
  );
});

test('token revocation binds client and revokes the whole family without revealing unknown tokens', async (t) => {
  const f = await fixture(t);
  const { client, pair } = await grant(f);
  const stranger = await register(f);
  assert.equal(
    (
      await formPost(f, '/oauth/revoke', {
        client_id: stranger.client_id,
        token: pair.access_token,
      })
    ).status,
    200,
  );
  assert.ok(f.service.verifyAccessToken(pair.access_token));
  assert.equal(
    (await formPost(f, '/oauth/revoke', { client_id: client.client_id, token: pair.refresh_token }))
      .status,
    200,
  );
  assert.equal(f.service.verifyAccessToken(pair.access_token), null);
  assert.equal((await rotate(f, client, pair.refresh_token)).status, 400);
  assert.equal(
    (await formPost(f, '/oauth/revoke', { client_id: client.client_id, token: 'unknown' })).status,
    200,
  );
});

test('registered grant restrictions and audience binding survive token issuance and persistence', async (t) => {
  const f = await fixture(t);
  const client = await register(f, { grant_types: ['authorization_code'], scope: 'tasks:read' });
  const { pair } = await grant(f, client, 'tasks:read');
  assert.equal(pair.refresh_token, undefined);
  assert.deepEqual(f.service.verifyAccessToken(pair.access_token)?.scopes, ['tasks:read']);
  const otherAuthority = new AuthService({
    filename: f.filename,
    publicUrl: 'https://different.example',
    now: () => f.now,
  });
  try {
    assert.equal(otherAuthority.verifyAccessToken(pair.access_token), null);
  } finally {
    otherAuthority.close();
  }
  assert.ok(f.service.verifyAccessToken(pair.access_token));
});

test('consent state, credentials and replay protection survive process restarts', async (t) => {
  const f = await fixture(t);
  const client = await register(f);
  const p = await page(f, client);
  const ownerCode = f.service.issueConnectorCode().code;
  await f.restart();
  const code = await approve(f, p, ownerCode);
  await f.restart();
  const response = await exchange(f, p, code);
  assert.equal(response.status, 200);
  const pair = (await response.json()) as Pair;
  await f.restart();
  assert.ok(f.service.verifyAccessToken(pair.access_token));
  const rotation = await rotate(f, client, pair.refresh_token);
  assert.equal(rotation.status, 200);
  const next = (await rotation.json()) as Pair;
  await f.restart();
  assert.equal((await rotate(f, client, pair.refresh_token)).status, 400);
  assert.equal(f.service.verifyAccessToken(next.access_token), null);
});

test('consent codes, authorization requests/codes and bearer tokens enforce their expiry boundaries', async (t) => {
  const f = await fixture(t);
  const client = await register(f);
  const p = await page(f, client);
  const ownerCode = f.service.issueConnectorCode().code;
  f.now += 5 * MINUTE;
  assert.equal(
    (await formPost(f, '/oauth/authorize', consentFields(p, ownerCode), { Cookie: p.cookie }))
      .status,
    403,
  );
  const code = await approve(f, p);
  f.now += MINUTE;
  assert.equal((await exchange(f, p, code)).status, 400);
  const expiredRequest = await page(f, client);
  f.now += 10 * MINUTE;
  assert.equal(
    (
      await formPost(
        f,
        '/oauth/authorize',
        consentFields(expiredRequest, f.service.issueConnectorCode().code),
        { Cookie: expiredRequest.cookie },
      )
    ).status,
    400,
  );
  const { pair } = await grant(f, client);
  f.now += 60 * MINUTE;
  assert.equal(f.service.verifyAccessToken(pair.access_token), null);
  assert.equal((await rotate(f, client, pair.refresh_token)).status, 200);
  const later = await grant(f, client);
  f.now += 30 * DAY;
  assert.equal((await rotate(f, client, later.pair.refresh_token)).status, 400);
});

test('CLI tokens only authorize task scopes, expire, persist, and are never stored in plaintext', async (t) => {
  const f = await fixture(t);
  const issued = f.service.issueAccessToken({
    name: 'CLI read token',
    scopes: ['tasks:read'],
    expiresInSeconds: 60,
  });
  assert.deepEqual(f.service.verifyAccessToken(issued.token)?.scopes, ['tasks:read']);
  assert.equal(f.service.verifyAccessToken(` ${issued.token}`), null);
  assert.equal(f.service.verifyAccessToken('cr_cc_not-an-access-token'), null);
  assert.throws(() => f.service.issueAccessToken({ name: 'bad', scopes: ['admin'] }));
  assert.throws(() => f.service.issueAccessToken({ name: 'bad', scopes: [] }));
  assert.throws(() =>
    f.service.issueAccessToken({ name: 'bad', scopes: ['tasks:read'], expiresInSeconds: -1 }),
  );
  const ownerCode = f.service.issueConnectorCode().code;
  const { pair, code } = await grant(f);
  const data = readFileSync(f.filename);
  for (const secret of [issued.token, ownerCode, pair.access_token, pair.refresh_token, code])
    assert.equal(data.includes(Buffer.from(secret)), false);
  if (process.platform !== 'win32') assert.equal(statSync(f.filename).mode & 0o777, 0o600);
  await f.restart();
  assert.ok(f.service.verifyAccessToken(issued.token));
  f.now += MINUTE;
  assert.equal(f.service.verifyAccessToken(issued.token), null);
});

test('OAuth endpoints reject token URL parameters, wrong content types, duplicate values and oversized bodies', async (t) => {
  const f = await fixture(t);
  const client = await register(f);
  const p = await page(f, client);
  const code = await approve(f, p);
  assert.equal(
    (
      await formPost(f, '/oauth/token?access_token=not-allowed', {
        grant_type: 'authorization_code',
      })
    ).status,
    400,
  );
  assert.equal(
    (await jsonPost(f, '/oauth/token', { grant_type: 'authorization_code' })).status,
    415,
  );
  const duplicate = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
    code_verifier: p.verifier,
  });
  duplicate.append('client_id', 'other-client');
  const response = await fetch(`${f.url}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: duplicate,
  });
  assert.equal(response.status, 400);
  assert.equal(
    (
      await jsonPost(f, '/oauth/register', {
        redirect_uris: [REDIRECT],
        client_name: 'a'.repeat(20_000),
      })
    ).status,
    413,
  );
  assert.equal((await formPost(f, '/oauth/token', { grant_type: 'a'.repeat(20_000) })).status, 413);
  assert.equal((await exchange(f, p, code)).status, 200);
});

test('registration throttling persists across restarts and never permits a permanent lockout', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++)
    assert.equal((await jsonPost(f, '/oauth/register', { redirect_uris: [REDIRECT] })).status, 201);
  const limited = await jsonPost(f, '/oauth/register', { redirect_uris: [REDIRECT] });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  await f.restart();
  assert.equal((await jsonPost(f, '/oauth/register', { redirect_uris: [REDIRECT] })).status, 429);
  f.now += 60 * MINUTE;
  assert.equal((await jsonPost(f, '/oauth/register', { redirect_uris: [REDIRECT] })).status, 201);
});

test('the consent page escapes untrusted metadata and sends defensive browser headers', async (t) => {
  const f = await fixture(t);
  const client = await register(f, { client_name: '<script>alert("pwned")</script>' });
  const verifier = randomBytes(48).toString('base64url');
  const response = await fetch(
    `${f.url}/oauth/authorize?${new URLSearchParams(authParams(client, verifier))}`,
  );
  const html = await response.text();
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.ok(response.headers.get('content-security-policy')?.includes("form-action 'self'"));
  const cookie = response.headers.get('set-cookie')!;
  assert.ok(
    cookie.includes('HttpOnly') && cookie.includes('Secure') && cookie.includes('SameSite=Lax'),
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('auth configuration refuses insecure public origins, URL credentials, subpaths and symlink databases', () => {
  for (const url of [
    'http://relay.example',
    'https://user:secret@relay.example',
    'https://relay.example/subpath',
    'https://relay.example?token=x',
  ]) {
    assert.throws(() => new AuthService({ filename: ':memory:', publicUrl: url }));
  }
  const local = new AuthService({ filename: ':memory:', publicUrl: 'http://127.0.0.1:8080' });
  local.close();
  const directory = mkdtempSync(join(tmpdir(), 'coderelay-auth-link-'));
  try {
    const target = join(directory, 'target');
    writeFileSync(target, 'do not overwrite');
    const link = join(directory, 'auth.sqlite');
    symlinkSync(target, link);
    assert.throws(() => new AuthService({ filename: link, publicUrl: PUBLIC_URL }));
    assert.equal(readFileSync(target, 'utf8'), 'do not overwrite');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('administrators can revoke CLI credentials and revocation survives restart', async (t) => {
  const f = await fixture(t);
  const first = f.service.issueAccessToken({
    name: 'first CLI',
    scopes: ['tasks:read', 'tasks:write'],
  });
  const second = f.service.issueAccessToken({ name: 'second CLI', scopes: ['tasks:read'] });
  assert.ok(f.service.verifyAccessToken(first.token));
  assert.equal(f.service.revokeAccessToken(first.token), true);
  assert.equal(f.service.revokeAccessToken(first.token), true);
  assert.equal(f.service.verifyAccessToken(first.token), null);
  assert.ok(f.service.verifyAccessToken(second.token));
  assert.equal(f.service.revokeAccessToken('not-a-token'), false);
  assert.equal(f.service.revokeAccessToken('cr_cli_' + 'a'.repeat(43)), false);
  await f.restart();
  assert.equal(f.service.verifyAccessToken(first.token), null);
  assert.ok(f.service.verifyAccessToken(second.token));
});

test('administrator revocation of an OAuth access token revokes its family without touching other grants', async (t) => {
  const f = await fixture(t);
  const { client, pair } = await grant(f);
  const other = await grant(f, client);
  const nextResponse = await rotate(f, client, pair.refresh_token);
  const next = (await nextResponse.json()) as Pair;
  assert.ok(f.service.verifyAccessToken(next.access_token));
  assert.equal(f.service.revokeAccessToken(pair.access_token), true);
  assert.equal(f.service.verifyAccessToken(next.access_token), null);
  assert.equal((await rotate(f, client, next.refresh_token)).status, 400);
  assert.ok(f.service.verifyAccessToken(other.pair.access_token));
  // This administrator API deliberately accepts access/CLI tokens only.
  assert.equal(f.service.revokeAccessToken(other.pair.refresh_token), false);
  await f.restart();
  assert.equal(f.service.verifyAccessToken(next.access_token), null);
});

test('capacity pressure clears abandoned dynamic registrations even inside the periodic prune window', async (t) => {
  const f = await fixture(t);
  const recent = await register(f);
  const db = new DatabaseSync(f.filename);
  try {
    const insert = db.prepare(
      'INSERT INTO auth_clients(id,name,redirects,scopes,grants,created_at) VALUES(?,?,?,?,?,?)',
    );
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 2047; index++)
      insert.run(
        `abandoned-${index}`,
        'abandoned',
        JSON.stringify([REDIRECT]),
        'tasks:read',
        '["authorization_code"]',
        f.now - 2 * DAY,
      );
    // An expired request must be removed before its client, preserving FK order.
    db.prepare(
      `INSERT INTO auth_requests(id,csrf_hash,client_id,redirect_uri,resource,scopes,challenge,expires_at)
      VALUES('expired-request','hash','abandoned-0',?,?, 'tasks:read','challenge',?)`,
    ).run(REDIRECT, RESOURCE, f.now - 1000);
    db.exec('COMMIT');
    const created = await register(f);
    assert.ok(created.client_id);
    assert.equal(db.prepare('SELECT count(*) AS total FROM auth_clients').get()?.total, 2);
    assert.equal(
      db.prepare('SELECT id FROM auth_requests WHERE id=?').get('expired-request'),
      undefined,
    );
  } finally {
    db.close();
  }
  // A recent unused registration remains usable.
  await page(f, recent);
});

test('registration cleanup preserves a live authorization page even for an old client', async (t) => {
  const f = await fixture(t);
  const client = await register(f);
  const p = await page(f, client);
  const db = new DatabaseSync(f.filename);
  try {
    db.prepare('UPDATE auth_clients SET created_at=? WHERE id=?').run(
      f.now - 2 * DAY,
      client.client_id,
    );
    const insert = db.prepare(
      'INSERT INTO auth_clients(id,name,redirects,scopes,grants,created_at) VALUES(?,?,?,?,?,?)',
    );
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 2047; index++)
      insert.run(
        `unused-${index}`,
        'unused',
        JSON.stringify([REDIRECT]),
        'tasks:read',
        '["authorization_code"]',
        f.now - 2 * DAY,
      );
    db.exec('COMMIT');
    await register(f);
    assert.ok(db.prepare('SELECT id FROM auth_clients WHERE id=?').get(client.client_id));
    assert.ok(db.prepare('SELECT id FROM auth_requests WHERE id=?').get(p.requestId));
  } finally {
    db.close();
  }
  const code = await approve(f, p);
  assert.equal((await exchange(f, p, code)).status, 200);
});

test('owner-authorized client registrations remain valid after all previous grants expire', async (t) => {
  const f = await fixture(t);
  const { client } = await grant(f);
  f.now += 92 * DAY;
  const fresh = await page(f, client);
  const code = await approve(f, fresh);
  assert.equal((await exchange(f, fresh, code)).status, 200);
  const db = new DatabaseSync(f.filename);
  try {
    assert.ok(
      db.prepare('SELECT authorized_at FROM auth_clients WHERE id=?').get(client.client_id)
        ?.authorized_at,
    );
  } finally {
    db.close();
  }
});

test('authorization-code replay receipts outlive pruning while their token family remains live', async (t) => {
  const f = await fixture(t);
  const { client, pair, p, code } = await grant(f);
  f.now += DAY + 2 * MINUTE;
  // Token route triggers pruning before refreshing. The old code receipt must survive.
  const rotatedResponse = await rotate(f, client, pair.refresh_token);
  assert.equal(rotatedResponse.status, 200);
  const rotated = (await rotatedResponse.json()) as Pair;
  assert.ok(f.service.verifyAccessToken(rotated.access_token));
  assert.equal((await exchange(f, p, code)).status, 400);
  assert.equal(f.service.verifyAccessToken(rotated.access_token), null);
  assert.equal((await rotate(f, client, rotated.refresh_token)).status, 400);
});
