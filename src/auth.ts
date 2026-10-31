import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { RelayError } from './errors.js';
import type { Principal } from './types.js';

const SCOPES = ['tasks:read', 'tasks:write'] as const;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ACCESS_LIFETIME = 60 * MINUTE;
const REFRESH_LIFETIME = 30 * DAY;
const FAMILY_LIFETIME = 90 * DAY;
const AUTH_REQUEST_LIFETIME = 10 * MINUTE;
const CODE_LIFETIME = MINUTE;

interface ClientRow {
  id: string;
  name: string;
  redirects: string;
  scopes: string;
  grants: string;
}
interface RequestRow {
  id: string;
  csrf_hash: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scopes: string;
  challenge: string;
  state: string | null;
  expires_at: number;
  completed_at: number | null;
  failures: number;
}
interface CodeRow {
  hash: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scopes: string;
  challenge: string;
  expires_at: number;
  used_at: number | null;
  family_id: string | null;
}
interface FamilyRow {
  id: string;
  client_id: string;
  principal_id: string;
  resource: string;
  expires_at: number;
  revoked_at: number | null;
}
interface TokenRow {
  hash: string;
  kind: string;
  client_id: string;
  principal_id: string;
  scopes: string;
  resource: string;
  family_id: string | null;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}
interface TokenReply {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function opaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function sameHash(value: string, expected: string): boolean {
  const actual = Buffer.from(hash(value), 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(hostname)
  );
}
function field(value: unknown, name: string, required = true, max = 4096): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new OAuthError('invalid_request', `Invalid ${name}.`);
  }
  return value;
}
function required(value: unknown, name: string, max = 4096): string {
  return field(value, name, true, max)!;
}
function parseScopes(value: unknown, fallback = SCOPES.join(' ')): string[] {
  const text = value === undefined ? fallback : required(value, 'scope', 128);
  const scopes = text.split(' ');
  if (
    !scopes.length ||
    scopes.some((s) => !(SCOPES as readonly string[]).includes(s)) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new OAuthError('invalid_scope', 'Only tasks:read and tasks:write scopes are supported.');
  }
  return [...scopes].sort();
}
function subset(scopes: string[], allowed: string): boolean {
  return scopes.every((s) => allowed.split(' ').includes(s));
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}
function callbackUrl(value: unknown): string {
  const raw = required(value, 'redirect_uri', 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthError('invalid_redirect_uri', 'A valid absolute redirect URI is required.');
  }
  if (
    raw !== raw.trim() ||
    raw.includes('\\') ||
    raw.includes('*') ||
    raw.includes('#') ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) ||
    [
      'code',
      'state',
      'iss',
      'error',
      'access_token',
      'refresh_token',
      'id_token',
      'client_secret',
    ].some((k) => url.searchParams.has(k))
  ) {
    throw new OAuthError(
      'invalid_redirect_uri',
      'Use an exact HTTPS callback, or an HTTP loopback callback, without credentials, wildcard, fragment, or OAuth response parameters.',
    );
  }
  // Preserve the original string: OAuth redirect matching is exact, not URL-normalized.
  return raw;
}
function objectBody(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
    throw new OAuthError('invalid_request', 'A request body is required.');
  return req.body as Record<string, unknown>;
}
function noQuery(req: Request): void {
  if (Object.keys(req.query).length)
    throw new OAuthError(
      'invalid_request',
      'Send credentials and token parameters in the request body, never the URL.',
    );
}
function noClientSecret(req: Request, body: Record<string, unknown>): void {
  if (
    req.headers.authorization ||
    body.client_secret !== undefined ||
    body.client_assertion !== undefined
  ) {
    throw new OAuthError(
      'invalid_client',
      'Only registered public clients with PKCE are supported.',
      401,
    );
  }
}

/** Single-owner OAuth authority. All bearer credentials and consent codes are stored as hashes. */
export class AuthService {
  readonly publicUrl: string;
  readonly resource: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private lastPrune = 0;

