import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.js';
import type { RelayConfig } from './config.js';
import { RelayError } from './errors.js';
import { handleMcp } from './mcp.js';
import { RelayStore } from './store.js';
import type {
  Device,
  Json,
  Principal,
  ProjectInput,
  SubmitTask,
  Task,
  WorkerEvent,
} from './types.js';

const VERSION = '0.1.0';
const requestKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const identifier = z.string().min(1).max(256);
const empty = z.object({}).strict();
const model = z
  .object({
    providerId: identifier,
    modelId: identifier,
    variant: z.string().max(256).optional(),
    thinking: z.object({ effort: identifier }).strict().optional(),
  })
  .strict();
const project = z
  .object({
    projectId: identifier.optional(),
    name: z.string().min(1).max(256),
    sessionId: identifier,
    workspaceDir: z.string().min(1).max(4096),
    workspaceKey: z.string().regex(/^[a-f0-9]{64}$/),
    model: model.optional(),
  })
  .strict();
const submit = z
  .object({
    projectId: identifier,
    requestKey,
    prompt: z.string().min(1).max(100_000),
    acceptanceCriteria: z.array(z.string().min(1).max(4096)).max(64).optional(),
    runVerification: z.boolean().optional(),
    parentTaskId: identifier.optional(),
  })
  .strict();
const command = z
  .object({ requestKey, kind: z.enum(['cancel', 'steer', 'reply', 'answer']), payload: z.json() })
  .strict();
const lease = z.string().min(16).max(256);
const page = z.coerce.number().int().min(1).max(100);
const sequence = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function clean<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function bearer(req: Request): string {
  const raw = req.headers.authorization;
  const copies = req.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization',
  ).length;
  const match =
    copies === 1 && typeof raw === 'string' && /^Bearer ([A-Za-z0-9_.~-]{16,512})$/i.exec(raw);
  if (!match) throw new RelayError('UNAUTHORIZED', 'A valid bearer credential is required.', 401);
  return match[1]!;
}
function param(req: Request, name: string): string {
  return identifier.parse(req.params[name]);
}
function equalsSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
function taskSummary(task: Task) {
  const { result, prompt, acceptanceCriteria, ...metadata } = task;
  return {
    ...metadata,
    promptPreview: prompt.slice(0, 1000),
    acceptanceCriteriaPreview: acceptanceCriteria.slice(0, 8).map((item) => item.slice(0, 200)),
    hasResult: result !== null,
  };
}

export interface ApplicationOptions {
  store?: RelayStore;
  auth?: AuthService;
  log?: (event: { level: string; code: string; requestId: string }) => void;
}

