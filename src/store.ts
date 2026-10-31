import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RelayError } from './errors.js';
import type {
  Assignment,
  CommandKind,
  Device,
  Json,
  Outcome,
  Project,
  ProjectInput,
  StoredEvent,
  SubmitTask,
  Task,
  TaskCommand,
  TaskStatus,
  WorkerEvent,
} from './types.js';

type Row = Record<string, null | string | number | bigint | Uint8Array>;
type Completion = { outcome: Outcome; result: Json; error?: string };
type CommandInput = { requestKey: string; kind: CommandKind; payload: Json };
type CommandAck = { status: 'applied' | 'rejected' | 'unknown'; message?: string };
type Reconciliation = { outcome: Exclude<Outcome, 'unknown'>; reason: string; result?: Json };
export interface AuditRecord {
  id: number;
  at: number;
  action: string;
  entityId: string;
  details: Json;
}
export interface StoreOptions {
  filename: string;
  now?: () => number;
  leaseMs?: number;
}

const ACTIVE = ['running', 'waiting_input', 'cancel_requested'] as const;
const TERMINAL = ['succeeded', 'failed', 'cancelled'] as const;
const ACTIVE_SQL = "'running','waiting_input','cancel_requested'";
const LOCK_SQL = `${ACTIVE_SQL},'unknown'`;
const MAX_RESULT = 512 * 1024;
const MAX_EVENT_BATCH = 128 * 1024;
const MAX_TASK_EVENTS = 50_000;