  constructor(options: { filename: string; publicUrl: string; now?: () => number }) {
    let url: URL;
    try {
      url = new URL(options.publicUrl);
    } catch {
      throw new RelayError('invalid_config', 'PUBLIC_URL must be an absolute HTTPS URL.');
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    ) {
      throw new RelayError(
        'invalid_config',
        'PUBLIC_URL must be an HTTPS origin without a path, credentials, query, or fragment; HTTP is allowed only on loopback.',
      );
    }
    this.publicUrl = url.origin;
    this.resource = `${this.publicUrl}/mcp`;
    this.now = options.now ?? Date.now;
    if (options.filename !== ':memory:') {
      mkdirSync(dirname(options.filename), { recursive: true, mode: 0o700 });
      try {
        closeSync(openSync(options.filename, 'wx', 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = lstatSync(options.filename);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new RelayError(
          'invalid_config',
          'The authentication database must be a regular file, not a symbolic link.',
        );
      chmodSync(options.filename, 0o600);
    }
    this.db = new DatabaseSync(options.filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS auth_clients (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL,
        scopes TEXT NOT NULL, grants TEXT NOT NULL, created_at INTEGER NOT NULL,
        authorized_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_consent_codes (
        hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_requests (
        id TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES auth_clients(id),
        redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL,
        challenge TEXT NOT NULL, state TEXT, expires_at INTEGER NOT NULL,
        completed_at INTEGER, failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS auth_codes (
        hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES auth_clients(id),
        redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL,
        challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, family_id TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_families (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES auth_clients(id), principal_id TEXT NOT NULL,
        resource TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_tokens (
        hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, principal_id TEXT NOT NULL,
        name TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL,
        family_id TEXT REFERENCES auth_families(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_tokens_family ON auth_tokens(family_id);
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
      );
    `);
    // Existing installations predate this marker. A successful owner consent is
    // retained independently of expiring requests/tokens; only never-authorized
    // abandoned dynamic registrations may be collected automatically.
    const columns = this.db.prepare('PRAGMA table_info(auth_clients)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'authorized_at')) {
      this.db.exec('ALTER TABLE auth_clients ADD COLUMN authorized_at INTEGER');
    }
    this.db
      .exec(`UPDATE auth_clients SET authorized_at = created_at WHERE authorized_at IS NULL AND (
      EXISTS(SELECT 1 FROM auth_codes WHERE auth_codes.client_id = auth_clients.id) OR
      EXISTS(SELECT 1 FROM auth_families WHERE auth_families.client_id = auth_clients.id)
    )`);
  }

  private get<T>(sql: string, ...values: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...values) as T | undefined;
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  issueConnectorCode(): { code: string; expiresAt: number } {
    const code = opaque('cr_cc_');
    const expiresAt = this.now() + 5 * MINUTE;
    this.db
      .prepare('INSERT INTO auth_consent_codes(hash, expires_at) VALUES (?, ?)')
      .run(hash(code), expiresAt);
    return { code, expiresAt };
  }

  issueAccessToken(input: { name: string; scopes: string[]; expiresInSeconds?: number }): {
    token: string;
    expiresAt: number;
  } {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 120 ||
      !Array.isArray(input.scopes) ||
      !input.scopes.length
    ) {
      throw new RelayError(
        'invalid_request',
        'A token name and at least one task scope are required.',
      );
    }
    let scopes: string[];
    try {
      scopes = parseScopes(input.scopes.join(' '));
    } catch {
      throw new RelayError(
        'invalid_scope',
        'Only tasks:read and tasks:write scopes are supported.',
      );
    }
    const seconds = input.expiresInSeconds ?? (30 * DAY) / 1000;
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > (365 * DAY) / 1000)
      throw new RelayError('invalid_request', 'Token lifetime must be 60 seconds to 365 days.');
    const token = opaque('cr_cli_');
    const expiresAt = this.now() + seconds * 1000;
    const principal = opaque('cli:');
    this.db
      .prepare(
        `INSERT INTO auth_tokens(hash,kind,client_id,principal_id,name,scopes,resource,expires_at,created_at)
      VALUES (?, 'cli', 'cli', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hash(token),
        principal,
        input.name.trim(),
        scopes.join(' '),
        this.resource,
        expiresAt,
        this.now(),
      );
    return { token, expiresAt };
  }

  verifyAccessToken(raw: string): Principal | null {
    if (typeof raw !== 'string' || !/^cr_(?:at|cli)_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const token = this.get<TokenRow>('SELECT * FROM auth_tokens WHERE hash = ?', hash(raw));
    const now = this.now();
    if (
      !token ||
      !['access', 'cli'].includes(token.kind) ||
      token.used_at !== null ||
      token.revoked_at !== null ||
      token.expires_at <= now ||
      token.resource !== this.resource
    )
      return null;
    if (token.family_id) {
      const family = this.get<FamilyRow>(
        'SELECT * FROM auth_families WHERE id = ?',
        token.family_id,
      );
      if (
        !family ||
        family.revoked_at !== null ||
        family.expires_at <= now ||
        family.resource !== this.resource ||
        family.client_id !== token.client_id
      )
        return null;
    }
    return { id: token.principal_id, clientId: token.client_id, scopes: token.scopes.split(' ') };
  }

  /** Administrator-only entry point. Never expose it as an unauthenticated route. */
  revokeAccessToken(raw: string): boolean {
    if (typeof raw !== 'string' || !/^cr_(?:at|cli)_[A-Za-z0-9_-]{43}$/.test(raw)) return false;
    return this.transaction(() => {
      const token = this.get<TokenRow>('SELECT * FROM auth_tokens WHERE hash = ?', hash(raw));
      if (!token || !['access', 'cli'].includes(token.kind)) return false;
      if (token.family_id) {
        this.db
          .prepare('UPDATE auth_families SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
          .run(this.now(), token.family_id);
      } else {
        this.db
          .prepare('UPDATE auth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE hash = ?')
          .run(this.now(), token.hash);
      }
      return true;
    });
  }

  private pruneExpired(): void {
    const now = this.now();
    this.transaction(() => {
      this.db.prepare('DELETE FROM auth_rate_limits WHERE window_start < ?').run(now - DAY);
      this.db.prepare('DELETE FROM auth_requests WHERE expires_at < ?').run(now - DAY);
      this.db.prepare('DELETE FROM auth_consent_codes WHERE expires_at < ?').run(now - DAY);
      // A consumed code can still identify replay against its live family. Do
      // not discard this receipt while that family could issue valid tokens.
      this.db
        .prepare(
          `DELETE FROM auth_codes WHERE expires_at < ? AND (
        family_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM auth_families f WHERE f.id = auth_codes.family_id AND f.expires_at > ?
        )
      )`,
        )
        .run(now - DAY, now);
      this.db.prepare('DELETE FROM auth_families WHERE expires_at < ?').run(now - DAY);
      this.db
        .prepare('DELETE FROM auth_tokens WHERE family_id IS NULL AND expires_at < ?')
        .run(now - DAY);

      const unused = `SELECT c.id FROM auth_clients c WHERE c.created_at < ? AND c.authorized_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM auth_requests r WHERE r.client_id = c.id AND r.completed_at IS NULL AND r.expires_at > ?)
        AND NOT EXISTS (SELECT 1 FROM auth_codes ac WHERE ac.client_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM auth_families f WHERE f.client_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM auth_tokens t WHERE t.client_id = c.id)`;
      // The candidate clients have no active request. Remove their expired or
      // denied request rows first to preserve the foreign-key constraints.
      this.db
        .prepare(`DELETE FROM auth_requests WHERE client_id IN (${unused})`)
        .run(now - DAY, now);
      this.db.prepare(`DELETE FROM auth_clients WHERE id IN (${unused})`).run(now - DAY, now);
    });
    this.lastPrune = now;
  }

  private throttle(req: Request, category: string, limit: number, windowMs: number): void {
    const now = this.now();
    const bucket = hash(`${category}:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`);
    const allowed = this.transaction(() => {
      const row = this.get<{ window_start: number; count: number }>(
        'SELECT * FROM auth_rate_limits WHERE bucket = ?',
        bucket,
      );
      if (!row || row.window_start + windowMs <= now) {
        this.db
          .prepare(
            'INSERT INTO auth_rate_limits VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 1',
          )
          .run(bucket, now);
        return true;
      }
      if (row.count >= limit) return false;
      this.db.prepare('UPDATE auth_rate_limits SET count = count + 1 WHERE bucket = ?').run(bucket);
      return true;
    });
    if (!allowed)
      throw new OAuthError(
        'temporarily_unavailable',
        'Too many attempts. Please try again later.',
        429,
      );
    if (now - this.lastPrune > MINUTE) this.pruneExpired();
  }

  private register(req: Request, res: Response): void {
    noQuery(req);
    this.throttle(req, 'register', 30, 60 * MINUTE);
    const body = objectBody(req);
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none')
      throw new OAuthError(
        'invalid_client_metadata',
        'Only public clients (token_endpoint_auth_method: none) are supported.',
      );
    if (body.client_secret !== undefined || body.client_id !== undefined)
      throw new OAuthError(
        'invalid_client_metadata',
        'Client identifiers are issued by this authorization server.',
      );
    if (
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length < 1 ||
      body.redirect_uris.length > 10
    )
      throw new OAuthError('invalid_redirect_uri', 'Register one to ten exact redirect URIs.');
    const redirects = body.redirect_uris.map(callbackUrl);
    if (new Set(redirects).size !== redirects.length)
      throw new OAuthError('invalid_redirect_uri', 'Duplicate redirect URIs are not allowed.');
    const grants = body.grant_types ?? ['authorization_code', 'refresh_token'];
    if (
      !Array.isArray(grants) ||
      !grants.includes('authorization_code') ||
      grants.some((x) => !['authorization_code', 'refresh_token'].includes(x as string)) ||
      new Set(grants).size !== grants.length
    )
      throw new OAuthError(
        'invalid_client_metadata',
        'Only authorization_code and refresh_token grants are supported.',
      );
    if (
      body.response_types !== undefined &&
      (!Array.isArray(body.response_types) ||
        body.response_types.length !== 1 ||
        body.response_types[0] !== 'code')
    )
      throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported.');
    const name = field(body.client_name, 'client_name', false, 120) ?? 'MCP client';
    const scopes = parseScopes(body.scope).join(' ');
    let count = this.get<{ total: number }>('SELECT count(*) AS total FROM auth_clients')!.total;
    if (count >= 2048) {
      // Capacity may be reached inside the periodic prune window. An unused
      // registration must not become a permanent public denial-of-service slot.
      this.pruneExpired();
      count = this.get<{ total: number }>('SELECT count(*) AS total FROM auth_clients')!.total;
    }
    if (count >= 2048)
      throw new OAuthError(
        'temporarily_unavailable',
        'Client registration capacity has been reached.',
        429,
      );
    const id = opaque('cr_client_');
    this.db
      .prepare(
        'INSERT INTO auth_clients(id,name,redirects,scopes,grants,created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, JSON.stringify(redirects), scopes, JSON.stringify(grants), this.now());
    res.status(201).json({
      client_id: id,
      client_id_issued_at: Math.floor(this.now() / 1000),
      client_name: name,
      redirect_uris: redirects,
      token_endpoint_auth_method: 'none',
      grant_types: grants,
      response_types: ['code'],
      scope: scopes,
    });
  }

  private cookieName(id: string): string {
    return `${this.publicUrl.startsWith('https:') ? '__Secure-' : ''}cr_csrf_${id}`;
  }
  private authorize(req: Request, res: Response): void {
    this.throttle(req, 'authorize', 60, MINUTE);
    const query = req.query;
    if (
      query.access_token !== undefined ||
      query.refresh_token !== undefined ||
      query.client_secret !== undefined
    )
      throw new OAuthError('invalid_request', 'Credentials must not be sent in a URL.');
    const clientId = required(query.client_id, 'client_id', 128);
    const client = this.get<ClientRow>('SELECT * FROM auth_clients WHERE id = ?', clientId);
    if (!client) throw new OAuthError('invalid_client', 'Unknown OAuth client.');
    const redirect = required(query.redirect_uri, 'redirect_uri', 2048);
    if (!(JSON.parse(client.redirects) as string[]).includes(redirect))
      throw new OAuthError(
        'invalid_request',
        'The redirect URI does not exactly match a registered URI.',
      );
    if (query.response_type !== 'code')
      throw new OAuthError(
        'unsupported_response_type',
        'Only authorization code responses are supported.',
      );
    if (query.response_mode !== undefined && query.response_mode !== 'query')
      throw new OAuthError('invalid_request', 'Only query response mode is supported.');
    if (query.resource !== this.resource)
      throw new OAuthError(
        'invalid_target',
        'The resource must identify this CodeRelay MCP endpoint.',
      );
    if (query.code_challenge_method !== 'S256')
      throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    const challenge = required(query.code_challenge, 'code_challenge', 43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw new OAuthError('invalid_request', 'Invalid PKCE S256 challenge.');
    const scopes = parseScopes(query.scope, client.scopes);
    if (!subset(scopes, client.scopes))
      throw new OAuthError(
        'invalid_scope',
        'The requested scope exceeds the registered client scope.',
      );
    const state = field(query.state, 'state', false, 2048) ?? null;
    const id = opaque('ar_');
    const csrf = opaque('');
    this.db
      .prepare(
        `INSERT INTO auth_requests(id,csrf_hash,client_id,redirect_uri,resource,scopes,challenge,state,expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        hash(csrf),
        clientId,
        redirect,
        this.resource,
        scopes.join(' '),
        challenge,
        state,
        this.now() + AUTH_REQUEST_LIFETIME,
      );
    res.cookie(this.cookieName(id), csrf, {
      httpOnly: true,
      secure: this.publicUrl.startsWith('https:'),
      sameSite: 'lax',
      path: '/oauth/authorize',
      maxAge: AUTH_REQUEST_LIFETIME,
    });
    res
      .type('html')
      .send(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 CodeRelay</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f4f6f9;color:#172136;margin:0;padding:32px 16px}main{max-width:560px;margin:auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 8px 32px #17213612}h1{font-size:24px}code{overflow-wrap:anywhere}label,input{display:block}input{box-sizing:border-box;width:100%;margin:8px 0 20px;padding:12px;font:inherit;border:1px solid #9ca9bd;border-radius:8px}button{padding:10px 18px;margin:4px;font:inherit;border:0;border-radius:8px;cursor:pointer;background:#175cd3;color:white}button[value=deny]{background:#e8edf4;color:#172136}.muted{color:#526079;font-size:14px}</style></head><body><main><h1>授权 CodeRelay</h1><p>应用 <strong>${escapeHtml(client.name)}</strong> 请求访问你的开发任务。</p><p class="muted">客户端：<code>${escapeHtml(client.id)}</code><br>资源：<code>${escapeHtml(this.resource)}</code><br>回调：<code>${escapeHtml(redirect)}</code></p><ul>${scopes.map((scope) => `<li>${scope === 'tasks:read' ? '查看设备、项目、任务与执行结果' : '创建和取消任务，发送执行指令及授权决定'}</li>`).join('')}</ul><p>请在 CodeRelay 管理命令中生成一次性连接码，再粘贴到下面。连接码 5 分钟内有效，每次仅能授权一个连接。</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><label for="connector_code">一次性连接码</label><input id="connector_code" name="connector_code" type="password" autocomplete="off" maxlength="128" required><button name="decision" value="allow" type="submit">同意授权</button><button name="decision" value="deny" type="submit" formnovalidate>取消</button></form><p class="muted">MiniMax 的登录凭据保留在你的设备中，不会传给此连接。</p></main></body></html>`,
      );
  }

  private consent(req: Request, res: Response): void {
    noQuery(req);
    this.throttle(req, 'consent', 20, MINUTE);
    const body = objectBody(req);
    if (
      Object.keys(body).some(
        (k) => !['request_id', 'csrf', 'connector_code', 'decision'].includes(k),
      )
    )
      throw new OAuthError(
        'invalid_request',
        'Authorization parameters cannot be changed in the consent form.',
      );
    if (req.headers.origin && req.headers.origin !== new URL(this.publicUrl).origin)
      throw new OAuthError('invalid_request', 'Invalid consent origin.', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new OAuthError('invalid_request', 'Cross-site consent is not allowed.', 403);
    const id = required(body.request_id, 'request_id', 128);
    const csrf = required(body.csrf, 'csrf', 128);
    const request = this.get<RequestRow>('SELECT * FROM auth_requests WHERE id = ?', id);
    const now = this.now();
    if (
      !request ||
      request.completed_at !== null ||
      request.expires_at <= now ||
      request.failures >= 5
    )
      throw new OAuthError(
        'invalid_request',
        'This authorization request has expired or was already completed.',
      );
    const cookies = (req.headers.cookie ?? '').split(';').map((part) => part.trim());
    const matching = cookies.filter((part) => part.startsWith(`${this.cookieName(id)}=`));
    if (
      matching.length !== 1 ||
      !sameHash(csrf, request.csrf_hash) ||
      !sameHash(matching[0]!.slice(this.cookieName(id).length + 1), request.csrf_hash)
    )
      throw new OAuthError(
        'invalid_request',
        'Consent security check failed. Reopen the authorization page.',
        403,
      );
    if (body.decision !== 'allow' && body.decision !== 'deny')
      throw new OAuthError('invalid_request', 'Choose whether to allow this connection.');
    let authCode: string | undefined;
    const decision = body.decision;
    const result = this.transaction(() => {
      if (decision === 'allow') {
        const code = field(body.connector_code, 'connector_code', false, 128)?.trim() ?? '';
        const consent = this.get<{ expires_at: number; consumed_at: number | null }>(
          'SELECT * FROM auth_consent_codes WHERE hash = ?',
          hash(code),
        );
        if (!consent || consent.consumed_at !== null || consent.expires_at <= now) {
          this.db.prepare('UPDATE auth_requests SET failures = failures + 1 WHERE id = ?').run(id);
          return new OAuthError(
            'access_denied',
            '连接码无效、已使用或已过期。请重新生成连接码。',
            403,
          );
        }
        this.db
          .prepare('UPDATE auth_consent_codes SET consumed_at = ? WHERE hash = ?')
          .run(now, hash(code));
        this.db
          .prepare(
            'UPDATE auth_clients SET authorized_at = COALESCE(authorized_at, ?) WHERE id = ?',
          )
          .run(now, request.client_id);
        authCode = opaque('cr_ac_');
        this.db
          .prepare(
            `INSERT INTO auth_codes(hash,client_id,redirect_uri,resource,scopes,challenge,expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            hash(authCode),
            request.client_id,
            request.redirect_uri,
            request.resource,
            request.scopes,
            request.challenge,
            now + CODE_LIFETIME,
          );
      }
      this.db.prepare('UPDATE auth_requests SET completed_at = ? WHERE id = ?').run(now, id);
      return undefined;
    });
    if (result) throw result;
    res.clearCookie(this.cookieName(id), {
      httpOnly: true,
      secure: this.publicUrl.startsWith('https:'),
      sameSite: 'lax',
      path: '/oauth/authorize',
    });
    const redirect = new URL(request.redirect_uri);
    if (authCode) redirect.searchParams.set('code', authCode);
    else redirect.searchParams.set('error', 'access_denied');
    if (request.state !== null) redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', this.publicUrl);
    res.redirect(303, redirect.toString());
  }

  private mintPair(family: FamilyRow, scopes: string, includeRefresh: boolean): TokenReply {
    const now = this.now();
    const access = opaque('cr_at_');
    const expiresAt = Math.min(now + ACCESS_LIFETIME, family.expires_at);
    const insert = this.db
      .prepare(`INSERT INTO auth_tokens(hash,kind,client_id,principal_id,name,scopes,resource,family_id,expires_at,created_at)
      VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`);
    insert.run(
      hash(access),
      'access',
      family.client_id,
      family.principal_id,
      scopes,
      family.resource,
      family.id,
      expiresAt,
      now,
    );
    const reply: TokenReply = {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor((expiresAt - now) / 1000),
      scope: scopes,
    };
    if (includeRefresh) {
      const refresh = opaque('cr_rt_');
      insert.run(
        hash(refresh),
        'refresh',
        family.client_id,
        family.principal_id,
        scopes,
        family.resource,
        family.id,
        Math.min(now + REFRESH_LIFETIME, family.expires_at),
        now,
      );
      reply.refresh_token = refresh;
    }
    return reply;
  }

  private exchangeCode(body: Record<string, unknown>, client: ClientRow): TokenReply | OAuthError {
    const raw = required(body.code, 'code', 128);
    const redirect = required(body.redirect_uri, 'redirect_uri', 2048);
    const verifier = required(body.code_verifier, 'code_verifier', 128);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      return new OAuthError('invalid_grant', 'Invalid authorization code or PKCE verifier.');
    if (body.resource !== this.resource)
      return new OAuthError(
        'invalid_target',
        'The resource must match the authorized MCP endpoint.',
      );
    const code = this.get<CodeRow>('SELECT * FROM auth_codes WHERE hash = ?', hash(raw));
    if (
      !code ||
      code.client_id !== client.id ||
      code.redirect_uri !== redirect ||
      code.resource !== this.resource ||
      code.challenge !== createHash('sha256').update(verifier).digest('base64url')
    )
      return new OAuthError(
        'invalid_grant',
        'Invalid authorization code, redirect URI, or PKCE verifier.',
      );
    if (code.used_at !== null) {
      if (code.family_id)
        this.db
          .prepare('UPDATE auth_families SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
          .run(this.now(), code.family_id);
      return new OAuthError(
        'invalid_grant',
        'This authorization code has already been used. Authorize again.',
      );
    }
    if (code.expires_at <= this.now())
      return new OAuthError('invalid_grant', 'The authorization code has expired.');
    if (body.scope !== undefined)
      return new OAuthError(
        'invalid_request',
        'Scope cannot be changed when exchanging an authorization code.',
      );
    const family: FamilyRow = {
      id: opaque('cr_family_'),
      client_id: client.id,
      principal_id: `oauth:${client.id}`,
      resource: this.resource,
      expires_at: this.now() + FAMILY_LIFETIME,
      revoked_at: null,
    };
    this.db
      .prepare('INSERT INTO auth_families VALUES (?, ?, ?, ?, ?, NULL)')
      .run(family.id, family.client_id, family.principal_id, family.resource, family.expires_at);
    this.db
      .prepare('UPDATE auth_codes SET used_at = ?, family_id = ? WHERE hash = ?')
      .run(this.now(), family.id, code.hash);
    return this.mintPair(
      family,
      code.scopes,
      (JSON.parse(client.grants) as string[]).includes('refresh_token'),
    );
  }

  private refresh(body: Record<string, unknown>, client: ClientRow): TokenReply | OAuthError {
    const raw = required(body.refresh_token, 'refresh_token', 128);
    if (!(JSON.parse(client.grants) as string[]).includes('refresh_token'))
      return new OAuthError(
        'unauthorized_client',
        'This client is not registered for refresh tokens.',
      );
    if (body.resource !== undefined && body.resource !== this.resource)
      return new OAuthError(
        'invalid_target',
        'The resource must match the authorized MCP endpoint.',
      );
    const token = this.get<TokenRow>('SELECT * FROM auth_tokens WHERE hash = ?', hash(raw));
    if (
      !token ||
      token.kind !== 'refresh' ||
      token.client_id !== client.id ||
      token.resource !== this.resource ||
      !token.family_id
    )
      return new OAuthError('invalid_grant', 'Invalid refresh token.');
    const family = this.get<FamilyRow>('SELECT * FROM auth_families WHERE id = ?', token.family_id);
    if (
      !family ||
      family.client_id !== client.id ||
      family.resource !== this.resource ||
      family.revoked_at !== null ||
      family.expires_at <= this.now()
    )
      return new OAuthError(
        'invalid_grant',
        'The refresh token family has expired or been revoked.',
      );
    if (token.used_at !== null) {
      this.db
        .prepare('UPDATE auth_families SET revoked_at = ? WHERE id = ?')
        .run(this.now(), family.id);
      return new OAuthError(
        'invalid_grant',
        'Refresh token replay detected. This token family is revoked; authorize again.',
      );
    }
    if (token.revoked_at !== null || token.expires_at <= this.now())
      return new OAuthError('invalid_grant', 'The refresh token has expired or been revoked.');
    const scopes = parseScopes(body.scope, token.scopes);
    if (!subset(scopes, token.scopes))
      return new OAuthError(
        'invalid_scope',
        'A refresh request cannot increase the authorized scope.',
      );
    this.db
      .prepare('UPDATE auth_tokens SET used_at = ? WHERE hash = ?')
      .run(this.now(), token.hash);
    return this.mintPair(family, scopes.join(' '), true);
  }

  private token(req: Request, res: Response): void {
    noQuery(req);
    this.throttle(req, 'token', 120, MINUTE);
    const body = objectBody(req);
    noClientSecret(req, body);
    const clientId = required(body.client_id, 'client_id', 128);
    const client = this.get<ClientRow>('SELECT * FROM auth_clients WHERE id = ?', clientId);
    if (!client) throw new OAuthError('invalid_client', 'Unknown OAuth client.', 401);
    if (body.grant_type !== 'authorization_code' && body.grant_type !== 'refresh_token')
      throw new OAuthError(
        'unsupported_grant_type',
        'Only authorization_code and refresh_token grants are supported.',
      );
    const reply = this.transaction(() =>
      body.grant_type === 'authorization_code'
        ? this.exchangeCode(body, client)
        : this.refresh(body, client),
    );
    // Replay revocation must commit before the protocol error is returned.
    if (reply instanceof OAuthError) throw reply;
    res.json(reply);
  }

  private revoke(req: Request, res: Response): void {
    noQuery(req);
    this.throttle(req, 'revoke', 60, MINUTE);
    const body = objectBody(req);
    noClientSecret(req, body);
    const clientId = required(body.client_id, 'client_id', 128);
    const raw = required(body.token, 'token', 256);
    const client = this.get<ClientRow>('SELECT * FROM auth_clients WHERE id = ?', clientId);
    if (!client) throw new OAuthError('invalid_client', 'Unknown OAuth client.', 401);
    if (
      body.token_type_hint !== undefined &&
      !['access_token', 'refresh_token'].includes(body.token_type_hint as string)
    )
      throw new OAuthError('unsupported_token_type', 'Unsupported token type hint.');
    const token = this.get<TokenRow>('SELECT * FROM auth_tokens WHERE hash = ?', hash(raw));
    if (token && token.client_id === clientId) {
      if (token.family_id)
        this.db
          .prepare('UPDATE auth_families SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
          .run(this.now(), token.family_id);
      else
        this.db
          .prepare('UPDATE auth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE hash = ?')
          .run(this.now(), token.hash);
    }
    res.status(200).send('');
  }

  installRoutes(app: Express): void {
    const router = express.Router();
    router.use((_req, res, next) => {
      res.set({
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      next();
    });
    const handle =
      (handler: (req: Request, res: Response) => void) =>
      (req: Request, res: Response, next: NextFunction): void => {
        try {
          handler(req, res);
        } catch (error) {
          next(error);
        }
      };
    const requireType =
      (type: string) =>
      (req: Request, _res: Response, next: NextFunction): void => {
        if (!req.is(type))
          next(new OAuthError('invalid_request', `Content-Type must be ${type}.`, 415));
        else next();
      };
    router.get('/.well-known/oauth-authorization-server', (_req, res) =>
      res.json({
        issuer: this.publicUrl,
        authorization_endpoint: `${this.publicUrl}/oauth/authorize`,
        token_endpoint: `${this.publicUrl}/oauth/token`,
        registration_endpoint: `${this.publicUrl}/oauth/register`,
        revocation_endpoint: `${this.publicUrl}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: SCOPES,
        authorization_response_iss_parameter_supported: true,
      }),
    );
    router.get(
      ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
      (_req, res) =>
        res.json({
          resource: this.resource,
          authorization_servers: [this.publicUrl],
          scopes_supported: SCOPES,
          bearer_methods_supported: ['header'],
          resource_name: 'CodeRelay',
        }),
    );
    const form = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 });
    router.post(
      '/oauth/register',
      requireType('application/json'),
      express.json({ limit: '16kb', strict: true }),
      handle((req, res) => this.register(req, res)),
    );
    router.get(
      '/oauth/authorize',
      handle((req, res) => this.authorize(req, res)),
    );
    router.post(
      '/oauth/authorize',
      requireType('application/x-www-form-urlencoded'),
      form,
      handle((req, res) => this.consent(req, res)),
    );
    router.post(
      '/oauth/token',
      requireType('application/x-www-form-urlencoded'),
      form,
      handle((req, res) => this.token(req, res)),
    );
    router.post(
      '/oauth/revoke',
      requireType('application/x-www-form-urlencoded'),
      form,
      handle((req, res) => this.revoke(req, res)),
    );
    router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      if (error instanceof OAuthError) {
        if (error.status === 429) res.set('Retry-After', '60');
        res.status(error.status).json({ error: error.code, error_description: error.message });
      } else if ((error as { type?: string })?.type === 'entity.too.large') {
        res
          .status(413)
          .json({ error: 'invalid_request', error_description: 'Request body exceeds 16 KiB.' });
      } else if (
        (error as { type?: string })?.type === 'entity.parse.failed' ||
        (error as { type?: string })?.type === 'parameters.too.many'
      ) {
        res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'Malformed request body.' });
      } else {
        // Do not reflect database paths, request bodies, or credentials in protocol errors.
        res.status(500).json({
          error: 'server_error',
          error_description: 'The authorization server could not complete this request.',
        });
      }
    });
    app.use(router);
  }

  close(): void {
    this.db.close();
  }
}
