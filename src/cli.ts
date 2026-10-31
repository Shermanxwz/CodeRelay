#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createApplication } from './app.js';
import { defaultDataDir, initConfig, loadConfig, type RelayConfig } from './config.js';
import { RelayError } from './errors.js';

const HELP = `CodeRelay · 代码接力

Usage: coderelay <command> [options]

  init                  Create private configuration (never overwrites)
  serve                 Start the HTTP/MCP gateway
  pair                  Issue a one-use device pairing code (5 minutes)
  connector-code        Issue a one-use OAuth owner consent code (5 minutes)
  access-token          Create a scoped CLI access token (shown once)
  revoke-token          Revoke an access token read from standard input
  status                Show devices, projects, and recent tasks
  revoke-device         Revoke a device credential; active work becomes unknown
  reconcile             Resolve an unknown task after checking the device
  audit                 Read the latest bounded audit records
  backup                Take consistent SQLite snapshots and a private config copy
  doctor                Check configuration and local gateway readiness

Options:
  --data-dir PATH       State directory (default: ~/.coderelay)
  --public-url URL      HTTPS origin advertised to MCP clients (init only)
  --host ADDRESS        127.0.0.1 by default; use 0.0.0.0 behind a TLS proxy
  --port NUMBER         Listen port, default 8787
  --name TEXT           Device/token display name
  --scopes LIST         Comma-separated tasks:read,tasks:write
  --id ID               Device/task ID for revoke-device/reconcile
  --outcome STATUS      succeeded, failed, or cancelled (reconcile)
  --reason TEXT         Evidence-based reconciliation reason
  --output PATH         New private backup directory (backup)
  --help                Show this help

Secrets are never accepted as URL parameters or command-line arguments.
MiniMax login credentials remain with MiniMax Code.
`;

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
async function adminRequest(config: RelayConfig, path: string, body?: unknown): Promise<unknown> {
  const host = config.host === '::1' ? '[::1]' : '127.0.0.1';
  const response = await fetch(`http://${host}:${config.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${config.adminToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const item = data as { error?: { code?: string; message?: string } };
    throw new RelayError(
      item.error?.code ?? 'REQUEST_FAILED',
      item.error?.message ?? `Request failed (${response.status}).`,
      response.status,
    );
  }
  return data;
}

async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'data-dir': { type: 'string' },
      'public-url': { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      name: { type: 'string' },
      scopes: { type: 'string' },
      id: { type: 'string' },
      outcome: { type: 'string' },
      reason: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length > 1)
    throw new RelayError('INVALID_ARGUMENT', 'Only one command is accepted.');
  const dataDir = resolve(values['data-dir'] ?? defaultDataDir());
  if (command === 'init') {
    const options: { dataDir: string; publicUrl?: string; host?: string; port?: number } = {
      dataDir,
    };
    if (values['public-url'] !== undefined) options.publicUrl = values['public-url'];
    if (values.host !== undefined) options.host = values.host;
    if (values.port !== undefined) options.port = Number(values.port);
    const config = initConfig(options);
    output({
      initialized: true,
      configFile: join(dataDir, 'config.json'),
      publicUrl: config.publicUrl,
      next: 'Run coderelay serve. Credentials were saved privately and are not printed.',
    });
    return;
  }
  const config = loadConfig(dataDir);
  if (command === 'serve') {
    const application = createApplication(config);
    const server = application.app.listen(config.port, config.host, () => {
      process.stderr.write(
        `${JSON.stringify({ event: 'ready', service: 'CodeRelay', publicUrl: config.publicUrl, listen: `${config.host}:${config.port}` })}\n`,
      );
    });
    const sweep = setInterval(() => {
      try {
        application.store.sweep();
      } catch {
        process.stderr.write('{"event":"sweep_failed"}\n');
      }
    }, 15_000);
    sweep.unref();
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(sweep);
      const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
      deadline.unref();
      server.close(() => {
        clearTimeout(deadline);
        application.close();
      });
      server.closeIdleConnections();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    server.on('error', (error) => {
      clearInterval(sweep);
      application.close();
      process.stderr.write(
        `${JSON.stringify({ error: 'LISTEN_FAILED', message: (error as NodeJS.ErrnoException).code ?? 'unknown' })}\n`,
      );
      process.exitCode = 1;
    });
    return;
  }
  if (command === 'pair') {
    output(
      await adminRequest(config, '/v1/admin/pairing-codes', {
        name: values.name ?? 'MiniMax desktop',
      }),
    );
    return;
  }
  if (command === 'connector-code') {
    output(await adminRequest(config, '/v1/admin/connector-codes', {}));
    return;
  }
  if (command === 'access-token') {
    output(
      await adminRequest(config, '/v1/admin/access-tokens', {
        name: values.name ?? 'CLI client',
        scopes: (values.scopes ?? 'tasks:read,tasks:write').split(','),
      }),
    );
    return;
  }
  if (command === 'revoke-token') {
    if (process.stdin.isTTY)
      throw new RelayError(
        'STDIN_REQUIRED',
        'Supply the token on standard input, not as an argument.',
      );
    let token = '';
    for await (const chunk of process.stdin) {
      token += String(chunk);
      if (token.length > 1024) throw new RelayError('INVALID_TOKEN', 'Input is too large.');
    }
    output(await adminRequest(config, '/v1/admin/access-tokens/revoke', { token: token.trim() }));
    return;
  }
  if (command === 'status') {
    output(await adminRequest(config, '/v1/admin/status'));
    return;
  }
  if (command === 'audit') {
    output(await adminRequest(config, '/v1/admin/audit'));
    return;
  }
  if (command === 'revoke-device') {
    if (!values.id) throw new RelayError('INVALID_ARGUMENT', '--id is required.');
    output(
      await adminRequest(config, `/v1/admin/devices/${encodeURIComponent(values.id)}/revoke`, {}),
    );
    return;
  }
  if (command === 'reconcile') {
    if (!values.id || !values.outcome || !values.reason)
      throw new RelayError(
        'INVALID_ARGUMENT',
        '--id, --outcome and --reason are required; inspect the actual device before reconciling.',
      );
    output(
      await adminRequest(config, `/v1/admin/tasks/${encodeURIComponent(values.id)}/reconcile`, {
        outcome: values.outcome,
        reason: values.reason,
      }),
    );
    return;
  }
  if (command === 'doctor') {
    const status = await adminRequest(config, '/readyz');
    output({
      configuration: 'valid',
      gateway: status,
      publicUrl: config.publicUrl,
      mcpUrl: `${config.publicUrl}/mcp`,
      node: process.versions.node,
      desktopHost: 'not checked by this command',
    });
    return;
  }
  if (command === 'backup') {
    if (!values.output)
      throw new RelayError('INVALID_ARGUMENT', '--output must name a new backup directory.');
    const destination = resolve(values.output);
    if (existsSync(destination))
      throw new RelayError(
        'DESTINATION_EXISTS',
        'Backup destination already exists; nothing was overwritten.',
        409,
      );
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    const files: { name: string; sha256: string }[] = [];
    for (const name of ['relay.sqlite', 'auth.sqlite']) {
      const source = join(dataDir, name);
      if (!existsSync(source))
        throw new RelayError('DATABASE_MISSING', 'Start the gateway once before taking a backup.');
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(db, join(destination, name));
      } finally {
        db.close();
      }
      chmodSync(join(destination, name), 0o600);
      files.push({
        name,
        sha256: createHash('sha256')
          .update(readFileSync(join(destination, name)))
          .digest('hex'),
      });
    }
    copyFileSync(join(dataDir, 'config.json'), join(destination, 'config.json'));
    chmodSync(join(destination, 'config.json'), 0o600);
    files.push({
      name: 'config.json',
      sha256: createHash('sha256')
        .update(readFileSync(join(destination, 'config.json')))
        .digest('hex'),
    });
    writeFileSync(
      join(destination, 'manifest.json'),
      `${JSON.stringify({ version: 1, id: randomUUID(), createdAt: Date.now(), files }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    output({
      backup: destination,
      files: files.map((file) => file.name),
      warning:
        'Contains administrator credentials. Keep private. Stop the gateway before restoring; never automatically replay unknown work.',
    });
    return;
  }
  throw new RelayError('UNKNOWN_COMMAND', `Unknown command: ${command}. Use --help.`);
}

void run().catch((error) => {
  if (error instanceof RelayError)
    process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n`);
  else
    process.stderr.write(
      '{"error":"COMMAND_FAILED","message":"Check configuration, permissions and gateway availability. No credentials were printed."}\n',
    );
  process.exitCode = 1;
});