function fail(code: string, message: string, status = 400): never {
  throw new RelayError(code, message, status);
}
function text(value: unknown, name: string, max = 256, min = 1): string {
  if (
    typeof value !== 'string' ||
    value.length < min ||
    value.length > max ||
    !value.trim() ||
    value.includes('\0')
  ) {
    fail('INVALID_INPUT', `${name} must contain ${min}–${max} nonempty characters.`);
  }
  return value;
}
function requestKey(value: unknown): string {
  const key = text(value, 'requestKey', 128, 8);
  if (!/^[A-Za-z0-9_.:-]+$/.test(key))
    fail('INVALID_INPUT', 'requestKey contains unsupported characters.');
  return key;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail('INVALID_INPUT', `${name} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}
function object(value: unknown, name = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_INPUT', `${name} must be an object.`);
  return value as Record<string, unknown>;
}
/** Canonical input hashing makes retry order independent without accepting non-JSON values. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 40) fail('INVALID_INPUT', 'JSON nesting exceeds 40 levels.');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`,
      )
      .join(',')}}`;
  }
  fail('INVALID_INPUT', 'Only finite JSON values are accepted.');
}
function encoded(value: unknown, max: number, name: string): string {
  const json = canonical(value);
  if (Buffer.byteLength(json, 'utf8') > max)
    fail('PAYLOAD_TOO_LARGE', `${name} exceeds ${max} bytes.`, 413);
  return json;
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function id(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}
function secret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}
function n(row: Row, key: string): number {
  return Number(row[key]);
}
function s(row: Row, key: string): string {
  return String(row[key]);
}
function nullableNumber(row: Row, key: string): number | null {
  return row[key] === null ? null : n(row, key);
}
function nullableString(row: Row, key: string): string | null {
  return row[key] === null ? null : s(row, key);
}
function parse<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}
function isActive(status: string): boolean {
  return (ACTIVE as readonly string[]).includes(status);
}
function isTerminal(status: string): boolean {
  return (TERMINAL as readonly string[]).includes(status);
}

/** Durable, single-owner state. Transactions protect side-effect ownership, not just queue bookkeeping. */
export class RelayStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #leaseMs: number;
  #closed = false;

  constructor(options: StoreOptions) {
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 90_000;
    integer(this.#leaseMs, 'leaseMs', 100, 24 * 60 * 60 * 1000);
    if (options.filename !== ':memory:') {
      text(options.filename, 'filename', 4096);
      if (!existsSync(dirname(options.filename)))
        mkdirSync(dirname(options.filename), { recursive: true, mode: 0o700 });
      if (existsSync(options.filename)) {
        if (!lstatSync(options.filename).isFile())
          fail('INVALID_DATABASE', 'Database must be a regular local file.');
        chmodSync(options.filename, 0o600);
      } else {
        closeSync(openSync(options.filename, 'wx', 0o600));
      }
      for (const sidecar of [`${options.filename}-wal`, `${options.filename}-shm`]) {
        try {
          if (!lstatSync(sidecar).isFile())
            fail('INVALID_DATABASE', 'Database journal files must be regular local files.');
          chmodSync(sidecar, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    this.#db = new DatabaseSync(options.filename);
    try {
      this.#db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;',
      );
      const version = n(this.#db.prepare('PRAGMA user_version').get() as Row, 'user_version');
      if (version > 1)
        fail(
          'UNSUPPORTED_SCHEMA',
          `Database schema ${version} is newer than this executable.`,
          500,
        );
      if (version === 0) this.#migrate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS pairing_codes (
          code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, used_at INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL, revoked_at INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), name TEXT NOT NULL,
          session_id TEXT NOT NULL, workspace_dir TEXT NOT NULL, workspace_key TEXT NOT NULL,
          model_json TEXT, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(device_id, session_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tasks (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          principal_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
          device_id TEXT NOT NULL REFERENCES devices(id), session_id TEXT NOT NULL,
          workspace_key TEXT NOT NULL, request_key TEXT NOT NULL, request_digest TEXT NOT NULL,
          prompt TEXT NOT NULL, criteria_json TEXT NOT NULL, run_verification INTEGER NOT NULL,
          parent_task_id TEXT REFERENCES tasks(id), status TEXT NOT NULL
            CHECK(status IN ('queued','running','waiting_input','cancel_requested','succeeded','failed','cancelled','unknown')),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
          lease_token_hash TEXT, lease_expires_at INTEGER, last_sequence INTEGER NOT NULL DEFAULT 0,
          result_json TEXT, error TEXT, completion_digest TEXT, reconciled_at INTEGER,
          UNIQUE(principal_id,request_key)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS tasks_order ON tasks(created_at DESC,seq DESC);
        CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(device_id,status,seq);
        CREATE UNIQUE INDEX IF NOT EXISTS tasks_workspace_lock ON tasks(device_id,workspace_key)
          WHERE status IN (${LOCK_SQL});
        CREATE UNIQUE INDEX IF NOT EXISTS tasks_device_lock ON tasks(device_id)
          WHERE status IN (${LOCK_SQL});
        CREATE TABLE IF NOT EXISTS events (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
          type TEXT NOT NULL, time INTEGER, payload_json TEXT NOT NULL, digest TEXT NOT NULL,
          received_at INTEGER NOT NULL, PRIMARY KEY(task_id,sequence)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS interactions (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('permission','question')),
          session_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','reserved','resolved','unknown')),
          command_id TEXT, PRIMARY KEY(task_id,kind,session_id,request_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS commands (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          principal_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('cancel','steer','reply','answer')),
          payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected','unknown')),
          request_key TEXT NOT NULL, request_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, message TEXT, ack_digest TEXT,
          UNIQUE(principal_id,request_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL,
          entity_id TEXT NOT NULL, details_json TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version=1;
      `);
    });
  }

  #transaction<T>(callback: () => T): T {
    if (this.#closed) fail('STORE_CLOSED', 'Store is closed.', 503);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #record(action: string, entityId: string, details: Json = {}): void {
    this.#db
      .prepare('INSERT INTO audit(at,action,entity_id,details_json) VALUES(?,?,?,?)')
      .run(this.#now(), action, entityId, encoded(details, 8192, 'audit details'));
  }
  #device(row: Row): Device {
    return {
      id: s(row, 'id'),
      name: s(row, 'name'),
      version: s(row, 'version'),
      createdAt: n(row, 'created_at'),
      lastSeenAt: n(row, 'last_seen_at'),
      revokedAt: nullableNumber(row, 'revoked_at'),
    };
  }
  #project(row: Row): Project {
    return {
      id: s(row, 'id'),
      deviceId: s(row, 'device_id'),
      name: s(row, 'name'),
      sessionId: s(row, 'session_id'),
      workspaceDir: s(row, 'workspace_dir'),
      workspaceKey: s(row, 'workspace_key'),
      model: row.model_json === null ? null : parse(row.model_json),
      enabled: n(row, 'enabled') === 1,
      createdAt: n(row, 'created_at'),
      updatedAt: n(row, 'updated_at'),
    };
  }
  #task(row: Row): Task {
    return {
      id: s(row, 'id'),
      projectId: s(row, 'project_id'),
      deviceId: s(row, 'device_id'),
      sessionId: s(row, 'session_id'),
      workspaceKey: s(row, 'workspace_key'),
      requestKey: s(row, 'request_key'),
      prompt: s(row, 'prompt'),
      acceptanceCriteria: parse(row.criteria_json),
      runVerification: n(row, 'run_verification') === 1,
      parentTaskId: nullableString(row, 'parent_task_id'),
      status: s(row, 'status') as TaskStatus,
      createdAt: n(row, 'created_at'),
      updatedAt: n(row, 'updated_at'),
      startedAt: nullableNumber(row, 'started_at'),
      completedAt: nullableNumber(row, 'completed_at'),
      leaseExpiresAt: nullableNumber(row, 'lease_expires_at'),
      lastSequence: n(row, 'last_sequence'),
      result: row.result_json === null ? null : parse(row.result_json),
      error: nullableString(row, 'error'),
    };
  }
  #command(row: Row): TaskCommand {
    return {
      id: s(row, 'id'),
      taskId: s(row, 'task_id'),
      kind: s(row, 'kind') as CommandKind,
      payload: parse(row.payload_json),
      status: s(row, 'status') as TaskCommand['status'],
      requestKey: s(row, 'request_key'),
      createdAt: n(row, 'created_at'),
      updatedAt: n(row, 'updated_at'),
      message: nullableString(row, 'message'),
    };
  }
  #getTask(idValue: string): Row {
    text(idValue, 'taskId');
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id=?').get(idValue) as Row | undefined;
    if (!row) fail('TASK_NOT_FOUND', 'Task was not found.', 404);
    return row;
  }
  #getProject(idValue: string): Row {
    text(idValue, 'projectId');
    const row = this.#db.prepare('SELECT * FROM projects WHERE id=?').get(idValue) as
      Row | undefined;
    if (!row) fail('PROJECT_NOT_FOUND', 'Project was not found.', 404);
    return row;
  }
  #requireDevice(deviceId: string): Row {
    text(deviceId, 'deviceId');
    const row = this.#db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId) as
      Row | undefined;
    if (!row || row.revoked_at !== null)
      fail('DEVICE_UNAUTHORIZED', 'Device authorization is unavailable.', 401);
    return row;
  }
  #lease(
    deviceId: string,
    taskId: string,
    leaseToken: string,
    allowUnknown = false,
    allowTerminal = false,
  ): Row {
    this.#requireDevice(deviceId);
    const row = this.#getTask(taskId);
    if (row.device_id !== deviceId)
      fail('TASK_NOT_FOUND', 'Task was not found for this device.', 404);
    if (
      typeof leaseToken !== 'string' ||
      !/^crl_[A-Za-z0-9_-]{43}$/.test(leaseToken) ||
      row.lease_token_hash !== hash(leaseToken)
    ) {
      fail('INVALID_LEASE', 'Task lease does not match.', 403);
    }
    if (row.reconciled_at !== null)
      fail(
        'TASK_RECONCILED',
        'This task was explicitly reconciled and cannot be overwritten.',
        409,
      );
    const status = s(row, 'status');
    if (isActive(status) && n(row, 'lease_expires_at') > this.#now()) return row;
    if (allowUnknown && status === 'unknown') return row;
    if (allowTerminal && isTerminal(status)) return row;
    fail(
      'LEASE_EXPIRED',
      'Task is no longer executable under this lease. Reconcile its actual outcome.',
      409,
    );
  }

  createPairingCode(name: string): { code: string; expiresAt: number } {
    text(name, 'name', 128);
    return this.#transaction(() => {
      const now = this.#now();
      const count = this.#db
        .prepare(
          'SELECT count(*) AS count FROM pairing_codes WHERE used_at IS NULL AND expires_at>?',
        )
        .get(now) as Row;
      if (n(count, 'count') >= 64)
        fail('PAIRING_LIMIT', 'There are too many unexpired pairing codes.', 429);
      const code = `CRP_${randomBytes(16).toString('base64url')}`;
      const expiresAt = now + 5 * 60_000;
      this.#db
        .prepare('INSERT INTO pairing_codes(code_hash,name,created_at,expires_at) VALUES(?,?,?,?)')
        .run(hash(code), name, now, expiresAt);
      this.#record('pairing.created', '', { name, expiresAt });
      return { code, expiresAt };
    });
  }

  pairDevice(input: { code: string; name: string; version: string }): {
    device: Device;
    token: string;
  } {
    text(input.code, 'code', 128);
    text(input.name, 'name', 128);
    text(input.version, 'version', 128);
    return this.#transaction(() => {
      const now = this.#now();
      const code = this.#db
        .prepare('SELECT * FROM pairing_codes WHERE code_hash=?')
        .get(hash(input.code.trim())) as Row | undefined;
      if (!code || code.used_at !== null || n(code, 'expires_at') <= now)
        fail('INVALID_PAIRING_CODE', 'Pairing code is invalid, expired, or already used.', 401);
      const deviceId = id('dev');
      const token = secret('crd');
      this.#db
        .prepare('UPDATE pairing_codes SET used_at=? WHERE code_hash=?')
        .run(now, hash(input.code.trim()));
      this.#db
        .prepare(
          'INSERT INTO devices(id,name,version,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)',
        )
        .run(deviceId, input.name, input.version, hash(token), now, now);
      this.#record('device.paired', deviceId, { name: input.name, version: input.version });
      return { device: this.#device(this.#requireDevice(deviceId)), token };
    });
  }

  authenticateDevice(token: string): Device | null {
    if (typeof token !== 'string' || !/^crd_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.#db
      .prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL')
      .get(hash(token)) as Row | undefined;
    return row ? this.#device(row) : null;
  }
  devices(): Device[] {
    return (this.#db.prepare('SELECT * FROM devices ORDER BY created_at,id').all() as Row[]).map(
      (row) => this.#device(row),
    );
  }

  revokeDevice(deviceId: string): void {
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId) as
        Row | undefined;
      if (!row) fail('DEVICE_NOT_FOUND', 'Device was not found.', 404);
      if (row.revoked_at !== null) return;
      const now = this.#now();
      this.#db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(now, deviceId);
      this.#db
        .prepare('UPDATE projects SET enabled=0,updated_at=? WHERE device_id=?')
        .run(now, deviceId);
      this.#db
        .prepare(
          "UPDATE tasks SET status='unknown',updated_at=?,error='Device authorization was revoked during execution.' WHERE device_id=? AND status IN (" +
            ACTIVE_SQL +
            ')',
        )
        .run(now, deviceId);
      this.#db
        .prepare(
          "UPDATE tasks SET status='cancelled',updated_at=?,completed_at=?,error='Device authorization was revoked before execution.' WHERE device_id=? AND status='queued'",
        )
        .run(now, now, deviceId);
      this.#record('device.revoked', deviceId);
    });
  }
  heartbeatDevice(deviceId: string): void {
    this.#transaction(() => {
      this.#requireDevice(deviceId);
      this.#db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(this.#now(), deviceId);
    });
  }

  upsertProject(deviceId: string, input: ProjectInput): Project {
    text(input.name, 'name', 128);
    text(input.sessionId, 'sessionId', 256);
    text(input.workspaceDir, 'workspaceDir', 4096);
    if (
      !isAbsolute(input.workspaceDir) &&
      !/^[A-Za-z]:[\\/]/.test(input.workspaceDir) &&
      !/^\\\\[^\\]+\\[^\\]+/.test(input.workspaceDir)
    ) {
      fail('INVALID_INPUT', 'workspaceDir must be an absolute canonical device path.');
    }
    if (!/^[a-f0-9]{64}$/.test(input.workspaceKey))
      fail('INVALID_INPUT', 'workspaceKey must be a SHA-256 lowercase hex digest.');
    if (input.projectId !== undefined) text(input.projectId, 'projectId');
    let modelJson: string | null = null;
    if (input.model !== undefined) {
      const model = object(input.model, 'model');
      text(model.providerId, 'providerId', 256);
      text(model.modelId, 'modelId', 256);
      modelJson = encoded(input.model, 8192, 'model');
    }
    return this.#transaction(() => {
      this.#sweep();
      this.#requireDevice(deviceId);
      const existing = input.projectId
        ? this.#getProject(input.projectId)
        : (this.#db
            .prepare('SELECT * FROM projects WHERE device_id=? AND session_id=?')
            .get(deviceId, input.sessionId) as Row | undefined);
      const now = this.#now();
      if (existing) {
        if (existing.device_id !== deviceId)
          fail('PROJECT_NOT_FOUND', 'Project was not found for this device.', 404);
        const unchanged =
          existing.name === input.name &&
          existing.session_id === input.sessionId &&
          existing.workspace_dir === input.workspaceDir &&
          existing.workspace_key === input.workspaceKey &&
          existing.model_json === modelJson;
        if (unchanged) return this.#project(existing);
        const occupied = this.#db
          .prepare(
            `SELECT id FROM tasks WHERE project_id=? AND status IN ('queued',${LOCK_SQL}) LIMIT 1`,
          )
          .get(s(existing, 'id'));
        if (occupied)
          fail(
            'PROJECT_BUSY',
            'A project with queued, active, or unknown work cannot be rebound.',
            409,
          );
        const conflict = this.#db
          .prepare('SELECT id FROM projects WHERE device_id=? AND session_id=? AND id<>?')
          .get(deviceId, input.sessionId, s(existing, 'id'));
        if (conflict)
          fail('SESSION_ALREADY_BOUND', 'This session is already bound to another project.', 409);
        this.#db
          .prepare(
            'UPDATE projects SET name=?,session_id=?,workspace_dir=?,workspace_key=?,model_json=?,enabled=1,updated_at=? WHERE id=?',
          )
          .run(
            input.name,
            input.sessionId,
            input.workspaceDir,
            input.workspaceKey,
            modelJson,
            now,
            s(existing, 'id'),
          );
        this.#record('project.updated', s(existing, 'id'), { deviceId });
        return this.#project(this.#getProject(s(existing, 'id')));
      }
      const count = this.#db
        .prepare('SELECT count(*) AS count FROM projects WHERE device_id=?')
        .get(deviceId) as Row;
      if (n(count, 'count') >= 256)
        fail('PROJECT_LIMIT', 'This device has reached its project binding limit.', 409);
      const projectId = id('prj');
      this.#db
        .prepare(
          'INSERT INTO projects(id,device_id,name,session_id,workspace_dir,workspace_key,model_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)',
        )
        .run(
          projectId,
          deviceId,
          input.name,
          input.sessionId,
          input.workspaceDir,
          input.workspaceKey,
          modelJson,
          now,
          now,
        );
      this.#record('project.created', projectId, { deviceId });
      return this.#project(this.#getProject(projectId));
    });
  }
  projects(deviceId?: string): Project[] {
    const rows = deviceId
      ? this.#db
          .prepare('SELECT * FROM projects WHERE device_id=? ORDER BY created_at,id')
          .all(deviceId)
      : this.#db.prepare('SELECT * FROM projects ORDER BY created_at,id').all();
    return (rows as Row[]).map((row) => this.#project(row));
  }

  submit(principalId: string, input: SubmitTask): Task {
    text(principalId, 'principalId');
    requestKey(input.requestKey);
    text(input.prompt, 'prompt', 100_000);
    text(input.projectId, 'projectId');
    const criteria = input.acceptanceCriteria ?? [];
    if (!Array.isArray(criteria) || criteria.length > 50)
      fail('INVALID_INPUT', 'acceptanceCriteria must contain at most 50 items.');
    for (const item of criteria) text(item, 'acceptance criterion', 4000);
    if (input.runVerification !== undefined && typeof input.runVerification !== 'boolean')
      fail('INVALID_INPUT', 'runVerification must be boolean.');
    if (input.parentTaskId !== undefined) text(input.parentTaskId, 'parentTaskId');
    const normalized = {
      projectId: input.projectId,
      prompt: input.prompt,
      acceptanceCriteria: criteria,
      runVerification: input.runVerification ?? true,
      parentTaskId: input.parentTaskId ?? null,
    };
    const digest = hash(encoded(normalized, 384 * 1024, 'task'));
    return this.#transaction(() => {
      this.#sweep();
      const prior = this.#db
        .prepare('SELECT * FROM tasks WHERE principal_id=? AND request_key=?')
        .get(principalId, input.requestKey) as Row | undefined;
      if (prior) {
        if (prior.request_digest !== digest)
          fail('IDEMPOTENCY_CONFLICT', 'This requestKey was used with different task input.', 409);
        return this.#task(prior);
      }
      const project = this.#getProject(input.projectId);
      this.#requireDevice(s(project, 'device_id'));
      if (n(project, 'enabled') !== 1)
        fail('PROJECT_DISABLED', 'Project binding is disabled.', 409);
      if (input.parentTaskId !== undefined) {
        const parent = this.#getTask(input.parentTaskId);
        if (parent.project_id !== input.projectId)
          fail('PARENT_PROJECT_MISMATCH', 'Continuation must use the original project.', 409);
        if (!isTerminal(s(parent, 'status')))
          fail('PARENT_NOT_TERMINAL', 'Only a confirmed terminal task can be continued.', 409);
        if (parent.session_id !== project.session_id)
          fail(
            'PARENT_SESSION_CHANGED',
            'The project was rebound; its previous task cannot be continued in another session.',
            409,
          );
      }
      const total = this.#db.prepare('SELECT count(*) AS count FROM tasks').get() as Row;
      const queued = this.#db
        .prepare("SELECT count(*) AS count FROM tasks WHERE status='queued'")
        .get() as Row;
      if (n(total, 'count') >= 10_000 || n(queued, 'count') >= 1000)
        fail(
          'TASK_LIMIT',
          'Task storage or queue capacity has been reached. Archive completed work before adding more.',
          429,
        );
      const taskId = id('task');
      const now = this.#now();
      this.#db
        .prepare(
          `INSERT INTO tasks(id,principal_id,project_id,device_id,session_id,workspace_key,request_key,request_digest,
        prompt,criteria_json,run_verification,parent_task_id,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
        )
        .run(
          taskId,
          principalId,
          input.projectId,
          s(project, 'device_id'),
          s(project, 'session_id'),
          s(project, 'workspace_key'),
          input.requestKey,
          digest,
          input.prompt,
          canonical(criteria),
          normalized.runVerification ? 1 : 0,
          normalized.parentTaskId,
          now,
          now,
        );
      this.#record('task.submitted', taskId, { principalId, projectId: input.projectId });
      return this.#task(this.#getTask(taskId));
    });
  }

  getTask(taskId: string): Task {
    this.sweep();
    return this.#task(this.#getTask(taskId));
  }
  listTasks(options: { limit?: number; before?: string } = {}): Task[] {
    const limit = integer(options.limit ?? 25, 'limit', 1, 100);
    this.sweep();
    let rows: Row[];
    if (options.before !== undefined) {
      const before = this.#getTask(options.before);
      rows = this.#db
        .prepare(
          'SELECT * FROM tasks WHERE created_at<? OR (created_at=? AND seq<?) ORDER BY created_at DESC,seq DESC LIMIT ?',
        )
        .all(n(before, 'created_at'), n(before, 'created_at'), n(before, 'seq'), limit) as Row[];
    } else
      rows = this.#db
        .prepare('SELECT * FROM tasks ORDER BY created_at DESC,seq DESC LIMIT ?')
        .all(limit) as Row[];
    return rows.map((row) => this.#task(row));
  }

  claim(deviceId: string): Assignment | null {
    return this.#transaction(() => {
      this.#sweep();
      this.#requireDevice(deviceId);
      const now = this.#now();
      this.#db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now, deviceId);
      if (
        this.#db
          .prepare(`SELECT id FROM tasks WHERE device_id=? AND status IN (${LOCK_SQL}) LIMIT 1`)
          .get(deviceId)
      )
        return null;
      const row = this.#db
        .prepare(
          `SELECT t.* FROM tasks t JOIN projects p ON p.id=t.project_id
        WHERE t.device_id=? AND t.status='queued' AND p.enabled=1
        AND NOT EXISTS (SELECT 1 FROM tasks busy WHERE busy.device_id=t.device_id AND busy.workspace_key=t.workspace_key
          AND busy.status IN (${LOCK_SQL})) ORDER BY t.seq LIMIT 1`,
        )
        .get(deviceId) as Row | undefined;
      if (!row) return null;
      const token = secret('crl');
      this.#db
        .prepare(
          "UPDATE tasks SET status='running',started_at=?,updated_at=?,lease_token_hash=?,lease_expires_at=? WHERE id=? AND status='queued'",
        )
        .run(now, now, hash(token), now + this.#leaseMs, s(row, 'id'));
      this.#record('task.claimed', s(row, 'id'), { deviceId });
      return {
        task: this.#task(this.#getTask(s(row, 'id'))),
        project: this.#project(this.#getProject(s(row, 'project_id'))),
        leaseToken: token,
      };
    });
  }

  heartbeat(
    deviceId: string,
    taskId: string,
    leaseToken: string,
  ): { leaseExpiresAt: number; commands: TaskCommand[] } {
    this.sweep();
    return this.#transaction(() => {
      this.#lease(deviceId, taskId, leaseToken);
      const now = this.#now();
      const leaseExpiresAt = now + this.#leaseMs;
      this.#db
        .prepare('UPDATE tasks SET lease_expires_at=?,updated_at=? WHERE id=?')
        .run(leaseExpiresAt, now, taskId);
      this.#db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now, deviceId);
      const commands = this.#db
        .prepare("SELECT * FROM commands WHERE task_id=? AND status='pending' ORDER BY seq")
        .all(taskId) as Row[];
      return { leaseExpiresAt, commands: commands.map((row) => this.#command(row)) };
    });
  }

  appendEvents(
    deviceId: string,
    taskId: string,
    leaseToken: string,
    events: WorkerEvent[],
  ): number {
    if (!Array.isArray(events) || events.length < 1 || events.length > 100)
      fail('INVALID_INPUT', 'events must contain 1–100 events.');
    encoded(events, MAX_EVENT_BATCH, 'event batch');
    for (const event of events) {
      integer(event.sequence, 'sequence', 1, MAX_TASK_EVENTS);
      text(event.type, 'event type', 128);
      if (event.time !== undefined) integer(event.time, 'event time', 0, Number.MAX_SAFE_INTEGER);
    }
    this.sweep();
    return this.#transaction(() => {
      const task = this.#lease(deviceId, taskId, leaseToken, true);
      let sequence = n(task, 'last_sequence');
      const now = this.#now();
      for (const event of events) {
        const normalized = {
          sequence: event.sequence,
          type: event.type,
          time: event.time ?? null,
          payload: event.payload,
        };
        const digest = hash(canonical(normalized));
        if (event.sequence <= sequence) {
          const previous = this.#db
            .prepare('SELECT digest FROM events WHERE task_id=? AND sequence=?')
            .get(taskId, event.sequence) as Row | undefined;
          if (!previous || previous.digest !== digest)
            fail('EVENT_CONFLICT', 'An event sequence was reused with different content.', 409);
          continue;
        }
        if (event.sequence !== sequence + 1)
          fail('EVENT_GAP', `Expected event sequence ${sequence + 1}.`, 409);
        this.#db
          .prepare(
            'INSERT INTO events(task_id,sequence,type,time,payload_json,digest,received_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            taskId,
            event.sequence,
            event.type,
            event.time ?? null,
            canonical(event.payload),
            digest,
            now,
          );
        this.#interactionEvent(taskId, event.type, event.payload);
        sequence = event.sequence;
      }
      this.#db
        .prepare('UPDATE tasks SET last_sequence=?,updated_at=? WHERE id=?')
        .run(sequence, now, taskId);
      this.#updateWaiting(taskId);
      return sequence;
    });
  }

  #interactionEvent(taskId: string, type: string, payload: Json): void {
    const requested = type === 'permission.requested' || type === 'question.requested';
    const resolved = type === 'permission.resolved' || type === 'question.answered';
    if (!requested && !resolved) return;
    const input = object(payload);
    const sessionId = text(input.sessionId, 'interaction sessionId');
    const requestId = text(input.requestId, 'interaction requestId');
    const kind = type.startsWith('permission.') ? 'permission' : 'question';
    if (requested) {
      const current = this.#db
        .prepare(
          'SELECT * FROM interactions WHERE task_id=? AND kind=? AND session_id=? AND request_id=?',
        )
        .get(taskId, kind, sessionId, requestId) as Row | undefined;
      if (current) {
        if (current.status === 'pending')
          this.#db
            .prepare(
              'UPDATE interactions SET payload_json=? WHERE task_id=? AND kind=? AND session_id=? AND request_id=?',
            )
            .run(canonical(payload), taskId, kind, sessionId, requestId);
      } else
        this.#db
          .prepare(
            "INSERT INTO interactions(task_id,kind,session_id,request_id,payload_json,status) VALUES(?,?,?,?,?,'pending')",
          )
          .run(taskId, kind, sessionId, requestId, canonical(payload));
    } else {
      const current = this.#db
        .prepare(
          'SELECT * FROM interactions WHERE task_id=? AND kind=? AND session_id=? AND request_id=?',
        )
        .get(taskId, kind, sessionId, requestId) as Row | undefined;
      if (!current)
        fail('INTERACTION_NOT_FOUND', 'Resolution does not match a recorded interaction.', 409);
      if (current.command_id !== null)
        this.#db
          .prepare(
            "UPDATE commands SET status='rejected',updated_at=?,message='Answered locally on the device.' WHERE id=? AND status='pending'",
          )
          .run(this.#now(), s(current, 'command_id'));
      this.#db
        .prepare(
          "UPDATE interactions SET status='resolved' WHERE task_id=? AND kind=? AND session_id=? AND request_id=?",
        )
        .run(taskId, kind, sessionId, requestId);
    }
  }

  #updateWaiting(taskId: string): void {
    const task = this.#getTask(taskId);
    if (task.status !== 'running' && task.status !== 'waiting_input') return;
    const pending = this.#db
      .prepare(
        "SELECT 1 FROM interactions WHERE task_id=? AND status IN ('pending','reserved') LIMIT 1",
      )
      .get(taskId);
    this.#db
      .prepare('UPDATE tasks SET status=? WHERE id=?')
      .run(pending ? 'waiting_input' : 'running', taskId);
  }
  events(taskId: string, after = 0, limit = 100): StoredEvent[] {
    this.#getTask(taskId);
    integer(after, 'after', 0, MAX_TASK_EVENTS);
    integer(limit, 'limit', 1, 100);
    return (
      this.#db
        .prepare('SELECT * FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?')
        .all(taskId, after, limit) as Row[]
    ).map((row) => ({
      sequence: n(row, 'sequence'),
      type: s(row, 'type'),
      ...(row.time === null ? {} : { time: n(row, 'time') }),
      payload: parse<Json>(row.payload_json),
      receivedAt: n(row, 'received_at'),
    }));
  }

  complete(deviceId: string, taskId: string, leaseToken: string, input: Completion): Task {
    if (![...TERMINAL, 'unknown'].includes(input.outcome))
      fail('INVALID_INPUT', 'Unsupported task outcome.');
    if (input.error !== undefined) text(input.error, 'error', 4000);
    const resultJson = encoded(input.result, MAX_RESULT, 'result');
    const digest = hash(
      canonical({ outcome: input.outcome, result: input.result, error: input.error ?? null }),
    );
    this.sweep();
    return this.#transaction(() => {
      const row = this.#lease(deviceId, taskId, leaseToken, true, true);
      if (isTerminal(s(row, 'status'))) {
        if (row.completion_digest !== digest)
          fail('COMPLETION_CONFLICT', 'A different terminal result is already committed.', 409);
        return this.#task(row);
      }
      if (row.status === 'unknown' && row.completion_digest === digest) return this.#task(row);
      const now = this.#now();
      this.#db
        .prepare(
          'UPDATE tasks SET status=?,updated_at=?,completed_at=?,result_json=?,error=?,completion_digest=? WHERE id=?',
        )
        .run(
          input.outcome,
          now,
          input.outcome === 'unknown' ? null : now,
          resultJson,
          input.error ?? null,
          digest,
          taskId,
        );
      if (input.outcome !== 'unknown') {
        this.#db
          .prepare(
            "UPDATE commands SET status='rejected',updated_at=?,message='Task finished before this command was acknowledged.' WHERE task_id=? AND status='pending'",
          )
          .run(now, taskId);
        this.#db.prepare("UPDATE interactions SET status='resolved' WHERE task_id=?").run(taskId);
      }
      this.#record('task.completed', taskId, { outcome: input.outcome });
      return this.#task(this.#getTask(taskId));
    });
  }

  #validateCommandPayload(kind: CommandKind, payload: Json): Record<string, unknown> {
    const value = object(payload);
    encoded(payload, 128 * 1024, 'command payload');
    if (kind === 'cancel') {
      if (Object.keys(value).length !== 0) fail('INVALID_INPUT', 'Cancel payload must be empty.');
    } else if (kind === 'steer') {
      text(value.text, 'text', 100_000);
      if (Object.keys(value).some((key) => key !== 'text'))
        fail('INVALID_INPUT', 'Unexpected steering field.');
    } else if (kind === 'reply' || kind === 'answer') {
      text(value.sessionId, 'sessionId');
      text(value.requestId, 'requestId');
      if (kind === 'reply') {
        if (value.decision !== 'allowOnce' && value.decision !== 'deny')
          fail('INVALID_INPUT', 'A permission decision must be allowOnce or deny.');
        if (Object.keys(value).some((key) => !['sessionId', 'requestId', 'decision'].includes(key)))
          fail('INVALID_INPUT', 'Unexpected permission field.');
      } else {
        if (!Array.isArray(value.answers) || value.answers.length < 1 || value.answers.length > 64)
          fail('INVALID_INPUT', 'answers must contain 1–64 steps.');
        if (Object.keys(value).some((key) => !['sessionId', 'requestId', 'answers'].includes(key)))
          fail('INVALID_INPUT', 'Unexpected questionnaire field.');
        const seen = new Set<string>();
        for (const raw of value.answers) {
          const answer = object(raw, 'answer');
          const stepId = text(answer.stepId, 'stepId', 4096);
          if (seen.has(stepId))
            fail('INVALID_INPUT', 'A questionnaire step may be answered only once.');
          seen.add(stepId);
          if (
            Object.keys(answer).some(
              (key) =>
                !['stepId', 'selectedOptionIds', 'selectedOther', 'otherText', 'skipped'].includes(
                  key,
                ),
            )
          )
            fail('INVALID_INPUT', 'Unexpected questionnaire answer field.');
          if (!Array.isArray(answer.selectedOptionIds) || answer.selectedOptionIds.length > 64)
            fail('INVALID_INPUT', 'selectedOptionIds must be an array of at most 64 IDs.');
          for (const optionId of answer.selectedOptionIds) text(optionId, 'optionId', 4096);
          if (new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length)
            fail('INVALID_INPUT', 'Duplicate selected option IDs.');
          if (typeof answer.selectedOther !== 'boolean')
            fail('INVALID_INPUT', 'selectedOther must be boolean.');
          if (answer.otherText !== undefined) text(answer.otherText, 'otherText', 4096);
          if (answer.skipped !== undefined && typeof answer.skipped !== 'boolean')
            fail('INVALID_INPUT', 'skipped must be boolean.');
        }
      }
    } else fail('INVALID_INPUT', 'Unknown command kind.');
    return value;
  }

  #validateQuestionAnswers(interaction: Row, payload: Record<string, unknown>): void {
    const source = object(parse<Json>(interaction.payload_json));
    const request = source.request;
    if (!request || typeof request !== 'object' || Array.isArray(request))
      fail('QUESTION_NOT_READY', 'Questionnaire details have not arrived yet.', 409);
    const steps = (request as Record<string, unknown>).steps;
    if (!Array.isArray(steps) || steps.length === 0)
      fail('QUESTION_NOT_READY', 'Questionnaire steps have not arrived yet.', 409);
    const answers = payload.answers as Record<string, unknown>[];
    const stepMap = new Map<string, Record<string, unknown>>();
    for (const raw of steps) {
      const step = object(raw, 'question step');
      const stepId = text(step.id ?? step.stepId, 'question step ID', 4096);
      stepMap.set(stepId, step);
    }
    if (answers.length !== stepMap.size)
      fail('ANSWER_MISMATCH', 'Provide one answer for every questionnaire step.', 409);
    for (const answer of answers) {
      const step = stepMap.get(answer.stepId as string);
      if (!step) fail('ANSWER_MISMATCH', 'Answer references an unknown questionnaire step.', 409);
      const options = Array.isArray(step.options) ? step.options : [];
      const ids = new Set(
        options.map((raw) => {
          const option = object(raw, 'question option');
          return text(option.id, 'question option ID', 4096);
        }),
      );
      for (const selected of answer.selectedOptionIds as string[])
        if (!ids.has(selected))
          fail('ANSWER_MISMATCH', 'Answer references an unknown option.', 409);
      if (
        step.selectionMode === 'single' &&
        (answer.selectedOptionIds as string[]).length + (answer.selectedOther ? 1 : 0) > 1
      ) {
        fail('ANSWER_MISMATCH', 'This questionnaire step permits only one selection.', 409);
      }
      if (answer.selectedOther && step.allowOther === false)
        fail('ANSWER_MISMATCH', 'This step does not allow a free-text answer.', 409);
      if (
        answer.selectedOther &&
        (typeof answer.otherText !== 'string' || !answer.otherText.trim())
      )
        fail('ANSWER_MISMATCH', 'A free-text selection requires otherText.', 409);
      if (!answer.selectedOther && answer.otherText !== undefined)
        fail('ANSWER_MISMATCH', 'otherText requires selectedOther.', 409);
      if (
        answer.skipped === true &&
        ((answer.selectedOptionIds as string[]).length > 0 || answer.selectedOther)
      )
        fail('ANSWER_MISMATCH', 'A skipped step cannot also contain selections.', 409);
      if (
        step.required !== false &&
        answer.skipped !== true &&
        (answer.selectedOptionIds as string[]).length === 0 &&
        !answer.selectedOther
      )
        fail('ANSWER_MISMATCH', 'A required step needs a selection or an explicit skip.', 409);
    }
    const expiresAt = (request as Record<string, unknown>).expiresAt;
    if (typeof expiresAt === 'number' && expiresAt <= this.#now())
      fail('QUESTION_EXPIRED', 'The questionnaire has expired.', 409);
  }

  enqueueCommand(principalId: string, taskId: string, input: CommandInput): TaskCommand {
    text(principalId, 'principalId');
    requestKey(input.requestKey);
    this.#validateCommandPayload(input.kind, input.payload);
    this.sweep();
    return this.#transaction(() => this.#enqueue(principalId, taskId, input));
  }
  #enqueue(principalId: string, taskId: string, input: CommandInput): TaskCommand {
    const digest = hash(canonical({ taskId, kind: input.kind, payload: input.payload }));
    const prior = this.#db
      .prepare('SELECT * FROM commands WHERE principal_id=? AND request_key=?')
      .get(principalId, input.requestKey) as Row | undefined;
    if (prior) {
      if (prior.request_digest !== digest)
        fail('IDEMPOTENCY_CONFLICT', 'This requestKey was used with different command input.', 409);
      return this.#command(prior);
    }
    const task = this.#getTask(taskId);
    if (task.status === 'unknown')
      fail(
        'OUTCOME_UNKNOWN',
        'Reconcile this task on the actual device before issuing another command.',
        409,
      );
    if (input.kind !== 'cancel' && !isActive(s(task, 'status')))
      fail('TASK_NOT_RUNNING', 'This task cannot receive an instruction.', 409);
    if (task.status === 'cancel_requested' && input.kind !== 'cancel')
      fail('CANCEL_PENDING', 'Cancellation is already pending.', 409);
    const pendingCount = this.#db
      .prepare("SELECT count(*) AS count FROM commands WHERE task_id=? AND status='pending'")
      .get(taskId) as Row;
    if (n(pendingCount, 'count') >= 100)
      fail('COMMAND_LIMIT', 'This task has too many pending commands.', 429);
    const commandId = id('cmd');
    const now = this.#now();
    const value = input.payload as Record<string, unknown>;
    if (input.kind === 'reply' || input.kind === 'answer') {
      const kind = input.kind === 'reply' ? 'permission' : 'question';
      const interaction = this.#db
        .prepare(
          'SELECT * FROM interactions WHERE task_id=? AND kind=? AND session_id=? AND request_id=?',
        )
        .get(taskId, kind, String(value.sessionId), String(value.requestId)) as Row | undefined;
      if (!interaction || interaction.status !== 'pending')
        fail(
          'INTERACTION_NOT_PENDING',
          'There is no matching unanswered interaction for this task.',
          409,
        );
      if (input.kind === 'answer') this.#validateQuestionAnswers(interaction, value);
      this.#db
        .prepare(
          "UPDATE interactions SET status='reserved',command_id=? WHERE task_id=? AND kind=? AND session_id=? AND request_id=?",
        )
        .run(commandId, taskId, kind, String(value.sessionId), String(value.requestId));
    }
    let status: TaskCommand['status'] = 'pending';
    let message: string | null = null;
    if (input.kind === 'cancel') {
      if (task.status === 'queued') {
        this.#db
          .prepare(
            "UPDATE tasks SET status='cancelled',updated_at=?,completed_at=?,error='Cancelled before execution.' WHERE id=?",
          )
          .run(now, now, taskId);
        status = 'applied';
        message = 'Cancelled before execution.';
      } else if (isTerminal(s(task, 'status'))) {
        status = 'applied';
        message = 'Task was already terminal; no execution was cancelled.';
      } else {
        this.#db
          .prepare("UPDATE tasks SET status='cancel_requested',updated_at=? WHERE id=?")
          .run(now, taskId);
      }
    }
    this.#db
      .prepare(
        'INSERT INTO commands(id,task_id,principal_id,kind,payload_json,status,request_key,request_digest,created_at,updated_at,message) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        commandId,
        taskId,
        principalId,
        input.kind,
        canonical(input.payload),
        status,
        input.requestKey,
        digest,
        now,
        now,
        message,
      );
    this.#record('command.queued', commandId, { taskId, kind: input.kind, principalId });
    return this.#command(
      this.#db.prepare('SELECT * FROM commands WHERE id=?').get(commandId) as Row,
    );
  }

  cancel(principalId: string, taskId: string, key: string): Task {
    text(principalId, 'principalId');
    requestKey(key);
    this.sweep();
    return this.#transaction(() => {
      this.#enqueue(principalId, taskId, { requestKey: key, kind: 'cancel', payload: {} });
      return this.#task(this.#getTask(taskId));
    });
  }
  commands(taskId: string): TaskCommand[] {
    this.#getTask(taskId);
    return (
      this.#db.prepare('SELECT * FROM commands WHERE task_id=? ORDER BY seq').all(taskId) as Row[]
    ).map((row) => this.#command(row));
  }

  ackCommand(
    deviceId: string,
    taskId: string,
    leaseToken: string,
    commandId: string,
    input: CommandAck,
  ): TaskCommand {
    if (!['applied', 'rejected', 'unknown'].includes(input.status))
      fail('INVALID_INPUT', 'Unsupported command acknowledgement.');
    if (input.message !== undefined) text(input.message, 'message', 4000);
    const digest = hash(canonical({ status: input.status, message: input.message ?? null }));
    this.sweep();
    return this.#transaction(() => {
      this.#lease(deviceId, taskId, leaseToken, true);
      const row = this.#db
        .prepare('SELECT * FROM commands WHERE id=? AND task_id=?')
        .get(commandId, taskId) as Row | undefined;
      if (!row) fail('COMMAND_NOT_FOUND', 'Command was not found for this task.', 404);
      if (row.status !== 'pending') {
        if (row.ack_digest === digest || (row.status === input.status && row.ack_digest === null))
          return this.#command(row);
        fail(
          'COMMAND_ACK_CONFLICT',
          'A different command acknowledgement is already committed.',
          409,
        );
      }
      const now = this.#now();
      this.#db
        .prepare('UPDATE commands SET status=?,updated_at=?,message=?,ack_digest=? WHERE id=?')
        .run(input.status, now, input.message ?? null, digest, commandId);
      if (row.kind === 'reply' || row.kind === 'answer') {
        const state =
          input.status === 'applied'
            ? 'resolved'
            : input.status === 'rejected'
              ? 'pending'
              : 'unknown';
        this.#db
          .prepare(
            "UPDATE interactions SET status=?,command_id=? WHERE task_id=? AND command_id=? AND status='reserved'",
          )
          .run(state, input.status === 'rejected' ? null : commandId, taskId, commandId);
      }
      if (input.status === 'unknown') {
        this.#db
          .prepare(
            "UPDATE tasks SET status='unknown',updated_at=?,error='A command may have executed; reconcile its outcome on the device.' WHERE id=?",
          )
          .run(now, taskId);
      } else this.#updateWaiting(taskId);
      this.#record('command.acknowledged', commandId, { taskId, status: input.status });
      return this.#command(
        this.#db.prepare('SELECT * FROM commands WHERE id=?').get(commandId) as Row,
      );
    });
  }

  reconcile(taskId: string, input: Reconciliation): Task {
    if (!isTerminal(input.outcome))
      fail('INVALID_INPUT', 'Reconciliation requires a confirmed terminal outcome.');
    text(input.reason, 'reason', 4000, 8);
    const resultJson =
      input.result === undefined ? null : encoded(input.result, MAX_RESULT, 'result');
    return this.#transaction(() => {
      this.#sweep();
      const row = this.#getTask(taskId);
      if (row.status !== 'unknown')
        fail('TASK_NOT_UNKNOWN', 'Only an unknown task can be reconciled.', 409);
      const now = this.#now();
      this.#db
        .prepare(
          'UPDATE tasks SET status=?,updated_at=?,completed_at=?,reconciled_at=?,result_json=COALESCE(?,result_json),error=? WHERE id=?',
        )
        .run(
          input.outcome,
          now,
          now,
          now,
          resultJson,
          `Owner reconciliation: ${input.reason}`,
          taskId,
        );
      this.#db
        .prepare(
          "UPDATE commands SET status='rejected',updated_at=?,message='Task was explicitly reconciled by its owner.' WHERE task_id=? AND status='pending'",
        )
        .run(now, taskId);
      this.#db.prepare("UPDATE interactions SET status='resolved' WHERE task_id=?").run(taskId);
      this.#record('task.reconciled', taskId, { outcome: input.outcome, reason: input.reason });
      return this.#task(this.#getTask(taskId));
    });
  }

  audit(options: { after?: number; limit?: number } = {}): AuditRecord[] {
    const after = integer(options.after ?? 0, 'after', 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(options.limit ?? 100, 'limit', 1, 100);
    return (
      this.#db
        .prepare('SELECT * FROM audit WHERE id>? ORDER BY id LIMIT ?')
        .all(after, limit) as Row[]
    ).map((row) => ({
      id: n(row, 'id'),
      at: n(row, 'at'),
      action: s(row, 'action'),
      entityId: s(row, 'entity_id'),
      details: parse<Json>(row.details_json),
    }));
  }
  #sweep(): void {
    const now = this.#now();
    const expired = this.#db
      .prepare(`SELECT id FROM tasks WHERE status IN (${ACTIVE_SQL}) AND lease_expires_at<=?`)
      .all(now) as Row[];
    for (const row of expired) {
      this.#db
        .prepare(
          "UPDATE tasks SET status='unknown',updated_at=?,error='Execution lease expired; no automatic retry is permitted.' WHERE id=?",
        )
        .run(now, s(row, 'id'));
      this.#record('task.lease_expired', s(row, 'id'));
    }
    this.#db.prepare('DELETE FROM pairing_codes WHERE expires_at<?').run(now - 24 * 60 * 60 * 1000);
  }
  sweep(): void {
    this.#transaction(() => this.#sweep());
  }
  close(): void {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
}