export function createApplication(config: RelayConfig, options: ApplicationOptions = {}) {
  const store = options.store ?? new RelayStore({ filename: join(config.dataDir, 'relay.sqlite') });
  const auth =
    options.auth ??
    new AuthService({ filename: join(config.dataDir, 'auth.sqlite'), publicUrl: config.publicUrl });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const allowedHosts = new Set([
    new URL(config.publicUrl).hostname,
    'localhost',
    '127.0.0.1',
    '[::1]',
  ]);
  const rates = new Map<string, { count: number; until: number }>();
  const log = options.log ?? ((event) => process.stderr.write(`${JSON.stringify(event)}\n`));

  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-ID', res.locals.requestId as string);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const rawHost = req.headers.host;
    const hostCount = req.rawHeaders.filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === 'host',
    ).length;
    if (
      hostCount !== 1 ||
      typeof rawHost !== 'string' ||
      rawHost.length > 255 ||
      !/^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/.test(rawHost)
    )
      return next(new RelayError('INVALID_HOST', 'Invalid Host header.', 400));
    let host: string;
    try {
      host = new URL(`http://${rawHost}`).hostname;
    } catch {
      return next(new RelayError('INVALID_HOST', 'Invalid Host header.', 400));
    }
    if (!allowedHosts.has(host))
      return next(new RelayError('INVALID_HOST', 'Host is not configured for this gateway.', 403));
    if (req.headers.origin && req.headers.origin !== auth.publicUrl)
      return next(new RelayError('INVALID_ORIGIN', 'Cross-origin requests are not allowed.', 403));
    if (
      req.query.access_token !== undefined ||
      req.query.token !== undefined ||
      req.query.adminToken !== undefined
    ) {
      return next(new RelayError('TOKEN_IN_URL', 'Credentials must not be placed in URLs.', 400));
    }
    const now = Date.now();
    const key = req.socket.remoteAddress ?? 'unknown';
    let bucket = rates.get(key);
    if (!bucket || bucket.until <= now) {
      if (rates.size > 10_000)
        for (const [id, value] of rates) if (value.until <= now) rates.delete(id);
      if (rates.size > 10_000 && !bucket)
        return next(new RelayError('RATE_LIMITED', 'Gateway is busy. Retry later.', 429));
      bucket = { count: 0, until: now + 60_000 };
      rates.set(key, bucket);
    }
    if (++bucket.count > 3000) {
      res.setHeader('Retry-After', '60');
      return next(new RelayError('RATE_LIMITED', 'Request rate exceeded.', 429));
    }
    next();
  });

  // OAuth owns its smaller body parser and its standards-compliant error format.
  auth.installRoutes(app);
  app.use(express.json({ limit: '600kb', strict: true }));
  app.use((req, _res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json'))
      return next(new RelayError('UNSUPPORTED_MEDIA_TYPE', 'Use application/json.', 415));
    next();
  });

  app.get('/healthz', (_req, res) =>
    res.json({ status: 'ok', service: 'CodeRelay', version: VERSION }),
  );
  app.get('/readyz', (_req, res) => {
    store.projects();
    res.json({ status: 'ready' });
  });
  app.get('/', (_req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    res
      .type('html')
      .send(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CodeRelay · 代码接力</title><style>body{font:17px/1.7 system-ui;max-width:720px;margin:12vh auto;padding:24px;color:#17324b;background:#f7fafc}h1{font-size:44px}code{background:#e7eef4;padding:3px 8px;border-radius:5px}a{color:#126885}</style><h1>CodeRelay <small>代码接力</small></h1><p>连接 ChatGPT、Claude 与你自己的 MiniMax Code 开发环境。</p><p>MCP 接口：<code>/mcp</code>。设备和项目数据需要授权才能访问。</p><p>在网关主机运行 <code>coderelay connector-code</code>，然后在客户端连接此服务并完成授权。</p><p><a href="https://github.com/Shermanxwz/CodeRelay">安装文档与源代码</a></p></html>',
      );
  });

  function admin(req: Request, _res: Response, next: NextFunction) {
    try {
      if (!equalsSecret(bearer(req), config.adminToken))
        throw new RelayError('UNAUTHORIZED', 'Invalid administrator credential.', 401);
      next();
    } catch (error) {
      next(error);
    }
  }
  function worker(req: Request, res: Response, next: NextFunction) {
    try {
      const device = store.authenticateDevice(bearer(req));
      if (!device)
        throw new RelayError('UNAUTHORIZED', 'Invalid or revoked device credential.', 401);
      res.locals.device = device;
      next();
    } catch (error) {
      next(error);
    }
  }
  function client(req: Request, res: Response, next: NextFunction) {
    try {
      const principal = auth.verifyAccessToken(bearer(req));
      if (!principal) throw new RelayError('UNAUTHORIZED', 'Invalid or expired access token.', 401);
      res.locals.principal = principal;
      next();
    } catch (error) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${auth.publicUrl}/.well-known/oauth-protected-resource/mcp"`,
      );
      next(error);
    }
  }
  function scope(name: string) {
    return (_req: Request, res: Response, next: NextFunction) => {
      if (!(res.locals.principal as Principal).scopes.includes(name))
        return next(new RelayError('INSUFFICIENT_SCOPE', `The ${name} scope is required.`, 403));
      next();
    };
  }
  const deviceId = (res: Response) => (res.locals.device as Device).id;
  const principalId = (res: Response) => (res.locals.principal as Principal).id;

  app.post('/v1/devices/pair', (req, res) => {
    const body = z
      .object({
        code: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
        version: z.string().min(1).max(128),
      })
      .strict()
      .parse(req.body);
    res.json({ ...store.pairDevice(body), leaseSeconds: 90 });
  });
  app.use('/v1/admin', admin);
  app.post('/v1/admin/pairing-codes', (req, res) => {
    const body = z
      .object({ name: z.string().min(1).max(256) })
      .strict()
      .parse(req.body);
    res.status(201).json(store.createPairingCode(body.name));
  });
  app.post('/v1/admin/connector-codes', (req, res) => {
    empty.parse(req.body);
    res.status(201).json(auth.issueConnectorCode());
  });
  app.post('/v1/admin/access-tokens', (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(256),
        scopes: z
          .array(z.enum(['tasks:read', 'tasks:write']))
          .min(1)
          .max(2),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(auth.issueAccessToken(body));
  });
  app.post('/v1/admin/access-tokens/revoke', (req, res) => {
    const body = z
      .object({ token: z.string().min(16).max(512) })
      .strict()
      .parse(req.body);
    res.json({ revoked: auth.revokeAccessToken(body.token) });
  });
  app.get('/v1/admin/status', (_req, res) =>
    res.json({
      devices: store.devices(),
      projects: store.projects(),
      tasks: store.listTasks({ limit: 30 }).map(taskSummary),
    }),
  );
  app.post('/v1/admin/devices/:id/revoke', (req, res) => {
    empty.parse(req.body);
    store.revokeDevice(param(req, 'id'));
    res.json({ revoked: true });
  });
  app.post('/v1/admin/tasks/:id/reconcile', (req, res) => {
    const body = z
      .object({
        outcome: z.enum(['succeeded', 'failed', 'cancelled']),
        reason: z.string().min(8).max(4096),
        result: z.json().optional(),
      })
      .strict()
      .parse(req.body);
    res.json({ task: store.reconcile(param(req, 'id'), clean(body)) });
  });
  app.get('/v1/admin/audit', (req, res) =>
    res.json({
      records: store.audit({
        after: sequence.parse(req.query.after ?? 0),
        limit: page.parse(req.query.limit ?? 100),
      }),
    }),
  );

  app.use('/v1/worker', worker);
  app.post('/v1/worker/heartbeat', (req, res) => {
    empty.parse(req.body);
    store.heartbeatDevice(deviceId(res));
    res.json({ serverTime: Date.now() });
  });
  app.get('/v1/worker/projects', (_req, res) =>
    res.json({ projects: store.projects(deviceId(res)) }),
  );
  app.post('/v1/worker/projects', (req, res) =>
    res.json({
      project: store.upsertProject(deviceId(res), clean<ProjectInput>(project.parse(req.body))),
    }),
  );
  app.post('/v1/worker/claim', (req, res) => {
    empty.parse(req.body);
    res.json({ assignment: store.claim(deviceId(res)), leaseSeconds: 90, pollAfterMs: 2000 });
  });
  app.use('/v1/worker/tasks/:id', (req, res, next) => {
    try {
      const task = store.getTask(param(req, 'id'));
      if (task.deviceId !== deviceId(res))
        throw new RelayError('NOT_FOUND', 'Task not found.', 404);
      res.locals.workerTask = task;
      next();
    } catch (error) {
      if (error instanceof RelayError && error.code === 'TASK_NOT_FOUND')
        return next(new RelayError('NOT_FOUND', 'Task not found.', 404));
      next(error);
    }
  });
  app.get('/v1/worker/tasks/:id', (req, res) => {
    const task = res.locals.workerTask as Task;
    void req;
    res.json({ task });
  });
  app.post('/v1/worker/tasks/:id/heartbeat', (req, res) => {
    const body = z.object({ leaseToken: lease }).strict().parse(req.body);
    res.json(store.heartbeat(deviceId(res), param(req, 'id'), body.leaseToken));
  });
  app.post('/v1/worker/tasks/:id/events', (req, res) => {
    const body = z
      .object({
        leaseToken: lease,
        events: z
          .array(
            z
              .object({
                sequence: z.number().int().positive(),
                type: z.string().min(1).max(128),
                time: z.number().int().optional(),
                payload: z.json(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .parse(req.body);
    res.json({
      acknowledgedSequence: store.appendEvents(
        deviceId(res),
        param(req, 'id'),
        body.leaseToken,
        clean<WorkerEvent[]>(body.events),
      ),
    });
  });
  app.post('/v1/worker/tasks/:id/complete', (req, res) => {
    const body = z
      .object({
        leaseToken: lease,
        outcome: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']),
        result: z.json(),
        error: z.string().max(4096).optional(),
      })
      .strict()
      .parse(req.body);
    res.json({
      task: store.complete(
        deviceId(res),
        param(req, 'id'),
        body.leaseToken,
        clean({ outcome: body.outcome, result: body.result, error: body.error }),
      ),
    });
  });
  app.post('/v1/worker/tasks/:id/commands/:commandId/ack', (req, res) => {
    const body = z
      .object({
        leaseToken: lease,
        status: z.enum(['applied', 'rejected', 'unknown']),
        message: z.string().max(4096).optional(),
      })
      .strict()
      .parse(req.body);
    res.json({
      command: store.ackCommand(
        deviceId(res),
        param(req, 'id'),
        body.leaseToken,
        param(req, 'commandId'),
        clean({ status: body.status, message: body.message }),
      ),
    });
  });
  app.use(['/v1/admin', '/v1/worker'], (_req, res) =>
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }),
  );

  app.all('/mcp', client, async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'This endpoint uses stateless Streamable HTTP POST.',
        },
      });
      return;
    }
    await handleMcp(req, res, store, res.locals.principal as Principal);
  });
  const clients = express.Router();
  clients.use(client);
  clients.get('/projects', scope('tasks:read'), (_req, res) =>
    res.json({ projects: store.projects() }),
  );
  clients.get('/devices', scope('tasks:read'), (_req, res) =>
    res.json({ devices: store.devices() }),
  );
  clients.get('/tasks', scope('tasks:read'), (req, res) => {
    const before = req.query.before === undefined ? undefined : identifier.parse(req.query.before);
    const tasks = store.listTasks(clean({ limit: page.parse(req.query.limit ?? 50), before }));
    res.json({ tasks: tasks.map(taskSummary), nextBefore: tasks.at(-1)?.id ?? null });
  });
  clients.post('/tasks', scope('tasks:write'), (req, res) =>
    res
      .status(201)
      .json({ task: store.submit(principalId(res), clean<SubmitTask>(submit.parse(req.body))) }),
  );
  clients.get('/tasks/:id', scope('tasks:read'), (req, res) =>
    res.json({ task: store.getTask(param(req, 'id')) }),
  );
  clients.get('/tasks/:id/events', scope('tasks:read'), (req, res) => {
    const after = sequence.parse(req.query.after ?? 0);
    const events = store.events(param(req, 'id'), after, page.parse(req.query.limit ?? 100));
    res.json({ events, nextSequence: events.at(-1)?.sequence ?? after });
  });
  clients.get('/tasks/:id/commands', scope('tasks:read'), (req, res) =>
    res.json({ commands: store.commands(param(req, 'id')) }),
  );
  clients.post('/tasks/:id/cancel', scope('tasks:write'), (req, res) => {
    const body = z.object({ requestKey }).strict().parse(req.body);
    res.json({ task: store.cancel(principalId(res), param(req, 'id'), body.requestKey) });
  });
  clients.post('/tasks/:id/commands', scope('tasks:write'), (req, res) => {
    const body = command.parse(req.body);
    res.json({
      command: store.enqueueCommand(
        principalId(res),
        param(req, 'id'),
        clean<{ requestKey: string; kind: 'cancel' | 'steer' | 'reply' | 'answer'; payload: Json }>(
          body,
        ),
      ),
    });
  });
  app.use('/v1', clients);
  app.use((_req, res) =>
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof RelayError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'Request fields do not match the API schema.' },
      });
      return;
    }
    const bodyError = error as { type?: string; status?: number };
    if (bodyError.type === 'entity.too.large') {
      res
        .status(413)
        .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
      return;
    }
    if (bodyError.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON.' } });
      return;
    }
    log({
      level: 'error',
      code: 'INTERNAL_ERROR',
      requestId: String(res.locals.requestId ?? 'unknown'),
    });
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred. Use the request ID to investigate.',
      },
    });
  });
  return {
    app,
    store,
    auth,
    close() {
      if (!options.store) store.close();
      if (!options.auth) auth.close();
    },
  };
}
